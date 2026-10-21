# Baseline audit and local runtime evidence

The audit reads the frozen `mega-blastoise/pokemon-tcg-data` commit `39a26a144c8b6ef6c2fb17b2c29d0bb7121e3a11` without changing that checkout. It creates draft artifacts and unapproved candidate evidence. It does not approve inventories, acquire images, contact an inference server, or publish anything.

## Reproduce

Build the packages with Bun 1.4.3, then run:

```sh
bun run build
NODE_BINARY=/path/to/node bun run test:catalog
```

`TCG_SOURCE_DIR` selects the source checkout; its default is `../pokemon-tcg-data`. `dataset-source.json` supplies the required full source and initial baseline commits. The source must be a clean Git repository root at the configured commit, descending from the frozen baseline. A wrong pin or dirty checkout fails.

Each run creates a fresh `.local/catalog-check-<uuid>/` directory containing two snapshots and `summary.json`. Nothing is overwritten. The complete records, field counts, query signatures, actual sizes, runtime versions, timings, and browser request counts are retained in that machine-readable report.

## Catalog and fidelity

The loader finds 176 sets and 20,635 unique cards. Every set has its matching card file. These counts are observations derived from the input, not hardcoded completeness gates.

| Meaningful source field | Cards containing it | Preserved normalized cards |
| --- | ---: | ---: |
| level | 2,404 | 2,404 |
| ancientTrait | 59 | 59 |
| resistances | 4,925 | 4,925 |
| attacks | 17,447 | 17,447 |
| abilities | 4,113 | 4,113 |
| rules | 6,345 | 6,345 |
| regulationMark | 8,360 | 8,360 |

The full raw-field inventory is included in `summary.json` and each snapshot's `reports/baseline.json`. Unknown source fields fail normalization so future fields cannot disappear silently. IDs, collector-number strings, printed text and symbols survive unchanged. In particular, `ex10-!` and `ex10-?` remain the two Unown identities with collector numbers `!` and `?`; neither character becomes an unsafe set-file path.

HP is normalized from numeric source strings to numbers. Unzoned set timestamps remain unzoned ISO representations with `updatedAtTimezone: null`. Legacy legality strings remain `reportedStatus` facts with `status: "unknown"`; this audit does not establish current tournament legality.

Source omissions remain visible: 1,611 cards omit artist, 295 omit rarity, and 191 omit legalities. Candidate printed-field receipts mark the artist/rarity omissions unresolved. A maintainer must resolve each printed-field omission or document its reviewed inapplicability before release. No omission is automatically treated as an approval or verification.

| Set | Reported total | Actual records |
| --- | ---: | ---: |
| sm10 | 234 | 238 |
| sm11 | 260 | 261 |
| smp | 250 | 251 |
| sve | 8 | 16 |
| svp | 75 | 165 |
| xy7 | 100 | 101 |

Declared totals are retained as source metadata. Reviewed inventories, including promo cutoffs, determine publication completeness. All initial set/card identities are derived from the frozen baseline, so a subsequent source commit cannot quietly publish a smaller catalog.

## What the integration check proves

Each run builds two standalone SQLite databases and generated browser views from the same normalized records. Database bytes and browser content-manifest hashes must match. Verification reads every normalized SQLite record and query column, compares them to the browser files and source baseline, checks references and integrity, and validates inventory/provenance and asset manifests.

The built Bun and Node native adapters and the built browser adapter then exercise:

- Full iteration over all 20,635 cards and 176 sets, comparing complete-record digests and meaningful field counts.
- Fifteen shared query cases covering pagination, default/natural/name ordering, literal text, Unicode/apostrophe normalization, type/subtype membership, supertype, rarity, regulation marks, and empty results.
- Full `me55`, `me55c`, and `ex10` set searches, plus ordered batch lookup of both punctuation IDs, a duplicate, and a missing record.

The browser adapter receives a filesystem-backed `fetch` function restricted to the selected commit's expected JSON paths. Its primary instance fetches 179 JSON resources during complete-catalog traversal with no duplicate requests. A separate fresh instance measures cold search, fetching nine resources without duplicates in that instance. Image URLs are data only; no remote image is loaded. This is adapter and payload verification, not a measurement of GitHub HTTP latency, real-browser execution, CORS, or hosted availability. The separate browser smoke is responsible for actual browser loading; local execution restrictions and any skipped checks must be reported separately.

## Measured local runs

