/** @module release_artifacts Prepares checked tarballs and publishes those same bytes after explicit approval. */
import { createHash } from "node:crypto";
import { cp, mkdir, readdir } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import {
  parseReleaseTag,
  type ReleaseStream,
  releasePackages,
  stagePackages,
} from "./stamp-release.ts";

// Release preparation uses one fixed builder runtime; consumers may use newer runtimes.
const PINNED_BUN = "1.4.3";
const REGISTRY = "https://registry.npmjs.org";
/** One tarball, with a local file hash and npm's SHA-512 integrity value. */
type PackedPackage = {
  name: string;
  version: string;
  file: string;
  sha256: string;
  integrity: string;
};
/** Handoff from the build job to the publish job; paths are relative to its artifact directory. */
type ReleasePlan = {
  formatVersion: 1;
  stream: ReleaseStream;
  tag: string;
  version: string;
  builderCommit: string;
  packages: PackedPackage[];
  files: Record<string, string>;
  source?: { repository: string; commit: string };
};
/** Checked local bytes and their immutable public S3 key. */
type Upload = {
  key: string;
  file: string;
  sha256: string;
  contentType: string;
};
// Only fields needed at publication: this job does not install the maintainer package.
type SnapshotManifest = {
  schemaVersion: number;
  dataVersion: string;
  source: { repository: string; commit: string };
  builder: { commit: string | null; bunVersion: string };
  database: { path: string; sha256: string };
  browser: { baseUrl: string; manifestPath: string; manifestSha256: string };
  assets: {
    origin: string | null;
    manifestPath: string;
    manifestSha256: string;
  };
  releaseReady: boolean;
  issues: string[];
};

/** Resolve a child file and reject references outside the release directory. */
function inside(root: string, path: string): string {
  const target = resolve(root, path);
  const delta = relative(root, target);
  if (
    !delta ||
    delta === ".." ||
    delta.startsWith(`..${sep}`) ||
    delta.startsWith(sep)
  )
    throw new Error(`Unsafe artifact path: ${path}`);
  return target;
}

