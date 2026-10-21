/** @module card_schema Defines the shared card, set, evidence, and snapshot formats. */
import { z } from "zod";

/** Format version checked by every reader; independent of npm package versions. */
export const SCHEMA_VERSION = 1 as const;
/** Lowercase SHA-256 of the exact referenced bytes. */
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
/** Full Git commit; moving branches and short hashes are not snapshot pins. */
export const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
// Historical Unown identities include the printed ! and ? collector numbers.
export const identifierSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._!?-]*$/);
/** Set IDs exclude card-only collector punctuation. */
export const setIdentifierSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const text = z.string();
// Null records an absent value; publication checks distinguish inapplicability from unfinished extraction.
const optionalText = text.nullable();
const nonnegative = z.number().int().nonnegative();
const strings = z.array(text);
const imagesSchema = z
  .object({ small: optionalText, large: optionalText })
  .strict();

/** Evidence carried with a record, including the source version or content hash. */
export const sourceReferenceSchema = z
  .object({
    kind: z.enum(["baseline", "tcgdex", "manual", "ollama", "official"]),
    id: text.optional(),
    url: text.optional(),
    version: text.optional(),
    sha256: sha256Schema.optional(),
    // Retrieval time does not establish that someone verified the source.
    observedAt: text.optional(),
    verifiedAt: optionalText.optional(),
  })
  .strict();

/** Keep a reported source flag separate from a verified legality decision. */
export const legalityFactSchema = z
  .object({
    status: z.enum(["legal", "banned", "not-legal", "unknown"]),
    reportedStatus: optionalText,
    verifiedAt: optionalText,
    source: sourceReferenceSchema.nullable(),
  })
  .strict();
/** Facts by format; unknown is valid and does not mean banned. */
export const legalitiesSchema = z
  .object({
    standard: legalityFactSchema,
    expanded: legalityFactSchema,
    unlimited: legalityFactSchema,
  })
  .strict();

/** Public card record; no live prices or provider-specific response wrappers. */
export const cardSchema = z
  .object({
    // Stable canonical identity, not a provider ID or a parsed collector number.
    id: identifierSchema,
    setId: setIdentifierSchema,
    language: z.literal("en"),
    name: text.min(1),
    // Preserve printed letters, suffixes, punctuation, and leading zeros.
    number: text.min(1),
    supertype: z.enum(["Pokémon", "Trainer", "Energy"]),
    subtypes: strings,
    types: strings,
    // Numeric when present; null when not provided or not applicable.
    hp: nonnegative.nullable(),
    level: optionalText,
    evolvesFrom: optionalText,
    evolvesTo: strings,
    ancientTrait: z.object({ name: text, text }).strict().nullable(),
    rules: strings,
    abilities: z.array(
      z.object({ name: text, text: optionalText, type: text }).strict(),
    ),
    attacks: z.array(
      z
        .object({
          name: text,
          cost: strings,
          convertedEnergyCost: nonnegative.nullable(),
          // Expressions such as 10+ and 20× remain printed strings.
          damage: optionalText,
          text: optionalText,
        })
        .strict(),
    ),
    weaknesses: z.array(z.object({ type: text, value: text }).strict()),
    resistances: z.array(z.object({ type: text, value: text }).strict()),
    retreatCost: strings,
    convertedRetreatCost: nonnegative.nullable(),
    artist: optionalText,
    rarity: optionalText,
    flavorText: optionalText,
    nationalPokedexNumbers: z.array(nonnegative),
    legalities: legalitiesSchema,
    regulationMark: optionalText,
    images: imagesSchema,
    marketplace: z
      .object({
        tcgplayerId: optionalText,
        tcgplayerUrl: optionalText,
        cardmarketId: optionalText,
        cardmarketUrl: optionalText,
      })
      .strict(),
    // Finishes and stamps are optional metadata, not additional primary cards.
    variants: z.array(
      z
        .object({
          id: text,
          finish: optionalText,
          stamp: optionalText,
          images: imagesSchema.nullable(),
          sources: z.array(sourceReferenceSchema),
        })
        .strict(),
    ),
    sources: z.array(sourceReferenceSchema),
  })
  .strict();

