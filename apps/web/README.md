# @johto-ai/tcg-chat-web

Conversational card search in the browser. The page itself creates the client from `@johto-ai/tcg-client/browser`. When Claude calls a tool, the Bun server relays the call over a WebSocket, the tab runs it with its own client, and the result goes back to Claude through ACP. Every result you see came from the browser client.

```sh
bun run build && bun run web     # http://localhost:4173 (PORT/HOST to change)
```

- **Local mirror vs GitHub raw.** The descriptor always names the commit-pinned GitHub URL. In mirror mode (the default) an instrumented `fetch` sends those requests to `/snapshot/*`, which the server serves gzipped from the local build. The client still checks every file's SHA-256 against the pin. GitHub mode fetches the real URL and will fail until the generated views are published at the pinned commit.
- **Panels.** The sidebar shows snapshot identity, agent status and context usage, the diagnostics suite, Claude's tool calls, and every snapshot file fetched with its size and timing.
- **Shortcuts.** ⌘K opens direct name search with no model involved. Esc stops a turn or closes the drawer. Tab accepts Claude's suggestion. Backticked card ids in answers open the detail drawer.
