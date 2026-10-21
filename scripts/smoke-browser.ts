/** @module browser_smoke Checks browser-only imports, real Chromium behavior, and GitHub CORS. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import type { SnapshotManifest } from "../packages/client/src/schema.js";

/** Test packed client behavior with fixed responses, then check unrouted GitHub transport. */
export async function runBrowserSmoke(options: {
  consumer: string;
  snapshot: SnapshotManifest;
  files: Map<string, string>;
}) {
  // Resolve the default package export from the installed consumer, as an app would.
  const entry = join(options.consumer, "browser.mjs");
  await Bun.write(
    entry,
    `import { PokemonTCGClient } from "@johto-ai/tcg-client";
export async function run(snapshot) {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const client = await PokemonTCGClient.createClientAsync({snapshot});
  try {
    check((await client.cards.get("old-2"))?.name === "Pikáchu", "card lookup");
    check(await client.cards.get("missing-1") === null, "missing card null");
    const batch = await client.cards.getMany(["old-2", "missing-1", "old-2"]);
    check(JSON.stringify(batch.map(card => card?.id ?? null)) === '["old-2",null,"old-2"]', "batch order/nulls");
    const page = await client.cards.search({name:"pikachu"});
    check(JSON.stringify(page.items.map(card => card.id)) === '["new-1","old-2"]', "accent search and sort");
    check((await client.sets.list()).total === 2, "sets");
    return {cards:5, sets:2, adapter:"browser"};
  } finally { await client.close(); }
}
`,
  );
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    conditions: ["browser"],
    plugins: [
      {
        name: "reject-native-browser-imports",
        setup(builder) {
          // Fail at resolution time even if a later optimizer would remove the import.
          builder.onResolve(
            { filter: /^(?:bun:|node:|@johto-ai\/tcg-data(?:\/|$))/ },
            (args) => {
              throw new Error(
                `Native/data module leaked into browser graph: ${args.path}`,
              );
            },
          );
        },
      },
    ],
  });
  assert.ok(result.success, result.logs.map(String).join("\n"));
  assert.equal(result.outputs.length, 1);
  assert.ok(result.outputs[0]);
  const bundle = await result.outputs[0].text();
  assert.doesNotMatch(
    bundle,
    /bun:sqlite|node:sqlite|@johto-ai\/tcg-data|DatabaseSync|native-store/,
  );
  const browser = await chromium
    .launch({
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    })
    .catch((cause) => {
      throw new Error(
        "Chromium launch failed; install with `bunx playwright install chromium` or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH",
        { cause },
      );
    });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    // Count fixture requests separately from the live GitHub probe below.
    const requests: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // A secure, intercepted test origin provides Web Crypto without requiring
    // a listening server or making a real DNS/network request.
    await page.route("https://tcg-smoke.invalid/**", async (route) => {
      const script = new URL(route.request().url()).pathname === "/app.js";
      await route.fulfill({
        status: 200,
        body: script
          ? bundle
          : "<!doctype html><title>TCG packed browser smoke</title>",
        contentType: script ? "text/javascript" : "text/html",
      });
    });
    await page.route("https://raw.githubusercontent.com/**", async (route) => {
      const url = route.request().url();
      const path = url.split("generated/v1/")[1] ?? "";
      requests.push(path);
      const body = options.files.get(path);
      await route.fulfill({
        status: body === undefined ? 404 : 200,
        body: body ?? "Missing fixture",
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    });
    await page.goto("https://tcg-smoke.invalid/");
    const output = await page.evaluate(async (snapshot) => {
      const path = "/app.js";
      const module = await import(path);
      return module.run(snapshot);
    }, options.snapshot);
    assert.deepEqual(output, { cards: 5, sets: 2, adapter: "browser" });
    assert.deepEqual(errors, []);
    assert.ok(requests.includes("manifest.json"));
    assert.equal(
      requests.filter((path) => path === "cards/old.json").length,
      1,
    );
    assert.ok(requests.includes("cards/new.json"));
    assert.ok(!requests.some((path) => path.endsWith(".db")));
    console.log(
      "Packed browser import/bundle and real Chromium fixture transport passed (GitHub responses mocked; no live GitHub claim)",
    );
    // Separately exercise real cross-origin GitHub transport, without routing
    // or substituting the provider response. Normalized views will be present
    // only after the reviewed fork update; the existing pinned set file proves
    // browser CORS/transport without pretending that update has been published.
    await page.unroute("https://raw.githubusercontent.com/**");
    const pin = await Bun.file(
      fileURLToPath(new URL("../dataset-source.json", import.meta.url)),
    ).json();
    assert.match(pin.repository, /^[\w.-]+\/[\w.-]+$/);
    assert.match(pin.commit, /^[a-f0-9]{40}$/);
    const github = await page.evaluate(async (url) => {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok)
        throw new Error(`Live GitHub fetch failed: ${response.status}`);
      const sets = await response.json();
      if (
        !Array.isArray(sets) ||
        !sets.length ||
        !sets.every((set) => typeof set.id === "string")
      )
        throw new Error("Live GitHub set data is malformed");
      return {
        type: response.type,
        status: response.status,
        sets: sets.length,
      };
    }, `https://raw.githubusercontent.com/${pin.repository}/${pin.commit}/sets/en.json`);
    assert.equal(github.type, "cors");
    assert.equal(github.status, 200);
    console.log(
      `Live browser GitHub CORS passed for pinned source (${github.sets} sets)`,
    );
  } finally {
    await browser.close();
  }
}
