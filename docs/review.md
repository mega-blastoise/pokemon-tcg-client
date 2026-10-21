# Source review guide

The client reads one fixed dataset. Maintainer tools prepare the next dataset; they never update an open client or publish data as a side effect.

The basic path is fork JSON → checked records → SQLite and browser JSON → the same client API. Images live separately at content-hashed URLs. Code and data have independent package versions.

## Reading order

| Review question | Start here | What to check |
| --- | --- | --- |
| What does a caller receive? | [schema.ts](../packages/client/src/schema.ts), [client.ts](../packages/client/src/client.ts), [query.ts](../packages/client/src/query.ts) | Record shapes, nulls, ordering, filters, paging, cancellation, and close behavior. |
| How does each runtime read it? | [bun.ts](../packages/client/src/bun.ts), [node.ts](../packages/client/src/node.ts), [browser.ts](../packages/client/src/browser.ts), then their stores | Entry points keep native imports out of browser builds. SQLite and browser searches share query rules. |
| How do existing records become a snapshot? | [baseline.ts](../packages/tools/src/baseline.ts), [normalize.ts](../packages/tools/src/normalize.ts), [inventory.ts](../packages/tools/src/inventory.ts), [snapshot.ts](../packages/tools/src/snapshot.ts) | Source pin, preserved identities, complete sets, required printed fields, and matching output formats. |
| How are new records reviewed? | [tcgdex.ts](../packages/tools/src/tcgdex.ts), [review.ts](../packages/tools/src/review.ts), [ollama.ts](../packages/tools/src/ollama.ts) | Explicit identity mapping, accepted-value preservation, draft proposals, and evidence tied to exact inputs. |
| What can leave this machine? | [assets.ts](../packages/tools/src/assets.ts), [stamp-release.ts](../scripts/stamp-release.ts), [release.ts](../scripts/release.ts) | Local staging versus explicit acquisition, PR submission, asset upload, and npm publication. |

Every handwritten TypeScript file starts with `@module module_name purpose`. Function comments state the contract; variable comments explain state that is easy to misread. Types and straightforward assignments speak for themselves.

## Client behavior

`PokemonTCGClient.createClientAsync()` validates storage before returning a client. Its resources keep lookup, search, and iteration behavior separate from storage. The data package only locates its adjacent manifest and database; the client validates them.

Native stores open a read-only SQLite snapshot. The browser checks a small content manifest, then downloads set records and search metadata as needed. It checks file hashes before trusting JSON. Returned records are copies, so callers cannot change cached data.

Two callers may share one browser download. Cancelling one caller stops that caller's wait; it stops the download only if nobody else needs it. Closing the client stops all downloads. The waiter count in `browser-store.ts` exists for this distinction.

## Data acceptance

An inventory answers “which card identities belong in this complete set?” A printed-field receipt answers “is the required printed information resolved, or genuinely absent?” Neither a source count nor a model response answers both questions.

The importer writes drafts, not canonical fork files. Existing accepted values stay in place until a correction is reviewed. Resolution receipts include the proposal hash, so editing a proposal makes an older receipt insufficient.

`buildSnapshot()` stages output, validates it, and only then replaces the destination. A failed build preserves the previous output. `verifySnapshot()` separately recomputes hashes and compares SQLite with browser records; it does not accept the build report as proof.

There are two manifests. The browser content manifest hashes generated files. The outer snapshot manifest pins the final fork commit and database. Keeping the final commit out of generated records avoids requiring a commit to contain its own hash.

Ollama produces draft printed fields and retained evidence. Scoring compares expected fields with model results; it does not establish repeatability or approve a model. Bulk extraction requires a separately approved qualification receipt for the exact configuration.

## Release boundaries

Preparation makes checked tarballs and a hash list. A separate privileged job checks and publishes those same bytes; it does not rebuild them. This second check matters because the files crossed a job boundary.

Local asset checks establish that reviewed bytes exist. Publication creates missing immutable S3 objects and verifies their CloudFront responses before publishing a dataset that references them. Changed bytes get new URLs; old published objects are not removed.

These are the areas with the most moving parts: shared browser cancellation, snapshot replacement and verification, model qualification, and the release handoff. Review their checks before their helper functions. None should silently turn a draft into an approval.

## Checks to run

Use the pinned Bun version from `.mise.toml`.

```sh
bun run check
bun run test
```

`check` builds all packages, checks types, and runs lint/format checks. Tests cover client behavior, ingestion/review, snapshots, model extraction with a local fake server, and release guards.

`bun run test:catalog` additionally builds and compares the full pinned catalog across adapters. `bun run smoke` tests installed package archives and real Chromium, including a separate live GitHub fetch. Passing unit tests or a fake browser fetch is not a substitute for that browser check.

For commands and setup details, use [maintainers.md](maintainers.md) and [releases.md](releases.md). For known verification limits and first-release prerequisites, use [IMPLEMENTATION.md](../IMPLEMENTATION.md).
