/** @module agent_tools Card tools the model can call, executed against any runtime's client. */
import {
  type Card,
  type CardFormat,
  type CardQuery,
  type CardSet,
  type SetQuery,
  STANDARD_REGULATION_MARKS,
} from "@johto-ai/tcg-client";
import type {
  CardView,
  SetView,
  TCGClient,
  ToolCall,
  ToolOutcome,
} from "./protocol.js";

/** MCP server name; Claude sees each tool as `mcp__tcg__<name>`. */
export const TOOL_SERVER_NAME = "tcg";

/** One tool as advertised over MCP. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// Facet values come from the pinned snapshot; filters are exact and case-sensitive.
const TYPES = [
  "Colorless",
  "Darkness",
  "Dragon",
  "Fairy",
  "Fighting",
  "Fire",
  "Grass",
  "Lightning",
  "Metal",
  "Psychic",
  "Water",
];
const page = {
  limit: {
    type: "integer",
    minimum: 1,
    maximum: 25,
    description: "Page size (default 10).",
  },
  offset: { type: "integer", minimum: 0, description: "Skip this many." },
  direction: { type: "string", enum: ["asc", "desc"] },
};

/** Tool contracts mirror the client's CardQuery/SetQuery so calls stay literal. */
export const toolDefinitions: readonly ToolDefinition[] = [
  {
    name: "search_cards",
    description:
      "Search the card catalog. All filters combine with AND. `name` is an accent/case-insensitive substring. `text` requires every word to appear in the card's name, rules, attack or ability text (use it for effects like 'search your deck'). Other filters are exact matches. Results are newest-first unless `sort` says otherwise; `total` counts every match.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", description: "Substring of the card name." },
        text: {
          type: "string",
          description:
            "Words that must all appear in rules/attack/ability text.",
        },
        setId: {
          type: "string",
          description: "Exact set id such as sv3pt5 or base1 (see list_sets).",
        },
        type: { type: "string", enum: TYPES, description: "Energy type." },
        supertype: { type: "string", enum: ["Pokémon", "Trainer", "Energy"] },
        subtype: {
          type: "string",
          description:
            "Exact subtype, e.g. Basic, Stage 1, Stage 2, ex, EX, GX, V, VMAX, VSTAR, MEGA, Tera, TAG TEAM, Radiant, ACE SPEC, Item, Supporter, Stadium, Pokémon Tool, Special.",
        },
        rarity: {
          type: "string",
          description:
            "Exact rarity, e.g. Common, Uncommon, Rare, Rare Holo, Double Rare, Ultra Rare, Illustration Rare, Special Illustration Rare, Hyper Rare, Rare Secret, Rare Rainbow, Rare Holo V, Rare Holo VMAX, Rare Holo GX, Rare Holo EX, Promo, Shiny Rare, ACE SPEC Rare, Radiant Rare.",
        },
        regulationMark: {
          type: "string",
          description: "Regulation mark letter, D through J.",
        },
        format: {
          type: "string",
          enum: ["standard"],
          description: `Only cards legal in Standard (regulation marks ${STANDARD_REGULATION_MARKS.join(", ")}). The user can also turn this on for every search; results then report \`format\`.`,
        },
        sort: { type: "string", enum: ["releaseDate", "name", "number"] },
        ...page,
      },
    },
  },
  {
    name: "get_cards",
    description:
      "Fetch full records (attacks, abilities, weaknesses, legality, artist, flavor) for up to 20 card ids, in order. Missing ids come back as null.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ids"],
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 20,
        },
      },
    },
  },
  {
    name: "list_sets",
    description:
      "List sets, newest first by default. `name` is a substring; `series` is exact (Scarlet & Violet, Sword & Shield, Sun & Moon, XY, Black & White, Mega Evolution, Base, Neo, ...).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        series: { type: "string" },
        sort: { type: "string", enum: ["releaseDate", "name", "number"] },
        ...page,
      },
    },
  },
  {
    name: "get_set",
    description: "Fetch one set's metadata by exact id.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "string" } },
    },
  },
];

