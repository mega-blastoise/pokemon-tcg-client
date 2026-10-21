# Research supporting the v1 specification

Reviewed on 2026-10-19. Findings describe observed source snapshots, not guarantees of continuing upstream availability.

## Local snapshots

| Repository | Reviewed commit | Observations |
| --- | --- | --- |
| deckvault | ed4768f16c3a12a43123cada7f37ddb6555984be | Clean worktree; JSON and canonical SQLite both contain 174 sets / 20,444 cards. |
| pokemon-tcg-data | 39a26a144c8b6ef6c2fb17b2c29d0bb7121e3a11 | Clean master checkout; 176 sets / 20,635 cards, English only. Origin is the mega-blastoise fork. |

The fork has 176 matching card files, 83 theme-deck files, no duplicate card IDs, and no card/set file association gaps in the measured snapshot. It contains no maintained scraper, schema, validator, CI, or publishing package. The Ruby executable is a legacy V2-to-V1 converter.

The card files are bare arrays. Set association comes from the filename; cards do not embed a set object. No card contains pricing.

Observed optional-field omissions include artist on 1,611 cards, rarity on 295 cards, and legalities on all 191 me55/me55c cards. These omissions are not automatically invalid records. All raw field names were inventoried; level and ancientTrait must survive normalization alongside resistances and the more common fields.

Six sets have reported totals different from record counts: xy7, smp, sm10, sm11, svp, and sve. Variants/promos explain some differences. A metadata total cannot independently prove completeness.

Images are URLs, not stored assets:

- 19,783 cards reference images.pokemontcg.io.
- 852 cards reference images.scrydex.com.
- Newer set logos/symbols also reference Scrydex.

The exact shutdown or access policy of these image hosts was not established. Their current use is sufficient to identify the external asset dependency.

## Deckvault pipeline

Relevant local paths, relative to deckvault:

| Path | Finding |
| --- | --- |
| .gitmodules | Configures the mega-blastoise data fork, master, shallow clone. Its local submodule directory is empty in this checkout. |
| apps/scripts/lib/fork-sync/index.js | Reads fork arrays, embeds set objects, rewrites JSON, and preserves old pricing blobs or substitutes null. |
| packages/@pokemon-data/index.js | Bun-only local JSON loading; missing set files can return an empty array. |
| apps/scripts/lib/database/sqlite.js | Incremental seeding with validation and hardcoded counts; gated by an environment variable and working-directory-relative paths. |
| packages/@database/lib/sqlite.ts | INSERT OR IGNORE ignores corrections to existing IDs. Older schema has field omissions and legacy serialization choices. |
| dist-packages/card-data/scripts/rebuild.ts | Separate full rebuild implementation; deletes old output first, uses WAL, and lacks a whole-build transaction/validation boundary. |
| dist-packages/card-data/scripts/cards.ts | Increments counts for attempted inserts despite INSERT OR IGNORE; omits resistances and other source fields. |
| dist-packages/card-data/scripts/schema.sql | Includes an unrelated users table and runtime timestamps, undermining a deterministic data artifact. |
| apps/cron/src/jobs/sync/ | Inserts missing local rows; does not acquire new source data or refresh existing records. |
| docsites/database/docs/card-data-pipeline.mdx | Documents the dual writers, stale correction behavior, manual constants, and replication debt. |

Read-only SQLite inspection reported integrity OK, 174 sets, and 20,444 cards. The database still stores me3.updated_at as 2026/003/26 15:00:00 while the JSON documents the corrected date.

The legacy db:sync command writes PostgreSQL and Neo4j, not this SQLite artifact. Legacy json:sync writes a separate directory. Neither is the current fork-to-SQLite pipeline.

The custom HTTP client is packages/@clients/lib/models/PokemonTCGClient.ts. It hardcodes the retiring API and its getAllSets pagination does not increment the returned page. Its shared types use loose any fields and differ from actual data, including collector-number and Pokédex types.

## Public API and SDK

