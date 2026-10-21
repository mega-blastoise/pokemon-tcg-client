/** @module audit_baseline Compares full catalog builds and client results across supported adapters. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PokemonTCGClient as BrowserClient,
  type ClientOptions,
} from "../packages/client/dist/browser.js";
import type { CardQuery } from "../packages/client/dist/query.js";
import type { SnapshotManifest } from "../packages/client/dist/schema.js";

// Exercise built runtime entries without a root dependency on a workspace package.
const { PokemonTCGClient } = await import(
  globalThis.Bun
    ? "../packages/client/dist/bun.js"
    : "../packages/client/dist/node.js"
);

const root = fileURLToPath(new URL("../", import.meta.url));
// One fixed query suite is run unchanged in Bun, Node, and the browser adapter.
const queries: CardQuery[] = [
  { limit: 50 },
  { limit: 50, offset: 50 },
  { setId: "me55", sort: "number", limit: 250 },
  { setId: "me55c", sort: "number", limit: 250 },
  { setId: "ex10", sort: "number", limit: 250 },
  { text: "draw cards", limit: 100 },
  { text: "draw cards", limit: 50, offset: 50, sort: "name" },
  { name: "Farfetch’d", limit: 100 },
  { name: "%", limit: 10 },
  { type: "Fire", subtype: "Basic", sort: "name", limit: 100 },
  { supertype: "Energy", subtype: "Basic", limit: 100 },
  { rarity: "Rare Holo", sort: "name", direction: "desc", limit: 100 },
  { regulationMark: "J", text: "draw", limit: 100 },
  { supertype: "Trainer", text: "Pokémon discard", limit: 100 },
  { text: "a-term-that-does-not-exist-in-card-rules", limit: 10 },
];
/** Sort object keys for hashing; preserve array order because result ordering is part of the API. */
function canonical(value: unknown): string {
  /** Recursively remove object-key insertion order from the comparison. */
  const order = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(order);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, entry]) => [key, order(entry)]),
      );
    return item;
  };
  return `${JSON.stringify(order(value))}\n`;
}
/** Reduce a complete record/page to a stable signature, not just an ID list. */
function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
/** Summarize the observed sample batch; these values are not service latency guarantees. */
function measurements(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
    p95Ms:
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ??
      0,
    maxMs: sorted.at(-1) ?? 0,
  };
}
/** Run identical lookup/search/iteration checks against any already-selected client adapter. */
async function exercise(
  factory: Pick<typeof BrowserClient, "createClientAsync">,
  options: ClientOptions,
  coldSearchOptions: ClientOptions = options,
) {
  const start = performance.now();
  const client = await factory.createClientAsync(options);
  const initializationMs = performance.now() - start;
  try {
    const lookupStart = performance.now();
    const special = await client.cards.get("ex10-?");
    const coldLookupMs = performance.now() - lookupStart;
    assert.equal(special?.number, "?");
    const lookupTimes: number[] = [];
    for (let index = 0; index < 25; index++) {
      const started = performance.now();
      await client.cards.get(index % 2 ? "ex10-!" : "ex10-?");
      lookupTimes.push(performance.now() - started);
    }
    // The cold search must not reuse state warmed by the earlier single-card lookup.
    const searchClient = await factory.createClientAsync(coldSearchOptions);
    let coldSearchMs: number;
    try {
      const searchStart = performance.now();
      await searchClient.cards.search({ text: "draw cards", limit: 50 });
      coldSearchMs = performance.now() - searchStart;
    } finally {
      await searchClient.close();
    }
    await client.cards.search({ text: "draw cards", limit: 50 });
    const searchTimes: number[] = [];
    // Measure time before the call returns its Promise, separately from total completion time.
    const callBlocking: number[] = [];
    for (let index = 0; index < 10; index++) {
      const started = performance.now();
      const pending = client.cards.search({ text: "draw cards", limit: 50 });
      callBlocking.push(performance.now() - started);
      await pending;
      searchTimes.push(performance.now() - started);
    }
    const pages = [];
    for (const query of queries) {
      const page = await client.cards.search(query);
      pages.push({
        query,
        total: page.total,
        count: page.items.length,
        sha256: hash(page),
      });
    }
    const batch = await client.cards.getMany([
      "ex10-!",
      "ex10-?",
      "ex10-!",
      "nonexistent-card",
    ]);
    assert.deepEqual(
      batch.map((card) => card?.id ?? null),
      ["ex10-!", "ex10-?", "ex10-!", null],
    );
    const iterationStart = performance.now();
    // Stream complete records into the hash so iteration does not need a second catalog copy.
    const digest = createHash("sha256");
    let cardCount = 0;
    const fieldCounts: Record<string, number> = {};
    for await (const card of client.cards.iterate({ limit: 250 })) {
      digest.update(canonical(card));
      cardCount++;
      for (const [key, value] of Object.entries(card)) {
        if (value !== null && (!Array.isArray(value) || value.length > 0))
          fieldCounts[key] = (fieldCounts[key] ?? 0) + 1;
      }
    }
    const iterationMs = performance.now() - iterationStart;
    const sets = [];
    for await (const set of client.sets.iterate({ limit: 100 })) sets.push(set);
    return {
      runtime: globalThis.Bun
        ? `bun ${Bun.version}`
        : `node ${process.versions.node}`,
      checks: {
        cardCount,
        setCount: sets.length,
        recordsSha256: digest.digest("hex"),
        setsSha256: hash(sets),
        specialBatchSha256: hash(batch),
        fieldCounts,
        pages,
      },
      timings: {
        initializationMs,
        coldLookupMs,
        warmLookup: measurements(lookupTimes),
        coldSearchMs,
        warmSearch: measurements(searchTimes),
        synchronousSearchCall: measurements(callBlocking),
        fullIterationMs: iterationMs,
      },
    };
  } finally {
    await client.close();
  }
}

