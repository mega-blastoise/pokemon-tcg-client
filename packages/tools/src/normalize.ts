/** @module normalize Convert source records into the shared schema without inventing facts. */
import { createHash } from "node:crypto";
import {
  type Card,
  type CardSet,
  cardSchema,
  type Inventory,
  type Legalities,
  type SourceReference,
  setSchema,
} from "@johto-ai/tcg-client/schema";

/** Source object whose values still need field-specific validation. */
export type RawRecord = Record<string, unknown>;
/** Evidence attached to each normalized record from its original source file. */
export interface NormalizationContext {
  source: SourceReference;
}
// Explicit field lists make upstream additions fail visibly instead of being discarded.
export const CARD_FIELDS = [
  "id",
  "name",
  "supertype",
  "subtypes",
  "hp",
  "types",
  "level",
  "evolvesFrom",
  "evolvesTo",
  "ancientTrait",
  "rules",
  "abilities",
  "attacks",
  "weaknesses",
  "resistances",
  "retreatCost",
  "convertedRetreatCost",
  "number",
  "artist",
  "rarity",
  "flavorText",
  "nationalPokedexNumbers",
  "legalities",
  "regulationMark",
  "images",
  "tcgplayer",
  "cardmarket",
] as const;
export const SET_FIELDS = [
  "id",
  "name",
  "series",
  "printedTotal",
  "total",
  "legalities",
  "ptcgoCode",
  "releaseDate",
  "updatedAt",
  "images",
] as const;

/** Hash exact text or bytes using the release artifact checksum format. */
export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
/** Sort object keys recursively while preserving meaningful array order. */
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, ordered(item)]),
    );
  return value;
}
/** Produce the same readable JSON bytes for equivalent object key orderings. */
export function stableJSON(value: unknown): string {
  return `${JSON.stringify(ordered(value), null, 2)}\n`;
}
/** Reject non-object source values before accessing their fields. */
export function asRecord(value: unknown, label: string): RawRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label}: expected an object`);
  return value as RawRecord;
}
/** Require an explicit normalization decision for every incoming field. */
export function assertKnownFields(
  record: RawRecord,
  fields: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(record).filter((key) => !fields.includes(key));
  if (unknown.length)
    throw new Error(
      `${label}: unhandled source fields: ${unknown.join(", ")}; extend the normalization contract before importing`,
    );
}
/** Treat an absent optional list as empty and reject other non-array values. */
function list(value: unknown, label: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${label}: expected an array`);
  return value;
}
/** Validate both the shape and allowed fields of a nested source object. */
function nested(
  value: unknown,
  fields: readonly string[],
  label: string,
): RawRecord {
  const record = asRecord(value, label);
  assertKnownFields(record, fields, label);
  return record;
}

