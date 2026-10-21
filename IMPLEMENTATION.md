# Implementation handoff

Date: 2026-10-19. Status: local software implemented; first production data release is **not ready**.

The new project is in `pokemon-tcg-client/`. It has not been initialized/pushed as a Git repository, deployed, or published. The existing `deckvault` and `pokemon-tcg-data` repositories remain unchanged and clean. Johto/Deckvault migration is out of scope.

## Delivered

- Three built ESM/declaration packages: client, data descriptor, and maintainer tooling.
- Class-based `PokemonTCGClient.createClientAsync`, native Bun/Node SQLite adapters, browser-safe conditional exports, shared queries, typed errors, cancellation and lifecycle.
- Browser single-card lookups load only set metadata and the matching set; searches lazily load the hash-checked index. All URLs remain pinned to one fork commit.
- Full-catalog normalization, unapproved inventory/provenance candidates, deterministic standalone SQLite/browser builds, record/query parity verification, and release gates that preserve prior good output.
- Safe literal TCGdex ingestion, explicit identity crosswalks, retained provider evidence/conflicts, proposal-bound manual resolutions, complete-set validation, review reports, and explicit dry-run-first draft PR submission.
- Local-only Ollama probing/extraction, installed digest/version/capability checks, evidence/caching/retry preservation, corpus scoring, and an approval-bound bulk-extraction gate. Snapshot builds never invoke inference.
- Content-addressed image acquisition/verification, private S3/CloudFront OAC + OIDC template, independent code/data Actions streams, exact-artifact package smoke checks and immutable asset publication preflights.

The AWS release skill informed private hosting and scoped OIDC configuration. Its static-site deletion pattern is deliberately not used: the approved immutable card archive retains old assets. The Playwright skill informed strict real-browser smoke coverage; sandbox restrictions do not turn failed checks into passing ones.

## Verified locally

Run with pinned Bun 1.4.3:

```sh
bun install --frozen-lockfile --offline
bun run check
bun run test
NODE_BINARY=/path/to/node-24.6.0 bun run test:catalog
NODE_BINARY=/path/to/node-26.8.1 bun run test:catalog
bun run smoke
```

The frozen source catalog contains 176 sets and 20,635 cards. Complete native/browser-adapter/Node record digests and query results agree; two builds are byte-identical in the pinned environment. Historical punctuation IDs and IDs independent of printed numbers are covered. See [the catalog audit](docs/baseline-audit.md) for measured sizes/timings and caveats.

Built, packed automatic imports and default installed-data resolution passed under Bun 1.4.3, Node 24.6.0 and Node 26.8.1. Browser bundle checks reject native modules and the SQLite data package. Unit/integration checks cover corruption, incomplete sets, missing/duplicate identities, source pins, unsafe AST expressions, stale resolutions, extraction failure evidence, artifact tampering and refused unauthorized publication.

Final local verification: `bun run check` passed; `bun run test` passed **55 tests / 223 assertions**; frozen offline dependency installation and workflow YAML parsing passed.

`bun run smoke` does **not** fully pass in this session: Chromium cannot launch under the sandbox's MachPort restrictions. The real Chromium fixture test and separate unrouted, commit-pinned GitHub CORS probe are implemented but remain unverified locally. CI installs Chromium and runs both; no browser check is silently skipped. The full-catalog browser-adapter audit uses a filesystem-backed fetch, not real HTTP.

## Required owner inputs/actions

1. Create/connect the intended GitHub repository and run CI in an environment that permits Chromium. No remote, tag, PR, or npm publication has been created automatically.
2. Review the entire initial catalog's candidate inventories and printed-field receipts. `.local/baseline-audit/` contains unapproved candidates. Six reported-total discrepancies, 1,611 missing artist fields, and 295 missing rarity fields need review; 191 absent legality objects remain explicitly unknown and are allowed.
3. Select/deploy owned asset hosting and review/acquire the checked bytes. `.local/asset-plan/` lists 41,622 distinct required image/logo/symbol URLs; zero were downloaded or approved here. Provide the pinned accepted asset artifact and real GitHub/AWS/npm release configuration described in [releases.md](docs/releases.md).
4. Review/commit generated browser views with the canonical changes, merge the complete accepted catalog, then pin its final full commit for the first data release. A complete subset is insufficient.
5. For bulk AI extraction, provide the DGX Spark's local Ollama endpoint, installed model/version/digest, checked corpus and qualification measurements. No model has been downloaded or qualified here. Structured/manual completion works without AI qualification.

Read [maintainers.md](docs/maintainers.md) for concrete commands and [releases.md](docs/releases.md) for external setup. None of these human reviews or external deployment results has been fabricated to satisfy a release gate.
