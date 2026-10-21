/** @module snapshot_tests Checks source fidelity, complete-set gates, safe replacement, and asset recovery. */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeAssetOrigin,
  parseAssetManifest,
  prepareAssets,
  safeAssetFile,
  verifyPublishedAssets,
} from "../src/assets.js";
import { type Baseline, loadBaseline } from "../src/baseline.js";
import {
  createCandidateInventory,
  createCandidateProvenance,
  validateInventory,
  validateProvenance,
} from "../src/inventory.js";
import {
  normalizeCard,
  normalizeDate,
  sha256,
  stableJSON,
} from "../src/normalize.js";
import { buildSnapshot, verifySnapshot } from "../src/snapshot.js";

// Cleanup is restricted to directories this fixture factory created.
const roots: string[] = [];
// Valid one-pixel image bytes avoid any dependency on copyrighted art or remote hosting.
const png = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1kAAAAASUVORK5CYII=",
    "base64",
  ),
);
const sourceImage = "https://images.example.test/card.png";
const review = {
  approved: true,
  reviewedBy: "Fixture maintainer",
  reviewedAt: "2026-10-19T12:00:00Z",
};
/** Allocate and remember a unique test workspace. */
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "tcg-snapshot-test-"));
  roots.push(path);
  return path;
}
afterAll(() => {
  for (const path of roots) rmSync(path, { recursive: true, force: true });
});
/** Run a checked Git command inside a synthetic source checkout. */
function git(source: string, args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", source, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
/** Freeze fixture input without relying on the user's Git signing configuration. */
function commit(source: string, message: string): string {
  git(source, ["add", "."]);
  git(source, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--no-gpg-sign",
    "-qm",
    message,
  ]);
  return git(source, ["rev-parse", "HEAD"]);
}
/** Write stable fixture JSON, including any missing parent directories. */
async function json(path: string, value: unknown): Promise<void> {
  mkdirSync(join(path, ".."), { recursive: true });
  await Bun.write(path, stableJSON(value));
}
/** Create a clean one-set source repository with representative legacy fields. */
async function fixture(): Promise<{
  root: string;
  source: string;
  baseline: Baseline;
  initialCommit: string;
}> {
  const root = directory();
  const source = join(root, "source");
  mkdirSync(source);
  git(source, ["init", "-q"]);
  await json(join(source, "sets/en.json"), [
    {
      id: "x1",
      name: "Fixture",
      series: "Fixture",
      printedTotal: 1,
      total: 1,
      releaseDate: "2026/01/02",
      updatedAt: "2026/01/02 15:00:00",
      legalities: { standard: "Legal" },
      images: { symbol: sourceImage, logo: sourceImage },
    },
  ]);
  await json(join(source, "cards/en/x1.json"), [
    {
      id: "x1-182a",
      name: "Pokémon's Fixture",
      supertype: "Pokémon",
      subtypes: ["Basic"],
      types: ["Fire"],
      hp: "80",
      number: "182a",
      level: "X",
      ancientTrait: { name: "Ω Trait", text: "Printed trait ×2" },
      artist: "Artist",
      rarity: "Rare",
      attacks: [
        {
          name: "Draw",
          cost: ["Fire"],
          convertedEnergyCost: 1,
          damage: "10+",
          text: "Draw 2 cards.",
        },
      ],
      abilities: [{ name: "Ability", type: "Ability", text: "Printed" }],
      rules: ["Printed rule"],
      resistances: [{ type: "Water", value: "-30" }],
      images: { small: sourceImage, large: sourceImage },
      legalities: { standard: "Legal" },
    },
  ]);
  const initialCommit = commit(source, "Initial cards");
  return {
    root,
    source,
    initialCommit,
    baseline: await loadBaseline({
      sourceDir: source,
      source: { repository: "fixtures/cards", commit: initialCommit },
    }),
  };
}

