# @johto-ai/tcg-data

An independently versioned standalone SQLite file plus `manifest.json`. The native descriptor exports `databasePath`, `manifestPath`, and `loadSnapshot()`. It reads the installed manifest at runtime; no placeholder snapshot is embedded in the JavaScript build.

Browser users import `@johto-ai/tcg-data/manifest` as JSON with their bundler's supported JSON syntax, or fetch the chosen release descriptor, then pass it to the browser client. Do not import the native data-package root into a browser bundle.

Data builds pin the authoritative `mega-blastoise/pokemon-tcg-data` commit, preserve canonical identities, and include complete reviewed sets only. Artwork is served separately through owned immutable hosting, not included in npm. Installing a different data version is an explicit consumer action.

The source workspace intentionally contains no release-ready database before the first complete catalog is reviewed and accepted.
