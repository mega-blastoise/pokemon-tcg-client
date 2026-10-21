/** @module snapshot Build and verify matching browser and SQLite snapshots before replacement. */
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { toSearchEntry } from "@johto-ai/tcg-client/query";
import {
  type Card,
  type CardSet,
  cardSchema,
  commitSchema,
  contentManifestSchema,
  identifierSchema,
  inventorySchema,
  type SnapshotManifest,
  searchEntrySchema,
  setIdentifierSchema,
  setSchema,
  snapshotManifestSchema,
} from "@johto-ai/tcg-client/schema";
import {
  SQLITE_METADATA_KEY,
  SQLITE_SCHEMA,
} from "@johto-ai/tcg-client/sqlite-schema";
import {
  type AssetManifest,
  normalizeAssetOrigin,
  parseAssetManifest,
  requiredAssetUrls,
  rewriteAssetUrls,
  safeAssetFile,
  verifyAssetFile,
  writeAssetManifest,
} from "./assets.js";
import type { Baseline } from "./baseline.js";
import {
  type InventoryReview,
  loadInventoryReview,
  parseProvenanceReceipt,
  reviewIssues,
  validateInventory,
  validateProvenance,
} from "./inventory.js";
import { asRecord, sha256, stableJSON } from "./normalize.js";

