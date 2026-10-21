/** @module native_store Validates local snapshots and shares read-only SQLite behavior. */
import { TCGError } from "./errors.js";
import { clone, combineSignals, freeze, throwIfAborted } from "./lifecycle.js";
import {
  cardSqlPlan,
  type NormalizedCardQuery,
  type NormalizedSetQuery,
  type Page,
  searchSets,
} from "./query.js";
import {
  type Card,
  type CardSet,
  cardSchema,
  type SnapshotManifest,
  setSchema,
} from "./schema.js";
import { SQLITE_METADATA_KEY } from "./sqlite-schema.js";
import type { ClientOptions, RequestOptions, SnapshotStore } from "./store.js";
import {
  assertRelativePath,
  checkSchemaVersion,
  parseJson,
  parseRecord,
  parseSnapshot,
  sha256,
} from "./validation.js";

/** Small internal database surface; public types never expose Bun or Node connections. */
export interface NativeDatabase {
  get(sql: string, parameters?: readonly (string | number)[]): unknown;
  all(sql: string, parameters?: readonly (string | number)[]): unknown[];
  close(): void;
}
/** Runtime entries supply native file reads, path resolution, and a read-only connection. */
export interface NativeDriver {
  read(path: string): Promise<Uint8Array>;
  resolveManifestPath(manifestPath: string, databasePath: string): string;
  open(path: string): NativeDatabase;
}

/** Optional data package exports, loaded only by the native entry's storage path. */
type DataDescriptor = {
  loadSnapshot?: () => Promise<unknown>;
  snapshot?: unknown;
  databasePath?: string;
  manifestPath?: string;
};
/** Resolve the installed optional data peer without importing it into browser code. */
async function loadDataDescriptor(): Promise<DataDescriptor> {
  const packageName = "@johto-ai/tcg-data";
  try {
    return (await import(packageName)) as DataDescriptor;
  } catch (cause) {
    throw new TCGError(
      "DATA_PACKAGE_MISSING",
      "Install a compatible @johto-ai/tcg-data package, or provide an explicit databasePath and snapshot/manifestPath",
      { cause },
    );
  }
}

/** Narrow untrusted SQLite results before reading their fields. */
function record(value: unknown, description: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TCGError("INVALID_DATA", `Invalid database ${description}`);
  return value as Record<string, unknown>;
}
/** Read the complete public record stored beside the indexed query columns. */
function jsonColumn(value: unknown): unknown {
  const row = record(value, "record");
  if (typeof row.data !== "string")
    throw new TCGError(
      "INVALID_DATA",
      "Database record is missing its JSON payload",
    );
  return parseJson(row.data, "database record");
}
/** Reject missing, negative, or unsafe counts instead of treating them as zero. */
function rowCount(value: unknown): number {
  const count = record(value, "count").count;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
    throw new TCGError("INVALID_DATA", "Invalid database count");
  return count;
}

/** Uniform async methods over native synchronous SQLite calls; queries still block locally. */
class NativeStore implements SnapshotStore {
  readonly snapshot: SnapshotManifest;
  private readonly database: NativeDatabase;
  // Native queries check cancellation before work; they are not interruptible mid-query here.
  private readonly initialSignal: AbortSignal | undefined;
  private closed = false;

  /** Retain a read-only connection and freeze its selected snapshot descriptor. */
  constructor(
    database: NativeDatabase,
    snapshot: SnapshotManifest,
    options: ClientOptions,
  ) {
    this.database = database;
    this.snapshot = freeze(snapshot);
    this.initialSignal = options.signal;
  }

