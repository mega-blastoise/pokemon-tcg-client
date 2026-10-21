/** @module browser_store Loads and checks commit-pinned JSON without server modules. */
import { z } from "zod";
import { TCGError } from "./errors.js";
import {
  clone,
  combineSignals,
  freeze,
  throwIfAborted,
  withAbort,
} from "./lifecycle.js";
import {
  compareEntries,
  matchesCard,
  type NormalizedCardQuery,
  type NormalizedSetQuery,
  type Page,
  paginate,
  searchSets,
  toSearchEntry,
} from "./query.js";
import {
  type Card,
  type CardSet,
  type ContentManifest,
  cardSchema,
  contentManifestSchema,
  type SearchEntry,
  type SnapshotManifest,
  searchEntrySchema,
  setSchema,
} from "./schema.js";
import type {
  ClientOptions,
  FetchFunction,
  RequestOptions,
  SnapshotStore,
} from "./store.js";
import {
  assertRelativePath,
  checkSchemaVersion,
  parseJson,
  parseRecord,
  parseSnapshot,
  sha256,
} from "./validation.js";

/** One shared download; each caller can cancel its own wait independently. */
type Pending = {
  promise: Promise<unknown>;
  // Abort the download only when no caller still needs it, or the store closes.
  controller: AbortController;
  // Count active callers, not network requests.
  waiters: number;
  // Finished downloads remain cached and must not be aborted during cleanup.
  settled: boolean;
};

/** Per-instance caches cannot mix records from different snapshot commits. */
class BrowserStore implements SnapshotStore {
  readonly snapshot: SnapshotManifest;
  private readonly fetcher: FetchFunction;
  // Closing the store cancels every download, including shared requests.
  private readonly lifetime = new AbortController();
  private readonly initialSignal: AbortSignal | undefined;
  // Raw JSON is cached by relative path and expected content hash.
  private readonly cache = new Map<string, Pending>();
  // Keep validated records separately so repeated lookups do not reparse large arrays.
  private readonly parsed = new Map<string, unknown>();
  // Populated only when search loads the index; direct lookups do not require it.
  private readonly entriesById = new Map<string, SearchEntry>();
  private manifest: ContentManifest | undefined;
  // Directory containing the generated manifest, relative to the pinned repository root.
  private contentRoot = "";
  private closed = false;

  /** Retain one checked descriptor and the caller's optional fetch implementation. */
  constructor(snapshot: SnapshotManifest, options: ClientOptions) {
    this.snapshot = freeze(snapshot);
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.initialSignal = options.signal;
    if (typeof this.fetcher !== "function" || !globalThis.crypto?.subtle)
      throw new TCGError(
        "UNSUPPORTED_RUNTIME",
        "This client requires fetch and Web Crypto",
      );
  }

  /** Verify the small content manifest before allowing any record request. */
  async initialize(): Promise<void> {
    const path = this.snapshot.browser.manifestPath;
    assertRelativePath(path);
    this.contentRoot = path.slice(0, path.lastIndexOf("/") + 1);
    const value = await this.fetchJson(
      path,
      this.snapshot.browser.manifestSha256,
      this.initialSignal,
    );
    checkSchemaVersion(value);
    this.manifest = freeze(
      parseRecord(contentManifestSchema, value, "browser content manifest"),
    );
    if (
      this.manifest.counts.cards !== this.snapshot.counts.cards ||
      this.manifest.counts.sets !== this.snapshot.counts.sets
    ) {
      throw new TCGError(
        "SNAPSHOT_MISMATCH",
        "Browser content counts do not match the selected snapshot",
      );
    }
    for (const file of Object.keys(this.manifest.files))
      assertRelativePath(file);
    if (
      !this.manifest.files["sets.json"] ||
      !this.manifest.files["search-index.json"]
    )
      throw new TCGError(
        "INVALID_DATA",
        "Browser content manifest is missing required files",
      );
  }

  /** Combine client-wide and request cancellation after checking the store is open. */
  private check(signal?: AbortSignal): AbortSignal | undefined {
    if (this.closed)
      throw new TCGError("CLIENT_CLOSED", "The client is closed");
    const combined = combineSignals(this.initialSignal, signal);
    throwIfAborted(combined);
    return combined;
  }