/** Run argv directly, capture failures, and stop commands that exceed their deadline. */
async function command(
  args: string[],
  options: { cwd?: string; allowFailure?: boolean; timeoutMs?: number } = {},
) {
  const child = Bun.spawn(args, {
    cwd: options.cwd ?? process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  // Distinguish a deadline from a normal command failure in the error report.
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, options.timeoutMs ?? 120_000);
  let stdout: string;
  let stderr: string;
  let exitCode: number;
  try {
    [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
  } finally {
    clearTimeout(timeout);
  }
  if (timedOut) throw new Error(`${args[0]} ${args[1] ?? ""} timed out`);
  if (exitCode !== 0 && !options.allowFailure)
    throw new Error(
      `${args[0]} ${args[1] ?? ""} failed (${exitCode}): ${stderr.trim() || stdout.trim()}`,
    );
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

/** Hash file bytes; npm comparisons use SHA-512/base64, local checks use SHA-256/hex. */
async function digest(
  path: string,
  algorithm = "sha256",
  encoding: "hex" | "base64" = "hex",
) {
  return createHash(algorithm)
    .update(new Uint8Array(await Bun.file(path).arrayBuffer()))
    .digest(encoding);
}

/** List artifact file hashes in stable path order; never follow symlink inputs. */
async function fileHashes(
  directory: string,
  prefix = "",
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of (
    await readdir(resolve(directory, prefix), { withFileTypes: true })
  ).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink())
      throw new Error(`Symlinks are not release inputs: ${name}`);
    if (entry.isDirectory())
      Object.assign(result, await fileHashes(directory, name));
    else if (entry.isFile())
      result[name] = await digest(inside(directory, name));
  }
  return result;
}

/** Check the archive's identity and allowed contents without extracting it to disk. */
async function inspectPackage(directory: string, item: PackedPackage) {
  const archive = inside(directory, item.file);
  if (
    (await digest(archive)) !== item.sha256 ||
    `sha512-${await digest(archive, "sha512", "base64")}` !== item.integrity
  )
    throw new Error(`Package checksum mismatch: ${item.file}`);
  const manifest = JSON.parse(
    (await command(["tar", "-xOf", archive, "package/package.json"])).stdout,
  ) as { name: string; version: string; scripts?: unknown };
  if (
    manifest.name !== item.name ||
    manifest.version !== item.version ||
    manifest.scripts
  )
    throw new Error(`Packed manifest does not match plan: ${item.file}`);
  const files = (await command(["tar", "-tzf", archive])).stdout.split("\n");
  for (const file of files) {
    if (
      !file.startsWith("package/") ||
      file.split("/").includes("..") ||
      /(?:^|\/)(?:src|node_modules|\.git)(?:\/|$)/.test(file) ||
      (/\.tsx?$/.test(file) && !file.endsWith(".d.ts")) ||
      /\.(?:map|png|jpe?g|webp|gif|avif|svg)$/i.test(file)
    )
      throw new Error(`Forbidden packed file: ${file}`);
  }
  if (
    !files.some(
      (file) => file.startsWith("package/dist/") && file.endsWith(".js"),
    ) ||
    !files.some((file) => file.endsWith(".d.ts"))
  )
    throw new Error(`Missing built JS/declarations: ${item.file}`);
}

/** Recheck the downloaded handoff and ensure a data tarball contains the verified snapshot. */
export async function verifyRelease(directory: string): Promise<ReleasePlan> {
  const plan = (await Bun.file(
    resolve(directory, "release-plan.json"),
  ).json()) as ReleasePlan;
  if (
    plan.formatVersion !== 1 ||
    (plan.stream !== "code" && plan.stream !== "data") ||
    parseReleaseTag(plan.stream, plan.tag) !== plan.version ||
    !/^[a-f0-9]{40}$/.test(plan.builderCommit)
  )
    throw new Error("Invalid release plan");
  // A plan cannot introduce extra packages or publish one package twice.
  const expected = releasePackages(plan.stream);
  if (
    plan.packages.length !== expected.length ||
    !expected.every(
      (name) =>
        plan.packages.filter(
          (item) => item.name === name && item.version === plan.version,
        ).length === 1,
    )
  )
    throw new Error("Release package set mismatch");
  for (const [file, hash] of Object.entries(plan.files))
    if (
      !/^[a-f0-9]{64}$/.test(hash) ||
      (await digest(inside(directory, file))) !== hash
    )
      throw new Error(`Artifact checksum mismatch: ${file}`);
  for (const item of plan.packages) await inspectPackage(directory, item);
  if (plan.stream === "data") {
    if (
      plan.source?.repository !== "mega-blastoise/pokemon-tcg-data" ||
      !/^[a-f0-9]{40}$/.test(plan.source.commit)
    )
      throw new Error(
        "Data source must be the explicitly pinned authoritative fork",
      );
    if (
      !plan.files["snapshot/manifest.json"] ||
      !plan.files["snapshot/assets/uploads.json"]
    )
      throw new Error("Data release is missing snapshot or asset evidence");
    const manifest = await snapshotManifest(directory, plan);
    const dataPackage = plan.packages[0];
    if (!dataPackage) throw new Error("Missing data package");
    const archive = inside(directory, dataPackage.file);
    // Outer artifact hashes alone do not prove that npm contains these same data files.
    for (const file of [manifest.database.path, "manifest.json"]) {
      const child = Bun.spawn(
        ["tar", "-xOf", archive, `package/data/${file}`],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [bytes, error, exitCode] = await Promise.all([
        new Response(child.stdout).arrayBuffer(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (
        exitCode !== 0 ||
        createHash("sha256").update(new Uint8Array(bytes)).digest("hex") !==
          plan.files[`snapshot/${file}`]
      )
        throw new Error(
          `Packed data differs from verified snapshot: ${file}; ${error.trim()}`,
        );
    }
    await verifyUploads(resolve(directory, "snapshot/assets"));
  }
  return plan;
}

/** Match source/builder versions and hashes before trusting a release-eligible snapshot. */
async function snapshotManifest(
  directory: string,
  plan: ReleasePlan,
): Promise<SnapshotManifest> {
  const manifest = (await Bun.file(
    resolve(directory, "snapshot/manifest.json"),
  ).json()) as SnapshotManifest;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.dataVersion !== plan.version ||
    manifest.releaseReady !== true ||
    !Array.isArray(manifest.issues) ||
    manifest.issues.length !== 0 ||
    manifest.source.repository !== plan.source?.repository ||
    manifest.source.commit !== plan.source?.commit ||
    manifest.builder.commit !== plan.builderCommit ||
    manifest.builder.bunVersion !== PINNED_BUN ||
    !`${manifest.browser.baseUrl.replace(/\/$/, "")}/`.startsWith(
      `https://raw.githubusercontent.com/${manifest.source.repository}/${manifest.source.commit}/`,
    )
  )
    throw new Error(
      "Snapshot is not approved/release-ready or disagrees with pinned release identity",
    );
  const root = resolve(directory, "snapshot");
  // A valid GitHub hostname is insufficient: the URL must identify this exact fork commit.
  const browserManifestUrl = new URL(
    manifest.browser.manifestPath,
    manifest.browser.baseUrl,
  );
  if (
    browserManifestUrl.href !==
    `https://raw.githubusercontent.com/${manifest.source.repository}/${manifest.source.commit}/generated/v1/manifest.json`
  )
    throw new Error(
      "Browser manifest must resolve to the pinned generated/v1 manifest",
    );
  for (const [path, expected] of [
    [manifest.database.path, manifest.database.sha256],
    ["generated/v1/manifest.json", manifest.browser.manifestSha256],
    [manifest.assets.manifestPath, manifest.assets.manifestSha256],
  ]) {
    if (!path || !expected || (await digest(inside(root, path))) !== expected)
      throw new Error(`Snapshot referenced file checksum mismatch: ${path}`);
  }
  return manifest;
}

/** Validate immutable keys and local hashes before any asset upload is attempted. */
async function verifyUploads(directory: string): Promise<Upload[]> {
  const uploads = (await Bun.file(
    resolve(directory, "uploads.json"),
  ).json()) as Upload[];
  if (!Array.isArray(uploads) || uploads.length === 0)
    throw new Error("Owned asset upload inventory is missing/empty");
  const seen = new Set<string>();
  for (const entry of uploads) {
    if (
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !new RegExp(`^assets/sha256/${entry.sha256}\\.[a-z0-9]+$`).test(
        entry.key,
      ) ||
      !/^image\/(?:png|jpeg|webp|gif|avif|svg\+xml)$/.test(entry.contentType) ||
      seen.has(entry.key)
    )
      throw new Error(`Invalid/duplicate asset inventory entry: ${entry.key}`);
    seen.add(entry.key);
    if ((await digest(inside(directory, entry.file))) !== entry.sha256)
      throw new Error(`Asset bytes do not match hash: ${entry.key}`);
  }
  return uploads;
}

/** Require a clean tagged checkout that belongs to the configured release branch. */
async function verifySourceIdentity(stream: ReleaseStream, tag: string) {
  if (Bun.version !== PINNED_BUN)
    throw new Error(
      `Release preparation requires Bun ${PINNED_BUN}; found ${Bun.version}`,
    );
  if (
    (
      await command([
        "git",
        "status",
        "--porcelain",
        "--untracked-files=normal",
      ])
    ).stdout
  )
    throw new Error(
      "Builder checkout must be clean; commit/review source changes before release preparation",
    );
  const head = (await command(["git", "rev-parse", "HEAD"])).stdout;
  if ((await command(["git", "rev-parse", `${tag}^{commit}`])).stdout !== head)
    throw new Error("Release tag does not resolve to the checked-out commit");
  const branch = process.env.RELEASE_BRANCH ?? "main";
  if (!/^[a-zA-Z0-9._/-]+$/.test(branch) || branch.includes(".."))
    throw new Error("Invalid release branch");
  await command([
    "git",
    "merge-base",
    "--is-ancestor",
    head,
    `origin/${branch}`,
  ]);
  if (process.env.GITHUB_REF && process.env.GITHUB_REF !== `refs/tags/${tag}`)
    throw new Error("GitHub ref does not match release tag");
  parseReleaseTag(stream, tag);
  return head;
}

/** Stage, stamp, pack, and hash local artifacts; this never publishes them. */
async function prepare(options: {
  stream: ReleaseStream;
  tag: string;
  output: string;
  source?: string;
  snapshot?: string;
  otherVersion?: string;
  notes: string;
}) {
  const root = process.cwd();
  const version = parseReleaseTag(options.stream, options.tag);
  const builderCommit = await verifySourceIdentity(options.stream, options.tag);
  await mkdir(options.output, { recursive: true });
  // Everything the publish job needs is copied under this fresh handoff directory.
  const artifact = resolve(options.output, "artifact");
  await mkdir(artifact); // Each preparation has a fresh destination; never delete a previous release.
  let source: ReleasePlan["source"];
  if (options.stream === "data") {
    if (!options.source || !options.snapshot)
      throw new Error("Data preparation requires --source and --snapshot");
    source = (await Bun.file(
      resolve(root, "dataset-source.json"),
    ).json()) as NonNullable<ReleasePlan["source"]>;
    if (
      source.repository !== "mega-blastoise/pokemon-tcg-data" ||
      !/^[a-f0-9]{40}$/.test(source.commit)
    )
      throw new Error(
        "Data source must pin the authoritative fork's full commit SHA",
      );
    if (
      (
        await command(["git", "rev-parse", "HEAD"], {
          cwd: resolve(options.source),
        })
      ).stdout !== source.commit ||
      (
        await command(["git", "status", "--porcelain"], {
          cwd: resolve(options.source),
        })
      ).stdout
    )
      throw new Error(
        "Fork checkout must be clean and match dataset-source.json",
      );
    // The maintainer verifier checks that source and snapshot records match before packing.
    await command(
      [
        process.execPath,
        "packages/tools/dist/cli.js",
        "verify-snapshot",
        "--source",
        resolve(options.source),
        "--snapshot",
        resolve(options.snapshot),
        "--release-ready",
      ],
      { timeoutMs: 600_000 },
    );
    await verifyUploads(resolve(options.snapshot, "assets"));
    await cp(resolve(options.snapshot), resolve(artifact, "snapshot"), {
      recursive: true,
    });
  }
  // Stamping edits copies, leaving the checked-out package versions unchanged.
  const staged = await stagePackages({
    root,
    output: resolve(options.output, "staged"),
    stream: options.stream,
    tag: options.tag,
    ...(options.otherVersion ? { otherVersion: options.otherVersion } : {}),
  });
  if (options.stream === "data") {
    const dataPackage = staged[0];
    if (!dataPackage || !options.snapshot)
      throw new Error("Missing staged data package or snapshot");
    await mkdir(resolve(dataPackage, "data"), { recursive: true });
    for (const file of ["pokemon-data.sqlite3.db", "manifest.json"])
      await cp(
        resolve(options.snapshot, file),
        resolve(dataPackage, "data", file),
        { force: true },
      );
  }
  // Record the archives npm actually produced, not a prediction of their filenames or bytes.
  const packages: PackedPackage[] = [];
  for (const directory of staged) {
    const result = JSON.parse(
      (
        await command(
          [
            "npm",
            "pack",
            "--json",
            "--ignore-scripts",
            "--pack-destination",
            artifact,
          ],
          { cwd: directory },
        )
      ).stdout,
    ) as Array<{ name: string; version: string; filename: string }>;
    if (result.length !== 1)
      throw new Error("npm pack did not produce exactly one artifact");
    const item = result[0];
    if (!item) throw new Error("Missing packed artifact");
    const path = inside(artifact, item.filename);
    packages.push({
      name: item.name,
      version: item.version,
      file: basename(path),
      sha256: await digest(path),
      integrity: `sha512-${await digest(path, "sha512", "base64")}`,
    });
  }
  await cp(resolve(root, options.notes), resolve(artifact, "notes.md"));
  // Hash content first; the plan cannot include its own hash without a circular definition.
  const files = await fileHashes(artifact);
  const plan: ReleasePlan = {
    formatVersion: 1,
    stream: options.stream,
    tag: options.tag,
    version,
    builderCommit,
    packages,
    files,
    ...(source
      ? { source: { repository: source.repository, commit: source.commit } }
      : {}),
  };
  await Bun.write(
    resolve(artifact, "release-plan.json"),
    `${JSON.stringify(plan, null, 2)}\n`,
  );
  await Bun.write(
    resolve(artifact, "SHA256SUMS"),
    `${Object.entries({
      ...files,
      "release-plan.json": await digest(resolve(artifact, "release-plan.json")),
    })
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, hash]) => `${hash}  ${file}`)
      .join("\n")}\n`,
  );
  await verifyRelease(artifact);
  console.log(`Validated release artifacts: ${artifact}`);
}

/** Create missing immutable objects and verify public bytes; never overwrite or delete assets. */
async function publishAssets(directory: string) {
  const bucket = process.env.S3_BUCKET;
  const origin = process.env.ASSET_ORIGIN;
  if (
    !bucket ||
    !/^[a-z0-9][a-z0-9.-]+$/.test(bucket) ||
    !origin ||
    new URL(origin).protocol !== "https:" ||
    new URL(origin).pathname !== "/"
  )
    throw new Error("S3_BUCKET and HTTPS ASSET_ORIGIN are required");
  const entries = await verifyUploads(directory);
  /** For one key, verify existing S3 bytes or conditionally create them, then check CloudFront. */
  const uploadAndVerify = async (entry: Upload) => {
    // S3 checksum headers use base64; canonical asset keys keep the same digest in hex.
    const checksum = Buffer.from(entry.sha256, "hex").toString("base64");
    // HEAD is read-only and reports the stored checksum/type before public delivery is tested.
    const inspect = async () =>
      command(
        [
          "aws",
          "s3api",
          "head-object",
          "--bucket",
          bucket,
          "--key",
          entry.key,
          "--checksum-mode",
          "ENABLED",
          "--output",
          "json",
        ],
        { allowFailure: true },
      );
    let existing = await inspect();
    if (existing.exitCode !== 0) {
      // S3 may hide a missing key behind 403 when ListBucket is prefix-restricted.
      // A conditional create is safe in either case and will never overwrite it.
      if (
        !/\b(?:403|404|Forbidden|AccessDenied|NotFound|NoSuchKey)\b/.test(
          existing.stderr,
        )
      )
        throw new Error(`Cannot inspect ${entry.key}: ${existing.stderr}`);
      const uploaded = await command(
        [
          "aws",
          "s3api",
          "put-object",
          "--bucket",
          bucket,
          "--key",
          entry.key,
          "--body",
          inside(directory, entry.file),
          "--content-type",
          entry.contentType,
          "--cache-control",
          "public, max-age=31536000, immutable",
          "--checksum-algorithm",
          "SHA256",
          "--checksum-sha256",
          checksum,
          "--metadata",
          `sha256=${entry.sha256}`,
          "--if-none-match",
          "*",
        ],
        { allowFailure: true },
      );
      if (
        uploaded.exitCode !== 0 &&
        !/\b(?:412|PreconditionFailed)\b/.test(uploaded.stderr)
      )
        throw new Error(`Asset upload failed: ${uploaded.stderr}`);
      existing = await inspect();
    }
    if (existing.exitCode !== 0)
      throw new Error(`Cannot verify uploaded asset: ${entry.key}`);
    const metadata = JSON.parse(existing.stdout) as {
      ChecksumSHA256?: string;
      ContentType?: string;
      Metadata?: { sha256?: string };
    };
    if (
      metadata.ChecksumSHA256 !== checksum ||
      metadata.ContentType !== entry.contentType ||
      metadata.Metadata?.sha256 !== entry.sha256
    )
      throw new Error(`Existing immutable asset differs: ${entry.key}`);
    // New objects can take time to become visible at the edge; every success still needs a hash check.
    let verified = false;
    for (let attempt = 0; attempt < 5 && !verified; attempt++) {
      const response = await fetch(new URL(entry.key, origin), {
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) {
        if (
          createHash("sha256")
            .update(new Uint8Array(await response.arrayBuffer()))
            .digest("hex") !== entry.sha256
        )
          throw new Error(`CloudFront asset checksum mismatch: ${entry.key}`);
        verified = true;
      } else if (
        response.status !== 404 &&
        response.status !== 403 &&
        response.status < 500
      )
        throw new Error(`CloudFront asset request failed: ${response.status}`);
      else if (attempt < 4) await Bun.sleep(1000 * (attempt + 1));
    }
    if (!verified)
      throw new Error(`CloudFront asset unavailable: ${entry.key}`);
  };
  // Bound network/process concurrency while keeping a complete first release practical.
  for (let start = 0; start < entries.length; start += 8)
    await Promise.all(entries.slice(start, start + 8).map(uploadAndVerify));
}

/** Publish only verified archives; require the matching Actions identity and upload assets first. */
async function publish(directory: string, execute: boolean) {
  const plan = await verifyRelease(directory);
  if (!execute) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          tag: plan.tag,
          assetsFirst: plan.stream === "data",
          commands: plan.packages.map((item) => [
            "npm",
            "publish",
            item.file,
            "--access",
            "public",
            "--provenance",
            "--ignore-scripts",
          ]),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_REF !== `refs/tags/${plan.tag}` ||
    process.env.GITHUB_SHA !== plan.builderCommit ||
    !process.env.ACTIONS_ID_TOKEN_REQUEST_URL ||
    process.env.NODE_AUTH_TOKEN ||
    process.env.NPM_TOKEN
  )
    throw new Error(
      "Publication requires the matching GitHub tag job with trusted OIDC; long-lived npm tokens are not accepted",
    );
  const [major = 0, minor = 0, patch = 0] = (
    await command(["npm", "--version"])
  ).stdout
    .split(".")
    .map(Number);
  if (
    ![major, minor, patch].every(Number.isInteger) ||
    major < 11 ||
    (major === 11 && (minor < 5 || (minor === 5 && patch < 1)))
  )
    throw new Error("Trusted publishing requires npm >=11.5.1");
  // Identical published versions make retries safe; differing existing bytes stop the release.
  const pending: PackedPackage[] = [];
  for (const item of plan.packages) {
    const response = await command(
      [
        "npm",
        "view",
        `${item.name}@${item.version}`,
        "dist.integrity",
        "--json",
        "--registry",
        REGISTRY,
      ],
      { allowFailure: true },
    );
    if (response.exitCode === 0) {
      if (JSON.parse(response.stdout) !== item.integrity)
        throw new Error(
          `${item.name}@${item.version} already exists with different bytes`,
        );
    } else if (/\bE404\b/.test(response.stderr + response.stdout))
      pending.push(item);
    else
      throw new Error(
        `Registry preflight failed: ${response.stderr || response.stdout}`,
      );
  }
  if (plan.stream === "data") {
    const manifest = await snapshotManifest(directory, plan);
    if (
      manifest.assets.origin?.replace(/\/$/, "") !==
      process.env.ASSET_ORIGIN?.replace(/\/$/, "")
    )
      throw new Error("ASSET_ORIGIN disagrees with the validated snapshot");
    await publishAssets(resolve(directory, "snapshot/assets"));
  }
  for (const item of pending)
    await command([
      "npm",
      "publish",
      inside(directory, item.file),
      "--registry",
      REGISTRY,
      "--access",
      "public",
      "--provenance",
      "--ignore-scripts",
    ]);
  console.log(
    `Published/verified ${plan.tag}; prior assets and snapshots were retained.`,
  );
}

// Preparation and publication are separate opt-ins: --write stages, --execute publishes.
if (import.meta.main) {
  try {
    const { values, positionals } = parseArgs({
      args: Bun.argv.slice(2),
      allowPositionals: true,
      options: {
        tag: { type: "string" },
        output: { type: "string" },
        source: { type: "string" },
        snapshot: { type: "string" },
        directory: { type: "string" },
        notes: { type: "string", default: "docs/releases.md" },
        "other-version": { type: "string" },
        write: { type: "boolean", default: false },
        execute: { type: "boolean", default: false },
      },
    });
    const action = positionals[0];
    if (action === "prepare") {
      const stream = positionals[1];
      if (
        (stream !== "code" && stream !== "data") ||
        !values.tag ||
        positionals.length !== 2
      )
        throw new Error(
          "Usage: release.ts prepare code|data --tag TAG [--source FORK --snapshot DIR] [--output DIR] [--notes FILE] [--write]",
        );
      const version = parseReleaseTag(stream, values.tag);
      const output = resolve(values.output ?? `.release/${stream}-${version}`);
      if (!values.write)
        console.log(
          JSON.stringify(
            {
              dryRun: true,
              stream,
              tag: values.tag,
              output,
              packages: releasePackages(stream),
              requiresBun: PINNED_BUN,
              source: values.source,
              snapshot: values.snapshot,
            },
            null,
            2,
          ),
        );
      else
        await prepare({
          stream,
          tag: values.tag,
          output,
          notes: values.notes,
          ...(values.source ? { source: values.source } : {}),
          ...(values.snapshot ? { snapshot: values.snapshot } : {}),
          ...(values["other-version"]
            ? { otherVersion: values["other-version"] }
            : {}),
        });
    } else if (
      (action === "verify" || action === "publish") &&
      values.directory &&
      positionals.length === 1
    ) {
      const directory = resolve(values.directory);
      if (action === "verify")
        console.log(JSON.stringify(await verifyRelease(directory), null, 2));
      else await publish(directory, values.execute);
    } else
      throw new Error(
        "Usage: release.ts prepare|verify|publish (preparation/publication are dry runs unless --write/--execute)",
      );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
