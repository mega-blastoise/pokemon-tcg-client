/** @module client_fixtures Builds tiny matching SQLite/JSON datasets without network access. */
import { Database } from "bun:sqlite";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toSearchEntry } from "./src/query.js";
import {
  type Card,
  type CardSet,
  cardSchema,
  type SnapshotManifest,
  setSchema,
} from "./src/schema.js";
import { SQLITE_SCHEMA } from "./src/sqlite-schema.js";
import type { FetchFunction } from "./src/store.js";
import { sha256 } from "./src/validation.js";

// Test data carries no claim about real tournament legality.
const unknown = {
  status: "unknown",
  reportedStatus: null,
  verifiedAt: null,
  source: null,
} as const;
const legalities = { standard: unknown, expanded: unknown, unlimited: unknown };

/** Return valid set metadata with a controllable release date and card count. */
export function fixtureSet(
  id: string,
  count: number,
  date = "2026-01-01",
): CardSet {
  return setSchema.parse({
    id,
    language: "en",
    name: `Set ${id}`,
    series: "Fixture",
    printedTotal: count,
    reportedTotal: count,
    cardCount: count,
    ptcgoCode: null,
    releaseDate: date,
    updatedAt: null,
    updatedAtTimezone: null,
    legalities,
    images: { symbol: null, logo: null },
    completeness: {
      kind: "fixed",
      cutoff: null,
      inventoryHash: "a".repeat(64),
      reviewed: true,
    },
    sources: [],
  });
}

/** Include historical fields, symbols, and text so equality checks cover more than IDs. */
export function fixtureCard(
  setId: string,
  number: string,
  name: string,
  text = "Draw two cards.",
): Card {
  return cardSchema.parse({
    id: `${setId}-${number}`,
    setId,
    language: "en",
    name,
    number,
    supertype: "Pokémon",
    subtypes: ["Basic"],
    types: ["Lightning"],
    hp: 60,
    level: "12",
    evolvesFrom: null,
    evolvesTo: [],
    ancientTrait: null,
    rules: [],
    abilities: [],
    attacks: [
      {
        name: "Think",
        cost: ["Colorless"],
        convertedEnergyCost: 1,
        damage: "10+",
        text,
      },
    ],
    weaknesses: [{ type: "Fighting", value: "×2" }],
    resistances: [{ type: "Metal", value: "-20" }],
    retreatCost: [],
    convertedRetreatCost: 0,
    artist: null,
    rarity: "Common",
    flavorText: null,
    nationalPokedexNumbers: [25],
    legalities,
    regulationMark: "J",
    images: { small: null, large: null },
    marketplace: {
      tcgplayerId: null,
      tcgplayerUrl: null,
      cardmarketId: null,
      cardmarketUrl: null,
    },
    variants: [],
    sources: [],
  });
}

/** Build both storage formats and a fake fetch that records which JSON files were requested. */
export async function createFixture(options: { punctuation?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "tcg-client-fixture-"));
  const databasePath = join(directory, "pokemon-data.sqlite3.db");
  const sets = [fixtureSet("old", 4, "2020-01-01"), fixtureSet("new", 1)];
  // Deliberate input disorder catches lexicographic sorting and unstable pagination.
  const cards = [
    // An older mark and a missing mark keep the Standard format filter honest.
    { ...fixtureCard("old", "10", "Zubat"), regulationMark: "G" },
    fixtureCard("old", "2", "Pikáchu"),
    fixtureCard("old", "182a", "Raichu", "Search your deck."),
    { ...fixtureCard("old", "R", "Red"), regulationMark: null },
    fixtureCard("new", "1", "Pikachu"),
  ];
  if (options.punctuation) {
    sets.push(fixtureSet("ex10", 2, "2005-08-01"));
    cards.push(
      fixtureCard("ex10", "!", "Unown !"),
      fixtureCard("ex10", "?", "Unown ?"),
    );
  }
  const source = { repository: "fixture/data", commit: "a".repeat(40) };
  const counts = { sets: sets.length, cards: cards.length };
  const database = new Database(databasePath);
  database.exec(SQLITE_SCHEMA);
  database.transaction(() => {
    database.query("INSERT INTO snapshot_metadata VALUES (?, ?)").run(
      "identity",
      JSON.stringify({
        schemaVersion: 1,
        dataVersion: "1.0.0",
        source,
        counts,
      }),
    );
    for (const set of sets)
      database
        .query("INSERT INTO sets VALUES (?, ?, ?, ?, ?)")
        .run(
          set.id,
          set.name,
          set.series,
          set.releaseDate ?? "",
          JSON.stringify(set),
        );
    for (const card of cards) {
      const set = sets.find((candidate) => candidate.id === card.setId);
      if (!set) throw new Error("Missing fixture set");
      const entry = toSearchEntry(card, set);
      database
        .query("INSERT INTO cards VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
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
          JSON.stringify(card),
        );
    }
  })();
  database.close();
  // In-memory HTTP bodies use the same normalized records as the database above.
  const files = new Map<string, string>();
  files.set("sets.json", JSON.stringify(sets));
  files.set(
    "search-index.json",
    JSON.stringify(
      cards.map((card) => {
        const set = sets.find((candidate) => candidate.id === card.setId);
        if (!set) throw new Error("Missing fixture set");
        return toSearchEntry(card, set);
      }),
    ),
  );
  for (const set of sets)
    files.set(
      `cards/${set.id}.json`,
      JSON.stringify(cards.filter((card) => card.setId === set.id)),
    );
  const contentHashes: Record<string, string> = {};
  for (const [path, contents] of files)
    contentHashes[path] = await sha256(new TextEncoder().encode(contents));
  const contentManifest = JSON.stringify({
    schemaVersion: 1,
    files: contentHashes,
    counts,
  });
  files.set("manifest.json", contentManifest);
  // Synthetic releaseReady permits runtime tests; it is not a real catalog approval.
  const snapshot: SnapshotManifest = {
    schemaVersion: 1,
    dataVersion: "1.0.0",
    source,
    builder: {
      version: "1.0.0",
      commit: null,
      bunVersion: Bun.version,
      sqliteVersion: "fixture",
    },
    counts,
    inventoryHash: "a".repeat(64),
    database: {
      path: "pokemon-data.sqlite3.db",
      sha256: await sha256(
        new Uint8Array(await Bun.file(databasePath).arrayBuffer()),
      ),
      requiredFeatures: ["json", "strict"],
    },
    browser: {
      baseUrl: `https://raw.githubusercontent.com/${source.repository}/${source.commit}/`,
      manifestPath: "generated/v1/manifest.json",
      manifestSha256: await sha256(new TextEncoder().encode(contentManifest)),
    },
    assets: {
      origin: null,
      manifestPath: "assets/manifest.json",
      manifestSha256: "b".repeat(64),
    },
    releaseReady: true,
    issues: [],
  };
  const manifestPath = join(directory, "manifest.json");
  await Bun.write(manifestPath, JSON.stringify(snapshot));
  // Preserve duplicates so tests can detect wasted requests or broken deduplication.
  const requests: string[] = [];
  const fetcher: FetchFunction = async (input, init) => {
    if (init?.signal?.aborted) throw init.signal.reason;
    const url = String(input);
    const path = url.split("generated/v1/")[1] ?? "";
    requests.push(path);
    const contents = files.get(path);
    return new Response(contents ?? "Missing fixture", {
      status: contents === undefined ? 404 : 200,
    });
  };
  return {
    directory,
    databasePath,
    manifestPath,
    sets,
    cards,
    snapshot,
    files,
    requests,
    fetcher,
  };
}
