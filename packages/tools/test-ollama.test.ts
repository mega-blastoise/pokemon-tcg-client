/** @module ollama_tests Checks model pins, draft evidence, cache reuse, and failure recovery with fake responses. */
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractPrintedFields,
  inspectOllama,
  ollamaConfigHash,
  ollamaConfigSchema,
  printedFieldsSchema,
  requireQualification,
  scoreExtractionRuns,
  validateLocalEndpoint,
} from "./src/ollama.js";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0))
    await rm(path, { recursive: true, force: true });
});
// This is a test identity, not a real installed or qualified model recommendation.
const config = ollamaConfigSchema.parse({
  endpoint: "http://192.168.1.2:11434",
  model: "local-vision:reviewed",
  digest: "a".repeat(64),
  quantization: "Q4_K_M",
  ollamaVersion: "0.20.0",
  environment: {
    machine: "Spark test fixture",
    driver: "fixture",
    runtime: "fixture",
  },
});
// Deliberately unresolved artist information must remain visible in the draft.
const candidate = printedFieldsSchema.parse({
  name: "Testmon",
  number: "R",
  hp: 60,
  supertype: "Pokémon",
  types: ["Water"],
  subtypes: ["Basic"],
  evolvesFrom: null,
  rules: [],
  attacks: [{ name: "Think", cost: [], damage: null, text: "Draw two cards." }],
  abilities: [],
  weaknesses: [],
  resistances: [],
  retreatCost: [],
  artist: null,
  rarity: null,
  regulationMark: null,
  unreadableFields: ["artist"],
});
/** Replace Ollama HTTP calls with fixed responses and capture the submitted settings. */
function server(
  options: { digest?: string; response?: string; vision?: boolean } = {},
) {
  // Recording every request lets tests distinguish cache hits from new model calls.
  const calls: { path: string; body: Record<string, unknown> | null }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : null;
    calls.push({ path, body });
    const payload =
      path === "/api/version"
        ? { version: config.ollamaVersion }
        : path === "/api/tags"
          ? {
              models: [
                {
                  name: config.model,
                  digest: options.digest ?? config.digest,
                  details: { quantization_level: config.quantization },
                },
              ],
            }
          : path === "/api/show"
            ? {
                capabilities:
                  options.vision === false
                    ? ["completion"]
                    : ["vision", "completion"],
              }
            : {
                done: true,
                response: options.response ?? JSON.stringify(candidate),
              };
    return Response.json(payload);
  }) as typeof fetch;
  return { fetcher, calls };
}
test("local-only endpoint and installed model identity/capabilities are enforced", async () => {
  expect(() => validateLocalEndpoint("https://ollama.com")).toThrow();
  expect(() =>
    validateLocalEndpoint("http://localhost:11434/private"),
  ).toThrow();
  expect(validateLocalEndpoint("http://dgx-spark.local:11434").hostname).toBe(
    "dgx-spark.local",
  );
  await expect(
    inspectOllama(config, server({ digest: "b".repeat(64) }).fetcher),
  ).rejects.toThrow("digest");
  await expect(
    inspectOllama(config, server({ vision: false }).fetcher),
  ).rejects.toThrow("vision");
});
test("extraction persists evidence, uses fixed settings, and reuses identical outputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tcg-ollama-test-"));
  temporary.push(directory);
  const imagePath = join(directory, "card.png");
  await Bun.write(imagePath, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  const mock = server();
  const input = {
    config,
    imagePath,
    context: { cardId: "test-R", setId: "test", sourceCommit: "c".repeat(40) },
    cacheDir: join(directory, "cache"),
    fetch: mock.fetcher,
  };
  const first = await extractPrintedFields(input);
  const second = await extractPrintedFields(input);
  expect(first.status).toBe("draft");
  expect(first.candidate.number).toBe("R");
  expect(second.cached).toBe(true);
  expect(
    mock.calls.filter((call) => call.path === "/api/generate"),
  ).toHaveLength(1);
  const body = mock.calls.find((call) => call.path === "/api/generate")?.body;
  expect(body?.stream).toBe(false);
  expect(body?.options).toMatchObject({ temperature: 0, seed: 0 });
  expect(body?.format).toBeObject();
  expect(await readdir(first.evidencePath)).toEqual(
    expect.arrayContaining([
      "image.original",
      "input.json",
      "raw-response.json",
      "result.json",
    ]),
  );
});
test("malformed model output remains as evidence rather than a published record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tcg-ollama-invalid-"));
  temporary.push(directory);
  const imagePath = join(directory, "card.png");
  await Bun.write(imagePath, "fixture");
  await expect(
    extractPrintedFields({
      config,
      imagePath,
      context: {
        cardId: "test-1",
        setId: "test",
        sourceCommit: "c".repeat(40),
      },
      cacheDir: join(directory, "cache"),
      fetch: server({ response: "not json" }).fetcher,
    }),
  ).rejects.toThrow("evidence retained");
  const [entry] = await readdir(join(directory, "cache"));
  if (!entry) throw new Error("Expected retained extraction evidence");
  expect(
    await Bun.file(
      join(directory, "cache", entry, "raw-response.json"),
    ).exists(),
  ).toBe(true);
});
test("bulk needs a passing reviewed receipt bound to settings and extraction contract", () => {
  const receipt = {
    schemaVersion: 1,
    configHash: ollamaConfigHash(config),
    approved: true,
    reviewedBy: "fixture maintainer",
    reviewedAt: "2026-10-19T00:00:00Z",
    corpusHash: "d".repeat(64),
    corpusSize: 50,
    criteria: {
      minSchemaSuccess: 1,
      minCriticalAccuracy: 1,
      minRepeatability: 1,
      maxCorrectionSeconds: 10,
    },
    observed: {
      schemaSuccess: 1,
      criticalAccuracy: 1,
      repeatability: 1,
      correctionSeconds: 1,
    },
    reportPath: "qualification-report.json",
    limitations: ["Fixture; not a real model qualification"],
  };
  expect(() => requireQualification(config, receipt)).not.toThrow();
  expect(() => requireQualification({ ...config, seed: 1 }, receipt)).toThrow();
  expect(() =>
    requireQualification(config, { ...receipt, approved: false }),
  ).toThrow();
  expect(() =>
    requireQualification(config, {
      ...receipt,
      observed: { ...receipt.observed, repeatability: 0.9 },
    }),
  ).toThrow();
  expect(
    scoreExtractionRuns([
      { expected: candidate, actual: candidate, correctionSeconds: 2 },
    ]).fullRecordAccuracy,
  ).toBe(1);
});