The [official API notice](https://docs.pokemontcg.io/api-reference/cards/search-cards/) states that existing keys continue through March 1, 2027 and new registrations are closed.

The [upstream data README](https://github.com/PokemonTCG/pokemon-tcg-data#readme) already says routine card-data updates are no longer a focus. March 1 is the API shutdown date, not a commitment to continue routine dataset updates until that date.

The [JavaScript SDK](https://github.com/PokemonTCG/pokemon-tcg-sdk-javascript) is a thin Axios/qs transport wrapper:

- Default singleton with card/set/type/subtype/rarity/supertype resources.
- find, where, and all methods; hardcoded API v2 host.
- No data ownership, ingestion, schema enforcement, or local database.
- Its all method can swallow failures and has paging defects.
- Legacy packaging provides CJS/ESM/UMD without a modern typed export contract.

[SDK query implementation](https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-sdk-javascript/master/src/queryBuilder.js), [manifest](https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-sdk-javascript/master/package.json).

The API's Lucene-like query language is server functionality, not implemented by this SDK. The interview explicitly chose a new typed interface.

## Structured sources

### TCGdex: selected first adapter

The [repository](https://github.com/tcgdex/cards-database) provides structured source data. Its full compiler/build includes additional remote processing; a bounded importer should audit/parse the source structures it actually needs.

Research observed the [30th Celebration merge](https://github.com/tcgdex/cards-database/commit/9f90a62ec32ec00cd4ca3059f5ee9d61eae85a1c), covering 161 Celebration cards and 30 Classic cards, matching the fork's corresponding counts.

Important mappings:

| TCGdex | Canonical fork | Implication |
| --- | --- | --- |
| me01 / 003 | me1-3 | Explicit set mapping and canonical number preservation. |
| 30th-001 | me55-1 | Approved source-to-canonical mapping. |
| 30th-R | me55-R | Alphabetic identity must survive. |
| 30th-c-001, Charizard | me55c-4 | Collector numbering is different; an explicit crosswalk is required. |
| 30th-c-019 / 020 | me55c-99 / 100 | Name matching cannot distinguish the two LEGEND halves. |

[Classic Charizard source](https://raw.githubusercontent.com/tcgdex/cards-database/master/data/Mega%20Evolution/30th%20Classic%20Collection/001.ts), [Classic Raikou source](https://raw.githubusercontent.com/tcgdex/cards-database/master/data/Mega%20Evolution/30th%20Classic%20Collection/012.ts).

Observed fidelity gaps include rule-box omissions and incorrect evolution/stage data. [Reported 30th defects](https://github.com/tcgdex/cards-database/issues/2371), [example card](https://github.com/tcgdex/cards-database/blob/master/data/Mega%20Evolution/30th%20Celebration/021.ts), [compiler card model](https://raw.githubusercontent.com/tcgdex/cards-database/master/server/compiler/utils/cardUtil.ts).

These sources justify reviewed imports and explicit conflicts, not automatic replacement of accepted fork content. Retain attribution and the applicable [source license](https://raw.githubusercontent.com/tcgdex/cards-database/master/LICENSE).

### Alternatives investigated, deferred

- [Malie](https://malie.io/static/index.html) exposes PTCGL metadata and image references. The observed [manifest](https://cdn.malie.io/file/malie-io/tcgl/export/index.json) had 158 main Celebration entries, 3 Mews, and zero Classic entries; actual current card payload downloads could not be verified through the research browser. Its [draft format](https://malie.io/static/draft/html/pkproto_sv.html) excludes errata.
- [TCGCSV](https://tcgcsv.com/) provides marketplace product data, which is not automatically a complete card-rules dataset.
- [PkmnCards](https://pkmncards.com/about/) provides readable cards/images but no bulk database/API.
- [Limitless](https://limitlesstcg.com/about) has useful coverage; its documented API is principally tournament data.
- Official [checklists](https://assets.pokemon.com/assets/cms2/pdf/trading-card-game/checklist/mew_web_cardlist_en.pdf) can corroborate inventory but do not supply full attack metadata.

Official legality/errata sources are separate from printed-image transcription: [rotation announcement](https://www.pokemon.com/us/pokemon-news/2026-pokemon-tcg-standard-format-rotation-announcement), [promo eligibility](https://www.pokemon.com/uk/play-pokemon/about/pokemon-tcg-promo-card-legality-status), [errata](https://play.pokemon.com/en-gb/resources/documents/tcg-errata/).

## Runtime evidence

[Bun 1.4.3 release notes](https://bun.com/blog/bun-v1.4.3) identify the current stable release, published October 10, 2026. The interview selected 1.4.3+ with an exact development/CI pin.

[Node 24.6 SQLite](https://nodejs.org/download/release/v24.6.0/docs/api/sqlite.html) provides unflagged read-only native SQLite APIs but labels the module active development/experimental. [Node 22.13](https://nodejs.org/en/blog/release/v22.13.0) originally removed the flag requirement. Newer native API changes must stay inside the adapter.

[Conditional exports](https://nodejs.org/download/release/v24.6.0/docs/api/packages.html#conditional-exports) are order-sensitive. [Bun module resolution](https://bun.com/docs/runtime/module-resolution) recognizes Bun and Node conditions, so place Bun before Node.

[Bun SQLite platform behavior](https://bun.com/docs/runtime/sqlite) means the runtime version does not by itself pin every host's SQLite implementation. Validate required capabilities; publish a portable finalized file. [SQLite STRICT tables](https://www.sqlite.org/stricttables.html), [JSON functions](https://www.sqlite.org/json1.html), and [FTS5 build options](https://www.sqlite.org/fts5.html) explain why advanced features should not be assumed across all readers.

No runtime conformance tests against Bun 1.4.3 or Node were run during this specification work.

## Local vision feasibility

[Ollama vision](https://docs.ollama.com/capabilities/vision) accepts image inputs. [Structured outputs](https://docs.ollama.com/capabilities/structured-outputs) support JSON Schema and demonstrate vision plus temperature zero.

[Seed parameters](https://docs.ollama.com/modelfile#valid-parameters-and-values) control sampling. Their documented behavior is not measured card-transcription accuracy or a guarantee across software/hardware changes.

[Model listing](https://docs.ollama.com/api/tags) exposes model digests; [model details](https://docs.ollama.com/api-reference/show-model-details) expose capabilities and metadata. Check the installed model rather than treating a tag as immutable.

NVIDIA documents [Ollama on DGX Spark](https://build.nvidia.com/spark/open-webui/overview); Ollama published [Spark performance measurements](https://ollama.com/blog/nvidia-spark-performance). These establish platform feasibility, not Pokémon extraction suitability.

No inference, model downloads, or DGX access occurred during research. The qualification work remains an explicit implementation deliverable.

## Johto patterns and deferred migration

Applicable local patterns:

- dist-packages/cli/package.json: separate card-data peer and platform launcher packages.
- dist-packages/cli/lib/resolve.js: discovers the installed data package and passes its path.
- scripts/changes-config.ts: independent data release cohort.
- scripts/stamp-release-versions.ts: tag-derived package stamping.
- .github/workflows/release-card-data.yml: separate data build/publish artifact flow.

Reuse the package separation, independent releases, and artifact handoff. Platform-specific executable packages do not apply to this universal JS client.

Migration findings retained for later: Johto's functional card queries go through a Rust MCP SQLite reader; the CLI doctor queries SQLite directly. Existing sync-data is a no-op without rebuild, has an executable-name mismatch on rebuild, and does not pass its resolved output path. Rust pricing still calls the retiring API. None of these consumer changes is part of v1 implementation scope.

## Skill influence

The requested [grilling skill](/Users/nickgalante/.codex/skills/grilling/SKILL.md) governed the one-question-at-a-time interview and final shared-understanding confirmation.

The [AWS static-site release skill](/Users/nickgalante/.codex/skills/aws-static-site-release/SKILL.md) informed private S3, CloudFront OAC, GitHub OIDC, artifact-based deployment, and cache policy. Its replace-a-site sync/delete pattern is not appropriate for the immutable historical asset archive specified here.
