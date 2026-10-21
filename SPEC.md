# Pokémon TCG Client — v1 specification

Status: approved; local software implementation delivered, production acceptance pending (see IMPLEMENTATION.md).
Date: 2026-10-19.
Working repository: mega-blastoise/pokemon-tcg-client.

The repository name is a working name. Creating the GitHub repository, publishing packages, deploying AWS resources, and implementing consumer migrations are separate from this specification.

## Outcome

Build a small, well-tested Pokémon TCG data system with three published packages:

| Package | Responsibility |
| --- | --- |
| @johto-ai/tcg-client | Typed card/set access in Bun, Node.js, and browsers; shared public schemas and query behavior. |
| @johto-ai/tcg-data | Independently versioned, prebuilt SQLite snapshot and portable snapshot metadata. |
| @johto-ai/tcg-tools | Bun-based maintainer CLI for import preparation, normalization, validation, evidence, asset preparation, and snapshot builds. |

The authoritative dataset remains mega-blastoise/pokemon-tcg-data. The new repository owns the software that maintains and serves that dataset.

The client provides a clean interface rather than reproducing the deprecated SDK. Johto is a future consumer, but Johto/MCP/Rust integration and migration are explicitly deferred.

## Agreed v1 boundaries

- English first, using the existing fork's historical catalog as the baseline and supporting future releases. The first dataset release must cover all 176 baseline sets.
- Bun and Node use their native SQLite APIs against the prebuilt dataset. Browsers fetch commit-pinned GitHub raw content.
- Prefer runtime-native Bun APIs where applicable; Node adapters use Node equivalents.
- Automatic adapter selection, backed by package exports that isolate native modules from browser bundles.
- Bun 1.4.3+; pin development, builds, and CI to 1.4.3. Node 24.6+ is the proposed Node floor carried forward from the runtime discussion. Target modern ESM-capable browsers.
- Normalized, strongly typed public data. Preserve canonical IDs, collector-number strings, printed text, and meaningful source fields.
- Class-based public client, created with PokemonTCGClient.createClientAsync(options), with cards/sets resources and an instance lifecycle.
- Metadata filters plus attack, ability, and rules-text search, with consistent results across runtimes.
- Sourced legality metadata and regulation marks. Unverified legality remains unknown; this package does not calculate tournament legality.
- Marketplace identifiers/links may be retained. Live pricing and price history are outside v1.
- Complete sets only in published snapshots. Drafts may be incomplete.
- Fixed expansions require their complete final inventory, including secret rares and alphanumeric collector numbers.
- Rolling promo series are complete against a reviewed inventory with an explicit cutoff date.
- Completeness counts canonical card identities. Known finishes/stamps may be optional variant metadata.
- Maintainer-triggered batch imports through a CLI. CI validates PRs; scheduled discovery is deferred.
- Structured imports first, initially from a pinned TCGdex repository commit.
- Ollama on the owner's DGX Spark is the preferred image-extraction fallback, conditional on an accuracy/repeatability evaluation.
- Failed local extraction requires manual completion in v1. It does not trigger a hosted model.
- Human review is required before canonical publication.
- Own card images, set symbols, and logos using private S3 behind CloudFront.
- Explicitly pinned dataset snapshots; client code and datasets release independently.
- Explicit release tags trigger simple GitHub Actions workflows, borrowing Johto's applicable release conventions.
- Browser loading uses caching and lazy fetches. Persistent offline synchronization is outside v1.
- Operational failures throw typed errors. Missing single records return null; a valid search with no matches returns an empty page.
- Trust existing fork content as the initial textual baseline, while auditing all records, references, inventories, and known defects.

## Engineering defaults proposed for the implementation

These make the agreed behavior concrete and are included in the final spec review:

