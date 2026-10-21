/** @module sqlite_schema Defines the portable SQLite layout shared by builders and readers. */

/** Embedded snapshot identity key; its value excludes the database's own hash. */
export const SQLITE_METADATA_KEY = "identity";
/** Store complete JSON beside indexed fields, with foreign keys and no required search extension. */
export const SQLITE_SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE snapshot_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE sets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  series TEXT NOT NULL,
  release_date TEXT NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data))
) STRICT;
CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  set_id TEXT NOT NULL REFERENCES sets(id),
  normalized_name TEXT NOT NULL,
  supertype TEXT NOT NULL,
  types TEXT NOT NULL CHECK (json_valid(types)),
  subtypes TEXT NOT NULL CHECK (json_valid(subtypes)),
  rarity TEXT,
  regulation_mark TEXT,
  number_key TEXT NOT NULL,
  release_date TEXT NOT NULL,
  search_text TEXT NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data))
) STRICT;
CREATE INDEX cards_set_id ON cards(set_id);
CREATE INDEX cards_default_order ON cards(release_date DESC, number_key, id);
CREATE INDEX cards_name_order ON cards(normalized_name, number_key, id);
`;
