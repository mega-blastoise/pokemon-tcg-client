/** @module store_contracts Defines the public options and the private storage boundary. */
import type { NormalizedCardQuery, NormalizedSetQuery, Page } from "./query.js";
import type { Card, CardSet, SnapshotManifest } from "./schema.js";

/** Per-operation controls, combined with the signal passed at client creation. */
export interface RequestOptions {
  readonly signal?: AbortSignal;
}
/** Standard Fetch call signature, without runtime-specific static helpers. */
export type FetchFunction = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
/** Select one immutable snapshot; browser callers must provide its descriptor explicitly. */
export interface ClientOptions {
  /** Explicit descriptor, or the installed data peer's manifest on native runtimes. */
  readonly snapshot?: SnapshotManifest;
  /** Native-only standalone SQLite file; requires compatible snapshot metadata. */
  readonly databasePath?: string;
  /** Native-only manifest file; its relative database path may resolve beside it. */
  readonly manifestPath?: string;
  /** Browser transport override for testing or controlled network access. */
  readonly fetch?: FetchFunction;
  /** Cancels creation and subsequent operations on this client. */
  readonly signal?: AbortSignal;
  /** Maintainer-only opt-in to unpublished snapshots; does not approve them. */
  readonly allowDraft?: boolean;
}
/** Adapter contract; validation, null behavior, and query semantics must match across stores. */
export interface SnapshotStore {
  readonly snapshot: SnapshotManifest;
  getCard(id: string, options?: RequestOptions): Promise<Card | null>;
  searchCards(
    query: NormalizedCardQuery,
    options?: RequestOptions,
  ): Promise<Page<Card>>;
  getSet(id: string, options?: RequestOptions): Promise<CardSet | null>;
  listSets(
    query: NormalizedSetQuery,
    options?: RequestOptions,
  ): Promise<Page<CardSet>>;
  close(): Promise<void>;
}
/** Return only initialized stores whose snapshot identity has already been checked. */
export type StoreFactory = (options: ClientOptions) => Promise<SnapshotStore>;