  /** Share downloads, verify exact bytes before parsing, and discard failed cache entries. */
  private async fetchJson(
    path: string,
    expectedHash: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.check(signal);
    // Including the expected hash prevents one path from reusing different content.
    const key = `${path}:${expectedHash}`;
    let pending = this.cache.get(key);
    if (!pending) {
      const controller = new AbortController();
      // Caller cancellation belongs to its wait, not this shared network signal.
      const requestSignal = combineSignals(
        controller.signal,
        this.lifetime.signal,
      );
      const entry: Pending = {
        promise: Promise.resolve(undefined),
        controller,
        waiters: 0,
        settled: false,
      };
      entry.promise = (async () => {
        try {
          const response = await this.fetcher(
            new URL(path, this.snapshot.browser.baseUrl),
            { signal: requestSignal ?? null },
          );
          if (!response.ok)
            throw new TCGError(
              "FETCH_FAILED",
              `Snapshot fetch failed (${response.status}) for ${path}`,
              { status: response.status },
            );
          const bytes = new Uint8Array(await response.arrayBuffer());
          if ((await sha256(bytes)) !== expectedHash)
            throw new TCGError(
              "SNAPSHOT_MISMATCH",
              `Content checksum mismatch for ${path}`,
            );
          let text: string;
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch (cause) {
            throw new TCGError("INVALID_DATA", `Invalid UTF-8 in ${path}`, {
              cause,
            });
          }
          return freeze(parseJson(text, path));
        } catch (cause) {
          if (cause instanceof TCGError) throw cause;
          if (requestSignal?.aborted)
            throw new TCGError(
              "ABORTED",
              "The snapshot request was cancelled",
              { cause },
            );
          throw new TCGError(
            "FETCH_FAILED",
            `Could not fetch snapshot file ${path}`,
            { cause },
          );
        } finally {
          entry.settled = true;
        }
      })();
      this.cache.set(key, entry);
      // A failed or cancelled download must be retryable on a later request.
      void entry.promise.catch(() => {
        if (this.cache.get(key) === entry) this.cache.delete(key);
      });
      pending = entry;
    }
    pending.waiters++;
    try {
      return await withAbort(pending.promise, signal);
    } finally {
      pending.waiters--;
      // Keep a shared fetch alive for other callers; otherwise stop unused work.
      if (pending.waiters === 0 && !pending.settled) {
        pending.controller.abort();
        if (this.cache.get(key) === pending) this.cache.delete(key);
      }
    }
  }

  /** Resolve only files named in the verified manifest and use their recorded hash. */
  private async content(
    path: string,
    options: RequestOptions,
  ): Promise<unknown> {
    const signal = this.check(options.signal);
    const hash = this.manifest?.files[path];
    if (!hash)
      throw new TCGError(
        "INVALID_DATA",
        `Snapshot content manifest does not list ${path}`,
      );
    return this.fetchJson(this.contentRoot + path, hash, signal);
  }

  /** Load the small set catalog once and check its count and unique identities. */
  private async sets(options: RequestOptions): Promise<CardSet[]> {
    const raw = await this.content("sets.json", options);
    const cached = this.parsed.get("sets");
    if (cached) return cached as CardSet[];
    const sets = parseRecord(z.array(setSchema), raw, "set records");
    if (
      sets.length !== this.snapshot.counts.sets ||
      new Set(sets.map((set) => set.id)).size !== sets.length
    )
      throw new TCGError(
        "SNAPSHOT_MISMATCH",
        "Set identities/count do not match the selected snapshot",
      );
    this.parsed.set("sets", freeze(sets));
    return sets;
  }

  /** Load the full search index on demand, never as a prerequisite for direct lookup. */
  private async index(options: RequestOptions): Promise<SearchEntry[]> {
    const raw = await this.content("search-index.json", options);
    const cached = this.parsed.get("index");
    if (cached) return cached as SearchEntry[];
    const index = parseRecord(
      z.array(searchEntrySchema),
      raw,
      "card search index",
    );
    if (
      index.length !== this.snapshot.counts.cards ||
      new Set(index.map((entry) => entry.id)).size !== index.length
    )
      throw new TCGError(
        "SNAPSHOT_MISMATCH",
        "Search identities/count do not match the selected snapshot",
      );
    this.parsed.set("index", freeze(index));
    for (const entry of index) this.entriesById.set(entry.id, entry);
    return index;
  }

  /** Load one set and reject wrong prefixes, duplicate cards, or count mismatches. */
  private async cards(set: CardSet, options: RequestOptions): Promise<Card[]> {
    const raw = await this.content(`cards/${set.id}.json`, options);
    const cached = this.parsed.get(`cards:${set.id}`);
    if (cached) return cached as Card[];
    const cards = parseRecord(z.array(cardSchema), raw, `cards for ${set.id}`);
    if (
      cards.length !== set.cardCount ||
      cards.some(
        (card) => card.setId !== set.id || !card.id.startsWith(`${set.id}-`),
      ) ||
      new Set(cards.map((card) => card.id)).size !== cards.length
    )
      throw new TCGError(
        "SNAPSHOT_MISMATCH",
        `Card identities/count do not match set ${set.id}`,
      );
    this.parsed.set(`cards:${set.id}`, freeze(cards));
    return cards;
  }

