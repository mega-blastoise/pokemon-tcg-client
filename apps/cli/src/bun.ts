#!/usr/bin/env bun
/** @module bun_cli Bun entry: the client's `bun` export selects bun:sqlite. */
import { PokemonTCGClient } from "@johto-ai/tcg-client";
import { run } from "./app/run.js";

if (!globalThis.Bun) {
  console.error("tcg-chat-bun must run on Bun; use tcg-chat-node for Node.js");
  process.exit(1);
}
await run({
  bin: "tcg-chat-bun",
  runtime: `bun ${Bun.version}`,
  adapter: "bun:sqlite",
  create: (options) => PokemonTCGClient.createClientAsync(options),
});
