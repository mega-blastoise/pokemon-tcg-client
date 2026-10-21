# Releases

Code tags `tcg/vX.Y.Z` release `@johto-ai/tcg-client` and `@johto-ai/tcg-tools` together. Data tags `tcg/data-vX.Y.Z` independently release `@johto-ai/tcg-data`. Source package versions stay `0.0.0`; helpers stamp copies in fresh release staging directories. Only compiled `dist` JavaScript, declarations, package notices, and the data package's finalized SQLite/manifest are packed. Images remain outside npm and Git.

No release has been published. The initial data release is blocked until all baseline sets have complete reviewed inventories, accepted printed fields, provenance, generated browser outputs, and owned, verified card/set assets. Neither these workflows nor the release helper creates review approval or ownership evidence.

## Before enabling publication

1. Create the intended repository separately and select the protected production branch (`main` by default). Protect both release tag patterns and restrict the `production` GitHub environment to those tags, with maintainer approval. Publication jobs use that environment; build jobs carry no publication credentials.
2. Configure npm trusted publishers for all three scoped packages. The workflow files are `release-code.yml` for client/tools and `release-data.yml` for data; select the `production` environment and explicitly permit direct `npm publish`. Initial package/scope ownership and any npm bootstrap publication are separate manual setup. Use a public source repository for npm provenance. Do not add an npm write token.
3. Pin `dataset-source.json` to the full reviewed commit of `mega-blastoise/pokemon-tcg-data`. Its generated browser data must already be committed at that same SHA. Freeze the reviewed source before tagging the software repository.
4. For assets, review [the CloudFormation template](../infra/assets.cfn.json) and supply real parameters: bucket name, GitHub owner/repository/environment, and the existing GitHub OIDC provider ARN. Optional custom-domain parameters need a validated ACM certificate in `us-east-1`; an optional hosted-zone ID enables A/AAAA aliases. No infrastructure is deployed by CI or these helpers.
5. Set repository variable `ASSET_ORIGIN` to the template's HTTPS origin output so the build records the correct public URL. Set production environment variables `AWS_REGION`, `AWS_ROLE_TO_ASSUME`, `S3_BUCKET`, and the same `ASSET_ORIGIN`. An optional repository `RELEASE_BRANCH` changes the branch ancestry preflight.
6. Provide accepted asset bytes through the pinned artifact handoff below. An image URL or a source provider's license is not proof that owned bytes exist. Protect candidate evidence until its reviewed canonical change is frozen.

Builds and CI pin Bun `1.4.3`. Node `24.6.0` exercises the supported minimum, and CI also exercises Node `26.x`. Node's SQLite implementation is experimental in 24.6; the native adapter owns compatibility with newer APIs. Publishing pins npm `11.5.1`, which supports GitHub OIDC. Native compilation/build and packed-export smoke checks must pass before publication.

## Local dry runs

These commands only print plans:

```sh
bun scripts/stamp-release.ts code --tag tcg/v1.0.0
bun scripts/release.ts prepare code --tag tcg/v1.0.0
bun scripts/release.ts prepare data --tag tcg/data-v1.0.0 --source ../pokemon-tcg-data --snapshot .local/snapshot
```

Prepare reviewable local artifacts using the exact release tag at the checked-out commit, reachable from `origin/main` (or `RELEASE_BRANCH`). Preparation requires the pinned Bun and an existing built workspace:

```sh
bun run check
bun run test
bun run build
bun scripts/release.ts prepare code --tag tcg/v1.0.0 --output .release/code-1.0.0 --write
bun scripts/release.ts verify --directory .release/code-1.0.0/artifact
TCG_RELEASE_DIR=.release/code-1.0.0/artifact bun run smoke
bun scripts/release.ts publish --directory .release/code-1.0.0/artifact
```

The last command still prints a plan. Actual publication requires `--execute` and the matching GitHub Actions tag/OIDC context. No helper creates tags, pushes branches, publishes PRs, or deploys infrastructure. A cross-stream `workspace:` dependency requires `--other-version X.Y.Z`; never stamp the independent dataset version from a code tag.

## Data preparation

The data workflow checks out the exact fork SHA, runs the repository checks, and invokes:

```sh
bun packages/tools/dist/cli.js build-snapshot --source SOURCE --output SNAPSHOT --release-version 1.0.0 --builder-version 0.0.0 --builder-commit BUILDER_SHA --asset-manifest ACCEPTED/assets/manifest.json --asset-origin HTTPS_ORIGIN --release-ready
bun packages/tools/dist/cli.js verify-snapshot --source SOURCE --snapshot SNAPSHOT --release-ready
bun scripts/release.ts prepare data --tag tcg/data-v1.0.0 --source SOURCE --snapshot SNAPSHOT --output .release/data-1.0.0 --write
```

`SNAPSHOT` contains `pokemon-data.sqlite3.db`, `manifest.json`, `generated/v1/`, reports, and `assets/`. The workflow builds twice and compares SQLite bytes, snapshot manifests and generated browser files. The readiness check must reject incomplete inventories, unresolved required fields, missing baseline sets, unreviewed or unowned assets, and stale generated files. The source checkout must remain clean and match the configured commit.