/** Release rejection with the complete issue list retained for callers and reports. */
export class SnapshotValidationError extends Error {
  readonly issues: readonly string[];
  /** Keep the displayed error short without discarding the underlying review issues. */
  constructor(issues: readonly string[]) {
    super(
      `Snapshot is not release-ready (${issues.length} issues):\n${issues
        .slice(0, 20)
        .map((issue) => `- ${issue}`)
        .join(
          "\n",
        )}${issues.length > 20 ? "\nSee reports/release-issues.json for the full report." : ""}`,
    );
    this.name = "SnapshotValidationError";
    this.issues = issues;
  }
}
/** Pinned inputs and explicit release intent; draft inputs never imply approval. */
export interface BuildSnapshotOptions {
  baseline: Baseline;
  outputDir: string;
  dataVersion: string;
  builderVersion?: string;
  builderCommit?: string;
  inventoriesDir?: string;
  assetManifestPath?: string;
  assetOrigin?: string;
  releaseReady?: boolean;
}
/** Write deterministic JSON inside the isolated staging directory. */
async function writeJSON(path: string, value: unknown): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, stableJSON(value));
}
/** Read artifact JSON without trusting its shape before schema validation. */
async function readJSON(path: string): Promise<unknown> {
  return await Bun.file(path).json();
}
/** Hash complete artifact bytes for manifest and source comparisons. */
async function fileHash(path: string): Promise<string> {
  return sha256(new Uint8Array(await Bun.file(path).arrayBuffer()));
}
/** Compare structured values without treating object key order as a difference. */
function identical(actual: unknown, expected: unknown, label: string): void {
  if (stableJSON(actual) !== stableJSON(expected))
    throw new Error(`Snapshot parity mismatch: ${label}`);
}
/** Select identity fields shared by the outer manifest and SQLite metadata. */
function snapshotIdentity(
  manifest: Pick<
    SnapshotManifest,
    "schemaVersion" | "dataVersion" | "source" | "counts"
  >,
) {
  return {
    schemaVersion: manifest.schemaVersion,
    dataVersion: manifest.dataVersion,
    source: manifest.source,
    counts: manifest.counts,
  };
}
/** Preserve every frozen baseline identity, not just a complete subset of sets. */
function sourceIdentityIssues(
  baseline: Baseline,
  sets: readonly CardSet[],
  cards: readonly Card[],
): string[] {
  const issues = [...baseline.issues];
  const setIds = new Set(sets.map((set) => set.id));
  const cardIds = new Set(cards.map((card) => card.id));
  for (const id of baseline.requiredSetIds)
    if (!setIds.has(id))
      issues.push(
        `Missing initial baseline set ${id}; all baseline sets must publish together`,
      );
  for (const id of baseline.requiredCardIds)
    if (!cardIds.has(id)) issues.push(`Missing preserved baseline card ${id}`);
  return issues;
}
/** Check local owned-byte readiness; remote publication is a later release step. */
async function assetIssues(
  manifest: AssetManifest,
  directory: string,
  required?: readonly string[],
): Promise<string[]> {
  const issues = [
    ...reviewIssues(manifest.review, "Owned asset mapping review"),
  ];
  if (!manifest.origin)
    issues.push(
      "Configure the owned HTTPS asset origin; upstream image URLs are not owned assets",
    );
  const entries = new Map(
    manifest.entries.map((entry) => [entry.sourceUrl, entry]),
  );
  const missing = (required ?? manifest.missing).filter(
    (url) => !entries.has(url),
  );
  if (missing.length || manifest.missing.length)
    issues.push(
      `Missing owned asset mappings: ${Math.max(missing.length, manifest.missing.length)}; prepare assets explicitly (examples: ${[...new Set([...missing, ...manifest.missing])].slice(0, 3).join(", ")})`,
    );
  // Distinct source URLs may share bytes, so check each staged file only once.
  const checked = new Set<string>();
  for (const entry of manifest.entries) {
    const path = safeAssetFile(directory, entry.file);
    if (!checked.has(entry.file)) {
      checked.add(entry.file);
      if (!existsSync(path))
        issues.push(`Missing staged asset bytes ${entry.file}`);
      else if ((await fileHash(path)) !== entry.sha256)
        issues.push(`Corrupt staged asset bytes ${entry.file}`);
    }
  }
  return issues;
}
/** Reject missing required images and URLs outside the checked owned mapping. */
function ownedImageIssues(
  cards: readonly Card[],
  sets: readonly CardSet[],
  assets: AssetManifest,
): string[] {
  const allowed = new Set(
    assets.origin
      ? assets.entries.map((entry) => `${assets.origin}/${entry.key}`)
      : [],
  );
  let missing = 0;
  let external = 0;
  for (const item of [...cards, ...sets])
    for (const url of Object.values(item.images)) {
      if (!url) missing++;
      else if (!allowed.has(url)) external++;
    }
  return [
    ...(missing
      ? [
          `${missing} required card/set image fields are missing; complete assets before publication`,
        ]
      : []),
    ...(external
      ? [
          `${external} image references still point outside the verified owned asset mapping`,
        ]
      : []),
  ];
}
/** Require generated browser bytes to match the files committed at the pinned source. */
async function generatedSourceIssues(
  sourceDir: string,
  generatedDir: string,
): Promise<string[]> {
  const issues: string[] = [];
  // Compare relative browser paths without changing either the source checkout or staging tree.
  const visit = async (directory: string, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(join(directory, entry.name), path);
      else if (entry.isFile()) {
        const expected = join(sourceDir, "generated/v1", path);
        if (
          !existsSync(expected) ||
          (await fileHash(expected)) !==
            (await fileHash(join(directory, entry.name)))
        )
          issues.push(
            `Canonical generated/v1/${path} is missing or stale; commit reviewed generated browser files before pinning the release SHA`,
          );
      }
    }
  };
  await visit(generatedDir);
  return issues;
}
/** Attach checklist completeness only when its exact inventory passes validation. */
function reviewedSets(baseline: Baseline, review: InventoryReview): CardSet[] {
  const inventoryById = new Map(
    review.inventories.map((inventory) => [inventory.setId, inventory]),
  );
  return baseline.sets.map((set) => {
    const inventory = inventoryById.get(set.id);
    return {
      ...set,
      completeness: inventory
        ? {
            kind: inventory.kind,
            cutoff: inventory.cutoff,
            inventoryHash: sha256(stableJSON(inventory)),
            reviewed: !validateInventory(
              inventory,
              set,
              baseline.cards.filter((card) => card.setId === set.id),
            ).length,
          }
        : set.completeness,
    };
  });
}