const CARD_FILTERS = [
  "name",
  "text",
  "setId",
  "type",
  "supertype",
  "subtype",
  "rarity",
  "regulationMark",
  "format",
  "sort",
  "direction",
  "limit",
  "offset",
] as const;
const SET_FILTERS = [
  "name",
  "series",
  "sort",
  "direction",
  "limit",
  "offset",
] as const;

/** Copy only known keys; the client's strict schemas reject anything else. */
function pick<T>(input: Record<string, unknown>, keys: readonly string[]): T {
  return Object.fromEntries(
    keys.filter((key) => input[key] !== undefined).map((k) => [k, input[k]]),
  ) as T;
}

/** Shape a set for UIs. */
export function toSetView(set: CardSet): SetView {
  return {
    id: set.id,
    name: set.name,
    series: set.series,
    releaseDate: set.releaseDate,
    cardCount: set.cardCount,
    printedTotal: set.printedTotal,
    ptcgoCode: set.ptcgoCode,
    logo: set.images.logo,
    symbol: set.images.symbol,
  };
}

/** Shape a card for UIs, joining the set name the record itself lacks. */
export function toCardView(card: Card, set: CardSet | null): CardView {
  return {
    id: card.id,
    name: card.name,
    number: card.number,
    setId: card.setId,
    setName: set?.name ?? null,
    series: set?.series ?? null,
    releaseDate: set?.releaseDate ?? null,
    supertype: card.supertype,
    subtypes: [...card.subtypes],
    types: [...card.types],
    hp: card.hp,
    rarity: card.rarity,
    regulationMark: card.regulationMark,
    evolvesFrom: card.evolvesFrom,
    artist: card.artist,
    flavorText: card.flavorText,
    rules: [...card.rules],
    abilities: card.abilities.map((a) => ({ ...a })),
    attacks: card.attacks.map(({ name, cost, damage, text }) => ({
      name,
      cost: [...cost],
      damage,
      text,
    })),
    weaknesses: card.weaknesses.map((w) => ({ ...w })),
    resistances: card.resistances.map((r) => ({ ...r })),
    retreatCost: card.convertedRetreatCost ?? card.retreatCost.length,
    legalities: {
      standard: card.legalities.standard.status,
      expanded: card.legalities.expanded.status,
      unlimited: card.legalities.unlimited.status,
    },
    images: { ...card.images },
  };
}

/** Drop empty fields so the model reads less JSON per card. */
function compact(view: CardView, detailed: boolean) {
  const out: Record<string, unknown> = {
    id: view.id,
    name: view.name,
    set: view.setName,
    number: view.number,
    released: view.releaseDate,
    supertype: view.supertype,
  };
  if (view.subtypes.length) out.subtypes = view.subtypes;
  if (view.types.length) out.types = view.types;
  if (view.hp !== null) out.hp = view.hp;
  if (view.rarity) out.rarity = view.rarity;
  if (view.regulationMark) out.regulationMark = view.regulationMark;
  if (view.evolvesFrom) out.evolvesFrom = view.evolvesFrom;
  if (view.abilities.length)
    out.abilities = view.abilities.map((a) => `${a.name}: ${a.text ?? ""}`);
  if (view.attacks.length)
    out.attacks = view.attacks.map(
      (a) =>
        `${a.name} [${a.cost.join(",")}]${a.damage ? ` ${a.damage}` : ""}${a.text ? ` — ${a.text}` : ""}`,
    );
  if (view.rules.length) out.rules = view.rules;
  if (detailed) {
    out.weaknesses = view.weaknesses;
    out.resistances = view.resistances;
    out.retreatCost = view.retreatCost;
    out.legalities = view.legalities;
    out.artist = view.artist;
    if (view.flavorText) out.flavorText = view.flavorText;
  }
  return out;
}

/** Resolve each distinct set once per call; the client caches the catalog itself. */
async function joinSets(
  client: TCGClient,
  cards: readonly Card[],
  signal: AbortSignal,
): Promise<Map<string, CardSet | null>> {
  const ids = [...new Set(cards.map((card) => card.setId))];
  const sets = await Promise.all(
    ids.map((id) => client.sets.get(id, { signal })),
  );
  return new Map(ids.map((id, index) => [id, sets[index] ?? null]));
}

