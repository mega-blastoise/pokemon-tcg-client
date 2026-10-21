# Maintainer workflow

Use Bun 1.4.3 and run `bun run build` first. Commands below run the built tooling, not source entry points. Failure returns a nonzero exit code and a machine-readable error/report. Exit 2 means a draft still has validation issues; exit 1 means an operational/configuration failure.

## Audit the full initial catalog

```sh
bun packages/tools/dist/cli.js audit --source ../pokemon-tcg-data --output .local/baseline-audit
bun run test:catalog
```

`dataset-source.json` pins the clean source checkout and the frozen initial baseline. Use `--source-config FILE` for another explicit pin. Audit output includes all field counts, count anomalies, and **unapproved** candidate `inventories/en/*.json` and `provenance/en/*.json`. Existing text is the baseline; omitted fields need a reviewed applicability decision, not whole-catalog retranscription. Unknown legality is allowed and never becomes a current ruling merely because it was present in legacy data.

Inventory review establishes the real identities, not a count. Fixed sets include the full final checklist; rolling promos need an ISO cutoff date. Inventory `review` records `approved`, `reviewedBy`, and an ISO `reviewedAt` with timezone. Printed-field receipts separately record unresolved fields, reviewed inapplicability, and source evidence. A candidate receipt starts unapproved. Never mass-toggle approval without the corresponding review.

Canonical IDs and printed numbers are independent strings. Preserve `ex10-!`, `ex10-?`, `cel25c-15_A1` (printed number `15`), and `me55c-106p` (printed number `106`). Do not construct identity from name or number. All initial baseline sets/IDs remain required; publishing a complete subset is not allowed.

## Import a complete English set

1. Obtain a local TCGdex checkout containing the selected full commit.
2. Prepare an explicit reviewed crosswalk: source repository/commit, source set and directory, canonical set, source-number → canonical-ID/printed-number entries, and a review receipt. Use `variantOf` only for a source finish/stamp record that maps to an existing primary. See [the unapproved example](../examples/crosswalk.json).
3. Import into a fresh local batch:

```sh
bun packages/tools/dist/cli.js import --tcgdex-source ../cards-database --mapping crosswalk.json --source ../pokemon-tcg-data --output .local/new-set-batch
```

The parser reads literal TypeScript objects without importing/evaluating upstream code. Unsupported expressions fail; unsupported data fields are retained as provider evidence and reported. All reads use `git show` at the selected source commit. The canonical fork is not modified.

`batch.json` retains accepted values, candidates, conflicts, full provider records, and source hashes. `proposed-cards.json` is editable draft fork-format JSON. Existing accepted values win conflicts until a correction is explicitly reviewed. New set metadata still needs reviewed `sets/en.json` information; the importer does not invent dates, totals, or series.

Review rule-box omissions, stage/evolution errors, English text, and image evidence. Mapping fixtures cover me01→me1, 30th R/G/B, Classic Charizard/Raikou renumbering, same-name LEGEND halves, promos, and finish variants. No name-only ID matching is used.

```sh
bun packages/tools/dist/cli.js validate --batch .local/new-set-batch --inventory reviewed-inventory.json
```

Resolve issues in `resolutions.json`, an array of `{cardId,field,decision,reason,evidence,proposedHash}`. Decisions are `keep-accepted`, `corrected`, or `inapplicable`. `proposedHash` comes from the validation report and binds the receipt to the exact proposal. Editing proposed records invalidates older receipts. These decisions prepare human review; they do not publish or approve a set. Do not describe unreadable text as inapplicable.

```sh
bun packages/tools/dist/cli.js prepare --batch .local/new-set-batch --inventory reviewed-inventory.json --output .local/new-set-review
bun packages/tools/dist/cli.js submit --branch reviewed-import-branch --title "Review English set import" --body .local/new-set-review/review.md
```

`prepare` writes JSON and a human review report. Copy accepted changes and evidence into a fork branch, regenerate browser views, and push the branch through your usual process. `submit` only prints the draft PR command unless `--execute` is given; it does not create/push a branch. PR submission needs `gh` authentication. Merge only a complete reviewed set.

## Prepare owned assets

