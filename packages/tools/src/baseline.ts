/** @module baseline Load and audit the pinned source catalog without changing it. */
import { readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  type Card,
  type CardSet,
  commitSchema,
  type Inventory,
  identifierSchema,
  type SourceReference,
  setIdentifierSchema,
} from "@johto-ai/tcg-client/schema";
import {
  createCandidateInventory,
  createCandidateProvenance,
  type ProvenanceReceipt,
} from "./inventory.js";
import {
  asRecord,
  normalizeCard,
  normalizeSet,
  type RawRecord,
  sha256,
} from "./normalize.js";

// Future releases must preserve the identities approved at this frozen commit.
export const INITIAL_BASELINE_COMMIT =
  "39a26a144c8b6ef6c2fb17b2c29d0bb7121e3a11";
/** Exact repository and full commit used as the source of a build. */
export interface DatasetSource {
  repository: string;
  commit: string;
}
/** Observed source coverage; counts and omissions do not establish completeness. */
export interface BaselineAudit {
  counts: { sets: number; cards: number };
  cardFields: Record<string, number>;
  setFields: Record<string, number>;
  missingFields: { artist: number; rarity: number; legalities: number };
  imageHosts: Record<string, number>;
  totalMismatches: {
    setId: string;
    reportedTotal: number | null;
    actual: number;
  }[];
  baselineCommit: string;
  requiredSetIds: string[];
  warnings: string[];
}
/** Normalized records, frozen identity requirements, and unapproved review drafts. */
export interface Baseline {
  sourceDir: string;
  source: DatasetSource;
  baselineCommit: string;
  // These identities come from the frozen baseline, not the current record counts.
  requiredSetIds: string[];
  requiredCardIds: string[];
  sets: CardSet[];
  cards: Card[];
  // Candidates describe existing data; a maintainer must independently review them.
  candidateInventories: Inventory[];
  candidateProvenance: ProvenanceReceipt[];
  audit: BaselineAudit;
  issues: string[];
}
/** Run a read-only Git check and retain its diagnostic on failure. */
async function git(directory: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", directory, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, error, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exit !== 0)
    throw new Error(
      `Pinned source validation failed (git ${args.join(" ")}): ${error.trim()}`,
    );
  return output.trim();
}
/** Require the bare-array format used by canonical set and card files. */
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value))
    throw new Error(`${label}: expected a bare JSON array`);
  return value;
}
/** Count source field occurrences before normalization supplies default values. */
function tally(record: RawRecord, fields: Record<string, number>): void {
  for (const key of Object.keys(record)) fields[key] = (fields[key] ?? 0) + 1;
}

