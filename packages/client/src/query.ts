/** @module query_semantics Shares filtering, ordering, and pagination across runtimes. */
import { z } from "zod";
import { TCGError } from "./errors.js";
import type { Card, CardSet, SearchEntry } from "./schema.js";
import { setIdentifierSchema } from "./schema.js";

// A limit bounds one page, not the total number yielded by iteration.
const pageFields = {
  limit: z.number().int().min(1).max(250).default(50),
  offset: z.number().int().nonnegative().default(0),
  sort: z.enum(["releaseDate", "name", "number"]).default("releaseDate"),
  direction: z.enum(["asc", "desc"]).optional(),
};
const filter = z.string().min(1).max(500);
/** Literal filters combine with AND; text is not a query-language expression. */
export const cardQuerySchema = z
  .object({
    ...pageFields,
    name: filter.optional(),
    setId: setIdentifierSchema.optional(),
    type: filter.optional(),
    supertype: z.enum(["Pokémon", "Trainer", "Energy"]).optional(),
    subtype: filter.optional(),
    rarity: filter.optional(),
    regulationMark: filter.optional(),
    text: z.string().max(2000).optional(),
  })
  .strict();
/** Set name substring and exact series filter with the same page controls. */
export const setQuerySchema = z
  .object({
    ...pageFields,
    name: filter.optional(),
    series: filter.optional(),
  })
  .strict();
/** Caller input before page defaults are applied. */
export type CardQuery = z.input<typeof cardQuerySchema>;
/** Adapter input with validated bounds and explicit page defaults. */
export type NormalizedCardQuery = z.output<typeof cardQuerySchema>;
/** Caller input for set listing. */
export type SetQuery = z.input<typeof setQuerySchema>;
/** Adapter input for set listing after validation. */
export type NormalizedSetQuery = z.output<typeof setQuerySchema>;
/** One slice of a stable snapshot; total counts every matching record. */
export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
}

