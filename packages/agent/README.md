# @johto-ai/tcg-agent

Private, shared backend for the TCG chat apps. It runs Claude through ACP and executes card tools against whichever `PokemonTCGClient` the frontend owns.

```
frontend ──prompt──▶ CardAgentSession ──ACP (stdio)──▶ claude-agent-acp ──▶ Claude
    ▲                      │                                    │
    └── ToolExecutor ◀── McpBridge (loopback HTTP, /mcp/<token>) ◀── tools/call
```

- `CardAgentHost.start()` spawns `@agentclientprotocol/claude-agent-acp` with the current runtime, negotiates ACP v1, and binds a loopback MCP bridge.
- `host.createSession(executor, onEvent)` opens an ACP session that has only the `mcp__tcg__*` tools. It disables built-in tools, ignores settings and user MCP servers, and does not persist the session. It streams `AgentEvent`s: text, thoughts, tool calls and results, usage, suggestions, and done.
- The `ToolExecutor` decides where tools run. The CLIs call `executeTool(nativeClient, ...)`. The web server forwards each call over a WebSocket to the browser tab.

Browser-safe subpaths: `./protocol` (types), `./tools` (definitions, `executeTool`, view mappers), and `./diagnostics` (`runDiagnostics`, the 14-check client contract suite).

Environment: `TCG_MODEL` picks the Claude model. `TCG_ACP_RUNTIME` overrides the runtime used to spawn the adapter. `TCG_DEBUG=1` prints adapter stderr.
