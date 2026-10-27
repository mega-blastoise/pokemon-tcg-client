/** @module agent_tests Checks the card tools and MCP bridge without starting Claude. */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { PokemonTCGClient as BrowserClient } from "../client/src/browser.js";
import { PokemonTCGClient as BunClient } from "../client/src/bun.js";
import { createFixture } from "../client/test-fixtures.js";
import { McpBridge } from "./src/mcp.js";
import type { TCGClient, ToolCall } from "./src/protocol.js";
import { executeTool, toolDefinitions } from "./src/tools.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** Open the fixture through both a native and the browser adapter. */
async function clients(): Promise<[string, TCGClient][]> {
  const fixture = await createFixture();
  const native = await BunClient.createClientAsync({
    databasePath: fixture.databasePath,
    manifestPath: fixture.manifestPath,
  });
  const browser = await BrowserClient.createClientAsync({
    snapshot: fixture.snapshot,
    fetch: fixture.fetcher,
  });
  cleanups.push(
    () => native.close(),
    () => browser.close(),
    () => rm(fixture.directory, { recursive: true, force: true }),
  );
  return [
    ["bun", native],
    ["browser", browser],
  ];
}

const signal = new AbortController().signal;

describe("card tools", () => {
  test("search, get, and set tools agree across adapters", async () => {
    const results = [];
    for (const [, client] of await clients()) {
      const search = await executeTool(
        client,
        { name: "search_cards", input: { name: "pikachu", extra: "ignored" } },
        signal,
      );
      expect(search.ok).toBe(true);
      expect(search.cards?.map((card) => card.id)).toEqual(["new-1", "old-2"]);
      expect(search.cards?.[0]?.setName).toBeTruthy();
      const get = await executeTool(
        client,
        { name: "get_cards", input: { ids: ["old-2", "absent-1"] } },
        signal,
      );
      expect(get.summary).toBe("1 found, 1 missing");
      expect(JSON.parse(get.content).missing).toEqual(["absent-1"]);
      const sets = await executeTool(
        client,
        { name: "list_sets", input: {} },
        signal,
      );
      expect(sets.total).toBe(2);
      results.push([search.content, get.content, sets.content]);
    }
    // Model-facing output is identical whichever runtime executed the call.
    expect(results[0]).toEqual(results[1]);
  });

  test("a user format toggle overrides the model's search filters", async () => {
    for (const [, client] of await clients()) {
      const call = { name: "search_cards", input: { setId: "old" } };
      const open = await executeTool(client, call, signal);
      expect(open.total).toBe(4);
      expect(JSON.parse(open.content).format).toBeUndefined();

      const toggled = await executeTool(client, call, signal, {
        format: "standard",
      });
      expect(toggled.cards?.map((card) => card.id).sort()).toEqual([
        "old-182a",
        "old-2",
      ]);
      expect(toggled.summary).toBe("2 of 2 cards · standard");
      const content = JSON.parse(toggled.content);
      expect(content.format).toBe("standard");
      expect(content.formatSetBy).toBe("user");

      // The model may also ask for Standard itself; that is not attributed to the user.
      const asked = await executeTool(
        client,
        { name: "search_cards", input: { setId: "old", format: "standard" } },
        signal,
      );
      expect(asked.total).toBe(2);
      expect(JSON.parse(asked.content).formatSetBy).toBeUndefined();
    }
  });

  test("client errors become readable failed outcomes", async () => {
    const [[, client]] = (await clients()) as [[string, TCGClient]];
    const invalid = await executeTool(
      client,
      { name: "search_cards", input: { limit: 999 } },
      signal,
    );
    expect(invalid.ok).toBe(false);
    expect(invalid.error?.code).toBe("INVALID_QUERY");
    const unknown = await executeTool(
      client,
      { name: "nope", input: {} },
      signal,
    );
    expect(unknown.error?.code).toBe("UNKNOWN_TOOL");
  });
});

describe("MCP bridge", () => {
  test("serves tool listing and routes calls to the registered session only", async () => {
    const [[, client]] = (await clients()) as [[string, TCGClient]];
    const bridge = await McpBridge.start();
    cleanups.push(() => bridge.close());
    const calls: ToolCall[] = [];
    const endpoint = bridge.register((call) => {
      calls.push(call);
      return executeTool(client, call, signal);
    });
    const rpc = (body: unknown, url = endpoint.url) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const init = await (
      await rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      })
    ).json();
    expect(init.result.serverInfo.name).toBe("tcg");
    expect(
      (await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }))
        .status,
    ).toBe(202);
    const list = await (
      await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    ).json();
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(
      toolDefinitions.map((t) => t.name),
    );
    const call = await (
      await rpc({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "search_cards",
          arguments: { setId: "old", sort: "number" },
        },
      })
    ).json();
    expect(call.result.isError).toBe(false);
    expect(JSON.parse(call.result.content[0].text).total).toBe(4);
    expect(calls).toHaveLength(1);

    // Unknown and disposed tokens cannot reach any session's client.
    expect(
      (
        await rpc(
          { jsonrpc: "2.0", id: 4, method: "ping" },
          `${bridge.origin}/mcp/forged`,
        )
      ).status,
    ).toBe(404);
    endpoint.dispose();
    expect((await rpc({ jsonrpc: "2.0", id: 5, method: "ping" })).status).toBe(
      404,
    );
  });
});