  /** Check embedded identity, declared SQLite capabilities, and actual table counts. */
  initialize(): void {
    try {
      const metadata = record(
        this.database.get("SELECT value FROM snapshot_metadata WHERE key = ?", [
          SQLITE_METADATA_KEY,
        ]),
        "metadata",
      );
      if (typeof metadata.value !== "string")
        throw new TCGError("INVALID_DATA", "Database has no snapshot identity");
      const identity = parseJson(metadata.value, "snapshot identity");
      checkSchemaVersion(identity);
      // The embedded identity excludes the database's own hash to avoid self-reference.
      const expected = {
        schemaVersion: this.snapshot.schemaVersion,
        dataVersion: this.snapshot.dataVersion,
        source: this.snapshot.source,
        counts: this.snapshot.counts,
      };
      const actual = record(identity, "snapshot identity");
      const actualSource = record(actual.source, "snapshot source");
      const actualCounts = record(actual.counts, "snapshot counts");
      if (
        actualSource.repository !== expected.source.repository ||
        actualSource.commit !== expected.source.commit ||
        actual.schemaVersion !== expected.schemaVersion ||
        actual.dataVersion !== expected.dataVersion ||
        actualCounts.cards !== expected.counts.cards ||
        actualCounts.sets !== expected.counts.sets
      ) {
        throw new TCGError(
          "SNAPSHOT_MISMATCH",
          "Database identity does not match the selected snapshot",
        );
      }
      // Reject unknown requirements instead of silently opening a newer schema.
      for (const feature of this.snapshot.database.requiredFeatures) {
        if (feature === "json") {
          if (
            record(
              this.database.get("SELECT json_valid('{}') AS ok"),
              "JSON capability",
            ).ok !== 1
          )
            throw new TCGError(
              "UNSUPPORTED_SCHEMA",
              "SQLite JSON functions are unavailable",
            );
        } else if (feature === "strict") {
          const tables = this.database
            .all("PRAGMA table_list")
            .map((value) => record(value, "table metadata"));
          for (const name of ["cards", "sets", "snapshot_metadata"])
            if (
              !tables.some((table) => table.name === name && table.strict === 1)
            )
              throw new TCGError(
                "UNSUPPORTED_SCHEMA",
                `Missing STRICT table ${name}`,
              );
        } else
          throw new TCGError(
            "UNSUPPORTED_SCHEMA",
            `Unsupported SQLite requirement: ${feature}`,
          );
      }
      if (
        rowCount(this.database.get("SELECT COUNT(*) AS count FROM cards")) !==
          this.snapshot.counts.cards ||
        rowCount(this.database.get("SELECT COUNT(*) AS count FROM sets")) !==
          this.snapshot.counts.sets
      )
        throw new TCGError(
          "SNAPSHOT_MISMATCH",
          "Database counts do not match the selected snapshot",
        );
    } catch (cause) {
      this.fail(cause);
    }
  }

