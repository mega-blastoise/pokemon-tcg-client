/** @module bun_entry Selects Bun-native file access and read-only SQLite for the shared client. */
import { Database } from "bun:sqlite";
import { dirname, resolve } from "node:path";
import { PokemonTCGClient as BaseClient } from "./client.js";
import { TCGError } from "./errors.js";
import { createNativeStore } from "./native-store.js";
import type { StoreFactory } from "./store.js";

/** Separate entry keeps bun:sqlite out of browser builds while retaining the same resources. */
export class PokemonTCGClient extends BaseClient {
  /** Check the minimum Bun version, then supply native operations to the shared store. */
  protected static override readonly createStore: StoreFactory = async (
    options,
  ) => {
    if (
      !globalThis.Bun ||
      Number(Bun.version.split(".")[0]) < 1 ||
      (Number(Bun.version.split(".")[0]) === 1 &&
        (Number(Bun.version.split(".")[1]) < 4 ||
          (Number(Bun.version.split(".")[1]) === 4 &&
            Number(Bun.version.split(".")[2]) < 3)))
    )
      throw new TCGError(
        "UNSUPPORTED_RUNTIME",
        "The Bun adapter requires Bun 1.4.3 or newer",
      );
    return createNativeStore(options, {
      // File bytes are hashed before the read-only connection is opened.
      read: async (path) => new Uint8Array(await Bun.file(path).arrayBuffer()),
      resolveManifestPath: (manifestPath, databasePath) =>
        resolve(dirname(manifestPath), databasePath),
      // These synchronous calls stay behind the uniform async public interface.
      open: (path) => {
        const database = new Database(path, { readonly: true, strict: true });
        return {
          get: (sql, parameters = []) => database.query(sql).get(...parameters),
          all: (sql, parameters = []) => database.query(sql).all(...parameters),
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