// The Node subprocess only reads an existing snapshot; Bun owns all build/audit work.
if (process.argv.includes("--node-worker")) {
  const input = JSON.parse(readFileSync(0, "utf8")) as { manifestPath: string };
  console.log(
    JSON.stringify(
      await exercise(PokemonTCGClient, {
        manifestPath: input.manifestPath,
        allowDraft: true,
      }),
    ),
  );
} else {
  if (!globalThis.Bun || Bun.version !== "1.4.3")
    throw new Error("The baseline audit requires pinned Bun 1.4.3");
  const { loadBaseline } = await import("../packages/tools/src/baseline.ts");
  const { buildSnapshot, verifySnapshot } = await import(
    "../packages/tools/src/snapshot.ts"
  );
  const { safeAssetFile } = await import("../packages/tools/src/assets.ts");
  const config = JSON.parse(
    readFileSync(join(root, "dataset-source.json"), "utf8"),
  ) as { repository: string; commit: string; baselineCommit?: string };
  // Keep each audit's drafts and measurements separate for later inspection.
  const output = join(root, ".local", `catalog-check-${crypto.randomUUID()}`);
  mkdirSync(output, { recursive: true });
  const baselineStarted = performance.now();
  const baseline = await loadBaseline({
    sourceDir: resolve(
      root,
      process.env.TCG_SOURCE_DIR ?? "../pokemon-tcg-data",
    ),
    source: { repository: config.repository, commit: config.commit },
    ...(config.baselineCommit ? { baselineCommit: config.baselineCommit } : {}),
  });
  const baselineLoadMs = performance.now() - baselineStarted;
  const buildTimes: number[] = [];
  const snapshots: SnapshotManifest[] = [];
  // Matching rows alone are weaker than matching database and browser file bytes.
  for (const name of ["first", "second"]) {
    const started = performance.now();
    snapshots.push(
      await buildSnapshot({
        baseline,
        outputDir: join(output, name),
        dataVersion: "0.0.0-catalog-audit",
      }),
    );
    buildTimes.push(performance.now() - started);
  }
  const first = snapshots[0];
  const second = snapshots[1];
  assert.ok(first && second);
  assert.equal(first.releaseReady, false);
  assert.equal(
    first.database.sha256,
    second.database.sha256,
    "Pinned SQLite builds must be byte-identical",
  );
  assert.equal(
    first.browser.manifestSha256,
    second.browser.manifestSha256,
    "Generated browser files must be byte-identical",
  );
  const verifyStarted = performance.now();
  await verifySnapshot(join(output, "first"), { baseline });
  await verifySnapshot(join(output, "second"), { baseline });
  const verificationMs = performance.now() - verifyStarted;
  const manifestPath = join(output, "first/manifest.json");
  const bun = await exercise(PokemonTCGClient, {
    manifestPath,
    allowDraft: true,
  });
  // Independent clients have independent caches; track them separately when counting requests.
  const requestScopes: Record<
    string,
    { counts: Record<string, number>; bytes: number }
  > = {
    primary: { counts: {}, bytes: 0 },
    coldSearch: { counts: {}, bytes: 0 },
  };
  /** Supply checked local JSON while leaving browser parsing, caching, and queries intact. */
  const localFetch = (scope: "primary" | "coldSearch") =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.signal?.aborted)
        throw new DOMException("Aborted", "AbortError");
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith(first.browser.baseUrl))
        throw new Error(`Unexpected browser transport request: ${url}`);
      const file = url.slice(first.browser.baseUrl.length);
      const requests = requestScopes[scope];
      if (!requests) throw new Error("Missing request scope");
      requests.counts[file] = (requests.counts[file] ?? 0) + 1;
      const bytes = new Uint8Array(
        await Bun.file(
          safeAssetFile(join(output, "first"), file),
        ).arrayBuffer(),
      );
      requests.bytes += bytes.length;
      return new Response(bytes, {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
  const browser = await exercise(
    BrowserClient,
    {
      snapshot: first,
      allowDraft: true,
      fetch: localFetch("primary"),
    },
    { snapshot: first, allowDraft: true, fetch: localFetch("coldSearch") },
  );
  assert.deepEqual(
    browser.checks,
    bun.checks,
    "Bun/browser complete-record and query parity",
  );
  const nodeBinary = process.env.NODE_BINARY ?? Bun.which("node");
  if (!nodeBinary)
    throw new Error(
      "NODE_BINARY or a supported Node executable on PATH is required",
    );
  // A real Node process is required; running the Node entry under Bun would not test Node SQLite.
  const nodeProcess = Bun.spawn(
    [nodeBinary, fileURLToPath(import.meta.url), "--node-worker"],
    {
      cwd: root,
      stdin: new Blob([JSON.stringify({ manifestPath })]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [nodeOutput, nodeError, nodeExit] = await Promise.all([
    new Response(nodeProcess.stdout).text(),
    new Response(nodeProcess.stderr).text(),
    nodeProcess.exited,
  ]);
  if (nodeExit !== 0)
    throw new Error(`Node catalog worker failed: ${nodeError || nodeOutput}`);
  const node = JSON.parse(nodeOutput) as Awaited<ReturnType<typeof exercise>>;
  assert.deepEqual(
    node.checks,
    bun.checks,
    "Bun/Node complete-record and query parity",
  );
  assert.deepEqual(
    { sets: bun.checks.setCount, cards: bun.checks.cardCount },
    baseline.audit.counts,
  );
  const bundle = await Bun.build({
    entrypoints: [join(root, "packages/client/dist/browser.js")],
    target: "browser",
    format: "esm",
    minify: true,
  });
  if (!bundle.success)
    throw new AggregateError(bundle.logs, "Browser payload measurement failed");
  const bundled = bundle.outputs[0];
  assert.ok(bundled);
  const bundleBytes = new Uint8Array(await bundled.arrayBuffer());
  const cardFileSizes = baseline.sets.map(
    (set) =>
      statSync(join(output, "first/generated/v1/cards", `${set.id}.json`)).size,
  );
  const searchBytes = new Uint8Array(
    await Bun.file(
      join(output, "first/generated/v1/search-index.json"),
    ).arrayBuffer(),
  );
  // Persist correctness checks alongside timings, sizes, and the limits of this local transport.
  const summary = {
    measuredAt: new Date().toISOString(),
    output,
    source: baseline.source,
    baselineCommit: baseline.baselineCommit,
    counts: baseline.audit.counts,
    rawFieldCounts: baseline.audit.cardFields,
    missingFields: baseline.audit.missingFields,
    totalMismatches: baseline.audit.totalMismatches,
    releaseReady: false,
    releaseIssues: first.issues.length,
    deterministicArtifacts: {
      databaseSha256: first.database.sha256,
      browserManifestSha256: first.browser.manifestSha256,
      buildsCompared: 2,
    },
    parity: {
      allRecordsAndSets: true,
      queryCases: queries.length,
      checks: bun.checks,
    },
    timings: {
      baselineLoadMs,
      buildMs: buildTimes,
      verificationMs,
      bun: bun.timings,
      browserAdapter: browser.timings,
      node: node.timings,
    },
    runtimes: {
      bun: bun.runtime,
      node: node.runtime,
      nodeDiagnostics: nodeError.trim(),
    },
    sizes: {
      sqliteBytes: statSync(join(output, "first/pokemon-data.sqlite3.db")).size,
      searchIndexBytes: searchBytes.length,
      searchIndexGzipBytes: Bun.gzipSync(searchBytes).length,
      setsJSONBytes: statSync(join(output, "first/generated/v1/sets.json"))
        .size,
      allCardJSONBytes: cardFileSizes.reduce((a, b) => a + b, 0),
      largestSetJSONBytes: Math.max(...cardFileSizes),
      minifiedBrowserBundleBytes: bundleBytes.length,
      minifiedBrowserBundleGzipBytes: Bun.gzipSync(bundleBytes).length,
    },
    browserTransport: {
      kind: "local-filesystem-fetch-stub",
      networkAndCORSMeasured: false,
      externalImagesFetched: false,
      scopes: Object.fromEntries(
        Object.entries(requestScopes).map(([scope, requests]) => [
          scope,
          {
            fetchedBytes: requests.bytes,
            requestCount: Object.values(requests.counts).reduce(
              (a, b) => a + b,
              0,
            ),
            duplicateRequests: Object.entries(requests.counts).filter(
              ([, count]) => count > 1,
            ),
          },
        ]),
      ),
    },
    interpretation:
      "Draft-only local audit. Cold lookup and cold search use separate fresh client instances; neither clears operating-system caches. Timings include validation/decoding; synchronousSearchCall measures call-return blocking, not total event-loop delay. Browser request counts are separated by client cache. Filesystem transport does not establish GitHub availability, real-browser execution or CORS. Owned-asset acquisition, inventory approval, and source publication remain explicit release gates.",
  };
  await Bun.write(
    join(output, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  console.log(JSON.stringify(summary, null, 2));
}
