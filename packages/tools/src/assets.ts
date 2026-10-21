/** @module assets Prepare resumable owned-image mappings with checked immutable bytes. */
import { existsSync, mkdirSync, realpathSync, renameSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type Card,
  type CardSet,
  reviewSchema,
  sha256Schema,
} from "@johto-ai/tcg-client/schema";
import type { Baseline } from "./baseline.js";
import { writeJson } from "./files.js";
import {
  asRecord,
  assertKnownFields,
  sha256,
  stableJSON,
} from "./normalize.js";

/** One immutable upload; file is relative to the local assets directory. */
export interface AssetUpload {
  key: string;
  file: string;
  sha256: string;
  contentType: string;
}
/** Link an upstream reference to checked bytes and an optional remote verification receipt. */
export interface AssetEntry extends AssetUpload {
  sourceUrl: string;
  published: { url: string; sha256: string; verifiedAt: string } | null;
}
/** Acquisition progress and human ownership review; publication is verified separately. */
export interface AssetManifest {
  schemaVersion: 1;
  origin: string | null;
  review: {
    approved: boolean;
    reviewedBy: string | null;
    reviewedAt: string | null;
  };
  entries: AssetEntry[];
  missing: string[];
}
// Keys identify bytes rather than upstream paths, preventing silent mutable replacements.
export const ASSET_KEY =
  /^assets\/sha256\/([a-f0-9]{64})\.(png|jpg|webp|gif|avif)$/;
const mimeByExtension: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
};

/** Accept only the pure owned HTTPS origin shared by runtime URLs and publication. */
export function normalizeAssetOrigin(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "Asset origin must be a pure HTTPS CloudFront/custom origin without a path, credentials, query or fragment",
    );
  return url.href.replace(/\/$/, "");
}
/** Deduplicate present source URLs; snapshot release checks handle absent image fields. */
export function requiredAssetUrls(
  baseline: Pick<Baseline, "cards" | "sets">,
): string[] {
  return [
    ...new Set(
      [
        ...baseline.cards.flatMap((card) => Object.values(card.images)),
        ...baseline.sets.flatMap((set) => Object.values(set.images)),
      ].filter((url): url is string => typeof url === "string" && !!url),
    ),
  ].sort();
}
/** Keep manifest paths inside their asset directory, including existing symlink targets. */
export function safeAssetFile(directory: string, file: string): string {
  if (
    isAbsolute(file) ||
    file.includes("\\") ||
    file.split("/").some((part) => part === ".." || part === "." || !part)
  )
    throw new Error(`Unsafe asset file path ${JSON.stringify(file)}`);
  const root = resolve(directory);
  const absolute = resolve(root, file);
  const child = relative(root, absolute);
  if (child.startsWith(`..${sep}`) || child === ".." || isAbsolute(child))
    throw new Error(`Asset file escapes asset directory: ${file}`);
  if (existsSync(absolute)) {
    const actual = realpathSync(absolute);
    const realRoot = realpathSync(root);
    const realChild = relative(realRoot, actual);
    if (
      realChild.startsWith(`..${sep}`) ||
      realChild === ".." ||
      isAbsolute(realChild)
    )
      throw new Error(`Asset symlink escapes asset directory: ${file}`);
  }
  return absolute;
}
/** Identify supported images from their bytes rather than trusting a URL or HTTP header. */
function imageFormat(bytes: Uint8Array): {
  extension: string;
  contentType: string;
} {
  const head = new TextDecoder("latin1").decode(bytes.slice(0, 32));
  const extension =
    bytes[0] === 137 && head.slice(1, 4) === "PNG"
      ? "png"
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        ? "jpg"
        : head.startsWith("RIFF") && head.slice(8, 12) === "WEBP"
          ? "webp"
          : head.startsWith("GIF87a") || head.startsWith("GIF89a")
            ? "gif"
            : head.slice(4, 8) === "ftyp" && /avif|avis/.test(head.slice(8))
              ? "avif"
              : null;
  if (!extension)
    throw new Error(
      "Unsupported or invalid image bytes; expected PNG, JPEG, WebP, GIF or AVIF",
    );
  return { extension, contentType: mimeByExtension[extension] as string };
}

