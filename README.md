# Pokémon TCG Client

Typed, snapshot-pinned Pokémon card data for Bun, Node.js, and browsers. No paid API or live pricing dependency.

```ts
import { PokemonTCGClient } from "@johto-ai/tcg-client";

const tcg = await PokemonTCGClient.createClientAsync();
try {
  const card = await tcg.cards.get("me1-3");
  const cards = await tcg.cards.getMany(["me1-3", "missing-1", "me1-3"]);
  const page = await tcg.cards.search({ setId: "me1", text: "draw cards", limit: 50 });
  for await (const card of tcg.cards.iterate({ setId: "me1" })) {
    console.log(card.id, card.name);
  }
  console.log(tcg.snapshot.source.commit);
} finally {
  await tcg.close();
}
```

Native consumers install `@johto-ai/tcg-data` separately, or pass `databasePath` and `manifestPath`. Bun selects `bun:sqlite`; Node selects `node:sqlite`. Both expose asynchronous operations over synchronous native queries. Node's SQLite API is experimental at the supported minimum, Node 24.6. Bun development/CI is pinned to 1.4.3.

Browser consumers supply a snapshot explicitly:

```ts
import { PokemonTCGClient } from "@johto-ai/tcg-client/browser";
// Fetch your selected release's manifest.json, or import tcg-data/manifest JSON.
const tcg = await PokemonTCGClient.createClientAsync({ snapshot });
```

The browser loads hash-checked normalized JSON from the fork's full Git commit, lazily fetching records by set and search metadata on demand. No native module or SQLite payload belongs in its bundle. A missing descriptor is an error, never a request for a moving latest branch. Direct ESM use needs an import map/bundler for package dependencies.

Missing records return `null`; batch results preserve input order, missing entries, and duplicates. A valid empty search returns an empty page. Other failures throw `TCGError` with a stable `code`. Queries combine filters with AND; text search uses normalized literal tokens, not the deprecated API's Lucene syntax. Page limits are 1–250 (default 50). Default order is release date descending, natural collector number ascending, then canonical ID. Use `{ signal }` on requests for cancellation.

## Development

```sh
mise install
bun install --frozen-lockfile
bun run check
bun run test
bun run smoke
```

All packages export built ESM and declarations from `dist/`, never TypeScript sources. `check` builds first; changing source without rebuilding can otherwise leave stale workspace exports. Browser smoke uses Playwright Chromium (`bunx playwright install chromium` if not installed).

To try the real catalog locally before publication, build an explicitly unapproved development snapshot:

```sh
bun packages/tools/dist/cli.js build-snapshot --source ../pokemon-tcg-data --output .local/dev-snapshot --release-version 0.0.0
```

```ts
import { PokemonTCGClient } from "./packages/client/dist/bun.js";
const tcg = await PokemonTCGClient.createClientAsync({
  manifestPath: ".local/dev-snapshot/manifest.json",
  allowDraft: true, // Maintainer development only; never the published default.
});
try { console.log(await tcg.cards.get("me1-3")); }
finally { await tcg.close(); }
```

The three packages have separate responsibilities:

- `@johto-ai/tcg-client`: public models, queries, runtime adapters.
- `@johto-ai/tcg-data`: independently versioned SQLite and snapshot descriptor.
- `@johto-ai/tcg-tools`: Bun maintainer CLI, review drafts, assets, and deterministic builds.

Start with [the source review guide](docs/review.md) for a short reading order and the main checks to review. See [IMPLEMENTATION.md](IMPLEMENTATION.md) for the implementation/validation handoff, [SPEC.md](SPEC.md) for approved decisions, and [docs/maintainers.md](docs/maintainers.md) / [docs/releases.md](docs/releases.md) for operation.

## Initial release status

This is a local implementation, not a published dataset. The entire 176-set baseline is required. First publication remains gated on reviewed inventories/printed-field receipts, accepted content-addressed assets, committed generated browser views, and configured release infrastructure. Ollama support does not imply that a model has been qualified on the DGX Spark. Johto/Deckvault migrations are deliberately deferred.

The MIT license covers this project's original software, not third-party card content. See [NOTICE](NOTICE).