```sh
bun packages/tools/dist/cli.js assets --source ../pokemon-tcg-data --output .local/accepted-assets --asset-origin https://YOUR-DISTRIBUTION.cloudfront.net
# Explicit network acquisition; resumable against already checked local bytes:
bun packages/tools/dist/cli.js assets --source ../pokemon-tcg-data --output .local/accepted-assets --asset-origin https://YOUR-DISTRIBUTION.cloudfront.net --acquire
```

Without `--acquire`, the command only inventories local/missing assets. Acquisition saves original bounded image bytes under content-hashed keys, retaining source URL provenance. Review `assets/manifest.json`; acquisition never approves it. Keep original binary evidence out of Git/npm. The local snapshot gate checks approved manifest/origin and local bytes. The privileged release job separately creates/verifies immutable S3/CloudFront objects **before npm publication**; deployed-byte receipts are optional earlier evidence, not a circular prerequisite to first upload.

Keep accepted asset bytes available through the exact pinned GitHub artifact handoff described in [releases.md](releases.md). `dataset-source.json.assetBundle` pins its run ID, artifact ID, and manifest SHA-256. No release build re-downloads mutable provider images or calls an AI model. Expired/missing evidence fails safely. Old published asset objects are never deleted.

## Generate and freeze a snapshot

```sh
bun packages/tools/dist/cli.js build-snapshot --source ../pokemon-tcg-data --output .local/snapshot --release-version 1.0.0 --asset-manifest .local/accepted-assets/assets/manifest.json
bun packages/tools/dist/cli.js verify-snapshot --source ../pokemon-tcg-data --snapshot .local/snapshot
```

A draft build works without release approvals. Its manifest lists every unmet gate. Copy/review `generated/v1/` into the canonical fork together with inventory/provenance changes, merge, then pin the resulting full source SHA. Generated records use source-file content hashes, not their own containing commit, avoiding a self-referential hash. The outer snapshot manifest supplies the final fork pin.

Source builds require a clean checkout. On an import branch, first commit the reviewed raw records and sidecars locally, build against that explicit intermediate SHA, then add the generated views in a second commit in the same PR. Freeze the final merged SHA for release. Check out full source history so the frozen initial baseline is available for identity preservation checks.

For a release candidate, add `--release-ready --builder-version VERSION --builder-commit FULL_SOFTWARE_SHA` to the build. Verification also uses `--release-ready`. It requires the entire frozen initial catalog, matching reviewed inventories/printed fields, owned asset bytes, clean source pin, current generated files, and full builder identity. Failed replacements preserve existing outputs and retain draft diagnostics. Do not ship a draft with `allowDraft` enabled by default.

## Local Ollama extraction

Configure the DGX Spark endpoint and a model already installed there. The [example config](../examples/ollama.config.json) contains placeholders, not a tested recommendation. Endpoints are restricted to local/private origins. No model download or hosted fallback is automatic.

```sh
bun packages/tools/dist/cli.js ollama-inspect --config ollama.config.json
bun packages/tools/dist/cli.js extract --config ollama.config.json --image card.png --card-id me1-3 --set-id me1 --source-commit FULL_SOURCE_SHA --cache .local/extractions
```

Single-card extraction is for evaluation/completion drafts. It checks installed digest, quantization, vision capability, and Ollama version before and after a request. Original bytes, input hashes, schema/prompt/configuration, fixed settings, raw responses, errors, candidates, and correction placeholders are retained. Identical inputs reuse outputs; `--repeat` records a separate run for repeatability experiments. Seed/temperature/schema control is not evidence of accurate transcription.

Build a manually checked corpus of about 50 representative cards; run warm/cold, restarts, and intended concurrency. Score expected vs actual printed-field JSON using `score --runs FILE`; separately analyze repeated records, latency, omissions/fabrications, throughput, memory, and reviewer effort. Agree pass/fail criteria with the maintainer. `extract-batch --config FILE --qualification RECEIPT --inputs FILE --cache DIR` requires an explicitly approved passing receipt bound to the exact config, model digest, environment, prompt, and schema. It cannot auto-qualify itself. If qualification fails, use structured/manual completion.

No DGX model has been qualified by this implementation session. An actual endpoint, installed model, checked corpus, measurements, and maintainer acceptance are still required.
