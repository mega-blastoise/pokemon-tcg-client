/** @module build_tools Builds the Bun maintainer library and executable CLI. */
import { buildPackage } from "../../scripts/build-package";

await buildPackage(import.meta.dir, [
  { name: "index", target: "bun" },
  { name: "cli", target: "bun" },
]);
