/** @module tcg_browser Creates the browser client with an observable, optionally mirrored transport. */
import type { TCGClient } from "@johto-ai/tcg-agent/protocol";
import {
  PokemonTCGClient,
  type SnapshotManifest,
} from "@johto-ai/tcg-client/browser";

/** One snapshot download as the client requested it. */
export interface FetchRecord {
  id: number;
  path: string;
  url: string;
  status: number | null;
  bytes: number | null;
  ms: number | null;
  error?: string;
}

/** Where snapshot JSON comes from; hashes are checked by the client either way. */
export type SnapshotSource = "mirror" | "github";

/** What the server knows about its snapshot. */
export interface SnapshotInfo {
  manifest: SnapshotManifest;
  directory: string;
  mirrorAvailable: boolean;
}

let nextId = 0;

/**
 * Build a browser client. The descriptor still names the pinned GitHub URL;
 * in mirror mode only the transport is redirected to this server, so the
 * client's own SHA-256 checks still prove every byte matches the pin.
 */
export async function createBrowserClient(
  info: SnapshotInfo,
  source: SnapshotSource,
  onFetch: (record: FetchRecord) => void,
): Promise<TCGClient> {
  const base = info.manifest.browser.baseUrl;
  const fetcher = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const original =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const path = original.startsWith(base)
      ? original.slice(base.length)
      : original;
    const url =
      source === "mirror" && original.startsWith(base)
        ? `/snapshot/${path}`
        : original;
    const record: FetchRecord = {
      id: ++nextId,
      path,
      url,
      status: null,
      bytes: null,
      ms: null,
    };
    onFetch({ ...record });
    const started = performance.now();
    try {
      const response = await fetch(url, init);
      const buffer = await response.arrayBuffer();
      record.status = response.status;
      record.bytes = buffer.byteLength;
      record.ms = Math.round(performance.now() - started);
      onFetch({ ...record });
      // Hand the client a fresh response; it verifies the hash itself.
      return new Response(buffer, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      record.ms = Math.round(performance.now() - started);
      record.error = error instanceof Error ? error.message : String(error);
      onFetch({ ...record });
      throw error;
    }
  };
  return PokemonTCGClient.createClientAsync({
    snapshot: info.manifest,
    allowDraft: true,
    fetch: fetcher,
  });
}