Measured on macOS ARM64, October 19, 2026. The tested runtimes are Bun 1.4.3, Node 24.6.0, and Node 26.8.1. Both Node versions passed complete-record and query parity. Node 24.6.0 emitted its expected SQLite experimental warning; Node 26.8.1 emitted none during these runs.

Final runs used the current natural collector-number ordering and the browser lookup path that avoids loading the search index for a single record. Their local summaries are:

- `.local/catalog-check-b0c5667f-7010-4dd8-a990-d3d036b6c0cc/summary.json`, Node 24.6.0 matrix, 22:38:08 UTC.
- `.local/catalog-check-780f2863-b79f-41a5-a006-ab020d3b5b5d/summary.json`, Node 26.8.1 matrix, 22:38:44 UTC.

Cold lookup and cold search use separate fresh client instances; operating-system caches are not cleared. Warm lookups use 25 repeated calls. Warm search and synchronous call-return blocking use ten repeated `text: "draw cards", limit: 50` calls. Search returns 1,181 matching records in total. Initialization, validation, decoding, and iteration timings remain available separately in each summary.

| Runtime/adapter | Cold lookup ms | Warm lookup median ms | Cold search ms | Warm search median ms | Largest synchronous search call ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Bun 1.4.3, two runs | 1.25–1.94 | 0.027–0.035 | 23.21–28.19 | 20.23–30.82 | 22.47–105.82 |
| Browser adapter in Bun, local files | 8.87–9.06 | 0.029–0.034 | 105.53–113.89 | 7.35–7.48 | 0.042–0.049 |
| Node 24.6.0 | 2.18 | 0.039 | 21.00 | 18.74 | 23.07 |
| Node 26.8.1 | 1.97 | 0.041 | 22.20 | 16.69 | 19.98 |

Native searches execute synchronously despite the asynchronous public API. The observed Bun outlier is retained in the report; these small developer-machine batches do not establish a service latency guarantee or total event-loop delay. Full iteration took approximately 0.48–0.57 seconds natively and 1.19–1.21 seconds through the browser adapter after the earlier query work had warmed some caches.

| Artifact | Exact bytes | Locally computed gzip bytes |
| --- | ---: | ---: |
| SQLite | 87,285,760 | Not measured |
| Browser search index | 11,798,674 | 1,264,111 |
| Set metadata JSON | 290,426 | Not measured |
| All per-set card JSON | 54,655,291 | Not measured |
| Largest individual set JSON | 870,263 | Not measured |
| Minified browser bundle, including dependencies | 108,360 | 31,297 |

Gzip columns are local compression measurements, not verified HTTP transfer sizes. The primary browser traversal reads 66,760,790 uncompressed JSON bytes across its 179 resources; normal lookups and search pages load a subset.

Both matrix runs produced the same artifacts and complete-record iteration digest:

```text
SQLite SHA-256:          26ed4a72211ca6b32938c5ef8aa8cf8de538d908e194f42c968ac9c1e1fcd3d8
Browser manifest SHA:  e7da478255fe8141b849e96835847fe24c90ca39dcd07161c8b8bbdd5ca07098
All-card iteration SHA: c1a0c2a0b2daf90b08f54c54cecf3c3da22a5226d0153867f056c2cd9ec8c01a
```

Each matrix independently compared two builds. Rebuilds took approximately 2.89–2.97 seconds, including staged verification, on this machine. Determinism is scoped to the pinned builder/runtime/SQLite environment; it is not a promise of byte identity after changing those inputs.

## Release state

These artifacts explicitly have `releaseReady: false`. The frozen fork has no reviewed inventories/printed-field receipts, owned image mapping, or committed generated browser views. The local build reports 3,243 actionable release issues; it does not convert a successful audit into canonical approval.

Preparing locally release-eligible data requires the full initial catalog, approved inventory and printed-field receipts, checked owned asset bytes and origin mappings, committed generated browser content, and a pinned builder commit. The release publisher subsequently uploads and verifies immutable assets before npm publication. A local release-eligibility check alone does not establish that an image has been deployed.

Asset acquisition is explicit and resumable. It validates cached bytes, atomically checkpoints mappings every 32 downloads and on failure, records the remaining URLs, and resumes those URLs on retry. Changes to the source inventory, owned origin, or checked bytes reset approval. Mocked interruption/resume tests verify that a successful download is retained when the next request fails. No production asset acquisition was performed for this audit.

Snapshot replacement occurs after staged validation and retains the previous generated output as a backup. An accepted snapshot cannot be replaced with a draft; that attempt preserves the accepted directory and retains the draft evidence at a separate staging path. Unrelated existing directories are rejected as output targets.
