/** @module build_client Builds separate browser, Bun, Node, and shared-contract entries. */
import { buildPackage } from "../../scripts/build-package";

// The browser/default entries must never pull in a native SQLite driver.
await buildPackage(import.meta.dir, [
  { name: "index", target: "browser" },
  { name: "bun", target: "bun" },
  { name: "node", target: "node" },
  { name: "browser", target: "browser" },
  { name: "schema", target: "browser" },
  { name: "query", target: "browser" },
  { name: "sqlite-schema", target: "browser" },
]);