  /** Find one card through its set prefix; a missing set or card returns null. */
  async getCard(
    id: string,
    options: RequestOptions = {},
  ): Promise<Card | null> {
    // The canonical set prefix locates one small record file; a lookup does not
    // require downloading the full-catalog search index. Set IDs may contain '-'.
    // The longest prefix distinguishes a set such as old-promo from old.
    const set = (await this.sets(options)).reduce<CardSet | undefined>(
      (selected, candidate) =>
        id.startsWith(`${candidate.id}-`) &&
        (!selected || candidate.id.length > selected.id.length)
          ? candidate
          : selected,
      undefined,
    );
    const card = set
      ? ((await this.cards(set, options)).find(
          (candidate) => candidate.id === id,
        ) ?? null)
      : null;
    // If search already loaded the index, also check its view of this lookup.
    const entry = this.entriesById.get(id);
    if (
      this.parsed.has("index") &&
      (card && set
        ? !entry ||
          JSON.stringify(toSearchEntry(card, set)) !== JSON.stringify(entry)
        : entry !== undefined)
    )
      throw new TCGError(
        "SNAPSHOT_MISMATCH",
        `Search entry does not match card ${id}`,
      );
    return clone(card);
  }

  /** Filter and order the index, then fetch full records only for the result page. */
  async searchCards(
    query: NormalizedCardQuery,
    options: RequestOptions = {},
  ): Promise<Page<Card>> {
    const entries = (await this.index(options))
      .filter((entry) => matchesCard(entry, query))
      .sort((a, b) => compareEntries(a, b, query));
    const page = paginate(entries, query);
    const sets = await this.sets(options);
    // Fetch each page's distinct set once, even when several results share it.
    const bySet = new Map<string, Card[]>();
    await Promise.all(
      [...new Set(page.items.map((entry) => entry.setId))].map(async (id) => {
        const set = sets.find((candidate) => candidate.id === id);
        if (!set)
          throw new TCGError(
            "SNAPSHOT_MISMATCH",
            `Search index references missing set ${id}`,
          );
        bySet.set(id, await this.cards(set, options));
      }),
    );
    // Re-derive each returned search entry so corrupt record/index pairs cannot agree by ID alone.
    const items = page.items.map((entry) => {
      const card = bySet
        .get(entry.setId)
        ?.find((candidate) => candidate.id === entry.id);
      const set = sets.find((candidate) => candidate.id === entry.setId);
      if (
        !card ||
        !set ||
        JSON.stringify(toSearchEntry(card, set)) !== JSON.stringify(entry)
      )
        throw new TCGError(
          "SNAPSHOT_MISMATCH",
          `Search entry does not match card ${entry.id}`,
        );
      return clone(card);
    });
    return { ...page, items };
  }

  /** Return a detached set record, or null when the catalog has no such ID. */
  async getSet(
    id: string,
    options: RequestOptions = {},
  ): Promise<CardSet | null> {
    return clone(
      (await this.sets(options)).find((set) => set.id === id) ?? null,
    );
  }
  /** Use the same set filtering and ordering rules as native storage. */
  async listSets(
    query: NormalizedSetQuery,
    options: RequestOptions = {},
  ): Promise<Page<CardSet>> {
    return clone(searchSets(await this.sets(options), query));
  }
  /** Cancel downloads and release both raw and validated in-memory caches. */
  async close(): Promise<void> {
    this.closed = true;
    this.lifetime.abort();
    this.cache.clear();
    this.parsed.clear();
    this.entriesById.clear();
  }
}

/** Require an explicit pinned descriptor; browser clients never read local package files. */
export async function createBrowserStore(
  options: ClientOptions,
): Promise<SnapshotStore> {
  throwIfAborted(options.signal);
  if (!options.snapshot)
    throw new TCGError(
      "CONFIGURATION",
      "Browser clients require an explicit commit-pinned snapshot descriptor",
    );
  if (options.databasePath || options.manifestPath)
    throw new TCGError(
      "CONFIGURATION",
      "Browser clients cannot open filesystem database or manifest paths",
    );
  const store = new BrowserStore(
    parseSnapshot(options.snapshot, options.allowDraft),
    options,
  );
  try {
    await store.initialize();
    return store;
  } catch (error) {
    // Initialization failure must not leave downloads or cache state alive.
    await store.close();
    throw error;
  }
}
