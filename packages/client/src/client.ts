/** @module tcg_client Exposes one class-based API over the selected snapshot store. */
import { createBrowserStore } from "./browser-store.js";
import { TCGError } from "./errors.js";
import { combineSignals, throwIfAborted } from "./lifecycle.js";
import {
  type CardQuery,
  normalizeCardQuery,
  normalizeSetQuery,
  type Page,
  type SetQuery,
} from "./query.js";
import {
  type Card,
  type CardSet,
  identifierSchema,
  type SnapshotManifest,
} from "./schema.js";
import type {
  ClientOptions,
  RequestOptions,
  SnapshotStore,
  StoreFactory,
} from "./store.js";

/** Reject invalid lookup keys while accepting historical collector punctuation. */
function validateId(id: string): void {
  if (!identifierSchema.safeParse(id).success)
    throw new TCGError("INVALID_QUERY", "Invalid canonical record ID");
}

/** Card operations always use this client's frozen snapshot. */
export interface CardResource {
  /** Return null only when the canonical card is absent. */
  get(id: string, options?: RequestOptions): Promise<Card | null>;
  /** Preserve input order, duplicate IDs, and null positions for missing cards. */
  getMany(
    ids: readonly string[],
    options?: RequestOptions,
  ): Promise<(Card | null)[]>;
  /** Return a bounded page; valid queries with no matches have empty items. */
  search(query?: CardQuery, options?: RequestOptions): Promise<Page<Card>>;
  /** Walk all matches from offset, loading at most limit records per page. */
  iterate(
    query?: CardQuery,
    options?: RequestOptions,
  ): AsyncIterableIterator<Card>;
}
/** Set lookups and lists share the same snapshot and query defaults as cards. */
export interface SetResource {
  /** Return null when the canonical set is absent. */
  get(id: string, options?: RequestOptions): Promise<CardSet | null>;
  /** Filter and page the set catalog. */
  list(query?: SetQuery, options?: RequestOptions): Promise<Page<CardSet>>;
  /** Walk set pages without changing the selected snapshot. */
  iterate(
    query?: SetQuery,
    options?: RequestOptions,
  ): AsyncIterableIterator<CardSet>;
}

/** Shared resource and lifecycle behavior; isolated runtime entries supply storage. */
export class PokemonTCGClient {
  // The base stays browser safe. Native subclasses override only this factory.
  protected static readonly createStore: StoreFactory = createBrowserStore;
  /** Read-only identity and checksums for the lifetime of this client. */
  readonly snapshot: SnapshotManifest;
  readonly cards: CardResource;
  readonly sets: SetResource;
  private readonly store: SnapshotStore;
  // A creation signal also cancels later requests; per-request signals remain optional.
  private readonly initialSignal: AbortSignal | undefined;
  private closed = false;

  /** Only the async factory constructs clients, after storage validation completes. */
  protected constructor(store: SnapshotStore, options: ClientOptions) {
    this.store = store;
    this.snapshot = store.snapshot;
    this.initialSignal = options.signal;
    this.cards = Object.freeze({
      get: async (id: string, request: RequestOptions = {}) => {
        this.check(request);
        validateId(id);
        return this.store.getCard(id, request);
      },
      getMany: async (ids: readonly string[], request: RequestOptions = {}) => {
        this.check(request);
        if (!Array.isArray(ids))
          throw new TCGError("INVALID_QUERY", "Card IDs must be an array");
        for (const id of ids) validateId(id);
        // Fetch each ID once, then clone each output position so duplicates cannot share mutations.
        const unique = new Map(
          await Promise.all(
            [...new Set(ids)].map(
              async (id) =>
                [id, await this.store.getCard(id, request)] as const,
            ),
          ),
        );
        return ids.map((id) => structuredClone(unique.get(id) ?? null));
      },
      search: async (query: CardQuery = {}, request: RequestOptions = {}) => {
        this.check(request);
        return this.store.searchCards(normalizeCardQuery(query), request);
      },
      iterate: (query: CardQuery = {}, request: RequestOptions = {}) =>
        this.iterateCards(query, request),
    });
    this.sets = Object.freeze({
      get: async (id: string, request: RequestOptions = {}) => {
        this.check(request);
        validateId(id);
        return this.store.getSet(id, request);
      },
      list: async (query: SetQuery = {}, request: RequestOptions = {}) => {
        this.check(request);
        return this.store.listSets(normalizeSetQuery(query), request);
      },
      iterate: (query: SetQuery = {}, request: RequestOptions = {}) =>
        this.iterateSets(query, request),
    });
  }

  /** Select the entry's adapter and finish snapshot checks before returning an instance. */
  static async createClientAsync(
    options: ClientOptions = {},
  ): Promise<PokemonTCGClient> {
    throwIfAborted(options.signal);
    // biome-ignore lint/complexity/noThisInStatic: Each conditional entry supplies its isolated adapter through this subclass.
    return new this(await this.createStore(options), options);
  }

  /** Stop closed or cancelled clients before storage work or another yielded item. */
  private check(options: RequestOptions): void {
    if (this.closed)
      throw new TCGError("CLIENT_CLOSED", "The client is closed");
    throwIfAborted(combineSignals(this.initialSignal, options.signal));
  }

  /** Load successive card pages, checking cancellation between yielded records. */
  private async *iterateCards(
    query: CardQuery,
    options: RequestOptions,
  ): AsyncIterableIterator<Card> {
    this.check(options);
    const normalized = normalizeCardQuery(query);
    // Advance within one snapshot; limit remains the internal page size.
    let offset = normalized.offset;
    while (true) {
      const page = await this.cards.search({ ...normalized, offset }, options);
      for (const card of page.items) {
        this.check(options);
        yield card;
      }
      if (!page.hasMore) return;
      offset += page.limit;
    }
  }
  /** Load successive set pages with the same lifecycle checks as card iteration. */
  private async *iterateSets(
    query: SetQuery,
    options: RequestOptions,
  ): AsyncIterableIterator<CardSet> {
    this.check(options);
    const normalized = normalizeSetQuery(query);
    let offset = normalized.offset;
    while (true) {
      const page = await this.sets.list({ ...normalized, offset }, options);
      for (const set of page.items) {
        this.check(options);
        yield set;
      }
      if (!page.hasMore) return;
      offset += page.limit;
    }
  }
  /** Release storage once; every later resource operation fails with CLIENT_CLOSED. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.store.close();
  }
}
