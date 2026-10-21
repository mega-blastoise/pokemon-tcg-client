/** @module release_tests Checks real archive bytes and release refusal paths without publishing. */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyRelease } from "../scripts/release.js";
import {
  parseReleaseTag,
  stagePackages,
  stampManifest,
} from "../scripts/stamp-release.js";

// All fake packages, Git checkouts, and npm caches stay in this temporary tree.
const root = await mkdtemp(join(tmpdir(), "tcg-release-test-"));
const source = join(root, "source");
await mkdir(source);
for (const name of ["client", "tools"]) {
  const directory = join(source, "packages", name);
  await mkdir(join(directory, "dist"), { recursive: true });
  await Bun.write(
    join(directory, "dist/index.js"),
    "export const fixture = true;\n",
  );
  await Bun.write(
    join(directory, "dist/index.d.ts"),
    "export declare const fixture: true;\n",
  );
  await Bun.write(join(directory, "dist/index.d.ts.map"), "must not ship");
  await Bun.write(
    join(directory, "package.json"),
    JSON.stringify({
      name: `@johto-ai/tcg-${name}`,
      version: "0.0.0",
      type: "module",
      files: ["dist"],
      exports: {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      },
      scripts: { prepack: "this-must-never-run" },
      ...(name === "tools"
        ? { dependencies: { "@johto-ai/tcg-client": "workspace:^" } }
        : {}),
    }),
  );
}
await Bun.write(join(source, "LICENSE"), "Fixture license notice\n");
await Bun.write(join(source, "NOTICE"), "Fixture attribution notice\n");
const staged = await stagePackages({
  root: source,
  output: join(root, "staged"),
  stream: "code",
  tag: "tcg/v1.2.3",
});
const artifact = join(root, "artifact");
await mkdir(artifact);
// These are actual npm pack outputs, not fabricated tarball names or checksums.
const packages: {
  name: string;
  version: string;
  file: string;
  sha256: string;
  integrity: string;
}[] = [];
const files: Record<string, string> = {};
for (const directory of staged) {
  const child = Bun.spawn(
    [
      "npm",
      "pack",
      "--offline",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      artifact,
    ],
    {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, npm_config_cache: join(root, "npm-cache") },
    },
  );
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code) throw new Error(error);
  const [item] = JSON.parse(output) as {
    name: string;
    version: string;
    filename: string;
  }[];
  if (!item) throw new Error("No fixture package packed");
  const bytes = new Uint8Array(
    await Bun.file(join(artifact, item.filename)).arrayBuffer(),
  );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  packages.push({
    name: item.name,
    version: item.version,
    file: item.filename,
    sha256,
    integrity,
  });
  files[item.filename] = sha256;
}
// A synthetic build handoff lets verification tests alter one requirement at a time.
const plan = {
  formatVersion: 1,
  stream: "code",
  tag: "tcg/v1.2.3",
  version: "1.2.3",
  builderCommit: "a".repeat(40),
  packages,
  files,
};
await Bun.write(join(artifact, "release-plan.json"), JSON.stringify(plan));