/** Human approval receipt; operational gates also check reviewer and timestamp. */
export const reviewSchema = z
  .object({
    approved: z.boolean(),
    reviewedBy: optionalText,
    reviewedAt: optionalText,
  })
  .strict();
/** Reviewed card-identity checklist, final for fixed sets or dated for promos. */
export const inventorySchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    setId: setIdentifierSchema,
    kind: z.enum(["fixed", "rolling"]),
    cutoff: optionalText,
    expectedIds: z.array(identifierSchema).min(1),
    sources: z.array(sourceReferenceSchema),
    review: reviewSchema,
  })
  .strict();

/** Set metadata plus actual card count and reviewed completeness evidence. */
export const setSchema = z
  .object({
    id: setIdentifierSchema,
    language: z.literal("en"),
    name: text.min(1),
    series: text,
    // Source totals are descriptive; neither can prove the identity checklist is complete.
    printedTotal: nonnegative.nullable(),
    reportedTotal: nonnegative.nullable(),
    cardCount: nonnegative,
    ptcgoCode: optionalText,
    releaseDate: optionalText,
    updatedAt: optionalText,
    // Null preserves an unknown source offset rather than manufacturing UTC.
    updatedAtTimezone: optionalText,
    legalities: legalitiesSchema,
    images: z.object({ symbol: optionalText, logo: optionalText }).strict(),
    completeness: z
      .object({
        kind: z.enum(["fixed", "rolling"]),
        cutoff: optionalText,
        inventoryHash: sha256Schema.nullable(),
        reviewed: z.boolean(),
      })
      .strict(),
    sources: z.array(sourceReferenceSchema),
  })
  .strict();

/** Small derived card view used to keep browser and native query results consistent. */
export const searchEntrySchema = z
  .object({
    id: identifierSchema,
    setId: setIdentifierSchema,
    name: text,
    number: text,
    supertype: cardSchema.shape.supertype,
    types: strings,
    subtypes: strings,
    rarity: optionalText,
    regulationMark: optionalText,
    releaseDate: text,
    normalizedName: text,
    // Derived ordering key only; never replaces the displayed collector number.
    numberKey: text,
    text,
  })
  .strict();

/** Hashes relative to the generated browser directory; excludes its own hash. */
export const contentManifestSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    files: z.record(text, sha256Schema),
    counts: z.object({ sets: nonnegative, cards: nonnegative }).strict(),
  })
  .strict();
/** Pins one dataset across SQLite, browser files, inventories, and owned assets. */
export const snapshotManifestSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    dataVersion: text.min(1),
    source: z
      .object({
        repository: text.regex(/^[\w.-]+\/[\w.-]+$/),
        commit: commitSchema,
      })
      .strict(),
    builder: z
      .object({
        version: text,
        commit: optionalText,
        bunVersion: text,
        sqliteVersion: text,
      })
      .strict(),
    counts: z.object({ sets: nonnegative, cards: nonnegative }).strict(),
    inventoryHash: sha256Schema,
    // Hash the finalized standalone database, not a live file with WAL sidecars.
    database: z
      .object({ path: text, sha256: sha256Schema, requiredFeatures: strings })
      .strict(),
    // The client requires baseUrl to contain the exact source repository and commit.
    browser: z
      .object({
        baseUrl: text,
        manifestPath: text,
        manifestSha256: sha256Schema,
      })
      .strict(),
    assets: z
      .object({
        origin: optionalText,
        manifestPath: text,
        manifestSha256: sha256Schema,
      })
      .strict(),
    // Drafts require an explicit client opt-in and are never release approvals.
    releaseReady: z.boolean(),
    issues: strings,
  })
  .strict();

/** Validated public card; nullable fields retain their explicit absence. */
export type Card = z.infer<typeof cardSchema>;
/** Validated set metadata, not the card contents of the set. */
export type CardSet = z.infer<typeof setSchema>;
export type SourceReference = z.infer<typeof sourceReferenceSchema>;
export type LegalityFact = z.infer<typeof legalityFactSchema>;
export type Legalities = z.infer<typeof legalitiesSchema>;
export type Inventory = z.infer<typeof inventorySchema>;
export type SearchEntry = z.infer<typeof searchEntrySchema>;
export type ContentManifest = z.infer<typeof contentManifestSchema>;
export type SnapshotManifest = z.infer<typeof snapshotManifestSchema>;
