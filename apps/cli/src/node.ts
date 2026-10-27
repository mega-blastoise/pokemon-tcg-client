#!/usr/bin/env node
/** @module node_cli Node entry: the client's `node` export selects node:sqlite. */
import type { ClientOptions } from "@johto-ai/tcg-client";

if (globalThis.Bun) {
  console.error("tcg-chat-node must run on Node.js; use tcg-chat-bun for Bun");
  process.exit(1);
}
// node:sqlite is experimental in Node 24; its one-time warning would tear the TUI.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  if (String(warning).includes("SQLite")) return;
  return (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
// Import after the filter so the client's node:sqlite load is silent.
const { PokemonTCGClient } = await import("@johto-ai/tcg-client");
const { run } = await import("./app/run.js");
await run({
  bin: "tcg-chat-node",
  runtime: `node ${process.versions.node}`,
  adapter: "node:sqlite",
  create: (options: ClientOptions) =>
    PokemonTCGClient.createClientAsync(options),
});