test("failed extraction keeps input evidence and a retry preserves the failed attempt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tcg-ollama-retry-"));
  temporary.push(directory);
  const imagePath = join(directory, "card.png");
  await Bun.write(imagePath, "fixture");
  const mock = server();
  const input = {
    config,
    imagePath,
    context: { cardId: "test-1", setId: "test", sourceCommit: "c".repeat(40) },
    cacheDir: join(directory, "cache"),
  };
  const failing = (async (url: RequestInfo | URL, init?: RequestInit) =>
    new URL(String(url)).pathname === "/api/generate"
      ? new Response("temporarily unavailable", { status: 503 })
      : mock.fetcher(url, init)) as typeof fetch;
  await expect(
    extractPrintedFields({ ...input, fetch: failing }),
  ).rejects.toThrow("evidence retained");
  const [first] = await readdir(input.cacheDir);
  if (!first) throw new Error("Expected failed attempt evidence");
  expect(
    await Bun.file(join(input.cacheDir, first, "failure.json")).exists(),
  ).toBe(true);
  const success = await extractPrintedFields({ ...input, fetch: mock.fetcher });
  expect(success.evidencePath).not.toBe(join(input.cacheDir, first));
  expect(
    (await extractPrintedFields({ ...input, fetch: mock.fetcher })).cached,
  ).toBe(true);
  expect(
    await Bun.file(join(input.cacheDir, first, "failure.json")).exists(),
  ).toBe(true);
});