The data descriptor loads its adjacent actual manifest at runtime; staging copies the verified database/manifest into the package without rebuilding or editing canonical source. The preparation helper invokes the readiness check again, hashes the complete artifact, and checks that the packed database/manifest are exactly the verified bytes. A snapshot must identify the source commit, builder commit, Bun version, schema, hashes and immutable asset origin consistently. Builder version `0.0.0` is the checked-out tooling package's source version, not the independent data version; the full builder SHA identifies its exact implementation.

### Accepted asset artifact handoff

After acquiring and genuinely reviewing candidate bytes, upload the accepted directory from a maintainer-controlled workflow in this same repository with `actions/upload-artifact@v7` (immutable v4+ artifact service). This is a setup prerequisite, not an automatic approval workflow. The artifact root must contain `assets/manifest.json` plus its referenced `assets/sha256/<hash>.<ext>` bytes. The reviewed manifest records the configured owned origin, review evidence and accepted content hashes. Do not manufacture approval or published-byte receipts to satisfy a gate.

Pin the resulting immutable artifact identity and the actual manifest hash in tracked `dataset-source.json`:

```json
{
  "assetBundle": {
    "runId": 123456789,
    "artifactId": 987654321,
    "manifestSha256": "<64 lowercase SHA-256 hex of assets/manifest.json>"
  }
}
```

Those example IDs are placeholders. Keep the existing authoritative source repository, source commit and baseline commit fields alongside this property. A data tag fails when this pin is absent. The build downloads that exact artifact ID from that exact run, compares the manifest hash, then validates every referenced local path and byte hash. It does not reacquire images from mutable providers or receive AWS publication credentials. The canonical fork's generated browser data must already match the accepted manifest at the pinned source commit.

GitHub artifact retention is finite. An expired/deleted artifact blocks a build; deliberately re-upload identical reviewed evidence and commit a new pin before a new tag, or preserve the accepted directory through the separate private evidence archive. Published immutable assets are not subject to CI artifact expiry. Local readiness requires reviewed checked bytes and owned URLs; the privileged publish job uploads/verifies those URLs before publishing npm data. Existing published-byte receipts may be checked explicitly, but are not invented or required to create the first owned snapshot.

## Artifact handoff and publication

Each prepare run refuses to overwrite an existing artifact directory. `artifact/` contains exact `.tgz` files, `release-plan.json`, `SHA256SUMS`, release notes, and, for data, the snapshot/evidence/accepted asset staging. CI uploads that directory before a separately privileged production job downloads it. Code release smoke jobs install/check these exact tarballs through `TCG_RELEASE_DIR`. Other smoke runs first pack fresh staged code. Both install the packages in a temporary consuming project with a tiny, clearly synthetic data fixture, exercise automatic Bun/Node imports and run the browser-safe bundle in real Chromium with mocked pinned GitHub responses. A separate unrouted browser fetch of the pinned real fork's set JSON checks GitHub CORS/transport; it does not claim that uncommitted normalized views are already hosted. Already-installed lockfile dependencies are locally packed for offline installation; native modules and the data package must not enter the browser graph. This session's sandbox prevents Chromium execution, so both real-browser and live CORS results remain unverified locally; the smoke script fails rather than skipping them.

The publisher verifies hashes and package identities again. Registry preflights are bounded to the explicitly tagged package versions. Existing identical npm integrity is accepted for a publish-job retry; a differing existing version stops publication. It never unpublishes or rebuilds an artifact. Code publication is two npm operations, not an atomic registry transaction; a failure after the first package is reported and the same artifact can be retried.

For data, accepted immutable assets are uploaded and checked before npm publication. The upload inventory is `assets/uploads.json`, an array of:

```json
[
  {
    "key": "assets/sha256/<64 lowercase SHA-256 hex>.png",
    "file": "<path relative to assets directory>",
    "sha256": "<same 64 lowercase SHA-256 hex>",
    "contentType": "image/png"
  }
]
```

An existing key must have matching SHA-256 checksum, metadata and MIME type. Missing objects are created with `If-None-Match: *`; concurrent creation is verified before proceeding. CloudFront response bytes are hashed against the accepted bytes. A mismatch or unavailable object stops the release before publishing a referencing npm dataset. Changed bytes receive a new key.

The S3 bucket is private, versioned, and retained when the stack is replaced/deleted. OAC can read only `assets/*`; private `staging/` evidence is not served. The publisher role has no delete permission and requires conditional object creation. **Never use `aws s3 sync --delete` against this historical archive.** Published objects have a one-year immutable cache policy and permissive read-only CORS. No CloudFront invalidation is needed for new hash URLs. No lifecycle expiration or automatic garbage collection removes snapshot-referenced assets. Evidence expiry, access and archival are managed separately from public immutable assets.

GitHub release metadata is written only after successful package/asset publication. Failure leaves prior snapshots/assets intact. Retain the CI artifact when investigating or retrying the privileged job; GitHub's configured artifact retention is 30 days, while published assets have no automatic expiry.

## Release notes

Before tagging, replace or append a human-written entry identifying the change, code/data compatibility, source commit for data, readiness evidence, validation and known limitations. The workflow carries these notes into the artifact; it does not synthesize approval or changelog claims.

References: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), [CloudFront OAC](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html), [S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html).