/** Source dates without a timezone remain unzoned; do not manufacture UTC. */
export function normalizeDate(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string")
    throw new Error(`${label}: expected a date string`);
  const result = value.replaceAll("/", "-").replace(" ", "T");
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(
      result,
    );
  if (!match)
    throw new Error(`${label}: unsupported date ${JSON.stringify(value)}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // UTC arithmetic checks calendar validity without assigning a timezone to the result.
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days ||
    Number(match[4] ?? 0) > 23 ||
    Number(match[5] ?? 0) > 59 ||
    Number(match[6] ?? 0) > 59
  )
    throw new Error(`${label}: invalid calendar date ${JSON.stringify(value)}`);
  if (match[7] && match[7] !== "Z") {
    const [hours, minutes] = match[7].slice(1).split(":").map(Number);
    if ((hours ?? 0) > 23 || (minutes ?? 0) > 59)
      throw new Error(`${label}: invalid timezone offset`);
  }
  return result;
}

/** Legacy legality flags are retained as reported facts, never promoted to current rulings. */
export function normalizeLegalities(
  value: unknown,
  source: SourceReference,
): Legalities {
  const raw =
    value === undefined || value === null
      ? {}
      : nested(value, ["standard", "expanded", "unlimited"], "legalities");
  // Preserve historical reports separately from the deliberately unknown current status.
  const fact = (format: string) => ({
    status: "unknown" as const,
    reportedStatus: raw[format] ?? null,
    verifiedAt: null,
    source: raw[format] === undefined ? null : source,
  });
  return {
    standard: fact("standard"),
    expanded: fact("expanded"),
    unlimited: fact("unlimited"),
  } as Legalities;
}

/** Preserve card identity and printed fields while validating the normalized public record. */
export function normalizeCard(
  input: unknown,
  setId: string,
  context: NormalizationContext,
): Card {
  const raw = asRecord(input, `card in ${setId}`);
  const label = String(raw.id ?? setId);
  assertKnownFields(raw, CARD_FIELDS, label);
  const images =
    raw.images == null
      ? {}
      : nested(raw.images, ["small", "large"], `${label}.images`);
  // Marketplace links and IDs are retained; price payloads require a separate scope decision.
  const market = (key: string) =>
    raw[key] == null
      ? {}
      : nested(
          raw[key],
          ["id", "productId", "url", "updatedAt", "prices"],
          `${label}.${key}`,
        );
  const tcgplayer = market("tcgplayer");
  const cardmarket = market("cardmarket");
  if (tcgplayer.prices != null || cardmarket.prices != null)
    throw new Error(
      `${label}: pricing payloads need an explicit out-of-scope archival decision; they cannot be silently discarded`,
    );
  // Numeric marketplace IDs become strings, but card IDs and collector numbers stay untouched.
  const marketplaceId = (value: unknown) =>
    value == null ? null : typeof value === "number" ? String(value) : value;
  // HP is numeric in the shared schema; missing HP remains an explicit unknown.
  let hp: number | null = null;
  if (raw.hp != null) {
    if (typeof raw.hp !== "string" || !/^\d+$/.test(raw.hp))
      throw new Error(
        `${label}.hp: expected an unsigned numeric source string`,
      );
    hp = Number(raw.hp);
  }
  // Validate nested source fields before supplying the schema's empty/null defaults.
  const attacks = list(raw.attacks, `${label}.attacks`).map((entry) => {
    const attack = nested(
      entry,
      ["name", "cost", "convertedEnergyCost", "damage", "text"],
      `${label}.attack`,
    );
    return {
      name: attack.name,
      cost: attack.cost ?? [],
      convertedEnergyCost: attack.convertedEnergyCost ?? null,
      damage: attack.damage ?? null,
      text: attack.text ?? null,
    };
  });
  const abilities = list(raw.abilities, `${label}.abilities`).map((entry) => {
    const ability = nested(entry, ["name", "text", "type"], `${label}.ability`);
    return {
      name: ability.name,
      text: ability.text ?? null,
      type: ability.type,
    };
  });
  // Weakness and resistance modifiers stay source strings, including symbols and multipliers.
  const pairs = (field: string) =>
    list(raw[field], `${label}.${field}`).map((entry) =>
      nested(entry, ["type", "value"], `${label}.${field}`),
    );
  const ancientTrait =
    raw.ancientTrait == null
      ? null
      : nested(raw.ancientTrait, ["name", "text"], `${label}.ancientTrait`);
  return cardSchema.parse({
    id: raw.id,
    setId,
    language: "en",
    name: raw.name,
    number: raw.number,
    supertype: raw.supertype,
    subtypes: raw.subtypes ?? [],
    types: raw.types ?? [],
    hp,
    level: raw.level ?? null,
    evolvesFrom: raw.evolvesFrom ?? null,
    evolvesTo: raw.evolvesTo ?? [],
    ancientTrait,
    rules: raw.rules ?? [],
    abilities,
    attacks,
    weaknesses: pairs("weaknesses"),
    resistances: pairs("resistances"),
    retreatCost: raw.retreatCost ?? [],
    convertedRetreatCost: raw.convertedRetreatCost ?? null,
    artist: raw.artist ?? null,
    rarity: raw.rarity ?? null,
    flavorText: raw.flavorText ?? null,
    nationalPokedexNumbers: raw.nationalPokedexNumbers ?? [],
    legalities: normalizeLegalities(raw.legalities, context.source),
    regulationMark: raw.regulationMark ?? null,
    images: { small: images.small ?? null, large: images.large ?? null },
    marketplace: {
      tcgplayerId: marketplaceId(tcgplayer.id ?? tcgplayer.productId),
      tcgplayerUrl: tcgplayer.url ?? null,
      cardmarketId: marketplaceId(cardmarket.id ?? cardmarket.productId),
      cardmarketUrl: cardmarket.url ?? null,
    },
    variants: [],
    sources: [context.source],
  });
}

/** Keep reported totals distinct from actual record counts and reviewed completeness. */
export function normalizeSet(
  input: unknown,
  cardCount: number,
  context: NormalizationContext,
  inventory?: Inventory,
): CardSet {
  const raw = asRecord(input, "set");
  const label = String(raw.id ?? "set");
  assertKnownFields(raw, SET_FIELDS, label);
  const images =
    raw.images == null
      ? {}
      : nested(raw.images, ["symbol", "logo"], `${label}.images`);
  const updatedAt = normalizeDate(raw.updatedAt, `${label}.updatedAt`);
  // Record only an offset actually present in the source timestamp.
  const timezone = updatedAt?.match(/(Z|[+-]\d{2}:\d{2})$/)?.[1] ?? null;
  return setSchema.parse({
    id: raw.id,
    language: "en",
    name: raw.name,
    series: raw.series,
    printedTotal: raw.printedTotal ?? null,
    reportedTotal: raw.total ?? null,
    cardCount,
    ptcgoCode: raw.ptcgoCode ?? null,
    releaseDate: normalizeDate(raw.releaseDate, `${label}.releaseDate`),
    updatedAt,
    updatedAtTimezone: timezone,
    legalities: normalizeLegalities(raw.legalities, context.source),
    images: { symbol: images.symbol ?? null, logo: images.logo ?? null },
    // The name-based kind is a draft hint, never evidence of a complete checklist.
    completeness: {
      kind:
        inventory?.kind ??
        (/promo/i.test(String(raw.name)) ? "rolling" : "fixed"),
      cutoff: inventory?.cutoff ?? null,
      inventoryHash: inventory ? sha256(stableJSON(inventory)) : null,
      reviewed: inventory?.review.approved ?? false,
    },
    sources: [context.source],
  });
}
