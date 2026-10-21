/** @module stamp_release Versions fresh package copies without editing source manifests. */
import { cp, mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

/** Client/tools release together; dataset versions advance independently. */
export type ReleaseStream = "code" | "data";
/** Explicit package list; release commands never discover arbitrary workspace packages. */
export const PACKAGE_PATHS = {
  "@johto-ai/tcg-client": "packages/client",
  "@johto-ai/tcg-tools": "packages/tools",
  "@johto-ai/tcg-data": "packages/data",
} as const;
type PackageName = keyof typeof PACKAGE_PATHS;
type PackageManifest = Record<string, unknown> & {
  name: PackageName;
  version: string;
  scripts?: Record<string, string>;
};

/** Accept only the selected stream's X.Y.Z tag; no prereleases or leading zeros. */
export function parseReleaseTag(stream: ReleaseStream, tag: string): string {
  const prefix = stream === "code" ? "tcg/v" : "tcg/data-v";
  const version = tag.startsWith(prefix) ? tag.slice(prefix.length) : "";
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Expected ${prefix}X.Y.Z; received ${JSON.stringify(tag)}`);
  }
  return version;
}

/** Return exactly the packages this tag is allowed to publish. */
export function releasePackages(stream: ReleaseStream): PackageName[] {
  return stream === "code"
    ? ["@johto-ai/tcg-client", "@johto-ai/tcg-tools"]
    : ["@johto-ai/tcg-data"];
}

/** Stamp a copy and replace workspace ranges with explicit published versions. */
export function stampManifest(
  input: PackageManifest,
  stream: ReleaseStream,
  version: string,
  otherVersion?: string,
): PackageManifest {
  if (input.version !== "0.0.0") {
    throw new Error(`${input.name}: source version must remain 0.0.0`);
  }
  // All edits stay in staging; source versions remain 0.0.0.
  const manifest = structuredClone(input);
  manifest.version = version;
  delete manifest.private;
  if (Array.isArray(manifest.files))
    manifest.files = [...new Set([...manifest.files, "LICENSE", "NOTICE"])];
  // Release packing never executes lifecycle hooks, including user prepack hooks.
  delete manifest.scripts;
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ] as const) {
    const dependencies = manifest[field] as Record<string, string> | undefined;
    if (!dependencies) continue;
    for (const [name, range] of Object.entries(dependencies)) {
      if (!range.startsWith("workspace:")) continue;
      if (!(name in PACKAGE_PATHS))
        throw new Error(`Unknown workspace package ${name}`);
      // A code tag must not silently choose a version for the independent dataset.
      const target = releasePackages(stream).includes(name as PackageName)
        ? version
        : otherVersion;
      if (
        !target ||
        !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(target)
      ) {
        throw new Error(
          `${name} has an independent release stream; provide --other-version`,
        );
      }
      dependencies[name] =
        range === "workspace:^"
          ? `^${target}`
          : range === "workspace:~"
            ? `~${target}`
            : target;
    }
  }
  const exportsText = JSON.stringify(manifest.exports ?? {});
  if (
    /\.ts["']/.test(exportsText.replaceAll(".d.ts", ".dts")) ||
    exportsText.includes("/src/")
  ) {
    throw new Error(
      `${input.name}: public exports must reference built JavaScript/declarations`,
    );
  }
  return manifest;
}

/** Copy built files/notices into new directories and write stamped manifests there. */
export async function stagePackages(options: {
  root: string;
  output: string;
  stream: ReleaseStream;
  tag: string;
  otherVersion?: string;
}): Promise<string[]> {
  const version = parseReleaseTag(options.stream, options.tag);
  await mkdir(options.output, { recursive: true });
  // Returned paths are the only inputs the caller should pass to npm pack.
  const directories: string[] = [];
  for (const name of releasePackages(options.stream)) {
    const source = resolve(options.root, PACKAGE_PATHS[name]);
    const manifest = (await Bun.file(
      resolve(source, "package.json"),
    ).json()) as PackageManifest;
    if (manifest.name !== name)
      throw new Error(`Unexpected package at ${source}`);
    const target = resolve(options.output, name.slice(name.indexOf("/") + 1));
    await mkdir(target); // Refuse to overwrite a previous staging run.
    for (const file of ["dist", "data", "README.md", "LICENSE", "NOTICE"]) {
      const path = resolve(source, file);
      const found = await stat(path).catch(() => null);
      if (found)
        await cp(path, resolve(target, file), {
          recursive: true,
          errorOnExist: true,
          force: false,
          filter: (entry) => !entry.endsWith(".map"),
        });
    }
    if (
      !(await stat(resolve(target, "dist")).catch(() => null))?.isDirectory()
    ) {
      throw new Error(`${name}: run bun run build before staging`);
    }
    // Ensure every tarball carries the repository's license/attribution notices.
    for (const file of ["LICENSE", "NOTICE"]) {
      if (
        !(await Bun.file(resolve(target, file)).exists()) &&
        (await Bun.file(resolve(options.root, file)).exists())
      ) {
        await cp(resolve(options.root, file), resolve(target, file));
      }
    }
    await Bun.write(
      resolve(target, "package.json"),
      `${JSON.stringify(stampManifest(manifest, options.stream, version, options.otherVersion), null, 2)}\n`,
    );
    directories.push(target);
  }
  return directories;
}

// CLI calls print a plan unless --write explicitly permits local staging.
if (import.meta.main) {
  try {
    const { values, positionals } = parseArgs({
      args: Bun.argv.slice(2),
      allowPositionals: true,
      options: {
        tag: { type: "string" },
        output: { type: "string", default: ".release/staged" },
        "other-version": { type: "string" },
        write: { type: "boolean", default: false },
      },
    });
    const stream = positionals[0];
    if (
      (stream !== "code" && stream !== "data") ||
      !values.tag ||
      positionals.length !== 1
    ) {
      throw new Error(
        "Usage: bun scripts/stamp-release.ts code|data --tag TAG [--output DIR] [--other-version X.Y.Z] [--write]",
      );
    }
    const version = parseReleaseTag(stream, values.tag);
    console.log(
      JSON.stringify(
        {
          dryRun: !values.write,
          stream,
          version,
          output: resolve(values.output),
          packages: releasePackages(stream),
        },
        null,
        2,
      ),
    );
    if (values.write) {
      await stagePackages({
        root: process.cwd(),
        output: resolve(values.output),
        stream,
        tag: values.tag,
        ...(values["other-version"]
          ? { otherVersion: values["other-version"] }
          : {}),
      });
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