1. Retain the fork's existing raw file layout. Add reviewed inventory/provenance sidecars and generated normalized browser views; avoid an unnecessary in-place rewrite of its historical storage format.
2. Commit browser JSON and its search index into the data fork in the same reviewed change as the canonical data. Both browser and SQLite outputs use one normalization/build implementation.
3. Create the public client through the static asynchronous PokemonTCGClient.createClientAsync factory. Keep its operations asynchronous even though the native SQLite operations are synchronous. This is a uniform interface, not a claim that native queries are nonblocking.
4. Start with deterministic lexical search, typed filters, stable sorting, and offset pagination. Share normalization and query semantics across adapters.
5. Publish client and tooling together in one code release stream. Give the data package its own release stream.
6. Use compiled ESM JavaScript and TypeScript declarations. Keep schemas usable without importing a native database adapter.
7. Choose the Ollama model during a bounded evaluation, not from an untested model recommendation.

## Repository structure

~~~text
pokemon-tcg-client/
  packages/
    client/
      src/                 public model, schemas, queries, adapters
      build.ts
      dist/                built JS and declarations
    tools/
      src/                 CLI, source adapter, normalization/build pipeline
      build.ts
      dist/                built CLI and declarations
    data/
      src/                 lightweight snapshot descriptor export
      data/                generated SQLite and release manifest
      build.ts
      dist/                built descriptor JS and declarations
  scripts/                 shared validation, version stamping, release helpers
  infra/                   parameterized S3/CloudFront/OIDC template
  .github/workflows/
    ci.yml
    release-code.yml
    release-data.yml
  dataset-source.json      exact authoritative fork commit for a data release
  bun.lock
  .mise.toml
~~~

Each executable/code package builds with Bun.build, external package dependencies, and a declaration-emission pass. Public exports resolve to built JS and declarations, never TypeScript source.

The data package contains data plus a small descriptor export. Rebuild/ingestion commands belong to tcg-tools, not tcg-data.

## Canonical data and snapshots

Keep canonical data in the fork's existing locations:

~~~text
sets/en.json
cards/en/<setId>.json
~~~

Add supporting files, with final path spelling treated as an implementation detail:

~~~text
inventories/en/<setId>.json
provenance/en/<setId>.json
provenance/imports/<batchId>/...
generated/v1/sets.json
generated/v1/cards/en/<setId>.json
generated/v1/search.json
generated/v1/assets.json
generated/v1/content-manifest.json
~~~

Inventories describe the expected canonical card IDs, the completeness policy, cutoff where applicable, and supporting sources. A set is release-ready only when its accepted records match that inventory. Legacy total/printedTotal fields alone are insufficient evidence of completeness.

Provenance identifies original source records, source commits/content hashes, transformations, image hashes, manual corrections, and extraction runs where used. Retrieval/observation time must not be represented as a verification date.

Generated browser files are derived and checked by CI. Mark them as generated for review tooling. A stale generated file fails validation.

The content manifest contains content hashes and schema/build information, but does not embed its own containing Git commit. After the fork commit is frozen, the npm release manifest records that final commit. This avoids a self-referential hash.

The data release input file in the new repository pins the fork to a full commit SHA and the generator/schema version. Releases never build from a moving branch.

### Release manifest

Include at least:

- Dataset npm version and schema version.
- Canonical fork repository and full commit SHA.
- Builder code version/commit and pinned build runtime/SQLite details.
- Actual set and card counts, derived from accepted records.
- Reviewed inventory and browser-content-manifest hashes.
- SQLite relative path, SHA-256, and required SQLite capabilities.
- Browser raw-content base URL containing the fork commit SHA.
- Asset-manifest hash and configured CloudFront asset origin.

Separate declared source totals from audited inventory counts. Search/page counts describe actual accepted records.

All published artifacts must agree on snapshot identity and normalized data. Preserve old snapshots and referenced immutable assets.

## Public model and API

Use one public model across adapters. At minimum:

- Card identity: id, setId, language, collector number, name.
- Card classification and values: supertype, subtypes, types, numeric-or-null HP.
- Evolution, abilities, attacks, rules, weaknesses, resistances, retreat costs.
- Artist, rarity, flavor text, Pokédex numbers, regulation mark.
- Legacy meaningful fields such as level and ancientTrait.
- Owned image URLs, sourced legality facts, provenance references, and optional verified variants.
- Set identity, name, series, release/update metadata, applicable printed totals, actual card count, inventory/completeness metadata, and owned symbol/logo URLs.

