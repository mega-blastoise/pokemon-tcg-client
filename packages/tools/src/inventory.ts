/** @module inventory Validate separate human reviews of card identities and printed information. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type Card,
  type CardSet,
  type Inventory,
  inventorySchema,
  reviewSchema,
  type SourceReference,
  sourceReferenceSchema,
} from "@johto-ai/tcg-client/schema";
import {
  asRecord,
  assertKnownFields,
  normalizeDate,
  sha256,
  stableJSON,
} from "./normalize.js";

/** Printed-field decisions; identity completeness is reviewed in a separate inventory. */
export interface ProvenanceReceipt {
  schemaVersion: 1;
  setId: string;
  review: {
    approved: boolean;
    reviewedBy: string | null;
    reviewedAt: string | null;
  };
  // Missing information stays unresolved until corrected or explicitly judged inapplicable.
  unresolvedRequiredFields: { cardId: string; field: string; reason: string }[];
  inapplicableFields: { cardId: string; field: string; reason: string }[];
  sources: SourceReference[];
}
/** Start generated evidence without implying human approval. */
const unreviewed = () => ({
  approved: false,
  reviewedBy: null,
  reviewedAt: null,
});
/** Identify nullable printed fields that need an explicit human decision when absent. */
function missingPrintedFields(card: Card): ("artist" | "rarity" | "hp")[] {
  const fields: ("artist" | "rarity" | "hp")[] = [];
  if (card.artist === null) fields.push("artist");
  if (card.rarity === null) fields.push("rarity");
  if (card.supertype === "Pokémon" && card.hp === null) fields.push("hp");
  return fields;
}
/** Draft a checklist from current identities without claiming that the source is complete. */
export function createCandidateInventory(
  set: CardSet,
  cards: readonly Card[],
): Inventory {
  return inventorySchema.parse({
    schemaVersion: 1,
    setId: set.id,
    kind: set.completeness.kind,
    cutoff: null,
    expectedIds: cards.map((card) => card.id).sort(),
    sources: set.sources,
    review: unreviewed(),
  });
}
/** Draft unresolved printed-field questions for review rather than inventing missing values. */
export function createCandidateProvenance(
  set: CardSet,
  cards: readonly Card[],
): ProvenanceReceipt {
  return {
    schemaVersion: 1,
    setId: set.id,
    review: unreviewed(),
    unresolvedRequiredFields: cards.flatMap((card) =>
      missingPrintedFields(card).map((field) => ({
        cardId: card.id,
        field,
        reason:
          "Absent in baseline; verify printed information or document inapplicability",
      })),
    ),
    inapplicableFields: [],
    sources: [...set.sources],
  };
}
/** Parse the strict receipt format before trusting any field-review claims. */
export function parseProvenanceReceipt(value: unknown): ProvenanceReceipt {
  const raw = asRecord(value, "provenance receipt");
  assertKnownFields(
    raw,
    [
      "schemaVersion",
      "setId",
      "review",
      "unresolvedRequiredFields",
      "inapplicableFields",
      "sources",
    ],
    "provenance receipt",
  );
  if (raw.schemaVersion !== 1 || typeof raw.setId !== "string")
    throw new Error("Invalid provenance schemaVersion/setId");
  // Both decision lists use the same explicit card/field/reason shape.
  const entries = (field: string) => {
    if (!Array.isArray(raw[field]))
      throw new Error(`provenance.${field}: expected an array`);
    return raw[field].map((value: unknown) => {
      const entry = asRecord(value, `provenance.${field}`);
      assertKnownFields(
        entry,
        ["cardId", "field", "reason"],
        `provenance.${field}`,
      );
      for (const key of ["cardId", "field", "reason"])
        if (typeof entry[key] !== "string" || !(entry[key] as string).trim())
          throw new Error(
            `provenance.${field}.${key}: expected a nonempty string`,
          );
      return entry as { cardId: string; field: string; reason: string };
    });
  };
  if (!Array.isArray(raw.sources))
    throw new Error("provenance.sources: expected an array");
  return {
    schemaVersion: 1,
    setId: raw.setId,
    review: reviewSchema.parse(raw.review),
    unresolvedRequiredFields: entries("unresolvedRequiredFields"),
    inapplicableFields: entries("inapplicableFields"),
    sources: raw.sources.map((source: unknown) =>
      sourceReferenceSchema.parse(source),
    ),
  };
}

