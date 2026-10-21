/** @module data_descriptor Locates the installed SQLite file and reads its snapshot manifest. */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { SnapshotManifest } from "@johto-ai/tcg-client/schema";

/** Paths resolve within this installed, independently versioned data package. */
export const databasePath = fileURLToPath(
  new URL("../data/pokemon-data.sqlite3.db", import.meta.url),
);
/** The release copies this file beside the database; it is not bundled into this module. */
export const manifestPath = fileURLToPath(
  new URL("../data/manifest.json", import.meta.url),
);

/** Loaded at runtime so release stamping never embeds a placeholder snapshot. */
export async function loadSnapshot(): Promise<SnapshotManifest> {
  // The client checks the schema and database hash before opening a connection.
  return JSON.parse(await readFile(manifestPath, "utf8")) as SnapshotManifest;
}
