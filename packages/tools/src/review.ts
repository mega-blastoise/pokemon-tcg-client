/** @module review Check import proposals and prepare evidence for human approval. */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { type Card, inventorySchema } from "@johto-ai/tcg-client/schema";
import { z } from "zod";
import { sha256, stableJson, writeJson } from "./files.js";
import { reviewIssues } from "./inventory.js";
import { normalizeCard, stableJSON } from "./normalize.js";
import {
  convertTCGdexCard,
  crosswalkSchema,
  type ImportIssue,
  type RecordValue,
  validateCrosswalk,
} from "./tcgdex.js";

const issueSchema = z
  .object({
    cardId: z.string(),
    field: z.string(),
    kind: z.enum(["missing", "conflict", "unsupported", "review"]),
    message: z.string(),
  })
  .strict();
/** A field decision is valid only for the exact proposal its hash identifies. */
export const resolutionSchema = z
  .object({
    cardId: z.string(),
    field: z.string(),
    decision: z.enum(["keep-accepted", "corrected", "inapplicable"]),
    reason: z.string().trim().min(1),
    evidence: z.string().trim().min(1),
    proposedHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
/** Draft evidence keeps accepted data separate from provider and proposed values. */
export const batchSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal("draft"),
    source: z
      .object({
        repository: z.literal("tcgdex/cards-database"),
        commit: z.string().regex(/^[a-f0-9]{40}$/),
      })
      .strict(),
    setId: z.string(),
    records: z.array(
      z
        .object({
          id: z.string(),
          accepted: z.record(z.string(), z.unknown()).nullable(),
          candidate: z.record(z.string(), z.unknown()),
          proposed: z.record(z.string(), z.unknown()),
          issues: z.array(issueSchema),
          evidence: z
            .object({
              sourcePath: z.string(),
              sha256: z.string().regex(/^[a-f0-9]{64}$/),
              providerRecord: z.record(z.string(), z.json()),
            })
            .strict(),
        })
        .strict(),
    ),
    issues: z.array(issueSchema),
  })
  .strict();

/** Read an own-property field path without following inherited or unsafe names. */
function fieldAt(
  record: Record<string, unknown> | null | undefined,
  path: string,
): { exists: boolean; value?: unknown } {
  const segments = path.split(".");
  if (
    segments.some(
      (part) =>
        !part || ["__proto__", "prototype", "constructor"].includes(part),
    )
  )
    return { exists: false };
  let value: unknown = record;
  for (const segment of segments) {
    if (
      value === null ||
      typeof value !== "object" ||
      !Object.hasOwn(value, segment)
    )
      return { exists: false };
    value = (value as Record<string, unknown>)[segment];
  }
  return { exists: true, value };
}

