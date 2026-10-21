/** @module packed_smoke Installs real tarballs and checks native/browser package consumers. */
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createFixture } from "../packages/client/test-fixtures.js";
import { verifyRelease } from "./release.js";
import { runBrowserSmoke } from "./smoke-browser.js";
import { stagePackages } from "./stamp-release.js";

/** Run an isolated consumer command with captured output and a fixed deadline. */
async function run(args: string[], cwd: string, env = process.env) {
  const child = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0)
      throw new Error(`${args[0]} failed (${code}): ${stderr || stdout}`);
    return stdout.trim();
  } finally {
    clearTimeout(timer);
  }
}

/** Pack existing files offline without running package lifecycle scripts. */
async function pack(directory: string, output: string, cache: string) {
  const result = JSON.parse(
    await run(
      [
        "npm",
        "pack",
        "--offline",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        output,
      ],
      directory,
      { ...process.env, npm_config_cache: cache },
    ),
  ) as { filename: string }[];
  assert.equal(result.length, 1, "npm pack must produce exactly one package");
  assert.ok(result[0]);
  return join(output, result[0].filename);
}

if (Bun.version !== "1.4.3")
  throw new Error(`Packed smoke requires Bun 1.4.3; found ${Bun.version}`);

const root = resolve(import.meta.dir, "..");
const temporary = await mkdtemp(join(tmpdir(), "tcg-packed-smoke-"));
// An isolated project prevents workspace links from hiding broken published exports.
const consumer = join(temporary, "consumer");
const artifact = join(temporary, "artifacts");
await mkdir(consumer);
await mkdir(artifact);
const fixture = await createFixture();
let version = "1.0.0";
// Package name -> exact archive installed below, including locked runtime dependencies.
const tarballs: Record<string, string> = {};
if (process.env.TCG_RELEASE_DIR) {
  // Release CI tests its downloaded artifacts, not newly rebuilt substitutes.
  const directory = resolve(process.env.TCG_RELEASE_DIR);
  const plan = await verifyRelease(directory);
  assert.equal(
    plan.stream,
    "code",
    "TCG_RELEASE_DIR must contain exact code release artifacts",
  );
  version = plan.version;
  for (const item of plan.packages)
    tarballs[item.name] = resolve(directory, item.file);
} else {
  for (const directory of await stagePackages({
    root,
    output: join(temporary, "code"),
    stream: "code",
    tag: "tcg/v1.0.0",
  })) {
    const manifest = await Bun.file(join(directory, "package.json")).json();
    tarballs[manifest.name] = await pack(
      directory,
      artifact,
      join(temporary, "npm-cache"),
    );
  }
}

// This deliberately tiny test dataset never becomes a canonical release artifact.
const [dataDirectory] = await stagePackages({
  root,
  output: join(temporary, "fixture-data"),
  stream: "data",
  tag: "tcg/data-v1.0.0",
});
assert.ok(dataDirectory);
await mkdir(join(dataDirectory, "data"), { recursive: true });
await cp(
  fixture.databasePath,
  join(dataDirectory, "data/pokemon-data.sqlite3.db"),
);
await cp(fixture.manifestPath, join(dataDirectory, "data/manifest.json"));
const dataManifest = await Bun.file(join(dataDirectory, "package.json")).json();
dataManifest.peerDependencies = { "@johto-ai/tcg-client": version };
await Bun.write(
  join(dataDirectory, "package.json"),
  JSON.stringify(dataManifest),
);
tarballs["@johto-ai/tcg-data"] = await pack(
  dataDirectory,
  artifact,
  join(temporary, "npm-cache"),
);
// Install the already-locked runtime dependencies from local tarballs as well.
// This avoids network access and writes to a user's shared package cache.
for (const name of ["zod", "typescript"]) {
  const packagePath = Bun.resolveSync(
    `${name}/package.json`,
    join(root, "packages/tools"),
  );
  tarballs[name] = await pack(
    dirname(packagePath),
    artifact,
    join(temporary, "npm-cache"),
  );
}
// Check dependency ranges before local overrides force everything to these tarballs.
const packedManifests = new Map<
  string,
  {
    version: string;
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  }
>();
for (const [name, file] of Object.entries(tarballs))
  packedManifests.set(
    name,
    JSON.parse(
      await run(["tar", "-xOf", file, "package/package.json"], consumer),
    ),
  );
for (const [name, manifest] of packedManifests)
  for (const [dependency, range] of Object.entries({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  })) {
    const target = packedManifests.get(dependency);
    assert.ok(
      target,
      `${name} has an unseeded smoke dependency: ${dependency}`,
    );
    assert.ok(
      Bun.semver.satisfies(target.version, range),
      `${name} requires ${dependency}@${range}, not ${target.version}`,
    );
  }
const localDependencies = Object.fromEntries(
  Object.entries(tarballs).map(([name, file]) => [name, `file:${file}`]),
);
await Bun.write(
  join(consumer, "package.json"),
  JSON.stringify({
    private: true,
    type: "module",
    dependencies: localDependencies,
    // Exact local resolution also applies to transitive/peer dependencies.
    // The compatibility assertions above ensure this cannot hide bad ranges.
    overrides: localDependencies,
  }),
);
await run(
  [
    process.execPath,
    "install",
    "--ignore-scripts",
    "--offline",
    "--no-progress",
    "--cache-dir",
    join(temporary, "bun-cache"),
  ],
  consumer,
  { ...process.env, TMPDIR: temporary },
);

// This generated consumer uses public package imports, not repository source paths.
await Bun.write(
  join(consumer, "native.mjs"),
  `import assert from "node:assert/strict";
import { PokemonTCGClient } from "@johto-ai/tcg-client";
import { loadSnapshot } from "@johto-ai/tcg-data";
const client = await PokemonTCGClient.createClientAsync();
try {
  assert.deepEqual(client.snapshot, await loadSnapshot());
  assert.equal((await client.cards.get("old-2")).name, "Pikáchu");
  assert.equal(await client.cards.get("absent-1"), null);
  assert.deepEqual((await client.cards.getMany(["old-2", "absent-1", "old-2"])).map(card => card?.id ?? null), ["old-2", null, "old-2"]);
  assert.deepEqual((await client.cards.search({name:"pikachu"})).items.map(card => card.id), ["new-1", "old-2"]);
  assert.deepEqual((await client.cards.search({setId:"old"})).items.map(card => card.number), ["2", "10", "182a", "R"]);
  assert.equal((await client.sets.list()).total, 2);
  assert.equal(await client.sets.get("absent"), null);
} finally { await client.close(); }
await assert.rejects(client.cards.get("old-2"), {code:"CLIENT_CLOSED"});
console.log(JSON.stringify({runtime:globalThis.Bun ? "bun" : "node", cards:5, sets:2}));
`,
);
// The same JavaScript must select the proper native adapter in both runtimes.
const bun = await run([process.execPath, "native.mjs"], consumer);
const node = await run(
  [process.env.NODE_BINARY ?? "node", "native.mjs"],
  consumer,
);
const tools = await run(
  [
    process.execPath,
    join(consumer, "node_modules/@johto-ai/tcg-tools/dist/cli.js"),
    "--help",
  ],
  consumer,
);
assert.match(tools, /tcg-tools/);
console.log(`Packed native imports: ${bun}; ${node}; tools CLI passed`);
await runBrowserSmoke({
  consumer,
  snapshot: fixture.snapshot,
  files: fixture.files,
});
console.log(`Packed smoke passed; retained diagnostic artifacts: ${temporary}`);
