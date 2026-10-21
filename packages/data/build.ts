/** @module build_data Builds the descriptor without embedding a dataset in JavaScript. */
import { buildPackage } from "../../scripts/build-package";

// The descriptor still reads files through Node APIs; browser callers import its JSON subpath.
await buildPackage(import.meta.dir, [{ name: "index", target: "browser" }]);