/** Constraints the user set outside the conversation, applied to every call. */
export interface ToolOptions {
  /** Limit every card search to this format, whatever the model asked for. */
  format?: CardFormat | undefined;
}

/** Run one tool call; client errors become a failed outcome the model can read. */
export async function executeTool(
  client: TCGClient,
  call: Pick<ToolCall, "name" | "input">,
  signal: AbortSignal,
  options: ToolOptions = {},
): Promise<ToolOutcome> {
  const started = performance.now();
  const input = call.input ?? {};
  const done = (outcome: Omit<ToolOutcome, "durationMs">): ToolOutcome => ({
    ...outcome,
    durationMs: Math.round((performance.now() - started) * 10) / 10,
  });
  try {
    switch (call.name) {
      case "search_cards": {
        const query = pick<CardQuery>(input, CARD_FILTERS);
        query.limit ??= 10;
        if (options.format) query.format = options.format;
        const result = await client.cards.search(query, { signal });
        const sets = await joinSets(client, result.items, signal);
        const cards = result.items.map((c) =>
          toCardView(c, sets.get(c.setId) ?? null),
        );
        return done({
          ok: true,
          summary: `${cards.length} of ${result.total} cards${query.format ? ` · ${query.format}` : ""}`,
          cards,
          total: result.total,
          content: JSON.stringify({
            // Tell the model when the user's toggle narrowed a search it did not ask to narrow.
            ...(query.format
              ? {
                  format: query.format,
                  ...(options.format ? { formatSetBy: "user" } : {}),
                }
              : {}),
            total: result.total,
            offset: result.offset,
            hasMore: result.hasMore,
            cards: cards.map((card) => compact(card, false)),
          }),
        });
      }
      case "get_cards": {
        const ids = Array.isArray(input.ids) ? input.ids.map(String) : [];
        const found = await client.cards.getMany(ids.slice(0, 20), { signal });
        const present = found.filter((card): card is Card => card !== null);
        const sets = await joinSets(client, present, signal);
        const cards = present.map((c) =>
          toCardView(c, sets.get(c.setId) ?? null),
        );
        const missing = ids.filter((_, index) => found[index] === null);
        return done({
          ok: true,
          summary: `${cards.length} found${missing.length ? `, ${missing.length} missing` : ""}`,
          cards,
          content: JSON.stringify({
            cards: cards.map((card) => compact(card, true)),
            missing,
          }),
        });
      }
      case "list_sets": {
        const query = pick<SetQuery>(input, SET_FILTERS);
        query.limit ??= 10;
        const result = await client.sets.list(query, { signal });
        const sets = result.items.map(toSetView);
        return done({
          ok: true,
          summary: `${sets.length} of ${result.total} sets`,
          sets,
          total: result.total,
          content: JSON.stringify({
            total: result.total,
            hasMore: result.hasMore,
            sets: sets.map(({ logo: _l, symbol: _s, ...rest }) => rest),
          }),
        });
      }
      case "get_set": {
        const set = await client.sets.get(String(input.id ?? ""), { signal });
        return done({
          ok: true,
          summary: set ? set.name : "not found",
          sets: set ? [toSetView(set)] : [],
          content: JSON.stringify(set ? toSetView(set) : null),
        });
      }
      default:
        return done({
          ok: false,
          summary: "unknown tool",
          content: `Unknown tool ${call.name}`,
          error: { code: "UNKNOWN_TOOL", message: `Unknown tool ${call.name}` },
        });
    }
  } catch (cause) {
    const code =
      typeof cause === "object" && cause && "code" in cause
        ? String(cause.code)
        : "ERROR";
    const message = cause instanceof Error ? cause.message : String(cause);
    return done({
      ok: false,
      summary: `${code}: ${message}`,
      content: `Error ${code}: ${message}`,
      error: { code, message },
    });
  }
}