describe("baseline normalization and reviewed snapshot gates", () => {
  test("normalizes historical fields and dates without inventing timezone or legality", async () => {
    const { baseline } = await fixture();
    const card = baseline.cards[0];
    const set = baseline.sets[0];
    expect(card?.number).toBe("182a");
    expect(card?.level).toBe("X");
    expect(card?.ancientTrait?.text).toContain("×2");
    expect(card?.resistances).toEqual([{ type: "Water", value: "-30" }]);
    expect(card?.hp).toBe(80);
    expect(card?.legalities.standard.status).toBe("unknown");
    expect(card?.legalities.standard.reportedStatus).toBe("Legal");
    expect(set?.updatedAt).toBe("2026-01-02T15:00:00");
    expect(set?.updatedAtTimezone).toBeNull();
    expect(baseline.candidateInventories[0]?.review.approved).toBe(false);
    expect(baseline.candidateProvenance[0]?.review.approved).toBe(false);
    expect(() => normalizeDate("2026/02/30", "date")).toThrow(
      "invalid calendar",
    );
    expect(() =>
      normalizeCard({ id: "x1-1", unexplained: 1 }, "x1", {
        source: { kind: "baseline" },
      }),
    ).toThrow("unhandled source fields");
  });
  test("rejects wrong pins and dirty source snapshots", async () => {
    const { source, initialCommit } = await fixture();
    await expect(
      loadBaseline({
        sourceDir: source,
        source: {
          repository: "mega-blastoise/pokemon-tcg-data",
          commit: initialCommit,
        },
        baselineCommit: initialCommit,
      }),
    ).rejects.toThrow("required catalog cannot be redefined");
    await expect(
      loadBaseline({
        sourceDir: source,
        source: { repository: "fixtures/cards", commit: "0".repeat(40) },
      }),
    ).rejects.toThrow("Pinned source mismatch");
    await Bun.write(join(source, "unreviewed.txt"), "draft");
    await expect(
      loadBaseline({
        sourceDir: source,
        source: { repository: "fixtures/cards", commit: initialCommit },
      }),
    ).rejects.toThrow("dirty");
  });
  test("draft rebuilds are byte-identical and release-ready cannot fake review or ownership", async () => {
    const { root, baseline } = await fixture();
    const first = await buildSnapshot({
      baseline,
      outputDir: join(root, "one"),
      dataVersion: "0.1.0-draft",
    });
    const second = await buildSnapshot({
      baseline,
      outputDir: join(root, "two"),
      dataVersion: "0.1.0-draft",
    });
    expect(first.database.sha256).toBe(second.database.sha256);
    expect(first.browser.manifestSha256).toBe(second.browser.manifestSha256);
    expect(first.releaseReady).toBe(false);
    expect(first.issues.some((issue) => issue.includes("UNREVIEWED"))).toBe(
      true,
    );
    await verifySnapshot(join(root, "one"), { baseline });
    await expect(
      buildSnapshot({
        baseline,
        outputDir: join(root, "release"),
        dataVersion: "1.0.0",
        releaseReady: true,
      }),
    ).rejects.toThrow("not release-ready");
    await expect(
      verifySnapshot(join(root, "one"), { baseline, releaseReady: true }),
    ).rejects.toThrow("local draft");
  });
  test("a reviewed inventory cannot hide duplicate/missing identities", async () => {
    const { baseline } = await fixture();
    const set = baseline.sets[0];
    if (!set) throw new Error("Fixture set missing");
    const inventory = createCandidateInventory(set, baseline.cards);
    inventory.review = review;
    inventory.expectedIds = ["x1-missing", "x1-missing"];
    const issues = validateInventory(inventory, set, baseline.cards);
    expect(issues.some((issue) => issue.includes("duplicate"))).toBe(true);
    expect(issues.some((issue) => issue.includes("missing inventory"))).toBe(
      true,
    );
    expect(issues.some((issue) => issue.includes("unexpected"))).toBe(true);
    baseline.requiredSetIds.push("initial-set-must-remain");
    const draft = await buildSnapshot({
      baseline,
      outputDir: join(directory(), "snapshot"),
      dataVersion: "0.1.0",
    });
    expect(
      draft.issues.some((issue) => issue.includes("initial-set-must-remain")),
    ).toBe(true);
  });
  test("missing Pokémon HP needs an explicit printed-field resolution and image nulls block release", async () => {
    const { root, baseline } = await fixture();
    const set = baseline.sets[0];
    const card = baseline.cards[0];
    if (!set || !card) throw new Error("Fixture records missing");
    card.hp = null;
    const receipt = createCandidateProvenance(set, [card]);
    expect(
      receipt.unresolvedRequiredFields.some((entry) => entry.field === "hp"),
    ).toBe(true);
    receipt.review = review;
    receipt.unresolvedRequiredFields = [];
    expect(
      validateProvenance(receipt, set, [card]).some((issue) =>
        issue.includes(".hp is missing"),
      ),
    ).toBe(true);
    receipt.inapplicableFields.push({
      cardId: card.id,
      field: "hp",
      reason: "Explicit fixture exception verified by the reviewer",
    });
    expect(validateProvenance(receipt, set, [card])).toEqual([]);
    card.images.large = null;
    const manifest = await buildSnapshot({
      baseline,
      outputDir: join(root, "snapshot"),
      dataVersion: "0.1.0",
    });
    expect(
      manifest.issues.some((issue) =>
        issue.includes("required card/set image fields are missing"),
      ),
    ).toBe(true);
    expect(manifest.releaseReady).toBe(false);
  });
  test("detects semantic query-column corruption even after a database checksum is rewritten", async () => {
    const { root, baseline } = await fixture();
    const out = join(root, "snapshot");
    const manifest = await buildSnapshot({
      baseline,
      outputDir: out,
      dataVersion: "0.1.0",
    });
    const db = new Database(join(out, manifest.database.path));
    db.exec("UPDATE cards SET search_text = 'incorrect'");
    db.close();
    manifest.database.sha256 = sha256(
      readFileSync(join(out, manifest.database.path)),
    );
    await json(join(out, "manifest.json"), manifest);
    await expect(verifySnapshot(out)).rejects.toThrow("SQLite query columns");
  });
  test("requires persisted baseline evidence and refuses unrelated output directories", async () => {
    const { root, baseline } = await fixture();
    const unrelated = join(root, "unrelated");
    mkdirSync(unrelated);
    await Bun.write(join(unrelated, "keep.txt"), "User-owned file");
    await expect(
      buildSnapshot({ baseline, outputDir: unrelated, dataVersion: "0.1.0" }),
    ).rejects.toThrow("not a snapshot/assets workspace");
    expect(readFileSync(join(unrelated, "keep.txt"), "utf8")).toBe(
      "User-owned file",
    );
    const output = join(root, "snapshot");
    await buildSnapshot({ baseline, outputDir: output, dataVersion: "0.1.0" });
    renameSync(
      join(output, "reports/required-identities.json"),
      join(output, "reports/required-identities.saved.json"),
    );
    await expect(verifySnapshot(output)).rejects.toThrow();
  });
  test("a later source commit cannot silently drop an initial baseline set", async () => {
    const { root, source, initialCommit } = await fixture();
    await json(join(source, "sets/en.json"), []);
    const later = commit(source, "Incomplete source update");
    const baseline = await loadBaseline({
      sourceDir: source,
      source: { repository: "fixtures/cards", commit: later },
      baselineCommit: initialCommit,
    });
    expect(baseline.requiredSetIds).toEqual(["x1"]);
    expect(
      baseline.issues.some((issue) =>
        issue.includes("Missing initial baseline set x1"),
      ),
    ).toBe(true);
    await expect(
      buildSnapshot({
        baseline,
        outputDir: join(root, "release"),
        dataVersion: "1.0.0",
        releaseReady: true,
      }),
    ).rejects.toThrow("not release-ready");
  });
  test("reviewed canonical generated content can publish without a self-referential commit", async () => {
    const { root, source, baseline, initialCommit } = await fixture();
    const set = baseline.sets[0];
    if (!set) throw new Error("Fixture set missing");
    const inventory = createCandidateInventory(set, baseline.cards);
    inventory.review = review;
    const provenance = createCandidateProvenance(set, baseline.cards);
    provenance.review = review;
    await json(join(source, "inventories/en/x1.json"), inventory);
    await json(join(source, "provenance/en/x1.json"), provenance);
    const reviewedCommit = commit(
      source,
      "Reviewed inventory and printed fields",
    );
    const reviewed = await loadBaseline({
      sourceDir: source,
      source: { repository: "fixtures/cards", commit: reviewedCommit },
      baselineCommit: initialCommit,
    });
    const bundle = join(root, "bundle");
    const assets = await prepareAssets({
      baseline: reviewed,
      outputDir: bundle,
      origin: "https://cards.example.test",
      allowNetwork: true,
      fetch: (async () => new Response(png)) as unknown as typeof fetch,
    });
    assets.review = review;
    const assetManifestPath = join(bundle, "assets/manifest.json");
    await json(assetManifestPath, assets);
    await verifyPublishedAssets(assetManifestPath, {
      fetch: (async () => new Response(png)) as unknown as typeof fetch,
    });
    const options = {
      dataVersion: "1.0.0",
      builderCommit: "a".repeat(40),
      assetManifestPath,
    };
    await buildSnapshot({
      ...options,
      baseline: reviewed,
      outputDir: join(root, "draft"),
    });
    cpSync(join(root, "draft/generated"), join(source, "generated"), {
      recursive: true,
    });
    const finalCommit = commit(source, "Reviewed generated browser views");
    const final = await loadBaseline({
      sourceDir: source,
      source: { repository: "fixtures/cards", commit: finalCommit },
      baselineCommit: initialCommit,
    });
    const release = await buildSnapshot({
      ...options,
      baseline: final,
      outputDir: join(root, "release"),
      releaseReady: true,
    });
    expect(release.releaseReady).toBe(true);
    expect(release.issues).toEqual([]);
    expect(release.source.commit).toBe(finalCommit);
    await expect(
      verifySnapshot(join(root, "release"), {
        baseline: final,
        releaseReady: true,
      }),
    ).resolves.toMatchObject({ releaseReady: true });
    const acceptedHash = sha256(
      readFileSync(join(root, "release/manifest.json")),
    );
    await expect(
      buildSnapshot({
        ...options,
        baseline: final,
        outputDir: join(root, "release"),
      }),
    ).rejects.toThrow("replace an accepted snapshot with a draft");
    expect(sha256(readFileSync(join(root, "release/manifest.json")))).toBe(
      acceptedHash,
    );
    expect(
      (await Bun.file(join(root, "release/manifest.json")).json()).releaseReady,
    ).toBe(true);
  });
});