Normalize dates into documented ISO representations without inventing missing timezone information. Preserve unknown offsets explicitly rather than appending UTC to an unzoned source timestamp. Preserve string-valued damage expressions, symbols, collector numbers, and printed text. Do not convert alphanumeric collector numbers into numeric identity.

Use null/empty values according to documented applicability. Do not fabricate absent fields, turn an unknown legality into legal/illegal, or confuse a missing rule box with a card that has no rule box.

The raw fork's current fields must be audited against the full normalized schema so normalization does not silently drop fields.

Export the PokemonTCGClient class. Its static createClientAsync(options) method returns a Promise<PokemonTCGClient>; its constructor is non-public so runtime selection and snapshot initialization complete before the instance is returned.

Use composition: the instance owns readonly cards, sets, and snapshot properties, with resource objects backed by the selected runtime adapter. The instance's close() method releases its resources.

Agreed API shape:

~~~ts
const tcg = await PokemonTCGClient.createClientAsync(options);

const card = await tcg.cards.get("me1-3");           // Card | null
const cards = await tcg.cards.getMany(ids);         // aligned (Card | null)[]
const set = await tcg.sets.get("me1");              // Set | null

const page = await tcg.cards.search({
  setId: "me1",
  text: "draw cards",
  limit: 50,
  offset: 0,
});

const sets = await tcg.sets.list({ limit: 50, offset: 0 });

for await (const card of tcg.cards.iterate(query)) {
  // Same query semantics; bounded internal page loading.
}

const snapshot = tcg.snapshot;
await tcg.close();
~~~

The class factory and resource method names above are the agreed public API. Complete option, model, and result interfaces will be finalized together with the schema.

### Query semantics

- Initial card filters: name, setId, type, supertype, subtype, rarity, regulationMark, and printed card text.
- Text covers names and attack/ability/rules text. It is lexical search, with documented shared case/Unicode/whitespace normalization.
- Plain text is treated as literal terms, with all supplied terms required in the search document. It is not a Lucene expression.
- Different metadata filters combine with AND. Type/subtype filters test membership, not accidental substrings in serialized JSON.
- Retain original display text; search normalization must not rewrite it.
- Stable default ordering: set release date descending, natural collector-number order, then canonical ID as a final tie-breaker.
- Explicit name ordering is supported. Any additional ordering has the same final tie-breaker.
- Use one natural collector-number key so numbers such as 2, 10, 182a, and R behave consistently.
- Proposed page defaults: limit 50, maximum 250, nonnegative offset. Invalid parameters throw INVALID_QUERY.
- Pages expose items, total, limit, offset, and whether more results exist.
- Batch lookup preserves input order, duplicates, and explicit nulls for missing IDs.
- Freeze the snapshot for a client instance; page traversal cannot silently switch versions.

Build a compact browser search document/index from the same normalized data used by SQLite. Do not require advanced SQLite extensions or a separate search service to reproduce browser behavior.

### Errors

Provide a shared typed error with stable code, message, and cause where available. Distinguish configuration/missing-data-package errors, unsupported runtime/schema, snapshot mismatch/corruption, invalid query, transport failure, cancellation, and database failure.

Never convert fetch/parse/query failure into an empty result or an up-to-date claim. A missing record is a successful lookup returning null.

## Runtime adapters and packaging

### Bun

Use bun:sqlite read-only. Use native Bun facilities in Bun-only filesystem, build, and ingestion paths where applicable.

### Node

Use node:sqlite read-only behind the Node entry point. Node 24.6's SQLite module is experimental and warns on import; the implementation must test the exact supported minimum and newer supported Node versions, including native API evolution.

Do not expose native connection types through public declarations.

### Browser

- Fetch normalized JSON and the index from the authoritative fork's full commit SHA.
- Fetch the search index on demand, then load full records by set for the requested result page.
- Cache by snapshot identity and content hash; deduplicate concurrent identical requests.
- Keep a client instance on one snapshot. Cache entries from different snapshots cannot mix.
- Support a supplied fetch function and request cancellation.
- Report GitHub fetch/rate-limit/parse failures through typed errors.
- Do not require the SQLite npm payload in browser bundles.
- Verify real cross-origin GitHub fetching in a browser smoke test.

