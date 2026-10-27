/** @module build_cli Builds one executable per runtime from the shared Ink app. */
import { chmod } from "node:fs/promises";
import { resolve } from "node:path";

// Each entry targets its own runtime so the client's conditional export resolves natively.
for (const [name, target] of [
  ["bun", "bun"],
  ["node", "node"],
] as const) {
  const result = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "src", `${name}.ts`)],
    outdir: resolve(import.meta.dir, "dist"),
    target,
    format: "esm",
    packages: "external",
    naming: "[name].js",
  });
  if (!result.success) throw new AggregateError(result.logs, "Build failed");
  await chmod(resolve(import.meta.dir, "dist", `${name}.js`), 0o755);
}
const compiler = Bun.spawn(
  [
    process.execPath,
    resolve(import.meta.dir, "../../node_modules/typescript/bin/tsc"),
    "-p",
    resolve(import.meta.dir, "tsconfig.json"),
  ],
  { stdout: "inherit", stderr: "inherit" },
);
if ((await compiler.exited) !== 0) throw new Error("Type check failed");
