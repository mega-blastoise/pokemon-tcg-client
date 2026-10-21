/** @module validation Checks runtime data, snapshot pins, paths, and content hashes. */
import type { z } from "zod";
import { TCGError } from "./errors.js";
import {
  SCHEMA_VERSION,
  type SnapshotManifest,
  snapshotManifestSchema,
} from "./schema.js";

/** Validate an untrusted value and retain schema details as the typed error's cause. */
export function parseRecord<T>(
  schema: z.ZodType<T>,
  value: unknown,
  description: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new TCGError("INVALID_DATA", `Invalid ${description}`, {
      cause: parsed.error,
    });
  return parsed.data;
}

/** Distinguish an explicitly unsupported format from otherwise malformed data. */
export function checkSchemaVersion(value: unknown): void {
  if (
    value !== null &&
    typeof value === "object" &&
    "schemaVersion" in value &&
    value.schemaVersion !== SCHEMA_VERSION
  ) {
    throw new TCGError(
      "UNSUPPORTED_SCHEMA",
      `Unsupported snapshot schema version: ${String(value.schemaVersion)}`,
    );
  }
}

/** Reject drafts by default and require the browser URL to match the exact Git commit. */
export function parseSnapshot(
  value: unknown,
  allowDraft = false,
): SnapshotManifest {
  checkSchemaVersion(value);
  const manifest = parseRecord(
    snapshotManifestSchema,
    value,
    "snapshot manifest",
  );
  if (!manifest.releaseReady && !allowDraft)
    throw new TCGError(
      "CONFIGURATION",
      "This snapshot is a draft; pass allowDraft explicitly for maintainer use",
    );
  // No branch URL or independent content host can silently change this snapshot's data.
  const expected = `https://raw.githubusercontent.com/${manifest.source.repository}/${manifest.source.commit}/`;
  if (manifest.browser.baseUrl !== expected) {
    throw new TCGError(
      "SNAPSHOT_MISMATCH",
      "Browser source must be the manifest's exact commit-pinned GitHub raw URL",
    );
  }
  return manifest;
}

/** Keep JSON syntax failures distinct from transport errors and empty results. */
export function parseJson(text: string, description: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new TCGError("INVALID_DATA", `Invalid JSON in ${description}`, {
      cause,
    });
  }
}

/** Hash the exact supplied bytes with the Web Crypto API available in every target runtime. */
export async function sha256(bytes: Uint8Array): Promise<string> {
  // Give Web Crypto a standalone buffer even when the input is a shared or sliced view.
  const copy = new Uint8Array(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

/** Keep manifest paths within the pinned content tree; reject escapes and URL syntax. */
export function assertRelativePath(value: string): void {
  if (
    !value ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((part) => !part || part === "." || part === "..") ||
    /[?#%:]/.test(value)
  ) {
    throw new TCGError(
      "INVALID_DATA",
      `Unsafe snapshot content path: ${value}`,
    );
  }
}