Browser consumers can pass an explicit snapshot descriptor, including a lightweight descriptor imported from tcg-data. Native consumers can resolve the installed optional data peer or use an explicit database path plus compatible manifest. An omitted browser descriptor is a configuration error, not a request for the latest branch.

Use conditional exports with types first, Bun before Node, a browser entry, and a browser-safe default. Direct browser ESM consumers use the documented browser entry/import map.

Separate entry points and import graphs are essential. A runtime if statement around a native module import does not isolate it from bundlers.

Publish an architecture-neutral SQLite file, finalized without required WAL/SHM sidecars. Record schema requirements and check native capabilities. Do not rely on the builder's newest SQLite-only features simply because Bun has a newer bundled SQLite.

## Ingestion and completeness

Ingestion means adding or updating set data in our fork. A maintainer starts the process; the tools prepare the data, and a person approves it before release.

1. **Choose the set and its checklist.** Establish exactly which card IDs belong in the finished set.
2. **Import the data and images.** Read a selected version of TCGdex, convert it to our format, and match its cards to our existing IDs. Show differences from approved fork data and preserve accepted values until a correction is reviewed.
3. **Fill in missing information.** Use qualified local Ollama extraction or manual entry. Keep unclear or conflicting details marked as unfinished.
4. **Check and review the whole set.** The CLI checks the checklist, card details, images, source records, and generated files. It prepares a draft pull request showing the changes and the evidence a reviewer needs.
5. **Approve, then release.** A person approves and merges the finished set. A separate tagged release builds a dataset from that exact approved Git commit.

The CLI provides small commands for importing, checking, preparing review reports, submitting PRs, building, and verifying data. PR submission is an explicit maintainer action. Failed checks stop the command and return a failure status; reports are readable by people and automation.

### What counts as complete?

- **A fixed expansion:** every card on its reviewed final checklist is present, including secret rares and alphanumeric collector numbers.
- **An ongoing promo series:** every released card on its reviewed checklist is present as of a recorded cutoff date.
- **Card identities are what count:** holo, reverse-holo, and stamp variations can be extra metadata; they do not each need a separate primary card record.

We check actual card IDs and information, not just the reported card count. For example, a checklist of 200 unique cards is not complete if the import contains 199 of them and a duplicate.

Required printed information must be resolved before release. An unreadable attack is unfinished; a field that does not apply to that card is fine. Tournament legality may remain explicitly unknown.

If a set is incomplete, it stays in draft. The previously published version remains available until the finished update is approved and released.

### TCGdex adapter

Start with a pinned source-repository adapter, rather than requiring its hosted API or full multi-language compiler build.

Audit source syntax and fields before implementing the importer. Parse supported data structures without executing arbitrary upstream TypeScript or evaluating imported code.

Use explicit source-set/source-card crosswalks and retain them for review. New canonical IDs follow the fork's established conventions and require review; never rename existing IDs to match a provider.

Specific required fixtures:

- me01 to canonical me1.
- 30th to me55, including alphabetic R/G/B identities.
- 30th-c to me55c with an explicit Classic Collection crosswalk.
- Multiple LEGEND halves sharing a name.
- Promos and source-only finish/stamp variants.
- Rule-box omissions and erroneous evolution/stage values.

TCGdex is an import source, not an authority that silently overwrites the fork. Missing rule boxes, conflicts, and unsupported source constructs require completion/review. Retain source attribution and applicable notices.

### Initial catalog

Import the existing fork as the accepted textual baseline. Audit all records and preserve identities and content through normalization. Review identified anomalies rather than retranscribing the whole catalog.

Audit schema, duplicates, references, inventories, declared totals, legalities, all source fields, and asset availability. Prepare reviewed inventories for the initial release. An incomplete baseline set blocks the first dataset release until resolved.

The first dataset release must include all 176 sets present in baseline fork commit 39a26a144c8b6ef6c2fb17b2c29d0bb7121e3a11, with their full reviewed inventories and owned assets. Derive the required set/card identities from that frozen baseline and the reviewed inventory files. A complete subset is insufficient. Client implementation can proceed against fixtures while the full-catalog audit and asset mirroring run.