/** Validate a clean pinned checkout, normalize its records, and audit frozen coverage. */
export async function loadBaseline(options: {
  sourceDir: string;
  source: DatasetSource;
  baselineCommit?: string;
}): Promise<Baseline> {
  const sourceDir = realpathSync(options.sourceDir);
  const commit = commitSchema.parse(options.source.commit);
  if (!/^[\w.-]+\/[\w.-]+$/.test(options.source.repository))
    throw new Error("Invalid canonical repository; expected owner/name");
  const actual = await git(sourceDir, ["rev-parse", "HEAD"]);
  if (
    realpathSync(await git(sourceDir, ["rev-parse", "--show-toplevel"])) !==
    sourceDir
  )
    throw new Error(
      "The source directory must be the root of its pinned Git repository",
    );
  if (actual !== commit)
    throw new Error(
      `Pinned source mismatch: expected ${commit}, checkout is ${actual}; check out the configured full commit`,
    );
  if (
    await git(sourceDir, ["status", "--porcelain", "--untracked-files=normal"])
  )
    throw new Error(
      "Pinned source checkout is dirty; commit/review changes before building a snapshot",
    );
  // Fixture repositories use their own commit; the canonical fork cannot redefine its baseline.
  const baselineCommit = commitSchema.parse(
    options.baselineCommit ??
      (options.source.repository === "mega-blastoise/pokemon-tcg-data"
        ? INITIAL_BASELINE_COMMIT
        : commit),
  );
  if (
    options.source.repository === "mega-blastoise/pokemon-tcg-data" &&
    baselineCommit !== INITIAL_BASELINE_COMMIT
  )
    throw new Error(
      `The canonical initial baseline is frozen at ${INITIAL_BASELINE_COMMIT}; its required catalog cannot be redefined`,
    );
  await git(sourceDir, ["merge-base", "--is-ancestor", baselineCommit, commit]);
  // Hash original file text for provenance; parse separately for normalization.
  const setsBytes = await Bun.file(join(sourceDir, "sets/en.json")).text();
  const rawSets = array(JSON.parse(setsBytes), "sets/en.json").map((value) =>
    asRecord(value, "set"),
  );
  // Current source identities detect duplicates and later expose baseline omissions.
  const allIds = new Set<string>();
  const setIds = new Set<string>();
  // Only validated normalized records leave the loader.
  const cards: Card[] = [];
  const sets: CardSet[] = [];
  const cardFields: Record<string, number> = {};
  const setFields: Record<string, number> = {};
  // Absence is an audit observation, not proof a printed field is inapplicable.
  const missingFields = { artist: 0, rarity: 0, legalities: 0 };
  const imageHosts: Record<string, number> = {};
  const issues: string[] = [];
  // The release descriptor pins the containing commit. Embedding it in generated
  // records would make committing those records self-referential.
  const reference = (path: string, bytes: string): SourceReference => ({
    kind: "baseline",
    id: path,
    sha256: sha256(bytes),
    verifiedAt: null,
  });
  const setSource = reference("sets/en.json", setsBytes);
  for (const raw of rawSets) {
    const setId = setIdentifierSchema.parse(raw.id);
    if (setIds.has(setId))
      throw new Error(`Duplicate source set identity ${setId}`);
    setIds.add(setId);
    tally(raw, setFields);
    const file = `cards/en/${setId}.json`;
    const bytes = await Bun.file(join(sourceDir, file)).text();
    const rawCards = array(JSON.parse(bytes), file);
    const source = reference(file, bytes);
    for (const item of rawCards) {
      const rawCard = asRecord(item, file);
      tally(rawCard, cardFields);
      for (const key of ["artist", "rarity", "legalities"] as const)
        if (rawCard[key] === undefined) missingFields[key]++;
      const card = normalizeCard(rawCard, setId, { source });
      if (!card.id.startsWith(`${setId}-`))
        throw new Error(
          `${card.id}: identity does not belong to source set ${setId}`,
        );
      if (allIds.has(card.id))
        throw new Error(`Duplicate source card identity ${card.id}`);
      allIds.add(card.id);
      cards.push(card);
      for (const image of Object.values(card.images))
        if (image) {
          const host = new URL(image).hostname;
          imageHosts[host] = (imageHosts[host] ?? 0) + 1;
        }
    }
    sets.push(normalizeSet(raw, rawCards.length, { source: setSource }));
  }
  const files = readdirSync(join(sourceDir, "cards/en")).filter((file) =>
    file.endsWith(".json"),
  );
  for (const file of files)
    if (!setIds.has(file.slice(0, -5)))
      issues.push(
        `Orphan source card file cards/en/${file}; associate it with a reviewed set`,
      );
  // Stable identity order keeps browser and SQLite artifacts reproducible.
  sets.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  cards.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Read historical identities directly; printed numbers and totals cannot reconstruct them.
  let requiredSetIds = [...setIds].sort();
  let requiredCardIds = [...allIds].sort();
  if (baselineCommit !== commit) {
    const baselineSets = array(
      JSON.parse(
        await git(sourceDir, ["show", `${baselineCommit}:sets/en.json`]),
      ),
      "baseline sets",
    ).map((raw) => setIdentifierSchema.parse(asRecord(raw, "baseline set").id));
    requiredSetIds = baselineSets.sort();
    requiredCardIds = [];
    for (const id of requiredSetIds)
      requiredCardIds.push(
        ...array(
          JSON.parse(
            await git(sourceDir, [
              "show",
              `${baselineCommit}:cards/en/${id}.json`,
            ]),
          ),
          `baseline ${id}`,
        ).map((raw) =>
          identifierSchema.parse(asRecord(raw, "baseline card").id),
        ),
      );
    requiredCardIds.sort();
  }
  for (const id of requiredSetIds)
    if (!setIds.has(id))
      issues.push(
        `Missing initial baseline set ${id}; a complete subset cannot publish`,
      );
  for (const id of requiredCardIds)
    if (!allIds.has(id))
      issues.push(`Missing preserved baseline identity ${id}`);
  // Printed/reported totals may differ from identity counts and are never a release checklist.
  const totalMismatches = sets
    .filter((set) => set.reportedTotal !== set.cardCount)
    .map((set) => ({
      setId: set.id,
      reportedTotal: set.reportedTotal,
      actual: set.cardCount,
    }));
  const warnings = [
    ...totalMismatches.map(
      (item) =>
        `${item.setId}: reported total ${item.reportedTotal} differs from ${item.actual} records; reviewed inventory is required`,
    ),
    ...Object.entries(missingFields)
      .filter(([, count]) => count)
      .map(
        ([field, count]) =>
          `${count} cards omit ${field}; absence is not proof of inapplicability`,
      ),
  ];
  const audit: BaselineAudit = {
    counts: { sets: sets.length, cards: cards.length },
    cardFields,
    setFields,
    missingFields,
    imageHosts,
    totalMismatches,
    baselineCommit,
    requiredSetIds,
    warnings,
  };
  return {
    sourceDir,
    source: { ...options.source },
    baselineCommit,
    requiredSetIds,
    requiredCardIds,
    sets,
    cards,
    candidateInventories: sets.map((set) =>
      createCandidateInventory(
        set,
        cards.filter((card) => card.setId === set.id),
      ),
    ),
    candidateProvenance: sets.map((set) =>
      createCandidateProvenance(
        set,
        cards.filter((card) => card.setId === set.id),
      ),
    ),
    audit,
    issues,
  };
}
