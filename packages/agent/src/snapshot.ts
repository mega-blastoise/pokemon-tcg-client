/** @module local_snapshot Finds a built snapshot directory for local verification runs. */
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { SnapshotManifest } from "@johto-ai/tcg-client";

/** A directory holding manifest.json, its SQLite file, and the generated browser views. */
export interface LocalSnapshot {
  directory: string;
  manifestPath: string;
  databasePath: string;
  manifest: SnapshotManifest;
}

/** Read a candidate directory; null when it is not a complete snapshot. */
async function load(directory: string): Promise<LocalSnapshot | null> {
  const manifestPath = join(directory, "manifest.json");
  try {
    const manifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as SnapshotManifest;
    const databasePath = resolve(directory, manifest.database.path);
    await stat(databasePath);
    return { directory, manifestPath, databasePath, manifest };
  } catch {
    return null;
  }
}

/**
 * Resolve an explicit directory, then TCG_SNAPSHOT_DIR, then the newest
 * `.local/catalog-check-*` build found walking up from `from`. Returns null
 * when nothing is found so callers can fall back to the installed data package.
 */
export async function findLocalSnapshot(
  options: { directory?: string; from?: string } = {},
): Promise<LocalSnapshot | null> {
  const explicit = options.directory ?? process.env.TCG_SNAPSHOT_DIR;
  if (explicit) {
    const found = await load(resolve(explicit));
    if (!found) throw new Error(`No snapshot manifest/database in ${explicit}`);
    return found;
  }
  let current = resolve(options.from ?? process.cwd());
  while (true) {
    const local = join(current, ".local");
    const entries = await readdir(local).catch(() => [] as string[]);
    const candidates: { snapshot: LocalSnapshot; mtime: number }[] = [];
    for (const entry of entries.filter((e) => e.startsWith("catalog-check-"))) {
      // Catalog checks build twice to prove reproducibility; either copy works.
      const snapshot = await load(join(local, entry, "first"));
      if (snapshot)
        candidates.push({
          snapshot,
          mtime: (await stat(snapshot.manifestPath)).mtimeMs,
        });
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    if (candidates[0]) return candidates[0].snapshot;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