Observed research counts are 176 sets and 20,635 cards. These are a baseline observation, never hardcoded validation constants.

## Ollama extraction

V1 targets a configurable local Ollama endpoint on the owner's DGX Spark. Use its native vision/schema-output API. Select a model only after evaluation on that machine.

Extraction returns a draft and issues, not an automatically verified card. Supply known set/identity context from the import; do not ask the image model to invent release dates, set totals, legalities, or repository identity.

Persist:

- Original image bytes/hash and any deterministic preprocessing/crop recipe.
- Source context and source version/hash.
- Model name and verified installed model digest/quantization.
- Ollama and relevant runtime/driver versions.
- Prompt/schema hashes, generation settings, seed, and limits.
- Raw response, normalized candidate, validation issues, and human corrections.

Verify the installed model's digest/capabilities before extraction. Do not assume a mutable model tag is a pin, or that digest-addressed model invocation is supported.

Reuse recorded outputs for identical extraction inputs. Snapshot builds consume reviewed JSON and never invoke a model.

### Required qualification work

Create a manually checked corpus of approximately 50 representative cards spanning eras, layouts, card types, dense text, symbols, multiple attacks/abilities, promos, and alphanumeric numbers.

Measure schema success, identity/number correctness, critical-field exactness, full-card text/symbol accuracy, omissions, fabricated values, human correction time, throughput, and memory. Repeat fixed inputs across warm/cold runs, restarts, and intended concurrency; compare normalized records separately from raw formatting.

The evaluation work must propose explicit pass/fail criteria for repeatability, field accuracy, schema validity, and review effort. The maintainer accepts the criteria and model/configuration qualification report before bulk extraction is enabled. Persist the criteria and results with the qualified configuration.

The qualification report must state observed repeatability and limitations. Fixed seeds, temperature zero, and schema-constrained output alone do not establish accurate deterministic transcription.

Enable bulk extraction only for an explicitly qualified model/configuration. If no configuration qualifies, the structured/manual ingestion path remains usable. No hosted inference, model download, or paid fallback is automatic.

## Asset storage

Use a private S3 bucket with public access blocked and CloudFront Origin Access Control. Serve public assets through CloudFront.

- Content-hashed immutable asset keys; preserve original image bytes where practical.
- Retain provenance and checksums, with optional verified small/large derivatives.
- Keep image binaries out of Git and npm.
- Candidate image bytes must survive review through a staging/evidence mechanism; publish accepted assets from those checked bytes.
- Restrict CloudFront access to the public asset prefix if the bucket also holds private staging/evidence.
- Retain assets referenced by old snapshots. Do not sync-delete the shared historical archive.
- Immutable asset caching; a changed image receives a new URL.
- Use appropriate MIME types and cross-origin read headers.
- Verify required assets before publishing a referencing dataset.

Use a parameterized infrastructure template and GitHub OIDC deployment credentials. Domain/certificate configuration is optional until a domain is selected. No account IDs, ARNs, bucket names, distribution IDs, or domains are assumed.

## Releases: simple GitHub Actions

Use two tag streams, with working tag names:

| Stream | Tag | Publishes |
| --- | --- | --- |
| Code | tcg/vX.Y.Z | tcg-client and tcg-tools |
| Data | tcg/data-vX.Y.Z | tcg-data |

Borrow Johto's independent data stream, tag-based version stamping, build-artifact handoff, and publishing preflights. Do not reproduce its platform-binary matrix for this JavaScript library.

Keep source package versions at 0.0.0 and stamp built package versions from the matching tag. Rewrite workspace dependency ranges appropriately before packing. Declare compatibility deliberately and enforce data schema compatibility at runtime.

Use a small dry-run-first release helper, bounded preflights, changelog notes, and straightforward workflows. Avoid a custom release orchestration framework.

### Code release

Validate tag/source, install the frozen lockfile with pinned Bun, check types/lint/tests, build JS/declarations, pack packages, and smoke-test the packed exports in supported runtimes and a browser bundle. Publish exactly those artifacts with provenance.