/** Require approval to identify both its reviewer and an unambiguous review time. */
export function reviewIssues(
  review: Inventory["review"],
  label: string,
): string[] {
  const issues: string[] = [];
  if (!review.approved)
    issues.push(`${label}: UNREVIEWED; obtain maintainer approval`);
  if (
    !review.reviewedBy?.trim() ||
    !review.reviewedAt ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      review.reviewedAt,
    ) ||
    Number.isNaN(Date.parse(review.reviewedAt))
  )
    issues.push(
      `${label}: record reviewer and ISO review timestamp with timezone`,
    );
  return issues;
}
/** Check exact identity coverage and, for rolling sets, a reviewed cutoff date. */
export function validateInventory(
  inventory: Inventory,
  set: CardSet,
  cards: readonly Card[],
): string[] {
  const issues = reviewIssues(inventory.review, `${set.id} inventory`);
  if (inventory.setId !== set.id)
    issues.push(`${set.id}: inventory belongs to ${inventory.setId}`);
  if (new Set(inventory.expectedIds).size !== inventory.expectedIds.length)
    issues.push(`${set.id}: inventory contains duplicate identities`);
  // Neither matching totals nor finish variants can substitute for matching card identities.
  const actual = new Set(cards.map((card) => card.id));
  const expected = new Set(inventory.expectedIds);
  const missing = [...expected].filter((id) => !actual.has(id));
  const unexpected = [...actual].filter((id) => !expected.has(id));
  if (missing.length)
    issues.push(
      `${set.id}: missing inventory identities: ${missing.join(", ")}`,
    );
  if (unexpected.length)
    issues.push(
      `${set.id}: unexpected identities outside reviewed inventory: ${unexpected.join(", ")}`,
    );
  // A rolling checklist is complete only for its stated calendar cutoff.
  let validCutoff = true;
  try {
    normalizeDate(inventory.cutoff, `${set.id} inventory cutoff`);
  } catch {
    validCutoff = false;
  }
  if (
    inventory.kind === "rolling" &&
    (!inventory.cutoff ||
      !/^\d{4}-\d{2}-\d{2}$/.test(inventory.cutoff) ||
      !validCutoff)
  )
    issues.push(
      `${set.id}: rolling inventory requires a reviewed ISO cutoff date`,
    );
  if (inventory.kind === "fixed" && inventory.cutoff !== null)
    issues.push(`${set.id}: a fixed inventory must not use a rolling cutoff`);
  if (
    !inventory.sources.length ||
    !inventory.sources.some((source) => source.url || source.id)
  )
    issues.push(`${set.id}: inventory requires supporting checklist evidence`);
  return issues;
}
/** Require resolved printed information and evidence-backed exceptions for absent values. */
export function validateProvenance(
  receipt: ProvenanceReceipt,
  set: CardSet,
  cards: readonly Card[],
): string[] {
  const issues = reviewIssues(receipt.review, `${set.id} printed-field review`);
  if (receipt.setId !== set.id)
    issues.push(`${set.id}: provenance receipt belongs to ${receipt.setId}`);
  if (receipt.unresolvedRequiredFields.length)
    issues.push(
      `${set.id}: unresolved required printed information: ${receipt.unresolvedRequiredFields.map((entry) => `${entry.cardId}.${entry.field}`).join(", ")}`,
    );
  // Receipts may discuss only existing cards and fields in the normalized schema.
  const byId = new Map(cards.map((card) => [card.id, card]));
  for (const item of [
    ...receipt.unresolvedRequiredFields,
    ...receipt.inapplicableFields,
  ]) {
    if (!byId.has(item.cardId))
      issues.push(
        `${set.id}: provenance refers to unknown card ${item.cardId}`,
      );
    else if (!(item.field in (byId.get(item.cardId) as Card)))
      issues.push(
        `${set.id}: provenance refers to unknown field ${item.field}`,
      );
  }
  for (const card of cards)
    for (const field of missingPrintedFields(card)) {
      if (
        card[field] === null &&
        !receipt.inapplicableFields.some(
          (entry) => entry.cardId === card.id && entry.field === field,
        )
      )
        issues.push(
          `${set.id}: ${card.id}.${field} is missing; fill it or document reviewed inapplicability`,
        );
    }
  if (!receipt.sources.length)
    issues.push(`${set.id}: printed-field review requires source evidence`);
  return issues;
}

/** Persisted reviews plus their combined checksum and independently recomputed issues. */
export interface InventoryReview {
  inventories: Inventory[];
  provenance: ProvenanceReceipt[];
  issues: string[];
  hash: string;
}
/** Load committed review evidence, falling back to unapproved drafts with actionable issues. */
export async function loadInventoryReview(options: {
  sourceDir: string;
  inventoriesDir?: string;
  sets: readonly CardSet[];
  cards: readonly Card[];
}): Promise<InventoryReview> {
  const inventories: Inventory[] = [];
  const provenance: ProvenanceReceipt[] = [];
  const issues: string[] = [];
  for (const set of options.sets) {
    const cards = options.cards.filter((card) => card.setId === set.id);
    const inventoryFile = join(
      options.inventoriesDir ?? join(options.sourceDir, "inventories/en"),
      `${set.id}.json`,
    );
    // A missing or malformed review must not turn source-derived candidates into approval.
    let inventory = createCandidateInventory(set, cards);
    if (existsSync(inventoryFile)) {
      try {
        inventory = inventorySchema.parse(await Bun.file(inventoryFile).json());
      } catch (error) {
        issues.push(
          `${set.id}: invalid reviewed inventory ${inventoryFile}: ${String(error)}`,
        );
      }
    } else
      issues.push(`${set.id}: missing reviewed inventory ${inventoryFile}`);
    inventories.push(inventory);
    issues.push(...validateInventory(inventory, set, cards));
    // Printed-field evidence always comes from the pinned fork, not an external inventory override.
    const receiptFile = join(
      options.sourceDir,
      "provenance/en",
      `${set.id}.json`,
    );
    let receipt = createCandidateProvenance(set, cards);
    if (existsSync(receiptFile)) {
      try {
        receipt = parseProvenanceReceipt(await Bun.file(receiptFile).json());
      } catch (error) {
        issues.push(
          `${set.id}: invalid provenance receipt ${receiptFile}: ${String(error)}`,
        );
      }
    } else
      issues.push(
        `${set.id}: missing printed-field review receipt ${receiptFile}`,
      );
    provenance.push(receipt);
    issues.push(...validateProvenance(receipt, set, cards));
  }
  return {
    inventories,
    provenance,
    issues,
    // Bind both review types; diagnostic messages are not part of the evidence identity.
    hash: sha256(stableJSON({ inventories, provenance })),
  };
}