/** Validate card filters and supply defaults; invalid input is never an empty result. */
export function normalizeCardQuery(query: CardQuery = {}): NormalizedCardQuery {
  const parsed = cardQuerySchema.safeParse(query);
  if (!parsed.success)
    throw new TCGError("INVALID_QUERY", "Invalid card query", {
      cause: parsed.error,
    });
  return parsed.data;
}
/** Validate set filters and supply defaults. */
export function normalizeSetQuery(query: SetQuery = {}): NormalizedSetQuery {
  const parsed = setQuerySchema.safeParse(query);
  if (!parsed.success)
    throw new TCGError("INVALID_QUERY", "Invalid set query", {
      cause: parsed.error,
    });
  return parsed.data;
}
/** Fold accents, case, apostrophes, and whitespace without changing display text. */
export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’‘]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
/** Sort digit runs naturally while retaining letters and punctuation in the key. */
export function collectorNumberKey(value: string): string {
  return normalizeSearchText(value).replace(/\d+/g, (part) => {
    // Equal numeric values share a key; the canonical ID breaks remaining ties.
    const digits = part.replace(/^0+(?=\d)/, "");
    return `${digits.length.toString().padStart(4, "0")}:${digits}`;
  });
}
/** Use fixed lexical comparison, independent of the machine's locale. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
/** Derive the same searchable fields used in browser JSON and SQLite columns. */
export function toSearchEntry(card: Card, set: CardSet): SearchEntry {
  return {
    id: card.id,
    setId: card.setId,
    name: card.name,
    number: card.number,
    supertype: card.supertype,
    types: [...card.types],
    subtypes: [...card.subtypes],
    rarity: card.rarity,
    regulationMark: card.regulationMark,
    releaseDate: set.releaseDate ?? "",
    normalizedName: normalizeSearchText(card.name),
    numberKey: collectorNumberKey(card.number),
    text: normalizeSearchText(
      [
        card.name,
        ...card.rules,
        ...card.attacks.flatMap((attack) => [attack.name, attack.text ?? ""]),
        ...card.abilities.flatMap((ability) => [
          ability.name,
          ability.text ?? "",
        ]),
        card.ancientTrait?.name ?? "",
        card.ancientTrait?.text ?? "",
      ].join(" "),
    ),
  };
}
/** Apply exact metadata membership and require every normalized text term. */
export function matchesCard(
  entry: SearchEntry,
  query: NormalizedCardQuery,
): boolean {
  if (
    query.name !== undefined &&
    !entry.normalizedName.includes(normalizeSearchText(query.name))
  )
    return false;
  if (query.setId !== undefined && entry.setId !== query.setId) return false;
  if (query.type !== undefined && !entry.types.includes(query.type))
    return false;
  if (query.subtype !== undefined && !entry.subtypes.includes(query.subtype))
    return false;
  if (query.supertype !== undefined && entry.supertype !== query.supertype)
    return false;
  if (query.rarity !== undefined && entry.rarity !== query.rarity) return false;
  if (
    query.regulationMark !== undefined &&
    entry.regulationMark !== query.regulationMark
  )
    return false;
  return normalizeSearchText(query.text ?? "")
    .split(" ")
    .filter(Boolean)
    .every((term) => entry.text.includes(term));
}
/** Apply the selected order, then natural collector number and canonical ID. */
export function compareEntries(
  a: SearchEntry,
  b: SearchEntry,
  query: NormalizedCardQuery,
): number {
  // Newest releases lead by default; explicit name and number sorts ascend.
  const direction =
    query.direction ?? (query.sort === "releaseDate" ? "desc" : "asc");
  const primary =
    query.sort === "name"
      ? compareText(a.normalizedName, b.normalizedName)
      : query.sort === "number"
        ? compareText(a.numberKey, b.numberKey)
        : compareText(a.releaseDate, b.releaseDate);
  return (
    primary * (direction === "asc" ? 1 : -1) ||
    compareText(a.numberKey, b.numberKey) ||
    compareText(a.id, b.id)
  );
}
/** Slice already ordered matches without leaking query fields into the page. */
export function paginate<T>(
  items: readonly T[],
  query: { limit: number; offset: number },
): Page<T> {
  return {
    items: items.slice(query.offset, query.offset + query.limit),
    total: items.length,
    limit: query.limit,
    offset: query.offset,
    hasMore: query.offset + query.limit < items.length,
  };
}
/** Share set filtering and sorting; the number sort uses set IDs. */
export function searchSets(
  sets: readonly CardSet[],
  query: NormalizedSetQuery,
): Page<CardSet> {
  const values = sets.filter(
    (set) =>
      (query.name === undefined ||
        normalizeSearchText(set.name).includes(
          normalizeSearchText(query.name),
        )) &&
      (query.series === undefined || set.series === query.series),
  );
  const direction =
    query.direction ?? (query.sort === "releaseDate" ? "desc" : "asc");
  values.sort((a, b) => {
    const primary =
      query.sort === "name"
        ? compareText(normalizeSearchText(a.name), normalizeSearchText(b.name))
        : query.sort === "number"
          ? compareText(a.id, b.id)
          : compareText(a.releaseDate ?? "", b.releaseDate ?? "");
    return primary * (direction === "asc" ? 1 : -1) || compareText(a.id, b.id);
  });
  return paginate(values, query);
}

/** Build equivalent SQLite filters with bound values and fixed column choices. */
export function cardSqlPlan(query: NormalizedCardQuery): {
  where: string;
  orderBy: string;
  parameters: string[];
} {
  // Clause and parameter order must stay aligned for every prepared statement.
  const conditions: string[] = [];
  const parameters: string[] = [];
  const add = (sql: string, value: string) => {
    conditions.push(sql);
    parameters.push(value);
  };
  if (query.name !== undefined)
    add("instr(normalized_name, ?) > 0", normalizeSearchText(query.name));
  if (query.setId !== undefined) add("set_id = ?", query.setId);
  if (query.type !== undefined)
    add(
      "EXISTS (SELECT 1 FROM json_each(cards.types) WHERE value = ?)",
      query.type,
    );
  if (query.subtype !== undefined)
    add(
      "EXISTS (SELECT 1 FROM json_each(cards.subtypes) WHERE value = ?)",
      query.subtype,
    );
  if (query.supertype !== undefined) add("supertype = ?", query.supertype);
  if (query.rarity !== undefined) add("rarity = ?", query.rarity);
  if (query.regulationMark !== undefined)
    add("regulation_mark = ?", query.regulationMark);
  for (const term of normalizeSearchText(query.text ?? "")
    .split(" ")
    .filter(Boolean))
    add("instr(search_text, ?) > 0", term);
  const direction =
    query.direction ?? (query.sort === "releaseDate" ? "desc" : "asc");
  const column =
    query.sort === "name"
      ? "normalized_name"
      : query.sort === "number"
        ? "number_key"
        : "release_date";
  return {
    where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    orderBy: `${column} ${direction.toUpperCase()}, number_key ASC, id ASC`,
    parameters,
  };
}