describe("release safeguards", () => {
  test("preparation refuses dirty builder source before staging artifacts", async () => {
    const directory = join(root, "dirty-builder");
    await mkdir(directory);
    const init = Bun.spawnSync(
      ["git", "init", "--initial-branch=main", directory],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(init.exitCode).toBe(0);
    await Bun.write(join(directory, "unreviewed.txt"), "uncommitted change");
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../scripts/release.ts", import.meta.url)),
        "prepare",
        "code",
        "--tag",
        "tcg/v1.2.3",
        "--output",
        join(directory, "output"),
        "--write",
      ],
      { cwd: directory, stdout: "pipe", stderr: "pipe" },
    );
    const [error, code] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(1);
    expect(error).toContain("Builder checkout must be clean");
    expect(
      await Bun.file(
        join(directory, "output/artifact/release-plan.json"),
      ).exists(),
    ).toBe(false);
  });
  test("release tag streams are exact and reject leading zeros/prereleases", () => {
    expect(parseReleaseTag("code", "tcg/v1.2.3")).toBe("1.2.3");
    expect(() => parseReleaseTag("code", "tcg/data-v1.2.3")).toThrow();
    expect(() => parseReleaseTag("data", "tcg/data-v01.2.3")).toThrow();
    expect(() => parseReleaseTag("code", "tcg/v1.2.3-beta.1")).toThrow();
  });

  test("stamps copies, rewrites workspace versions and strips lifecycle hooks", async () => {
    const original = await Bun.file(
      join(source, "packages/tools/package.json"),
    ).json();
    const stamped = await Bun.file(
      join(root, "staged/tcg-tools/package.json"),
    ).json();
    expect(original.version).toBe("0.0.0");
    expect(original.dependencies["@johto-ai/tcg-client"]).toBe("workspace:^");
    expect(stamped.version).toBe("1.2.3");
    expect(stamped.dependencies["@johto-ai/tcg-client"]).toBe("^1.2.3");
    expect(stamped.scripts).toBeUndefined();
    expect(() =>
      stampManifest(
        {
          ...original,
          peerDependencies: { "@johto-ai/tcg-data": "workspace:*" },
        },
        "code",
        "1.2.3",
      ),
    ).toThrow();
  });

  test("staged artifacts carry notices without source maps", async () => {
    expect(
      await Bun.file(join(root, "staged/tcg-client/NOTICE")).text(),
    ).toContain("Fixture attribution");
    expect(
      await Bun.file(
        join(root, "staged/tcg-client/dist/index.d.ts.map"),
      ).exists(),
    ).toBe(false);
    const item = packages[0];
    if (!item) throw new Error("Missing fixture package");
    const child = Bun.spawn(["tar", "-tzf", join(artifact, item.file)], {
      stdout: "pipe",
    });
    const contents = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(contents).toContain("package/NOTICE");
    expect(contents).toContain("package/LICENSE");
    expect(contents).not.toContain(".map");
  });

  test("staging refuses to overwrite an existing run", async () => {
    await expect(
      stagePackages({
        root: source,
        output: join(root, "staged"),
        stream: "code",
        tag: "tcg/v1.2.3",
      }),
    ).rejects.toThrow();
  });

  test("exact packed artifacts pass independent verification", async () => {
    expect((await verifyRelease(artifact)).packages).toHaveLength(2);
  });

  test("data artifacts resolve the pinned browser path and verify AVIF bytes", async () => {
    const output = join(root, "data-artifact");
    const packageDir = join(root, "data-package");
    await mkdir(join(output, "snapshot/generated/v1"), { recursive: true });
    await mkdir(join(output, "snapshot/assets/sha256"), { recursive: true });
    await mkdir(join(packageDir, "dist"), { recursive: true });
    await mkdir(join(packageDir, "data"));
    const hash = (value: string) =>
      createHash("sha256").update(value).digest("hex");
    const bytes =
      "synthetic AVIF transport checksum fixture, not a real owned asset";
    const imageHash = hash(bytes);
    const database =
      "synthetic opaque database bytes; SQL validation belongs to the builder";
    const browserManifest = "{}\n";
    const assetManifest = "{}\n";
    const source = {
      repository: "mega-blastoise/pokemon-tcg-data",
      commit: "b".repeat(40),
    };
    const snapshot = {
      schemaVersion: 1,
      dataVersion: "1.2.3",
      source,
      builder: { commit: plan.builderCommit, bunVersion: "1.4.3" },
      database: { path: "pokemon-data.sqlite3.db", sha256: hash(database) },
      browser: {
        baseUrl: `https://raw.githubusercontent.com/${source.repository}/${source.commit}/`,
        manifestPath: "generated/v1/manifest.json",
        manifestSha256: hash(browserManifest),
      },
      assets: {
        origin: "https://assets.example.test",
        manifestPath: "assets/manifest.json",
        manifestSha256: hash(assetManifest),
      },
      releaseReady: true,
      issues: [],
    };
    const snapshotBytes = JSON.stringify(snapshot);
    const uploads = JSON.stringify([
      {
        key: `assets/sha256/${imageHash}.avif`,
        file: `sha256/${imageHash}.avif`,
        sha256: imageHash,
        contentType: "image/avif",
      },
    ]);
    const inputs: Record<string, string> = {
      "snapshot/pokemon-data.sqlite3.db": database,
      "snapshot/manifest.json": snapshotBytes,
      "snapshot/generated/v1/manifest.json": browserManifest,
      "snapshot/assets/manifest.json": assetManifest,
      "snapshot/assets/uploads.json": uploads,
      [`snapshot/assets/sha256/${imageHash}.avif`]: bytes,
    };
    const dataFiles: Record<string, string> = {};
    for (const [file, contents] of Object.entries(inputs)) {
      await Bun.write(join(output, file), contents);
      dataFiles[file] = hash(contents);
    }
    await Bun.write(
      join(packageDir, "dist/index.js"),
      "export const fixture = true;",
    );
    await Bun.write(
      join(packageDir, "dist/index.d.ts"),
      "export declare const fixture: true;",
    );
    await Bun.write(join(packageDir, "data/manifest.json"), snapshotBytes);
    await Bun.write(join(packageDir, "data/pokemon-data.sqlite3.db"), database);
    await Bun.write(
      join(packageDir, "package.json"),
      JSON.stringify({
        name: "@johto-ai/tcg-data",
        version: "1.2.3",
        files: ["dist", "data"],
      }),
    );
    const child = Bun.spawn(
      [
        "npm",
        "pack",
        "--offline",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        output,
      ],
      {
        cwd: packageDir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, npm_config_cache: join(root, "npm-cache") },
      },
    );
    const [packed, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(error);
    const item = (JSON.parse(packed) as { filename: string }[])[0];
    if (!item) throw new Error("Missing fixture data package");
    const archive = new Uint8Array(
      await Bun.file(join(output, item.filename)).arrayBuffer(),
    );
    const sha256 = createHash("sha256").update(archive).digest("hex");
    dataFiles[item.filename] = sha256;
    await Bun.write(
      join(output, "release-plan.json"),
      JSON.stringify({
        ...plan,
        stream: "data",
        tag: "tcg/data-v1.2.3",
        source,
        files: dataFiles,
        packages: [
          {
            name: "@johto-ai/tcg-data",
            version: "1.2.3",
            file: item.filename,
            sha256,
            integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
          },
        ],
      }),
    );
    expect((await verifyRelease(output)).stream).toBe("data");
    await Bun.write(
      join(output, `snapshot/assets/sha256/${imageHash}.avif`),
      "tampered",
    );
    await expect(verifyRelease(output)).rejects.toThrow("checksum mismatch");
  });

  test("actual publication is refused outside matching GitHub OIDC", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../scripts/release.ts"),
        "publish",
        "--directory",
        artifact,
        "--execute",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          GITHUB_ACTIONS: "false",
          ACTIONS_ID_TOKEN_REQUEST_URL: "",
          NODE_AUTH_TOKEN: "",
          NPM_TOKEN: "",
        },
      },
    );
    const [error, code] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(1);
    expect(error).toContain("matching GitHub tag job with trusted OIDC");
  });

  test("out-of-root artifact references are rejected", async () => {
    await Bun.write(
      join(artifact, "release-plan.json"),
      JSON.stringify({ ...plan, files: { "../outside": "a".repeat(64) } }),
    );
    await expect(verifyRelease(artifact)).rejects.toThrow(
      "Unsafe artifact path",
    );
    await Bun.write(join(artifact, "release-plan.json"), JSON.stringify(plan));
  });

  test("tampered tarball fails before packing or publishing", async () => {
    const item = packages[0];
    if (!item) throw new Error("Missing fixture package");
    await Bun.write(join(artifact, item.file), "corrupt fixture");
    await expect(verifyRelease(artifact)).rejects.toThrow("checksum mismatch");
  });
});
