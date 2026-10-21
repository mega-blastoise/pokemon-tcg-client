/** @module browser_entry Exposes the browser-safe client and its shared public types. */
export {
  type CardResource,
  PokemonTCGClient,
  type SetResource,
} from "./client.js";
export { TCGError, type TCGErrorCode } from "./errors.js";
export type { CardQuery, Page, SetQuery } from "./query.js";
export type { Card, CardSet, SnapshotManifest } from "./schema.js";
export type { ClientOptions, FetchFunction, RequestOptions } from "./store.js";
