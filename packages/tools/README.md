# @johto-ai/tcg-tools

Bun-only maintainer tools. Run `tcg-tools --help` for commands and consult the repository's `docs/maintainers.md` for the review workflow.

Imports and image extraction create local drafts. They never approve canonical data or invoke paid inference. Snapshot building consumes reviewed JSON, not models. Acquisition and PR submission are explicit operations; PR submission is dry-run unless `--execute` is provided. Published datasets require complete reviewed inventories and owned checked asset bytes. CloudFront publication is verified before npm publication.

The compiled CLI and declarations ship in `dist/`; no TypeScript source is exported.