/** Check cached or staged bytes against both the declared checksum and image type. */
export async function verifyAssetFile(
  directory: string,
  entry: AssetUpload,
): Promise<void> {
  const bytes = new Uint8Array(
    await Bun.file(safeAssetFile(directory, entry.file)).arrayBuffer(),
  );
  if (sha256(bytes) !== entry.sha256)
    throw new Error(`Asset checksum mismatch: ${entry.file}`);
  if (imageFormat(bytes).contentType !== entry.contentType)
    throw new Error(
      `Asset image format does not match contentType: ${entry.file}`,
    );
}
/** Read a successful image response with a streaming size limit and format check. */
async function imageResponse(
  response: Response,
  label: string,
): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
  if (Number(response.headers.get("content-length") ?? 0) > 25 * 1024 * 1024)
    throw new Error(`${label}: image exceeds 25 MiB`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${label}: missing image body`);
  // Enforce the limit while reading even when Content-Length is absent or incorrect.
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.length;
    if (length > 25 * 1024 * 1024) {
      await reader.cancel();
      throw new Error(`${label}: image exceeds 25 MiB`);
    }
    chunks.push(part.value);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  imageFormat(result);
  return result;
}
/** Validate canonical mappings and bind any publication receipt to its owned URL and hash. */
export function parseAssetManifest(value: unknown): AssetManifest {
  const raw = asRecord(value, "asset manifest");
  assertKnownFields(
    raw,
    ["schemaVersion", "origin", "review", "entries", "missing"],
    "asset manifest",
  );
  if (
    raw.schemaVersion !== 1 ||
    !Array.isArray(raw.entries) ||
    !Array.isArray(raw.missing) ||
    !raw.missing.every((value) => typeof value === "string")
  )
    throw new Error("Invalid asset manifest schema");
  if (raw.origin !== null && typeof raw.origin !== "string")
    throw new Error("Invalid asset manifest origin");
  const origin = normalizeAssetOrigin(raw.origin as string | null);
  const entries = raw.entries.map((value: unknown) => {
    const entry = asRecord(value, "asset entry");
    assertKnownFields(
      entry,
      ["sourceUrl", "key", "file", "sha256", "contentType", "published"],
      "asset entry",
    );
    for (const key of ["sourceUrl", "key", "file", "sha256", "contentType"])
      if (typeof entry[key] !== "string")
        throw new Error(`Invalid asset entry ${key}`);
    // Key, local path, hash, and MIME type must describe the same immutable object.
    const match = ASSET_KEY.exec(entry.key as string);
    const hash = sha256Schema.parse(entry.sha256);
    if (
      !match ||
      match[1] !== hash ||
      entry.file !== (entry.key as string).slice("assets/".length) ||
      entry.contentType !== mimeByExtension[match[2] as string]
    )
      throw new Error(
        "Asset key/file/hash/contentType must use the canonical content-addressed layout",
      );
    const source = new URL(entry.sourceUrl as string);
    if (source.protocol !== "https:")
      throw new Error("Asset source must use HTTPS");
    if (entry.published !== null) {
      const receipt = asRecord(entry.published, "published asset receipt");
      assertKnownFields(
        receipt,
        ["url", "sha256", "verifiedAt"],
        "published asset receipt",
      );
      if (
        !origin ||
        receipt.url !== `${origin}/${entry.key}` ||
        receipt.sha256 !== hash ||
        typeof receipt.verifiedAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(
          receipt.verifiedAt,
        ) ||
        Number.isNaN(Date.parse(receipt.verifiedAt))
      )
        throw new Error(
          "Published asset receipt does not match its configured owned URL and bytes",
        );
    }
    return entry as unknown as AssetEntry;
  });
  if (new Set(entries.map((entry) => entry.sourceUrl)).size !== entries.length)
    throw new Error("Duplicate source URL in asset manifest");
  return {
    schemaVersion: 1,
    origin,
    review: reviewSchema.parse(raw.review),
    entries,
    missing: raw.missing as string[],
  };
}

/** Reuse checked local assets and acquire only missing URLs when explicitly authorized. */
export async function prepareAssets(options: {
  baseline: Pick<Baseline, "cards" | "sets">;
  outputDir: string;
  origin?: string;
  fetch?: typeof fetch;
  allowNetwork?: boolean;
}): Promise<AssetManifest> {
  const directory = join(options.outputDir, "assets");
  mkdirSync(directory, { recursive: true });
  const required = requiredAssetUrls(options.baseline);
  const origin = normalizeAssetOrigin(options.origin);
  const previousFile = join(directory, "manifest.json");
  const previous = existsSync(previousFile)
    ? parseAssetManifest(await Bun.file(previousFile).json())
    : null;
  const previousEntries = new Map(
    previous?.entries.map((entry) => [entry.sourceUrl, entry]),
  );
  // Reconstruct the last source inventory, including work not yet acquired.
  const previousRequired = [
    ...new Set([
      ...(previous?.entries.map((entry) => entry.sourceUrl) ?? []),
      ...(previous?.missing ?? []),
    ]),
  ].sort();
  // Approval survives only an unchanged origin, source inventory, and validated cached bytes.
  const manifest: AssetManifest = {
    schemaVersion: 1,
    origin,
    review:
      previous?.origin === origin &&
      stableJSON(previousRequired) === stableJSON(required)
        ? previous.review
        : { approved: false, reviewedBy: null, reviewedAt: null },
    entries: [],
    missing: [],
  };
  // This map contains only bytes checked during this run, never merely claimed prior mappings.
  const entries = new Map<string, AssetEntry>();
  // Validate all existing mappings before fetching. A failure checkpoint must
  // retain valid cached entries even if their URLs occur later in the batch.
  for (const sourceUrl of required) {
    const existing = previousEntries.get(sourceUrl);
    if (existing) {
      try {
        await verifyAssetFile(directory, existing);
        entries.set(sourceUrl, {
          ...existing,
          published: previous?.origin === origin ? existing.published : null,
        });
      } catch {
        manifest.review = {
          approved: false,
          reviewedBy: null,
          reviewedAt: null,
        };
      }
    }
  }
  // Save accurate remaining work so failures resume without refetching accepted local bytes.
  const checkpoint = async () => {
    manifest.entries = [...entries.values()].sort((a, b) =>
      a.sourceUrl < b.sourceUrl ? -1 : a.sourceUrl > b.sourceUrl ? 1 : 0,
    );
    manifest.missing = required.filter((url) => !entries.has(url));
    await writeAssetManifest(directory, manifest);
  };
  await checkpoint();
  if (options.allowNetwork) {
    // Bound successful acquisitions between checkpoints; errors also checkpoint immediately.
    let pending = 0;
    try {
      for (const sourceUrl of [...manifest.missing]) {
        const url = new URL(sourceUrl);
        if (url.protocol !== "https:")
          throw new Error(`Refusing non-HTTPS source image ${sourceUrl}`);
        const bytes = await imageResponse(
          await (options.fetch ?? fetch)(sourceUrl, {
            signal: AbortSignal.timeout(30_000),
          }),
          sourceUrl,
        );
        const format = imageFormat(bytes);
        const hash = sha256(bytes);
        // Multiple source URLs with identical bytes share one immutable local/upload object.
        const file = `sha256/${hash}.${format.extension}`;
        const target = safeAssetFile(directory, file);
        mkdirSync(dirname(target), { recursive: true });
        if (
          existsSync(target) &&
          sha256(new Uint8Array(await Bun.file(target).arrayBuffer())) !== hash
        )
          throw new Error(
            `Existing content-addressed asset is corrupt: ${target}`,
          );
        // Rename only complete downloads into the content-addressed cache.
        if (!existsSync(target)) {
          const temporary = `${target}.${crypto.randomUUID()}.tmp`;
          await Bun.write(temporary, bytes);
          renameSync(temporary, target);
        }
        entries.set(sourceUrl, {
          sourceUrl,
          key: `assets/${file}`,
          file,
          sha256: hash,
          contentType: format.contentType,
          published: null,
        });
        // Newly acquired bytes invalidate prior approval even if the source URL is unchanged.
        manifest.review = {
          approved: false,
          reviewedBy: null,
          reviewedAt: null,
        };
        pending++;
        if (pending === 32) {
          await checkpoint();
          pending = 0;
        }
      }
    } catch (error) {
      await checkpoint();
      throw new Error(
        `Asset acquisition stopped; checked progress saved to ${previousFile}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  await checkpoint();
  return manifest;
}
/** Save deterministic acquisition and deduplicated upload manifests using atomic JSON writes. */
export async function writeAssetManifest(
  directory: string,
  manifest: AssetManifest,
): Promise<void> {
  mkdirSync(directory, { recursive: true });
  // Upload each byte identity once even when several upstream URLs point to it.
  const unique = new Map(
    manifest.entries.map(({ key, file, sha256, contentType }) => [
      key,
      { key, file, sha256, contentType },
    ]),
  );
  await writeJson(
    join(directory, "uploads.json"),
    JSON.parse(
      stableJSON([...unique.values()].sort((a, b) => (a.key < b.key ? -1 : 1))),
    ),
  );
  // Commit the manifest last. Both files are individually atomic; a reader
  // observing an interrupted pair fails the upload-manifest consistency check.
  await writeJson(
    join(directory, "manifest.json"),
    JSON.parse(stableJSON(manifest)),
  );
}
/** Explicit network operation: compare each deployed immutable asset with the checked local bytes. */
export async function verifyPublishedAssets(
  manifestPath: string,
  options: { fetch?: typeof fetch } = {},
): Promise<AssetManifest> {
  const manifest = parseAssetManifest(await Bun.file(manifestPath).json());
  if (!manifest.origin)
    throw new Error(
      "Configure the owned asset origin before verifying publication",
    );
  for (const entry of manifest.entries) {
    const local = safeAssetFile(dirname(manifestPath), entry.file);
    if (
      sha256(new Uint8Array(await Bun.file(local).arrayBuffer())) !==
      entry.sha256
    )
      throw new Error(`Local asset checksum mismatch: ${entry.file}`);
    const url = `${manifest.origin}/${entry.key}`;
    const bytes = await imageResponse(
      await (options.fetch ?? fetch)(url, {
        signal: AbortSignal.timeout(30_000),
      }),
      url,
    );
    if (sha256(bytes) !== entry.sha256)
      throw new Error(`Published asset checksum mismatch: ${url}`);
    entry.published = {
      url,
      sha256: entry.sha256,
      verifiedAt: new Date().toISOString(),
    };
  }
  await writeAssetManifest(dirname(manifestPath), manifest);
  return manifest;
}
/** Replace acquired references with owned URLs while leaving missing draft mappings visible. */
export function rewriteAssetUrls(
  cards: readonly Card[],
  sets: readonly CardSet[],
  manifest: AssetManifest,
): { cards: Card[]; sets: CardSet[] } {
  const mapping = new Map(
    manifest.origin
      ? manifest.entries.map((entry) => [
          entry.sourceUrl,
          `${manifest.origin}/${entry.key}`,
        ])
      : [],
  );
  // Unmapped references remain external so release validation can report them explicitly.
  const replace = (value: string | null) =>
    value === null ? null : (mapping.get(value) ?? value);
  return {
    cards: cards.map((card) => ({
      ...card,
      images: {
        small: replace(card.images.small),
        large: replace(card.images.large),
      },
    })),
    sets: sets.map((set) => ({
      ...set,
      images: {
        symbol: replace(set.images.symbol),
        logo: replace(set.images.logo),
      },
    })),
  };
}