  /** Reject closed or cancelled operations before issuing synchronous SQL. */
  private check(options: RequestOptions): void {
    if (this.closed)
      throw new TCGError("CLIENT_CLOSED", "The client is closed");
    throwIfAborted(combineSignals(this.initialSignal, options.signal));
  }
  /** Preserve typed data errors and wrap native SQLite failures consistently. */
  private fail(cause: unknown): never {
    if (cause instanceof TCGError) throw cause;
    throw new TCGError("DATABASE_FAILED", "The SQLite operation failed", {
      cause,
    });
  }
  /** Fetch one canonical card; only an absent database row becomes null. */
  async getCard(
    id: string,
    options: RequestOptions = {},
  ): Promise<Card | null> {
    this.check(options);
    try {
      const row = this.database.get("SELECT data FROM cards WHERE id = ?", [
        id,
      ]);
      if (row === null || row === undefined) return null;
      const card = parseRecord(cardSchema, jsonColumn(row), "card record");
      if (card.id !== id)
        throw new TCGError(
          "SNAPSHOT_MISMATCH",
          `Database ID does not match card ${id}`,
        );
      return card;
    } catch (cause) {
      this.fail(cause);
    }
  }
  /** Count all matches and fetch one page using the shared filters and bound values. */
  async searchCards(
    query: NormalizedCardQuery,
    options: RequestOptions = {},
  ): Promise<Page<Card>> {
    this.check(options);
    try {
      // Count and page use identical filters; only the second statement adds ordering and bounds.
      const plan = cardSqlPlan(query);
      const total = rowCount(
        this.database.get(
          `SELECT COUNT(*) AS count FROM cards ${plan.where}`,
          plan.parameters,
        ),
      );
      const items = this.database
        .all(
          `SELECT data FROM cards ${plan.where} ORDER BY ${plan.orderBy} LIMIT ? OFFSET ?`,
          [...plan.parameters, query.limit, query.offset],
        )
        .map((row) => parseRecord(cardSchema, jsonColumn(row), "card record"));
      return {
        items,
        total,
        limit: query.limit,
        offset: query.offset,
        hasMore: query.offset + query.limit < total,
      };
    } catch (cause) {
      this.fail(cause);
    }
  }
  /** Fetch and validate one set, preserving null for a genuinely missing row. */
  async getSet(
    id: string,
    options: RequestOptions = {},
  ): Promise<CardSet | null> {
    this.check(options);
    try {
      const row = this.database.get("SELECT data FROM sets WHERE id = ?", [id]);
      if (row === null || row === undefined) return null;
      const set = parseRecord(setSchema, jsonColumn(row), "set record");
      if (set.id !== id)
        throw new TCGError(
          "SNAPSHOT_MISMATCH",
          `Database ID does not match set ${id}`,
        );
      return set;
    } catch (cause) {
      this.fail(cause);
    }
  }
  /** Reuse the browser's set-list rules rather than maintaining a second sorter. */
  async listSets(
    query: NormalizedSetQuery,
    options: RequestOptions = {},
  ): Promise<Page<CardSet>> {
    this.check(options);
    try {
      const sets = this.database
        .all("SELECT data FROM sets")
        .map((row) => parseRecord(setSchema, jsonColumn(row), "set record"));
      return clone(searchSets(sets, query));
    } catch (cause) {
      this.fail(cause);
    }
  }
  /** Close the native connection once, including during failed initialization. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.database.close();
    } catch (cause) {
      this.fail(cause);
    }
  }
}

/** Resolve explicit files or the optional data peer, verify bytes, then open read-only. */
export async function createNativeStore(
  options: ClientOptions,
  driver: NativeDriver,
): Promise<SnapshotStore> {
  throwIfAborted(options.signal);
  if (options.databasePath && !options.snapshot && !options.manifestPath)
    throw new TCGError(
      "CONFIGURATION",
      "An explicit databasePath requires a snapshot descriptor or manifestPath",
    );
  // Explicit paths take precedence; a manifest-only selection resolves its sibling database.
  let databasePath = options.databasePath;
  let manifestPath = options.manifestPath;
  let snapshot: unknown = options.snapshot;
  if (!databasePath && !manifestPath) {
    const descriptor = await loadDataDescriptor();
    databasePath = descriptor.databasePath;
    manifestPath = descriptor.manifestPath;
    if (!snapshot) {
      try {
        snapshot = descriptor.loadSnapshot
          ? await descriptor.loadSnapshot()
          : descriptor.snapshot;
      } catch (cause) {
        if (cause instanceof TCGError) throw cause;
        throw new TCGError(
          "CONFIGURATION",
          "The installed data package has no readable snapshot manifest",
          { cause },
        );
      }
    }
  }
  if (!snapshot && manifestPath) {
    try {
      snapshot = parseJson(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await driver.read(manifestPath),
        ),
        "snapshot manifest",
      );
    } catch (cause) {
      if (cause instanceof TCGError) throw cause;
      throw new TCGError(
        "CONFIGURATION",
        `Could not read snapshot manifest ${manifestPath}`,
        { cause },
      );
    }
  }
  const manifest = parseSnapshot(snapshot, options.allowDraft);
  if (!databasePath && manifestPath) {
    assertRelativePath(manifest.database.path);
    databasePath = driver.resolveManifestPath(
      manifestPath,
      manifest.database.path,
    );
  }
  if (!databasePath)
    throw new TCGError(
      "CONFIGURATION",
      "The selected snapshot has no filesystem database path",
    );
  try {
    // Check the whole standalone file before opening any SQLite connection.
    const bytes = await driver.read(databasePath);
    throwIfAborted(options.signal);
    if ((await sha256(bytes)) !== manifest.database.sha256)
      throw new TCGError(
        "SNAPSHOT_MISMATCH",
        "SQLite file checksum does not match the selected snapshot",
      );
    throwIfAborted(options.signal);
    const database = driver.open(databasePath);
    const store = new NativeStore(database, manifest, options);
    try {
      store.initialize();
      return store;
    } catch (cause) {
      await store.close();
      throw cause;
    }
  } catch (cause) {
    if (cause instanceof TCGError) throw cause;
    throw new TCGError(
      "DATABASE_FAILED",
      `Could not open the SQLite snapshot at ${databasePath}`,
      { cause },
    );
  }
}
