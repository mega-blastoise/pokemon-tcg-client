# @johto-ai/tcg-client

Use `await PokemonTCGClient.createClientAsync(options)` from this package. Bun and Node automatically select their native SQLite adapter; browsers fetch normalized commit-pinned JSON and require an explicit snapshot. Install `@johto-ai/tcg-data` for native default resolution, or provide database and manifest paths.

```ts
import { PokemonTCGClient } from "@johto-ai/tcg-client";
const tcg = await PokemonTCGClient.createClientAsync();
try { console.log(await tcg.cards.get("me1-3")); }
finally { await tcg.close(); }
```

The browser-specific entry is `@johto-ai/tcg-client/browser`. Models and Zod schemas are available from `@johto-ai/tcg-client/schema` without native imports. Operations throw typed errors on failure, return null for absent records, and keep consistent query semantics across runtimes. Native SQLite queries are synchronous internally. Node 24.6's native SQLite is experimental. No pricing or tournament legality engine is included.

Full documentation: https://github.com/mega-blastoise/pokemon-tcg-client
