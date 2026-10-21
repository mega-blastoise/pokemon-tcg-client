/** @module build_package Builds package JavaScript and checks/emits its public types. */
import { resolve } from "node:path";

/** Bundle each runtime entry separately, then emit declarations from the same source. */
export async function buildPackage(
  directory: string,
  entries: readonly { name: string; target: "bun" | "node" | "browser" }[],
): Promise<void> {
  for (const entry of entries) {
    // Keep package dependencies external; runtime entry points select their own built-ins.
    const result = await Bun.build({
      entrypoints: [resolve(directory, "src", `${entry.name}.ts`)],
      outdir: resolve(directory, "dist"),
      target: entry.target,
      format: "esm",
      packages: "external",
      sourcemap: "none",
      naming: "[name].js",
      minify: false,
    });
    if (!result.success) throw new AggregateError(result.logs, "Build failed");
  }
  // Bundling alone does not type-check or produce .d.ts files.
  const compiler = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../node_modules/typescript/bin/tsc"),
      "-p",
      resolve(directory, "tsconfig.json"),
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  if ((await compiler.exited) !== 0)
    throw new Error("Declaration/type check failed");
}
