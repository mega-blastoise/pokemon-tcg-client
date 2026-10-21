/** @module ingestion_tests Exercises safe parsing, explicit identity maps, and draft review checks. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Inventory } from "@johto-ai/tcg-client/schema";
import { writeJson } from "./src/files.js";
import { validateBatch } from "./src/review.js";
import {
  type Crosswalk,
  convertTCGdexCard,
  importTCGdex,
  parseTCGdexLiteral,
  type RecordValue,
  validateCrosswalk,
} from "./src/tcgdex.js";

// Fictional approval for fixture records only; no production review is generated here.
const review = {
  approved: true,
  reviewedBy: "Fixture maintainer",
  reviewedAt: "2026-10-19T12:00:00Z",
};
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** Build a small provider-shaped record that individual tests can alter. */
function provider(name = "Pikachu"): RecordValue {
  return {
    name: { en: name },
    category: "Pokemon",
    hp: 60,
    stage: "Basic",
    types: ["Lightning"],
    rarity: "Common",
    illustrator: "Fixture artist",
    dexId: [25],
    attacks: [
      {
        name: { en: "Think" },
        cost: ["Colorless"],
        damage: 10,
        effect: { en: "Draw two cards." },
      },
    ],
  };
}
/** Run Git only in a temporary source repository, without shell interpolation. */
async function git(directory: string, args: string[]) {
  const child = Bun.spawn(["git", "-C", directory, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(stderr);
  return stdout.trim();
}
/** Commit synthetic provider files so the importer must read a real pinned Git object. */
async function sourceFixture(options: {
  sourceSetId?: string;
  setId?: string;
  cards: Record<string, RecordValue>;
  mappings: Crosswalk["cards"];
  accepted?: Record<string, unknown>[];
}) {
  const directory = await mkdtemp(join(tmpdir(), "tcg-ingestion-fixture-"));
  temporary.push(directory);
  const sourceDir = join(directory, "source");
  const canonicalDir = join(directory, "canonical");
  const sourceSetId = options.sourceSetId ?? "me01";
  const setId = options.setId ?? "me1";
  // Spaces and '&' occur in actual provider paths and must remain valid literal filenames.
  const sourceDirectory = `data/Mega Evolution & Fixture/${sourceSetId}`;
  await mkdir(join(sourceDir, sourceDirectory), { recursive: true });
  await mkdir(join(canonicalDir, "cards/en"), { recursive: true });
  for (const [number, raw] of Object.entries(options.cards))
    await Bun.write(
      join(sourceDir, sourceDirectory, `${number}.ts`),
      `import type {Card} from '../../types';\nimport Set from './_set';\nconst card: Card = {set: Set, ...unsupported};\nexport default card;`.replace(
        "...unsupported",
        JSON.stringify(raw).slice(1, -1),
      ),
    );
  await git(sourceDir, ["init", "--initial-branch=main"]);
  await git(sourceDir, ["add", "."]);
  await git(sourceDir, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "Synthetic TCGdex fixture",
  ]);
  const commit = await git(sourceDir, ["rev-parse", "HEAD"]);
  await writeJson(
    join(canonicalDir, "cards/en", `${setId}.json`),
    options.accepted ?? [],
  );
  const mapping: Crosswalk = {
    schemaVersion: 1,
    sourceRepository: "tcgdex/cards-database",
    sourceCommit: commit,
    sourceSetId,
    sourceDirectory,
    setId,
    review,
    cards: options.mappings,
  };
  const outputDir = join(directory, "batch");
  const imported = await importTCGdex({
    sourceDir,
    canonicalDir,
    outputDir,
    crosswalk: mapping,
  });
  return { directory, sourceDir, canonicalDir, outputDir, mapping, imported };
}
/** Supply an exact test checklist; rolling promo cases also need a cutoff date. */
function inventory(setId: string, ids: string[], rolling = false): Inventory {
  return {
    schemaVersion: 1,
    setId,
    kind: rolling ? "rolling" : "fixed",
    cutoff: rolling ? "2026-10-19" : null,
    expectedIds: ids,
    sources: [{ kind: "manual", id: "fixture-final-checklist" }],
    review,
  };
}
/** Bind fictional review decisions to this exact proposal, not future edits. */
function resolutions(
  report: Awaited<ReturnType<typeof validateBatch>>,
  decision: "keep-accepted" | "inapplicable" = "inapplicable",
) {
  return [
    ...new Map(
      report.unresolved.map((issue) => [
        `${issue.cardId}:${issue.field}`,
        {
          cardId: issue.cardId,
          field: issue.field,
          decision,
          reason: "Manually checked fixture printed fields",
          evidence: "fixture/image-reviewed",
          proposedHash: report.proposedHash,
        },
      ]),
    ).values(),
  ];
}

describe("safe structured TCGdex ingestion", () => {
  test("literal parser supports typed declarations but never evaluates source expressions", () => {
    const parsed = parseTCGdexLiteral(
      "import Set from './_set'; const card: Card = {set: Set, name: {en: 'Pikachu'}, hp: 60}; export default card",
    );
    expect(parsed.name).toEqual({ en: "Pikachu" });
    expect(parsed).not.toHaveProperty("set");
    for (const source of [
      "export default (() => {throw new Error('executed')})()",
      "Bun.write('/tmp/nope','bad'); export default {}",
      "export default {...other}",
      "export default {['name']: 'Bad'}",
      "export default {__proto__: {polluted: true}}",
      "export default {name:'one',name:'two'}",
    ])
      expect(() => parseTCGdexLiteral(source)).toThrow();
  });

  test("me01 maps explicitly to me1 and retains unknown provider evidence", async () => {
    const raw = provider();
    raw.customPrinting = { stamp: "Fixture stamp" };
    const attacks = raw.attacks as RecordValue[];
    if (attacks[0]) attacks[0].customEffect = "Not silently discarded";
    const fixture = await sourceFixture({
      cards: { "003": raw },
      mappings: [
        { sourceNumber: "003", canonicalId: "me1-3", canonicalNumber: "3" },
      ],
    });
    const record = fixture.imported.records[0];
    expect(record?.candidate.id).toBe("me1-3");
    expect(record?.evidence.providerRecord).toEqual(raw);
    expect(record?.issues.map((issue) => issue.field)).toContain(
      "provider.customPrinting",
    );
    expect(record?.issues.map((issue) => issue.field)).toContain(
      "provider.attacks.0.customEffect",
    );
  });

  test("30th alphabetic identities stay R/G/B rather than becoming numeric", async () => {
    const fixture = await sourceFixture({
      sourceSetId: "30th",
      setId: "me55",
      cards: { R: provider("Red"), G: provider("Green"), B: provider("Blue") },
      mappings: ["R", "G", "B"].map((number) => ({
        sourceNumber: number,
        canonicalId: `me55-${number}`,
        canonicalNumber: number,
      })),
    });
    expect(
      fixture.imported.records.map((record) => record.proposed.id),
    ).toEqual(["me55-R", "me55-G", "me55-B"]);
  });

  test("canonical IDs are independent of printed collector numbers", async () => {
    const raw = provider("Historical identity");
    const accepted = {
      ...convertTCGdexCard(raw, { id: "me55c-106p", number: "106" }).candidate,
    };
    const fixture = await sourceFixture({
      sourceSetId: "30th-c",
      setId: "me55c",
      cards: { "030": raw },
      mappings: [
        {
          sourceNumber: "030",
          canonicalId: "me55c-106p",
          canonicalNumber: "106",
        },
      ],
      accepted: [accepted],
    });
    expect(fixture.imported.records[0]?.id).toBe("me55c-106p");
    expect(fixture.imported.records[0]?.proposed.number).toBe("106");
    await expect(
      importTCGdex({
        sourceDir: fixture.sourceDir,
        canonicalDir: fixture.canonicalDir,
        outputDir: join(fixture.directory, "renumbered"),
        crosswalk: {
          ...fixture.mapping,
          cards: [
            {
              sourceNumber: "030",
              canonicalId: "me55c-106p",
              canonicalNumber: "107",
            },
          ],
        },
      }),
    ).rejects.toThrow("renumber accepted");
  });

  test("removing accepted printed fields is surfaced as a review issue", async () => {
    const raw = provider();
    const accepted = {
      ...convertTCGdexCard(raw, { id: "me1-3", number: "3" }).candidate,
      resistances: [{ type: "Metal", value: "-20" }],
    };
    const fixture = await sourceFixture({
      cards: { "003": raw },
      mappings: [
        { sourceNumber: "003", canonicalId: "me1-3", canonicalNumber: "3" },
      ],
      accepted: [accepted],
    });
    const proposed = await Bun.file(
      join(fixture.outputDir, "proposed-cards.json"),
    ).json();
    delete proposed[0].resistances;
    await writeJson(join(fixture.outputDir, "proposed-cards.json"), proposed);
    const report = await validateBatch(
      fixture.outputDir,
      inventory("me1", ["me1-3"]),
    );
    expect(
      report.unresolved.some(
        (issue) => issue.field === "resistances" && issue.kind === "review",
      ),
    ).toBe(true);
    expect(report.status).toBe("draft");
  });

  test("Classic Collection uses explicit Charizard/Raikou mappings and distinct same-name LEGEND halves", async () => {
    const fixture = await sourceFixture({
      sourceSetId: "30th-c",
      setId: "me55c",
      cards: {
        "001": provider("Charizard"),
        "012": provider("Raikou"),
        "019": provider("Shared LEGEND"),
        "020": provider("Shared LEGEND"),
      },
      mappings: [
        ["001", "4"],
        ["012", "50"],
        ["019", "99"],
        ["020", "100"],
      ].map(([source, canonical]) => ({
        sourceNumber: source ?? "",
        canonicalId: `me55c-${canonical}`,
        canonicalNumber: canonical ?? "",
      })),
    });
    expect(fixture.imported.records.map((record) => record.id)).toEqual([
      "me55c-4",
      "me55c-50",
      "me55c-99",
      "me55c-100",
    ]);
    expect(fixture.imported.records[2]?.candidate.name).toBe(
      fixture.imported.records[3]?.candidate.name,
    );
  });

  test("promo finish variants are retained as evidence and excluded from primary proposals", async () => {
    const variant = provider();
    variant.variants = { reverse: true };
    const fixture = await sourceFixture({
      sourceSetId: "svp",
      setId: "svp",
      cards: { "001": provider(), "001-reverse": variant },
      mappings: [
        { sourceNumber: "001", canonicalId: "svp-1", canonicalNumber: "1" },
        {
          sourceNumber: "001-reverse",
          canonicalId: "svp-1",
          canonicalNumber: "1",
          variantOf: "svp-1",
        },
      ],
    });
    const proposed = await Bun.file(
      join(fixture.outputDir, "proposed-cards.json"),
    ).json();
    expect(proposed.map((card: { id: string }) => card.id)).toEqual(["svp-1"]);
    expect(fixture.imported.records).toHaveLength(2);
    expect(
      fixture.imported.issues.some((issue) => issue.field === "variants"),
    ).toBe(true);
    expect(
      (
        await validateBatch(
          fixture.outputDir,
          inventory("svp", ["svp-1"], true),
        )
      ).status,
    ).toBe("draft");
  });

  test("incorrect stage and absent rule boxes cannot overwrite accepted fork text", async () => {
    const raw = provider("Greninja");
    raw.suffix = "ex";
    const accepted = {
      ...convertTCGdexCard(raw, { id: "me1-3", number: "3" }).candidate,
      subtypes: ["Stage 2", "ex"],
      rules: ["Accepted printed rule box."],
    };
    const fixture = await sourceFixture({
      cards: { "003": raw },
      mappings: [
        { sourceNumber: "003", canonicalId: "me1-3", canonicalNumber: "3" },
      ],
      accepted: [accepted],
    });
    expect(fixture.imported.records[0]?.candidate.subtypes).toEqual([
      "Basic",
      "ex",
    ]);
    expect(fixture.imported.records[0]?.proposed.subtypes).toEqual([
      "Stage 2",
      "ex",
    ]);
    expect(fixture.imported.records[0]?.proposed.rules).toEqual([
      "Accepted printed rule box.",
    ]);
    expect(
      fixture.imported.issues.some(
        (issue) => issue.field === "subtypes" && issue.kind === "conflict",
      ),
    ).toBe(true);
    expect(
      fixture.imported.issues.some((issue) => issue.field === "rules"),
    ).toBe(true);
  });

  test("review requires every mapped identity and a complete inventory", async () => {
    const fixture = await sourceFixture({
      cards: { "003": provider() },
      mappings: [
        { sourceNumber: "003", canonicalId: "me1-3", canonicalNumber: "3" },
      ],
    });
    const report = await validateBatch(
      fixture.outputDir,
      inventory("me1", ["me1-3", "me1-4"]),
    );
    expect(report.status).toBe("draft");
    expect(report.missing).toEqual(["me1-4"]);
    const proposed = await Bun.file(
      join(fixture.outputDir, "proposed-cards.json"),
    ).json();
    proposed[0].id = "me1-999";
    proposed[0].number = "999";
    await writeJson(join(fixture.outputDir, "proposed-cards.json"), proposed);
    const tampered = await validateBatch(
      fixture.outputDir,
      inventory("me1", ["me1-999"]),
    );
    expect(
      tampered.errors.some((error) =>
        error.includes("reviewed primary mapping"),
      ),
    ).toBe(true);
  });

  test("deleting issue summaries cannot remove unresolved source-record issues", async () => {
    const fixture = await sourceFixture({
      cards: { "003": provider() },
      mappings: [
        { sourceNumber: "003", canonicalId: "me1-3", canonicalNumber: "3" },
      ],
    });
    const batch = await Bun.file(join(fixture.outputDir, "batch.json")).json();
    batch.issues = [];
    await writeJson(join(fixture.outputDir, "batch.json"), batch);
    expect(
      (
        await validateBatch(fixture.outputDir, inventory("me1", ["me1-3"]))
      ).unresolved.some((issue) => issue.field === "rules"),
    ).toBe(true);
    batch.records[0].issues = [];
    await writeJson(join(fixture.outputDir, "batch.json"), batch);
    expect(
      (
        await validateBatch(fixture.outputDir, inventory("me1", ["me1-3"]))
      ).unresolved.some((issue) => issue.field === "rules"),
    ).toBe(true);
  });

  test("resolutions bind the reviewed proposal and never approve publication", async () => {
    const fixture = await sourceFixture({
      cards: { "003": provider() },
      mappings: [
        { sourceNumber: "003", canonicalId: "me1-3", canonicalNumber: "3" },
      ],
    });
    const checklist = inventory("me1", ["me1-3"]);
    const report = await validateBatch(fixture.outputDir, checklist);
    await writeJson(
      join(fixture.outputDir, "resolutions.json"),
      resolutions(report),
    );
    const reviewed = await validateBatch(fixture.outputDir, checklist);
    expect(reviewed.status).toBe("ready-for-human-review");
    expect(reviewed).not.toHaveProperty("approved");
    const proposed = await Bun.file(
      join(fixture.outputDir, "proposed-cards.json"),
    ).json();
    proposed[0].name = "Changed after review";
    await writeJson(join(fixture.outputDir, "proposed-cards.json"), proposed);
    const stale = await validateBatch(fixture.outputDir, checklist);
    expect(
      stale.errors.some((error) => error.includes("Stale resolution")),
    ).toBe(true);
    expect(stale.status).toBe("draft");
  });

  test("nested keep-accepted resolution checks values; corrected cannot claim an unchanged field", async () => {
    const raw = provider();
    const accepted = {
      ...convertTCGdexCard(raw, { id: "me1-3", number: "3" }).candidate,
      rules: ["Accepted printed rule."],
    };
    const attacks = raw.attacks as RecordValue[];
    if (attacks[0]) delete attacks[0].name;
    const fixture = await sourceFixture({
      cards: { "003": raw },
      mappings: [
        { sourceNumber: "003", canonicalId: "me1-3", canonicalNumber: "3" },
      ],
      accepted: [accepted],
    });
    const checklist = inventory("me1", ["me1-3"]);
    const report = await validateBatch(fixture.outputDir, checklist);
    const receipts = resolutions(report, "keep-accepted");
    await writeJson(join(fixture.outputDir, "resolutions.json"), receipts);
    expect((await validateBatch(fixture.outputDir, checklist)).errors).toEqual(
      [],
    );
    const nested = receipts.find(
      (receipt) => receipt.field === "attacks.0.name",
    );
    expect(nested).toBeDefined();
    await writeJson(
      join(fixture.outputDir, "resolutions.json"),
      receipts.map((receipt) => ({
        ...receipt,
        decision:
          receipt.field === "attacks.0.name" ? "corrected" : receipt.decision,
      })),
    );
    expect(
      (await validateBatch(fixture.outputDir, checklist)).errors.some((error) =>
        error.includes("did not correct me1-3.attacks.0.name"),
      ),
    ).toBe(true);
  });

  test("reviewed crosswalk cannot silently renumber, duplicate or create a variant identity", async () => {
    const mapping: Crosswalk = {
      schemaVersion: 1,
      sourceRepository: "tcgdex/cards-database",
      sourceCommit: "a".repeat(40),
      sourceSetId: "me01",
      sourceDirectory: "data/Fixture/me01",
      setId: "me1",
      review,
      cards: [
        { sourceNumber: "003", canonicalId: "me1-3", canonicalNumber: "3" },
      ],
    };
    expect(() =>
      validateCrosswalk({
        ...mapping,
        cards: [
          { sourceNumber: "003", canonicalId: "me2-3", canonicalNumber: "3" },
        ],
      }),
    ).toThrow("outside selected set");
    expect(() =>
      validateCrosswalk({
        ...mapping,
        cards: [...mapping.cards, ...mapping.cards],
      }),
    ).toThrow("Duplicate source");
    expect(() =>
      validateCrosswalk({
        ...mapping,
        cards: [
          ...mapping.cards,
          {
            sourceNumber: "003-foil",
            canonicalId: "me1-4",
            canonicalNumber: "4",
            variantOf: "me1-3",
          },
        ],
      }),
    ).toThrow("canonical primary");
    const fixture = await sourceFixture({
      cards: { "003": provider() },
      mappings: mapping.cards,
    });
    await writeJson(join(fixture.outputDir, "crosswalk.json"), {
      ...fixture.mapping,
      review: { ...review, approved: false },
    });
    await expect(
      validateBatch(fixture.outputDir, inventory("me1", ["me1-3"])),
    ).rejects.toThrow("human review receipt");
  });
});