### Data release

1. Validate the explicit tag and pinned fork SHA.
2. Check out the pinned fork and pinned builder/toolchain.
3. Validate inventories, identities, provenance, schemas, and generated browser outputs.
4. Build SQLite in a fresh staging location within a transaction.
5. Validate integrity, references, actual counts, source-to-output fidelity, and manifest hashes.
6. Finalize the standalone database and demonstrate deterministic rebuilds in the pinned environment.
7. Upload the validated package/asset outputs as CI artifacts.
8. In the publish job, publish/verify approved immutable assets first.
9. Publish the already-validated data npm artifact and release metadata.

Do not delete an existing good database before validating its replacement. Do not ignore duplicate insertions or report attempted rows as successful inserts.

Use deployment/release concurrency, restricted GitHub environments, and scoped OIDC roles. Configure trusted npm publishing/provenance through supported GitHub/npm mechanisms during setup.

On failure, keep existing snapshots and assets intact and report the failed stage. Dataset consumers change versions through an explicit dependency/configuration update.

## Work packages and acceptance

| Work | Deliverable | Acceptance |
| --- | --- | --- |
| 1. Foundation | Three-package Bun workspace, exports, shared model/schema and manifests. | Built JS/declarations only; browser import graph excludes native modules; schema compatibility is explicit. |
| 2. Baseline and normalization | Fork loader, field audit, inventories, provenance, full normalized output. | No IDs or meaningful fields lost during normalization; known anomalies resolved; complete-set gates pass; counts derived from input; all 176 baseline sets are ready for the first dataset release. |
| 3. Snapshot builder | Browser views/index and SQLite from one pipeline. | Same normalized records across outputs; repeatable bytes in the pinned build environment; integrity checks; no required sidecars. |
| 4. Universal client | Bun/Node/browser adapters, queries, caching, typed errors. | Shared fixture queries return identical IDs, order, counts and records; correct null/error behavior; lazy browser request behavior. |
| 5. Structured ingestion | Maintainer CLI and pinned TCGdex adapter. | Explicit mapping fixtures pass; unresolved conflicts remain drafts; incomplete sets cannot publish; PR evidence is reviewable. |
| 6. Local extraction qualification | Spark/Ollama evaluation and extraction adapter. | Reproducible experiment/evidence; accuracy and repeatability report; qualified configuration or documented manual path. |
| 7. Assets | S3/CloudFront template, content-addressed mirroring and verification. | All initial published references resolve to owned assets; checksums/provenance recorded; old references remain available. |
| 8. Releases and docs | Small Actions flows, version stamping, pack/install tests, usage/maintainer guides. | Code/data release independently from tags; exact artifacts tested/published; failure preserves prior release. |

Foundation precedes builder/client work. The baseline, source adapter, and Ollama evaluation can progress independently once shared schemas exist. A data release depends on complete inventories and available assets.

Measure browser payload size, cold/warm lookups and search, native query blocking, and import/review time. Record actual baselines and address demonstrated bottlenecks before adding workers, services, or alternate search engines.

## Completion checklist

- The first dataset release covers all 176 baseline sets with full reviewed inventories and owned assets.
- All three runtime paths operate against one selected snapshot with matching observable query results.
- Node's experimental SQLite status is documented and its supported versions are exercised in CI.
- Browser consumers can use the package without bundling SQLite or server modules.
- IDs, alphanumeric numbers, symbols, rules, resistances, level, and ancientTrait survive normalization.
- No incomplete set, unresolved required printed field, or duplicate identity can publish.
- Legality uncertainty remains visible; pricing is not silently inherited as current data.
- Every published image/logo/symbol reference uses owned, verified immutable hosting.
- A pinned snapshot rebuild does not contact an AI provider or mutable upstream data.
- Ollama extraction is qualified experimentally; manual completion is a working fallback.
- Code and data npm packages release independently through simple tag-triggered Actions.
- Johto/Deckvault consumer migrations remain a subsequent specification.

See [RESEARCH.md](RESEARCH.md) for evidence, source caveats, and existing-pipeline findings.