/** Stage both storage formats, verify their shared records, then safely replace the output. */
export async function buildSnapshot(
  options: BuildSnapshotOptions,
): Promise<SnapshotManifest> {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(options.dataVersion))
    throw new Error("dataVersion must be an explicit semantic version");
  const outputDir = resolve(options.outputDir);
  // An accepted output must never be replaced with incomplete draft evidence.
  let existingAccepted = false;
  const resolvedOutput = existsSync(outputDir)
    ? realpathSync(outputDir)
    : outputDir;
  if (
    resolvedOutput === options.baseline.sourceDir ||
    resolvedOutput.startsWith(`${options.baseline.sourceDir}/`)
  )
    throw new Error(
      "Snapshot output must be outside the canonical source checkout",
    );
  if (existsSync(outputDir)) {
    const allowed = new Set([
      "manifest.json",
      "pokemon-data.sqlite3.db",
      "generated",
      "reports",
      "assets",
    ]);
    if (readdirSync(outputDir).some((entry) => !allowed.has(entry)))
      throw new Error(
        "Existing output is not a snapshot/assets workspace; choose a fresh output directory",
      );
    if (existsSync(join(outputDir, "manifest.json")))
      existingAccepted = snapshotManifestSchema.parse(
        await readJSON(join(outputDir, "manifest.json")),
      ).releaseReady;
  }
  mkdirSync(dirname(outputDir), { recursive: true });
  // Build beside the destination so validation cannot damage the last accepted snapshot.
  const staging = mkdtempSync(
    join(dirname(outputDir), `.${basename(outputDir)}.staging-`),
  );
  const review = await loadInventoryReview({
    sourceDir: options.baseline.sourceDir,
    sets: options.baseline.sets,
    cards: options.baseline.cards,
    ...(options.inventoriesDir
      ? { inventoriesDir: options.inventoriesDir }
      : {}),
  });
  // Acquisition is separate: a build consumes checked local bytes and never fetches images.
  const assetPath =
    options.assetManifestPath ?? join(outputDir, "assets/manifest.json");
  const assets: AssetManifest = existsSync(assetPath)
    ? parseAssetManifest(await readJSON(assetPath))
    : {
        schemaVersion: 1,
        origin: normalizeAssetOrigin(options.assetOrigin),
        review: { approved: false, reviewedBy: null, reviewedAt: null },
        entries: [],
        missing: requiredAssetUrls(options.baseline),
      };
  const issues = [...review.issues];
  if (
    options.assetOrigin &&
    assets.origin !== normalizeAssetOrigin(options.assetOrigin)
  )
    issues.push("Configured asset origin does not match the asset manifest");
  const assetDir = join(staging, "assets");
  mkdirSync(assetDir, { recursive: true });
  // Copy shared byte identities only once, regardless of the number of source references.
  const copied = new Set<string>();
  for (const entry of assets.entries) {
    const file = safeAssetFile(dirname(assetPath), entry.file);
    const target = safeAssetFile(assetDir, entry.file);
    if (copied.has(entry.file)) continue;
    copied.add(entry.file);
    if (!existsSync(file)) {
      issues.push(`Missing acquired asset file ${file}`);
      continue;
    }
    if ((await fileHash(file)) !== entry.sha256)
      throw new Error(`Asset checksum mismatch before build: ${file}`);
    mkdirSync(dirname(target), { recursive: true });
    await Bun.write(target, Bun.file(file));
  }
  await writeAssetManifest(assetDir, assets);
  issues.push(
    ...(await assetIssues(
      assets,
      assetDir,
      requiredAssetUrls(options.baseline),
    )),
  );
  // These exact records feed browser JSON, search entries, and SQLite data columns.
  const normalized = rewriteAssetUrls(
    options.baseline.cards,
    reviewedSets(options.baseline, review),
    assets,
  );
  issues.push(
    ...sourceIdentityIssues(
      options.baseline,
      normalized.sets,
      normalized.cards,
    ),
    ...ownedImageIssues(normalized.cards, normalized.sets, assets),
  );
  if (
    options.inventoriesDir &&
    resolve(options.inventoriesDir) !==
      resolve(options.baseline.sourceDir, "inventories/en")
  )
    issues.push(
      "Release inventories must be committed under the pinned canonical fork's inventories/en directory; external review files are draft inputs",
    );
  const generatedDir = join(staging, "generated/v1");
  // Paths are relative to generated/v1; its manifest is hashed by the outer descriptor instead.
  const files: Record<string, string> = {};
  // Register each payload only after its final deterministic bytes have been written.
  const browserFile = async (path: string, value: unknown) => {
    const fullPath = join(generatedDir, path);
    await writeJSON(fullPath, value);
    files[path] = await fileHash(fullPath);
  };
  await browserFile("sets.json", normalized.sets);
  const setMap = new Map(normalized.sets.map((set) => [set.id, set]));
  // Shared search normalization keeps browser filters and native query columns aligned.
  const entries = normalized.cards.map((card) =>
    toSearchEntry(card, setMap.get(card.setId) as CardSet),
  );
  await browserFile("search-index.json", entries);
  await browserFile("assets.json", assets);
  for (const set of normalized.sets)
    await browserFile(
      `cards/${set.id}.json`,
      normalized.cards.filter((card) => card.setId === set.id),
    );
  const counts = {
    sets: normalized.sets.length,
    cards: normalized.cards.length,
  };
  await writeJSON(join(generatedDir, "manifest.json"), {
    schemaVersion: 1,
    counts,
    files,
  });
  issues.push(
    ...(await generatedSourceIssues(options.baseline.sourceDir, generatedDir)),
  );
  if (!options.builderCommit || !/^[a-f0-9]{40}$/.test(options.builderCommit))
    issues.push("Release builds require the full reviewed builder Git commit");
  // A standalone database avoids requiring mutable WAL/SHM sidecars in the data package.
  const databasePath = join(staging, "pokemon-data.sqlite3.db");
  const db = new Database(databasePath, { create: true, readwrite: true });
  let sqliteVersion: string;
  try {
    db.exec(
      "PRAGMA journal_mode = DELETE; PRAGMA page_size = 4096; PRAGMA user_version = 1;",
    );
    db.exec(SQLITE_SCHEMA);
    sqliteVersion = (
      db.query("SELECT sqlite_version() AS version").get() as {
        version: string;
      }
    ).version;
    const insertSet = db.prepare(
      "INSERT INTO sets (id,name,series,release_date,data) VALUES (?,?,?,?,?)",
    );
    const insertCard = db.prepare(
      "INSERT INTO cards (id,set_id,normalized_name,supertype,types,subtypes,rarity,regulation_mark,number_key,release_date,search_text,data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    // Insert metadata and all records together; the final database hash is computed after close.
    db.transaction(() => {
      db.prepare("INSERT INTO snapshot_metadata (key,value) VALUES (?,?)").run(
        SQLITE_METADATA_KEY,
        stableJSON({
          schemaVersion: 1,
          dataVersion: options.dataVersion,
          source: options.baseline.source,
          counts,
        }),
      );
      for (const set of normalized.sets)
        insertSet.run(
          set.id,
          set.name,
          set.series,
          set.releaseDate ?? "",
          stableJSON(set),
        );
      for (let i = 0; i < normalized.cards.length; i++) {
        const card = normalized.cards[i] as Card;
        const entry = entries[i];
        if (!entry) throw new Error("Missing normalized search entry");
        insertCard.run(
          card.id,
          card.setId,
          entry.normalizedName,
          card.supertype,
          JSON.stringify(card.types),
          JSON.stringify(card.subtypes),
          card.rarity,
          card.regulationMark,
          entry.numberKey,
          entry.releaseDate,
          entry.text,
          stableJSON(card),
        );
      }
    })();
  } finally {
    db.close();
  }
  // The outer manifest binds source, builder, and final artifact hashes without hashing itself.
  const manifest = snapshotManifestSchema.parse({
    schemaVersion: 1,
    dataVersion: options.dataVersion,
    source: options.baseline.source,
    builder: {
      version: options.builderVersion ?? "0.0.0",
      commit: options.builderCommit ?? null,
      bunVersion: Bun.version,
      sqliteVersion,
    },
    counts,
    inventoryHash: review.hash,
    database: {
      path: "pokemon-data.sqlite3.db",
      sha256: await fileHash(databasePath),
      requiredFeatures: ["json", "strict"],
    },
    browser: {
      baseUrl: `https://raw.githubusercontent.com/${options.baseline.source.repository}/${options.baseline.source.commit}/`,
      manifestPath: "generated/v1/manifest.json",
      manifestSha256: await fileHash(join(generatedDir, "manifest.json")),
    },
    assets: {
      origin: assets.origin,
      manifestPath: "assets/manifest.json",
      manifestSha256: await fileHash(join(assetDir, "manifest.json")),
    },
    releaseReady: options.releaseReady === true && issues.length === 0,
    issues: [...new Set(issues)].sort(),
  });
  await writeJSON(join(staging, "manifest.json"), manifest);
  await writeJSON(
    join(staging, "reports/baseline.json"),
    options.baseline.audit,
  );
  await writeJSON(join(staging, "reports/required-identities.json"), {
    source: options.baseline.source,
    baselineCommit: options.baseline.baselineCommit,
    setIds: options.baseline.requiredSetIds,
    cardIds: options.baseline.requiredCardIds,
  });
  await writeJSON(join(staging, "reports/review.json"), review);
  await writeJSON(
    join(staging, "reports/release-issues.json"),
    manifest.issues,
  );
  for (const inventory of options.baseline.candidateInventories)
    await writeJSON(
      join(staging, "reports/candidate-inventories", `${inventory.setId}.json`),
      inventory,
    );
  for (const receipt of options.baseline.candidateProvenance)
    await writeJSON(
      join(staging, "reports/candidate-provenance", `${receipt.setId}.json`),
      receipt,
    );
  // Drafts still require matching bytes, schemas, and records; missing review remains explicit.
  await verifySnapshot(staging, { baseline: options.baseline });
  if (options.releaseReady && manifest.issues.length)
    throw new SnapshotValidationError([
      ...manifest.issues,
      `Draft evidence retained at ${staging}`,
    ]);
  if (existingAccepted && !manifest.releaseReady)
    throw new Error(
      `Refusing to replace an accepted snapshot with a draft. Choose a fresh output path. Draft evidence retained at ${staging}; accepted output remains at ${outputDir}`,
    );
  // Retain the previous tree for recovery and restore it if the final rename fails.
  if (existsSync(outputDir)) {
    const previous = `${outputDir}.previous-${crypto.randomUUID()}`;
    renameSync(outputDir, previous);
    try {
      renameSync(staging, outputDir);
    } catch (error) {
      renameSync(previous, outputDir);
      throw error;
    }
  } else renameSync(staging, outputDir);
  return manifest;
}