/** Recheck mapping, proposal, inventory and decisions without writing or approving data. */
export async function validateBatch(batchDir: string, inventoryInput: unknown) {
  const batch = batchSchema.parse(
    await Bun.file(resolve(batchDir, "batch.json")).json(),
  );
  const mapping = crosswalkSchema.parse(
    await Bun.file(resolve(batchDir, "crosswalk.json")).json(),
  );
  validateCrosswalk(mapping);
  const inventory = inventorySchema.parse(inventoryInput);
  if (
    mapping.setId !== batch.setId ||
    mapping.sourceCommit !== batch.source.commit ||
    inventory.setId !== batch.setId
  )
    throw new Error("Batch/mapping/inventory identities disagree");
  const proposed = z
    .array(z.record(z.string(), z.unknown()))
    .parse(await Bun.file(resolve(batchDir, "proposed-cards.json")).json());
  const resolutionsFile = Bun.file(resolve(batchDir, "resolutions.json"));
  const resolutions = z
    .array(resolutionSchema)
    .parse(
      (await resolutionsFile.exists()) ? await resolutionsFile.json() : [],
    );
  // Editing any proposed record invalidates every decision tied to the old hash.
  const proposedHash = sha256(stableJson(proposed));
  const issues: ImportIssue[] = [
    ...batch.issues,
    ...batch.records.flatMap((record) => record.issues),
  ];
  const cards: Card[] = [];
  const errors: string[] = [];
  // Each reviewed provider file must contribute evidence exactly once.
  const mappedPaths = new Map(
    mapping.cards.map((entry) => [
      `${mapping.sourceDirectory}/${entry.sourceNumber}.ts`,
      entry,
    ]),
  );
  const seenPaths = new Set<string>();
  for (const record of batch.records) {
    const entry = mappedPaths.get(record.evidence.sourcePath);
    if (!entry || seenPaths.has(record.evidence.sourcePath)) {
      errors.push(
        `Unmapped/duplicate source evidence path: ${record.evidence.sourcePath}`,
      );
      continue;
    }
    seenPaths.add(record.evidence.sourcePath);
    if (
      record.id !== entry.canonicalId ||
      record.candidate.id !== entry.canonicalId ||
      record.candidate.number !== entry.canonicalNumber ||
      record.proposed.id !== entry.canonicalId ||
      record.proposed.number !== entry.canonicalNumber
    )
      errors.push(
        `Imported record identity/number disagrees with reviewed crosswalk: ${record.id}`,
      );
    if (
      record.accepted &&
      (record.accepted.id !== entry.canonicalId ||
        record.accepted.number !== entry.canonicalNumber)
    )
      errors.push(
        `Accepted record identity/number disagrees with reviewed crosswalk: ${record.id}`,
      );
    // Recompute suggestions from saved provider data instead of trusting edits to them.
    const regenerated = convertTCGdexCard(
      record.evidence.providerRecord as RecordValue,
      { id: entry.canonicalId, number: entry.canonicalNumber },
      record.accepted,
    );
    issues.push(...regenerated.issues);
    if (stableJSON(record.candidate) !== stableJSON(regenerated.candidate))
      errors.push(
        `Provider evidence/candidate mismatch for ${record.id}; re-import rather than modifying source evidence`,
      );
    if (entry.variantOf)
      issues.push({
        cardId: record.id,
        field: "variants",
        kind: "review",
        message: `Source variant of ${entry.variantOf}; not a separate canonical identity`,
      });
  }
  for (const path of mappedPaths.keys())
    if (!seenPaths.has(path))
      errors.push(`Missing imported source evidence: ${path}`);
  // Variants may support review but cannot become extra canonical card identities.
  const primaries = new Map(
    mapping.cards
      .filter((entry) => !entry.variantOf)
      .map((entry) => [entry.canonicalId, entry]),
  );
  for (const raw of proposed) {
    const entry =
      typeof raw.id === "string" ? primaries.get(raw.id) : undefined;
    if (!entry || raw.number !== entry.canonicalNumber)
      errors.push(
        `Proposed identity/number is not a reviewed primary mapping: ${String(raw.id)}`,
      );
    const accepted = batch.records.find(
      (record) => record.id === raw.id,
    )?.accepted;
    // Even fields outside the provider mapping need evidence before accepted data changes.
    if (accepted)
      for (const field of new Set([
        ...Object.keys(accepted),
        ...Object.keys(raw),
      ]))
        if (stableJSON(raw[field]) !== stableJSON(accepted[field]))
          issues.push({
            cardId: String(raw.id),
            field,
            kind: "review",
            message:
              "Proposed change/removal of accepted data requires explicit correction evidence",
          });
    try {
      cards.push(
        normalizeCard(raw, batch.setId, {
          source: {
            kind: "tcgdex",
            version: batch.source.commit,
            id: String(raw.id),
          },
        }),
      );
    } catch (error) {
      errors.push(
        `${String(raw.id)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  for (const id of primaries.keys())
    if (!proposed.some((raw) => raw.id === id))
      errors.push(`Missing proposed primary mapping: ${id}`);
  const actual = cards.map((card) => card.id);
  if (new Set(actual).size !== actual.length)
    errors.push("Duplicate canonical card identity");
  if (new Set(inventory.expectedIds).size !== inventory.expectedIds.length)
    errors.push("Reviewed inventory contains duplicate identity");
  const missing = inventory.expectedIds.filter((id) => !actual.includes(id));
  const unexpected = actual.filter((id) => !inventory.expectedIds.includes(id));
  if (missing.length)
    errors.push(`Missing inventory identities: ${missing.join(", ")}`);
  if (unexpected.length)
    errors.push(`Unexpected identities: ${unexpected.join(", ")}`);
  errors.push(...reviewIssues(inventory.review, `${batch.setId} inventory`));
  if (
    inventory.kind === "rolling" &&
    (!inventory.cutoff ||
      !/^\d{4}-\d{2}-\d{2}$/.test(inventory.cutoff) ||
      Number.isNaN(Date.parse(inventory.cutoff)))
  )
    errors.push("Rolling promo inventory needs an explicit ISO cutoff");
  if (inventory.kind === "fixed" && inventory.cutoff !== null)
    errors.push("Fixed inventory cannot use a rolling cutoff");
  if (!inventory.sources.some((source) => source.url || source.id))
    errors.push("Inventory requires checklist evidence");
  // One field decision can address repeated reports, but not an unrelated field.
  const uniqueIssues = new Map(
    issues.map((issue) => [
      `${issue.cardId}:${issue.field}:${issue.kind}`,
      issue,
    ]),
  );
  const resolved = new Set<string>();
  const seenResolutions = new Set<string>();
  for (const resolution of resolutions) {
    const key = `${resolution.cardId}:${resolution.field}`;
    const label = `${resolution.cardId}.${resolution.field}`;
    const found = [...uniqueIssues.values()].some(
      (issue) =>
        issue.cardId === resolution.cardId && issue.field === resolution.field,
    );
    if (!found) {
      errors.push(`Resolution refers to unknown issue ${label}`);
      continue;
    }
    if (seenResolutions.has(key)) {
      errors.push(`Duplicate resolution for ${label}`);
      continue;
    }
    seenResolutions.add(key);
    if (resolution.proposedHash !== proposedHash) {
      errors.push(
        `Stale resolution for ${label}; proposedHash does not match current proposed data`,
      );
      continue;
    }
    const original = batch.records.find(
      (record) => record.id === resolution.cardId,
    )?.accepted;
    const current = proposed.find((record) => record.id === resolution.cardId);
    // Check the decision against values, not just its stated reason and evidence.
    const before = fieldAt(original, resolution.field);
    const after = fieldAt(current, resolution.field);
    if (resolution.decision === "keep-accepted") {
      if (
        !before.exists ||
        !after.exists ||
        stableJSON(after.value) !== stableJSON(before.value)
      ) {
        errors.push(`keep-accepted resolution changed/missing ${label}`);
        continue;
      }
    } else if (resolution.decision === "corrected") {
      if (
        !after.exists ||
        (before.exists && stableJSON(after.value) === stableJSON(before.value))
      ) {
        errors.push(`corrected resolution did not correct ${label}`);
        continue;
      }
    }
    resolved.add(key);
  }
  const unresolved = [...uniqueIssues.values()].filter(
    (issue) => !resolved.has(`${issue.cardId}:${issue.field}`),
  );
  return {
    schemaVersion: 1,
    status:
      errors.length || unresolved.length ? "draft" : "ready-for-human-review",
    setId: batch.setId,
    counts: { cards: cards.length },
    missing,
    unexpected,
    unresolved,
    errors,
    proposedHash,
    cards,
    resolutions,
    inventory,
  };
}

/** Write a fresh review packet with approval unset; canonical data remains untouched. */
export async function prepareReview(
  batchDir: string,
  inventoryInput: unknown,
  outputDir: string,
) {
  const report = await validateBatch(batchDir, inventoryInput);
  await mkdir(dirname(resolve(outputDir)), { recursive: true });
  await mkdir(outputDir, { recursive: false });
  await writeJson(resolve(outputDir, "report.json"), report);
  await writeJson(resolve(outputDir, "provenance-import.json"), {
    schemaVersion: 1,
    batchHash: sha256(await Bun.file(resolve(batchDir, "batch.json")).text()),
    proposedHash: report.proposedHash,
    resolutions: report.resolutions,
    review: { approved: false, reviewedBy: null, reviewedAt: null },
  });
  await writeFile(
    resolve(outputDir, "review.md"),
    `# ${report.setId} import review\n\nStatus: ${report.status}. No canonical data was changed.\n\n- Cards: ${report.counts.cards}\n- Missing identities: ${report.missing.length}\n- Unexpected identities: ${report.unexpected.length}\n- Unresolved issues: ${report.unresolved.length}\n- Validation errors: ${report.errors.length}\n- Proposed data SHA-256: ${report.proposedHash}\n\nInspect batch.json (accepted/candidate differences and source hashes), proposed-cards.json, crosswalk.json, resolutions.json, and report.json. Check printed fields and complete checklist evidence. Copy accepted changes into a reviewed fork branch; commit regenerated browser files with them. A separate exact-commit data release still requires approved inventories, printed-field receipts, and owned assets.\n`,
  );
  return report;
}

/** Plan a draft PR for an existing fork branch; only execute when explicitly requested. */
export async function submitDraftPR(options: {
  branch: string;
  title: string;
  bodyFile: string;
  execute?: boolean;
}) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]+$/.test(options.branch) ||
    options.branch.includes("..")
  )
    throw new Error("Invalid source branch");
  // Submission does not create, commit or push the branch, and never merges it.
  const command = [
    "gh",
    "pr",
    "create",
    "--repo",
    "mega-blastoise/pokemon-tcg-data",
    "--head",
    options.branch,
    "--title",
    options.title,
    "--body-file",
    resolve(options.bodyFile),
    "--draft",
  ];
  if (!options.execute) return { dryRun: true, command };
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(`Draft PR submission failed: ${stderr.trim()}`);
  return { dryRun: false, url: stdout.trim() };
}
