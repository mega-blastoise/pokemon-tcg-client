/** @module node_entry Selects Node-native file access and read-only SQLite for the shared client. */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PokemonTCGClient as BaseClient } from "./client.js";
import { TCGError } from "./errors.js";
import { createNativeStore } from "./native-store.js";
import type { StoreFactory } from "./store.js";

/** Keep Node imports out of browser builds; node:sqlite is experimental in the minimum Node version. */
export class PokemonTCGClient extends BaseClient {
  /** Check the minimum Node version and adapt its native APIs to the shared store. */
  protected static override readonly createStore: StoreFactory = async (
    options,
  ) => {
    const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
    if (major < 24 || (major === 24 && minor < 6))
      throw new TCGError(
        "UNSUPPORTED_RUNTIME",
        "The Node adapter requires Node.js 24.6 or newer",
      );
    return createNativeStore(options, {
      // Use Node file APIs rather than assuming Bun globals exist.
      read: async (path) => new Uint8Array(await readFile(path)),
      resolveManifestPath: (manifestPath, databasePath) =>
        resolve(dirname(manifestPath), databasePath),
      // Read-only SQLite calls are synchronous despite the client's async method signatures.
      open: (path) => {
        const database = new DatabaseSync(path, {
          readOnly: true,
          enableForeignKeyConstraints: true,
        });
        return {
          get: (sql, parameters = []) =>
            database.prepare(sql).get(...parameters),
          all: (sql, parameters = []) =>
            database.prepare(sql).all(...parameters),
          close: () => database.close(),
        };
      },
    });
  };
}
export type { CardResource, SetResource } from "./client.js";
export { TCGError, type TCGErrorCode } from "./errors.js";
export {
  CARD_FORMATS,
  type CardFormat,
  type CardQuery,
  type Page,
  type SetQuery,
  STANDARD_REGULATION_MARKS,
} from "./query.js";
export type { Card, CardSet, SnapshotManifest } from "./schema.js";
export type { ClientOptions, FetchFunction, RequestOptions } from "./store.js";
