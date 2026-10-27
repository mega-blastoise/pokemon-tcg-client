/** @module build_agent Builds the Node/Bun host and its browser-safe shared modules. */
import { buildPackage } from "../../scripts/build-package";

// Protocol, tools, and diagnostics run inside the web GUI, so they stay browser safe.
await buildPackage(import.meta.dir, [
  { name: "index", target: "node" },
  { name: "protocol", target: "browser" },
  { name: "tools", target: "browser" },
  { name: "diagnostics", target: "browser" },
]);