describe("explicit content-addressed asset preparation", () => {
  test("checkpoints partial downloads, resumes remaining URLs, and resets stale approvals", async () => {
    const { root, baseline } = await fixture();
    const card = baseline.cards[0];
    const set = baseline.sets[0];
    if (!card || !set) throw new Error("Fixture records missing");
    const urls = [
      "https://images.example.test/a.png",
      "https://images.example.test/b.png",
      "https://images.example.test/c.png",
    ];
    card.images = { small: urls[0] as string, large: urls[1] as string };
    set.images = { symbol: urls[0] as string, logo: urls[2] as string };
    const firstCalls: string[] = [];
    await expect(
      prepareAssets({
        baseline,
        outputDir: root,
        origin: "https://cards.example.test",
        allowNetwork: true,
        fetch: (async (url: string | URL | Request) => {
          firstCalls.push(String(url));
          return String(url).endsWith("/b.png")
            ? new Response("Unavailable", { status: 503 })
            : new Response(png);
        }) as unknown as typeof fetch,
      }),
    ).rejects.toThrow("checked progress saved");
    expect(firstCalls).toEqual(urls.slice(0, 2));
    const manifestPath = join(root, "assets/manifest.json");
    const partial = parseAssetManifest(await Bun.file(manifestPath).json());
    expect(partial.entries.map((entry) => entry.sourceUrl)).toEqual(
      urls.slice(0, 1),
    );
    expect(partial.missing).toEqual(urls.slice(1));
    const retryCalls: string[] = [];
    const complete = await prepareAssets({
      baseline,
      outputDir: root,
      origin: "https://cards.example.test",
      allowNetwork: true,
      fetch: (async (url: string | URL | Request) => {
        retryCalls.push(String(url));
        return new Response(png);
      }) as unknown as typeof fetch,
    });
    expect(retryCalls).toEqual(urls.slice(1));
    expect(complete.missing).toEqual([]);
    expect(complete.entries).toHaveLength(3);
    complete.review = review;
    await json(manifestPath, complete);
    set.images.logo = urls[0] as string;
    const changed = await prepareAssets({
      baseline,
      outputDir: root,
      origin: "https://cards.example.test",
    });
    expect(changed.review.approved).toBe(false);
    expect(changed.entries).toHaveLength(2);
    changed.review = review;
    await json(manifestPath, changed);
    const entry = changed.entries[0];
    if (!entry) throw new Error("Fixture asset missing");
    await Bun.write(
      join(root, "assets", entry.file),
      new Uint8Array([...png, 0]),
    );
    const invalid = await prepareAssets({
      baseline,
      outputDir: root,
      origin: "https://cards.example.test",
    });
    expect(invalid.review.approved).toBe(false);
    expect(invalid.missing).toHaveLength(2);
  });
  test("does not fetch by default; verifies acquisition/publication bytes without approving review", async () => {
    const { root, baseline } = await fixture();
    let calls = 0;
    const network = (async () => {
      calls++;
      return new Response(png);
    }) as unknown as typeof fetch;
    const empty = await prepareAssets({
      baseline,
      outputDir: root,
      origin: "https://cards.example.test",
      fetch: network,
    });
    expect(calls).toBe(0);
    expect(empty.missing).toEqual([sourceImage]);
    const assets = await prepareAssets({
      baseline,
      outputDir: root,
      origin: "https://cards.example.test",
      fetch: network,
      allowNetwork: true,
    });
    expect(calls).toBe(1);
    expect(assets.entries[0]?.key).toBe(`assets/sha256/${sha256(png)}.png`);
    expect(assets.review.approved).toBe(false);
    const manifestPath = join(root, "assets/manifest.json");
    const verified = await verifyPublishedAssets(manifestPath, {
      fetch: network,
    });
    expect(verified.entries[0]?.published?.sha256).toBe(sha256(png));
    expect(verified.review.approved).toBe(false);
    await expect(
      verifyPublishedAssets(manifestPath, {
        fetch: (async () =>
          new Response(new Uint8Array([...png, 0]))) as unknown as typeof fetch,
      }),
    ).rejects.toThrow("checksum mismatch");
  });
  test("rejects traversal, key/hash disagreement and non-origin asset URLs", () => {
    expect(() => safeAssetFile(directory(), "../secret")).toThrow("Unsafe");
    expect(() =>
      normalizeAssetOrigin("https://cards.example.test/private"),
    ).toThrow("pure HTTPS");
    expect(() =>
      parseAssetManifest({
        schemaVersion: 1,
        origin: null,
        review: { approved: false, reviewedBy: null, reviewedAt: null },
        missing: [],
        entries: [
          {
            sourceUrl: sourceImage,
            key: `assets/sha256/${"a".repeat(64)}.png`,
            file: `sha256/${"b".repeat(64)}.png`,
            sha256: "a".repeat(64),
            contentType: "image/png",
            published: null,
          },
        ],
      }),
    ).toThrow("canonical content-addressed");
  });
});
