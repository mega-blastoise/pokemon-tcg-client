/** @module client_runtime_tests Checks observable client behavior, lazy loading, errors, and isolation. */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { PokemonTCGClient as BrowserClient } from "./src/browser.js";
import { PokemonTCGClient as BunClient } from "./src/bun.js";
import { TCGError } from "./src/errors.js";
import type { CardQuery } from "./src/query.js";
import type { FetchFunction } from "./src/store.js";
import { sha256 } from "./src/validation.js";
import { createFixture, fixtureCard, fixtureSet } from "./test-fixtures.js";

// Only directories created by these fixtures are eligible for test cleanup.
const cleanups: string[] = [];
/** Create a fresh snapshot per test and register its temporary files for cleanup. */
async function fixture(options: { punctuation?: boolean } = {}) {
  const value = await createFixture(options);
  cleanups.push(value.directory);
  return value;
}
afterEach(async () => {
  await Promise.all(
    cleanups
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("universal client", () => {
  test("Bun/browser queries, records, batches and pagination agree", async () => {
    const data = await fixture();
    const native = await BunClient.createClientAsync({
      snapshot: data.snapshot,
      databasePath: data.databasePath,
    });
    const browser = await BrowserClient.createClientAsync({
      snapshot: data.snapshot,
      fetch: data.fetcher,
    });
    const queries: CardQuery[] = [
      {},
      { setId: "old", text: "DRAW cards", limit: 2 },
      { name: "pikachu" },
      {
        type: "Lightning",
        subtype: "Basic",
        rarity: "Common",
        regulationMark: "J",
        supertype: "Pokémon",
      },
      { text: "search deck" },
      { sort: "number" },
      { sort: "name", direction: "desc", offset: 1, limit: 2 },
      { name: "' OR 1=1 --" },
      { format: "standard" },
      { format: "standard", setId: "old", sort: "number" },
      { format: "standard", regulationMark: "G" },
    ];
    for (const query of queries)
      expect(await browser.cards.search(query)).toEqual(
        await native.cards.search(query),
      );
    expect(
      (await native.cards.search({ setId: "old" })).items.map(
        (card) => card.number,
      ),
    ).toEqual(["2", "10", "182a", "R"]);
    // Standard keeps marks H, I and J; Zubat (G) and Red (no mark) drop out.
    expect(
      (
        await native.cards.search({ setId: "old", format: "standard" })
      ).items.map((card) => card.id),
    ).toEqual(["old-2", "old-182a"]);
    expect(
      (await browser.cards.search({ format: "standard", regulationMark: "G" }))
        .total,
    ).toBe(0);
    const ids = ["old-2", "missing-99", "old-2", "old-R"];
    expect(await browser.cards.getMany(ids)).toEqual(
      await native.cards.getMany(ids),
    );
    expect(
      (await browser.cards.getMany(ids)).map((card) => card?.id ?? null),
    ).toEqual(["old-2", null, "old-2", "old-R"]);
    expect(await browser.sets.list({})).toEqual(await native.sets.list({}));
    expect(await native.sets.get("missing")).toBeNull();
    const iterated = await Array.fromAsync(
      browser.cards.iterate({ setId: "old", limit: 1, offset: 1 }),
    );
    expect(iterated.map((card) => card.number)).toEqual(["10", "182a", "R"]);
    expect(await Array.fromAsync(browser.sets.iterate({ limit: 1 }))).toEqual([
      ...(await native.sets.list()).items,
    ]);
    await Promise.all([browser.close(), native.close()]);
  });

  test("browser loads lazily, deduplicates, and protects cached records from mutation", async () => {
    const data = await fixture();
    const client = await BrowserClient.createClientAsync({
      snapshot: data.snapshot,
      fetch: data.fetcher,
    });
    expect(data.requests).toEqual(["manifest.json"]);
    const values = await Promise.all([
      client.cards.get("old-2"),
      client.cards.get("old-10"),
      client.cards.get("old-2"),
    ]);
    expect(data.requests).not.toContain("search-index.json");
    expect(
      data.requests.filter((path) => path === "cards/old.json"),
    ).toHaveLength(1);
    expect(data.requests).not.toContain("cards/new.json");
    if (values[0]) values[0].name = "Mutated";
    expect((await client.cards.get("old-2"))?.name).toBe("Pikáchu");
    expect(Object.isFrozen(client.snapshot.source)).toBe(true);
    await client.cards.search({ setId: "old", limit: 1 });
    expect(
      data.requests.filter((path) => path === "search-index.json"),
    ).toHaveLength(1);
    expect(
      data.requests.filter((path) => path === "cards/old.json"),
    ).toHaveLength(1);
    await client.close();
  });

  test("direct lookup chooses the longest hyphenated set prefix without loading search", async () => {
    const data = await fixture();
    const set = fixtureSet("old-promo", 1);
    const card = fixtureCard(set.id, "1", "Hyphenated set card");
    data.files.set("sets.json", JSON.stringify([...data.sets, set]));
    data.files.set(`cards/${set.id}.json`, JSON.stringify([card]));
    const snapshot = structuredClone(data.snapshot);
    snapshot.counts.sets++;
    snapshot.counts.cards++;
    const manifest = JSON.parse(data.files.get("manifest.json") ?? "null");
    manifest.counts = snapshot.counts;
    for (const path of ["sets.json", `cards/${set.id}.json`])
      manifest.files[path] = await sha256(
        new TextEncoder().encode(data.files.get(path)),
      );
    const contentManifest = JSON.stringify(manifest);
    data.files.set("manifest.json", contentManifest);
    snapshot.browser.manifestSha256 = await sha256(
      new TextEncoder().encode(contentManifest),
    );
    const client = await BrowserClient.createClientAsync({
      snapshot,
      fetch: data.fetcher,
    });
    expect((await client.cards.get("old-promo-1"))?.id).toBe(card.id);
    expect(await client.cards.get("old-promo-missing")).toBeNull();
    expect(await client.cards.get("unknown-1")).toBeNull();
    expect(data.requests).toEqual([
      "manifest.json",
      "sets.json",
      "cards/old-promo.json",
    ]);
    await client.close();
  });

  test("set record files reject card IDs outside their canonical set prefix", async () => {
    const data = await fixture();
    const cards = data.cards.filter((card) => card.setId === "old");
    const first = cards[0];
    if (!first) throw new Error("Missing fixture card");
    first.id = "outside-10";
    const content = JSON.stringify(cards);
    data.files.set("cards/old.json", content);
    const manifest = JSON.parse(data.files.get("manifest.json") ?? "null");
    manifest.files["cards/old.json"] = await sha256(
      new TextEncoder().encode(content),
    );
    const manifestText = JSON.stringify(manifest);
    data.files.set("manifest.json", manifestText);
    const snapshot = structuredClone(data.snapshot);
    snapshot.browser.manifestSha256 = await sha256(
      new TextEncoder().encode(manifestText),
    );
    const client = await BrowserClient.createClientAsync({
      snapshot,
      fetch: data.fetcher,
    });
    await expect(client.cards.get("old-2")).rejects.toMatchObject({
      code: "SNAPSHOT_MISMATCH",
    });
    expect(data.requests).not.toContain("search-index.json");
    await client.close();
  });

  test("native manifests resolve sibling database paths", async () => {
    const data = await fixture();
    const client = await BunClient.createClientAsync({
      manifestPath: data.manifestPath,
    });
    expect((await client.cards.get("old-R"))?.number).toBe("R");
    await client.close();
  });

  test("invalid queries, cancellation and post-close access throw typed errors", async () => {
    const data = await fixture();
    const client = await BunClient.createClientAsync({
      snapshot: data.snapshot,
      databasePath: data.databasePath,
    });
    await expect(client.cards.search({ limit: 251 })).rejects.toMatchObject({
      code: "INVALID_QUERY",
    });
    await expect(client.cards.get("../../secret")).rejects.toMatchObject({
      code: "INVALID_QUERY",
    });
    const controller = new AbortController();
    controller.abort("test cancellation");
    await expect(
      client.cards.get("old-2", { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "ABORTED" });
    await client.close();
    await client.close();
    await expect(client.cards.get("old-2")).rejects.toMatchObject({
      code: "CLIENT_CLOSED",
    });
    await expect(client.cards.getMany([])).rejects.toMatchObject({
      code: "CLIENT_CLOSED",
    });
  });

  test("browser requires explicit snapshots and rejects draft, schema, hash and transport failures", async () => {
    const data = await fixture();
    await expect(BrowserClient.createClientAsync()).rejects.toMatchObject({
      code: "CONFIGURATION",
    });
    await expect(
      BrowserClient.createClientAsync({
        snapshot: { ...data.snapshot, releaseReady: false },
        fetch: data.fetcher,
      }),
    ).rejects.toMatchObject({ code: "CONFIGURATION" });
    await expect(
      BrowserClient.createClientAsync({
        snapshot: { ...data.snapshot, schemaVersion: 2 } as never,
        fetch: data.fetcher,
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_SCHEMA" });
    await expect(
      BrowserClient.createClientAsync({
        snapshot: {
          ...data.snapshot,
          browser: { ...data.snapshot.browser, manifestSha256: "0".repeat(64) },
        },
        fetch: data.fetcher,
      }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_MISMATCH" });
    const fail: FetchFunction = async () =>
      new Response("rate limit", { status: 429 });
    await expect(
      BrowserClient.createClientAsync({ snapshot: data.snapshot, fetch: fail }),
    ).rejects.toMatchObject({ code: "FETCH_FAILED", status: 429 });
    const offline: FetchFunction = async () => {
      throw new TypeError("offline");
    };
    await expect(
      BrowserClient.createClientAsync({
        snapshot: data.snapshot,
        fetch: offline,
      }),
    ).rejects.toBeInstanceOf(TCGError);
  });

  test("verified malformed JSON is invalid data, not an empty result", async () => {
    const data = await fixture();
    const invalid = "{this is not JSON";
    data.files.set("manifest.json", invalid);
    const snapshot = {
      ...data.snapshot,
      browser: {
        ...data.snapshot.browser,
        manifestSha256: await sha256(new TextEncoder().encode(invalid)),
      },
    };
    await expect(
      BrowserClient.createClientAsync({ snapshot, fetch: data.fetcher }),
    ).rejects.toMatchObject({ code: "INVALID_DATA" });
  });

  test("one cancelled browser consumer does not cancel a shared fetch for another", async () => {
    const data = await fixture();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: (() => void) | undefined;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetcher: FetchFunction = async (input, init) => {
      if (String(input).endsWith("cards/old.json")) {
        started?.();
        await gate;
      }
      return data.fetcher(input, init);
    };
    const client = await BrowserClient.createClientAsync({
      snapshot: data.snapshot,
      fetch: fetcher,
    });
    const controller = new AbortController();
    const cancelled = client.cards.get("old-2", { signal: controller.signal });
    const surviving = client.cards.get("old-10");
    await start;
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "ABORTED" });
    release?.();
    expect((await surviving)?.id).toBe("old-10");
    expect(
      data.requests.filter((path) => path === "cards/old.json"),
    ).toHaveLength(1);
    await client.close();
  });

  test("native rejects a mismatched file checksum before opening it", async () => {
    const data = await fixture();
    await expect(
      BunClient.createClientAsync({
        snapshot: {
          ...data.snapshot,
          database: { ...data.snapshot.database, sha256: "0".repeat(64) },
        },
        databasePath: data.databasePath,
      }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_MISMATCH" });
  });

  test("historical punctuation IDs ex10-! and ex10-? survive both adapters", async () => {
    const data = await fixture({ punctuation: true });
    const native = await BunClient.createClientAsync({
      snapshot: data.snapshot,
      databasePath: data.databasePath,
    });
    const browser = await BrowserClient.createClientAsync({
      snapshot: data.snapshot,
      fetch: data.fetcher,
    });
    const ids = ["ex10-!", "ex10-?", "ex10-!"];
    expect(
      (await native.cards.getMany(ids)).map((card) => card?.number),
    ).toEqual(["!", "?", "!"]);
    expect(await browser.cards.getMany(ids)).toEqual(
      await native.cards.getMany(ids),
    );
    await Promise.all([native.close(), browser.close()]);
  });

  test("native checks internal snapshot identity and declared SQLite requirements", async () => {
    const data = await fixture();
    const database = new Database(data.databasePath);
    database.query("UPDATE snapshot_metadata SET value = ? WHERE key = ?").run(
      JSON.stringify({
        schemaVersion: 1,
        dataVersion: "another-version",
        source: data.snapshot.source,
        counts: data.snapshot.counts,
      }),
      "identity",
    );
    database.close();
    const snapshot = structuredClone(data.snapshot);
    snapshot.database.sha256 = await sha256(
      new Uint8Array(await Bun.file(data.databasePath).arrayBuffer()),
    );
    await expect(
      BunClient.createClientAsync({
        snapshot,
        databasePath: data.databasePath,
      }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_MISMATCH" });
    const fresh = await fixture();
    await expect(
      BunClient.createClientAsync({
        snapshot: {
          ...fresh.snapshot,
          database: {
            ...fresh.snapshot.database,
            requiredFeatures: ["unknown-extension"],
          },
        },
        databasePath: fresh.databasePath,
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_SCHEMA" });
  });

  test("built Node entry returns the same observable page", async () => {
    const data = await fixture();
    const native = await BunClient.createClientAsync({
      snapshot: data.snapshot,
      databasePath: data.databasePath,
    });
    const entry = pathToFileURL(
      new URL("./dist/node.js", import.meta.url).pathname,
    ).href;
    const script = `const {PokemonTCGClient}=await import(${JSON.stringify(entry)});const tcg=await PokemonTCGClient.createClientAsync({manifestPath:${JSON.stringify(data.manifestPath)}});console.log(JSON.stringify(await tcg.cards.search({text:'draw cards',limit:2})));await tcg.close();`;
    const process = Bun.spawn(
      [
        Bun.env.TCG_TEST_NODE ?? "node",
        "--input-type=module",
        "--eval",
        script,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(process.stdout).text();
    const stderr = await new Response(process.stderr).text();
    expect(await process.exited, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual(
      await native.cards.search({ text: "draw cards", limit: 2 }),
    );
    await native.close();
  });
});
