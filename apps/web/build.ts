/** @module build_web Builds the browser bundle, static shell, and Bun server. */
import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const dist = resolve(import.meta.dir, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(resolve(dist, "public"), { recursive: true });

// The browser bundle inlines its dependencies and must never reach native code.
const app = await Bun.build({
  entrypoints: [resolve(import.meta.dir, "src/client/main.tsx")],
  outdir: resolve(dist, "public"),
  target: "browser",
  format: "esm",
  conditions: ["browser"],
  naming: "app.js",
  minify: true,
  sourcemap: "linked",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "reject-native-imports",
      setup(builder) {
        builder.onResolve({ filter: /^(?:bun:|node:)/ }, (args) => {
          throw new Error(
            `Native module leaked into the browser bundle: ${args.path}`,
          );
        });
      },
    },
  ],
});
if (!app.success) throw new AggregateError(app.logs, "Browser build failed");
for (const file of ["index.html", "styles.css"])
  await cp(
    resolve(import.meta.dir, "src/client", file),
    resolve(dist, "public", file),
  );

const server = await Bun.build({
  entrypoints: [resolve(import.meta.dir, "src/server.ts")],
  outdir: dist,
  target: "bun",
  format: "esm",
  packages: "external",
  naming: "[name].js",
});
if (!server.success)
  throw new AggregateError(server.logs, "Server build failed");

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