/** Recheck file hashes and matching JSON/SQLite records, with optional release checks. */
export async function verifySnapshot(
  snapshotDir: string,
  options: { releaseReady?: boolean; baseline?: Baseline } = {},
): Promise<SnapshotManifest> {
  const manifest = snapshotManifestSchema.parse(
    await readJSON(join(snapshotDir, "manifest.json")),
  );
  if (
    manifest.browser.baseUrl !==
      `https://raw.githubusercontent.com/${manifest.source.repository}/${manifest.source.commit}/` ||
    manifest.browser.manifestPath !== "generated/v1/manifest.json"
  )
    throw new Error(
      "Browser descriptor does not identify this pinned canonical snapshot",
    );
  const generatedDir = join(snapshotDir, "generated/v1");
  const databasePath = safeAssetFile(snapshotDir, manifest.database.path);
  if ((await fileHash(databasePath)) !== manifest.database.sha256)
    throw new Error("SQLite checksum mismatch");
  if (
    (await fileHash(join(generatedDir, "manifest.json"))) !==
    manifest.browser.manifestSha256
  )
    throw new Error("Browser content manifest checksum mismatch");
  // Trust no payload until the descriptor and its listed file hashes agree with local bytes.
  const content = contentManifestSchema.parse(
    await readJSON(join(generatedDir, "manifest.json")),
  );
  identical(content.counts, manifest.counts, "browser counts");
  for (const required of ["sets.json", "search-index.json", "assets.json"])
    if (!content.files[required])
      throw new Error(
        `Required browser file missing from manifest: ${required}`,
      );
  for (const [file, hash] of Object.entries(content.files))
    if ((await fileHash(safeAssetFile(generatedDir, file))) !== hash)
      throw new Error(`Browser content checksum mismatch: ${file}`);
  const sets = setSchema
    .array()
    .parse(await readJSON(join(generatedDir, "sets.json")));
  // Reassemble canonical records from per-set files before comparing other representations.
  const cards: Card[] = [];
  for (const set of sets) {
    const file = `cards/${set.id}.json`;
    if (!content.files[file])
      throw new Error(
        `Required card file missing from browser manifest: ${file}`,
      );
    const members = cardSchema
      .array()
      .parse(await readJSON(join(generatedDir, file)));
    if (members.some((card) => card.setId !== set.id))
      throw new Error(`Wrong set association in ${file}`);
    if (members.length !== set.cardCount)
      throw new Error(`Wrong actual card count for ${set.id}`);
    cards.push(...members);
  }
  cards.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (
    new Set(sets.map((set) => set.id)).size !== sets.length ||
    new Set(cards.map((card) => card.id)).size !== cards.length
  )
    throw new Error("Duplicate identities in browser snapshot");
  identical(
    { sets: sets.length, cards: cards.length },
    manifest.counts,
    "normalized counts",
  );
  const setMap = new Map(sets.map((set) => [set.id, set]));
  // Recompute search entries from records rather than trusting a self-consistent stale index.
  const entries = searchEntrySchema
    .array()
    .parse(await readJSON(join(generatedDir, "search-index.json")));
  identical(
    entries,
    cards.map((card) => toSearchEntry(card, setMap.get(card.setId) as CardSet)),
    "search index/source records",
  );
  const assetFile = safeAssetFile(snapshotDir, manifest.assets.manifestPath);
  if ((await fileHash(assetFile)) !== manifest.assets.manifestSha256)
    throw new Error("Asset manifest checksum mismatch");
  const assets = parseAssetManifest(await readJSON(assetFile));
  identical(
    assets,
    await readJSON(join(generatedDir, "assets.json")),
    "browser asset mapping",
  );
  if (assets.origin !== manifest.assets.origin)
    throw new Error("Asset origin mismatch");
  // Local byte checks apply to drafts too; missing acquisition stays an explicit release issue.
  for (const entry of assets.entries) {
    const file = safeAssetFile(dirname(assetFile), entry.file);
    if (!existsSync(file) || (await fileHash(file)) !== entry.sha256)
      throw new Error(`Asset checksum mismatch: ${entry.file}`);
    await verifyAssetFile(dirname(assetFile), entry);
  }
  const uploads = await readJSON(join(snapshotDir, "assets/uploads.json"));
  // The upload plan must list each checked asset key once, with the same file and hash.
  const expectedUploads = [
    ...new Map(
      assets.entries.map(({ key, file, sha256, contentType }) => [
        key,
        { key, file, sha256, contentType },
      ]),
    ).values(),
  ].sort((a, b) => (a.key < b.key ? -1 : 1));
  identical(uploads, expectedUploads, "asset upload manifest");
  // Persisted identity reviews and printed-field reviews must both cover every set exactly once.
  const review = (await readJSON(
    join(snapshotDir, "reports/review.json"),
  )) as InventoryReview;
  review.inventories = inventorySchema.array().parse(review.inventories);
  review.provenance = review.provenance.map(parseProvenanceReceipt);
  for (const [label, values] of [
    ["inventory", review.inventories],
    ["printed-field review", review.provenance],
  ] as const) {
    const ids = values.map((value) => value.setId);
    if (
      new Set(ids).size !== ids.length ||
      ids.length !== sets.length ||
      sets.some((set) => !ids.includes(set.id))
    )
      throw new Error(
        `Missing, duplicate or unexpected persisted ${label} records`,
      );
  }
  if (
    sha256(
      stableJSON({
        inventories: review.inventories,
        provenance: review.provenance,
      }),
    ) !== manifest.inventoryHash
  )
    throw new Error("Inventory/provenance hash mismatch");
  // Saved requirements explain the frozen baseline; a supplied loader later verifies their truth.
  const required = asRecord(
    await readJSON(join(snapshotDir, "reports/required-identities.json")),
    "required identity report",
  );
  identical(required.source, manifest.source, "required identity source");
  commitSchema.parse(required.baselineCommit);
  const requiredSets = setIdentifierSchema.array().parse(required.setIds);
  const requiredCards = identifierSchema.array().parse(required.cardIds);
  if (
    new Set(requiredSets).size !== requiredSets.length ||
    new Set(requiredCards).size !== requiredCards.length
  )
    throw new Error("Duplicate required baseline identities");
  // Read only: verification must not repair or otherwise alter the artifact being checked.
  const db = new Database(databasePath, { readonly: true });
  try {
    const integrity = db.query("PRAGMA integrity_check").all() as Record<
      string,
      unknown
    >[];
    if (
      integrity.length !== 1 ||
      Object.values(integrity[0] ?? {})[0] !== "ok" ||
      db.query("PRAGMA foreign_key_check").all().length
    )
      throw new Error("SQLite integrity/reference check failed");
    const identity = db
      .query("SELECT value FROM snapshot_metadata WHERE key = ?")
      .get(SQLITE_METADATA_KEY) as { value: string } | null;
    if (!identity) throw new Error("Missing SQLite snapshot identity");
    identical(
      JSON.parse(identity.value),
      snapshotIdentity(manifest),
      "SQLite identity",
    );
    // Compare full JSON records first, then the separate columns used by native queries.
    const sqlSets = db.query("SELECT * FROM sets ORDER BY id").all() as {
      id: string;
      name: string;
      series: string;
      release_date: string;
      data: string;
    }[];
    identical(
      sqlSets.map((row) => JSON.parse(row.data)),
      sets,
      "SQLite/browser sets",
    );
    for (const row of sqlSets) {
      const set = setMap.get(row.id) as CardSet;
      identical(
        { name: row.name, series: row.series, release_date: row.release_date },
        {
          name: set.name,
          series: set.series,
          release_date: set.releaseDate ?? "",
        },
        `set query columns ${row.id}`,
      );
    }
    // Identity ordering matches browser reconstruction and the shared search index.
    const sqlCards = db
      .query("SELECT * FROM cards ORDER BY id")
      .all() as Record<string, unknown>[];
    identical(
      sqlCards.map((row) => JSON.parse(row.data as string)),
      cards,
      "SQLite/browser cards",
    );
    for (let i = 0; i < sqlCards.length; i++) {
      const row = sqlCards[i] as Record<string, unknown>;
      const card = cards[i] as Card;
      const entry = entries[i];
      if (!entry) throw new Error("Missing search entry");
      identical(
        {
          id: row.id,
          set_id: row.set_id,
          normalized_name: row.normalized_name,
          supertype: row.supertype,
          types: JSON.parse(row.types as string),
          subtypes: JSON.parse(row.subtypes as string),
          rarity: row.rarity,
          regulation_mark: row.regulation_mark,
          number_key: row.number_key,
          release_date: row.release_date,
          search_text: row.search_text,
        },
        {
          id: card.id,
          set_id: card.setId,
          normalized_name: entry.normalizedName,
          supertype: card.supertype,
          types: card.types,
          subtypes: card.subtypes,
          rarity: card.rarity,
          regulation_mark: card.regulationMark,
          number_key: entry.numberKey,
          release_date: entry.releaseDate,
          search_text: entry.text,
        },
        `SQLite query columns ${card.id}`,
      );
    }
  } finally {
    db.close();
  }
  if (existsSync(`${databasePath}-wal`) || existsSync(`${databasePath}-shm`))
    throw new Error("Snapshot requires SQLite WAL/SHM sidecars");
  // Cross-check artifacts against independently loaded source, not just against each other.
  if (options.baseline) {
    identical(
      requiredSets,
      options.baseline.requiredSetIds,
      "frozen baseline set inventory",
    );
    identical(
      requiredCards,
      options.baseline.requiredCardIds,
      "frozen baseline card inventory",
    );
    identical(
      required.baselineCommit,
      options.baseline.baselineCommit,
      "frozen baseline commit",
    );
    identical(manifest.source, options.baseline.source, "pinned source");
    const expected = rewriteAssetUrls(
      options.baseline.cards,
      reviewedSets(options.baseline, review),
      assets,
    );
    identical(cards, expected.cards, "normalized source/cards");
    identical(sets, expected.sets, "normalized source/sets");
  }
  // Re-evaluate approvals and completeness; a saved releaseReady flag is not sufficient evidence.
  if (options.releaseReady || manifest.releaseReady) {
    const issues = [
      ...manifest.issues,
      ...(await assetIssues(
        assets,
        dirname(assetFile),
        options.baseline ? requiredAssetUrls(options.baseline) : undefined,
      )),
      ...ownedImageIssues(cards, sets, assets),
    ];
    if (!options.baseline)
      issues.push(
        "Release verification requires the pinned baseline loader to verify initial catalog coverage and source fidelity",
      );
    else
      issues.push(
        ...sourceIdentityIssues(options.baseline, sets, cards),
        ...(await generatedSourceIssues(
          options.baseline.sourceDir,
          generatedDir,
        )),
      );
    if (!manifest.releaseReady)
      issues.push("Snapshot is explicitly a local draft (releaseReady=false)");
    for (const set of sets) {
      const inventory = review.inventories.find(
        (item) => item.setId === set.id,
      );
      const receipt = review.provenance.find((item) => item.setId === set.id);
      const members = cards.filter((card) => card.setId === set.id);
      if (!inventory || !receipt)
        issues.push(
          `${set.id}: missing persisted inventory/printed-field review`,
        );
      else {
        issues.push(
          ...validateInventory(inventory, set, members),
          ...validateProvenance(parseProvenanceReceipt(receipt), set, members),
        );
      }
    }
    if (issues.length)
      throw new SnapshotValidationError([...new Set(issues)].sort());
  }
  return manifest;
}
