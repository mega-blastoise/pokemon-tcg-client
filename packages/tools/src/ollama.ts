/** @module ollama Extract draft printed text with a pinned local model and retained evidence. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FetchFunction } from "@johto-ai/tcg-client";
import {
  commitSchema,
  identifierSchema,
  setIdentifierSchema,
} from "@johto-ai/tcg-client/schema";
import { z } from "zod";
import { sha256, stableJson, writeJson } from "./files.js";

// Null means unreadable text; an empty list means visibly absent or inapplicable.
const nullable = z.string().nullable();
export const printedFieldsSchema = z
  .object({
    name: nullable,
    number: nullable,
    hp: z.number().int().nonnegative().nullable(),
    supertype: z.enum(["Pokémon", "Trainer", "Energy"]).nullable(),
    types: z.array(z.string()),
    subtypes: z.array(z.string()),
    evolvesFrom: nullable,
    rules: z.array(z.string()),
    attacks: z.array(
      z
        .object({
          name: nullable,
          cost: z.array(z.string()),
          damage: nullable,
          text: nullable,
        })
        .strict(),
    ),
    abilities: z.array(
      z.object({ name: nullable, type: nullable, text: nullable }).strict(),
    ),
    weaknesses: z.array(
      z.object({ type: z.string(), value: z.string() }).strict(),
    ),
    resistances: z.array(
      z.object({ type: z.string(), value: z.string() }).strict(),
    ),
    retreatCost: z.array(z.string()),
    artist: nullable,
    rarity: nullable,
    regulationMark: nullable,
    unreadableFields: z.array(z.string()),
  })
  .strict();
export type PrintedFields = z.infer<typeof printedFieldsSchema>;
/** Record model/runtime pins, machine labels and request limits for comparable runs. */
export const ollamaConfigSchema = z
  .object({
    endpoint: z.url(),
    model: z.string().min(1),
    digest: z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/),
    quantization: z.string().min(1),
    ollamaVersion: z.string().min(1),
    seed: z.number().int().default(0),
    numPredict: z.number().int().positive().max(32768).default(4096),
    numCtx: z.number().int().positive().max(131072).default(8192),
    timeoutMs: z.number().int().positive().max(900000).default(180000),
    environment: z
      .object({
        machine: z.string().min(1),
        driver: z.string().min(1),
        runtime: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export type OllamaConfig = z.output<typeof ollamaConfigSchema>;
/** Maintainer approval binds measured limits to one configuration and checked corpus. */
export const qualificationSchema = z
  .object({
    schemaVersion: z.literal(1),
    configHash: z.string().regex(/^[a-f0-9]{64}$/),
    approved: z.boolean(),
    reviewedBy: z.string().min(1),
    reviewedAt: z
      .string()
      .regex(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/,
      )
      .refine((value) => !Number.isNaN(Date.parse(value))),
    corpusHash: z.string().regex(/^[a-f0-9]{64}$/),
    corpusSize: z.number().int().min(45),
    criteria: z
      .object({
        minSchemaSuccess: z.number().min(0).max(1),
        minCriticalAccuracy: z.number().min(0).max(1),
        minRepeatability: z.number().min(0).max(1),
        maxCorrectionSeconds: z.number().nonnegative(),
      })
      .strict(),
    observed: z
      .object({
        schemaSuccess: z.number().min(0).max(1),
        criticalAccuracy: z.number().min(0).max(1),
        repeatability: z.number().min(0).max(1),
        correctionSeconds: z.number().nonnegative(),
      })
      .strict(),
    reportPath: z.string().min(1),
    limitations: z.array(z.string()),
  })
  .strict();

/** Accept only local/private origin forms; hosted fallback and embedded credentials are forbidden. */
export function validateLocalEndpoint(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const octets = host.split(".").map(Number);
  const secondOctet = octets[1] ?? -1;
  // Include private LAN, loopback and shared-address space used by private networks.
  const privateIp =
    octets.length === 4 &&
    octets.every(
      (part) => Number.isInteger(part) && part >= 0 && part <= 255,
    ) &&
    (octets[0] === 10 ||
      octets[0] === 127 ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 172 && secondOctet >= 16 && secondOctet <= 31) ||
      (octets[0] === 100 && secondOctet >= 64 && secondOctet <= 127));
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(
      privateIp ||
      host === "localhost" ||
      host === "::1" ||
      /^f[cd][0-9a-f:]+$/i.test(host) ||
      host.endsWith(".local") ||
      host.endsWith(".lan")
    )
  )
    throw new Error(
      "Ollama endpoint must be a local/private HTTP(S) origin; no hosted fallback is permitted",
    );
  return url;
}

/** Restrict extraction to visible printed fields, not inferred identity or metadata. */
export const EXTRACTION_PROMPT =
  "Transcribe the English printed fields visible on this Pokémon trading card. Preserve spelling, symbols, damage expressions, and rule boxes exactly. Do not infer illegible text, tournament legality, set metadata, identity, or release dates. Use null for unreadable scalars, list unresolved field paths in unreadableFields, and use empty arrays only for fields visibly absent/inapplicable. Output only the supplied JSON schema. Known identity context is supplied separately and is not evidence of printed text.";
export const extractionJsonSchema = z.toJSONSchema(printedFieldsSchema);
/** Invalidate qualification and caches when settings, prompt, schema or pipeline change. */
export function ollamaConfigHash(config: OllamaConfig): string {
  return sha256(
    stableJson({
      config,
      pipelineVersion: 1,
      promptHash: sha256(EXTRACTION_PROMPT),
      schemaHash: sha256(stableJson(extractionJsonSchema)),
    }),
  );
}
/** Require an approved passing receipt for these exact settings before bulk extraction. */
export function requireQualification(
  config: OllamaConfig,
  receipt: unknown,
): void {
  const q = qualificationSchema.parse(receipt);
  if (
    !q.approved ||
    q.configHash !== ollamaConfigHash(config) ||
    q.observed.schemaSuccess < q.criteria.minSchemaSuccess ||
    q.observed.criticalAccuracy < q.criteria.minCriticalAccuracy ||
    q.observed.repeatability < q.criteria.minRepeatability ||
    q.observed.correctionSeconds > q.criteria.maxCorrectionSeconds
  )
    throw new Error(
      "Bulk extraction requires a maintainer-approved passing qualification for this exact configuration",
    );
}

/** Bound local requests and reject redirects rather than follow a hosted fallback. */
async function request(
  config: OllamaConfig,
  path: string,
  fetcher: FetchFunction,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const endpoint = validateLocalEndpoint(config.endpoint);
  const response = await fetcher(new URL(path, endpoint), {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    signal: AbortSignal.timeout(config.timeoutMs),
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  if (!response.ok)
    throw new Error(`Ollama ${path} failed (${response.status})`);
  const result = await response.json();
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new Error("Ollama returned a malformed response");
  return result as Record<string, unknown>;
}
/** Verify model bytes, vision support and Ollama version without pulling a model. */
export async function inspectOllama(
  configInput: unknown,
  fetcher: FetchFunction = fetch,
) {
  const config = ollamaConfigSchema.parse(configInput);
  const [version, tags, show] = await Promise.all([
    request(config, "/api/version", fetcher),
    request(config, "/api/tags", fetcher),
    request(config, "/api/show", fetcher, { model: config.model }),
  ]);
  const models = z
    .array(
      z
        .object({
          name: z.string(),
          digest: z.string(),
          details: z.object({ quantization_level: z.string() }).passthrough(),
        })
        .passthrough(),
    )
    .parse(tags.models);
  const model = models.find((entry) => entry.name === config.model);
  if (
    !model ||
    model.digest.replace(/^sha256:/, "") !==
      config.digest.replace(/^sha256:/, "") ||
    model.details.quantization_level !== config.quantization
  )
    throw new Error(
      "Installed model digest/quantization does not match the pinned configuration; no model is pulled automatically",
    );
  if (
    !Array.isArray(show.capabilities) ||
    !show.capabilities.includes("vision")
  )
    throw new Error("Installed model does not report vision capability");
  if (version.version !== config.ollamaVersion)
    throw new Error(
      "Ollama version does not match the qualified configuration",
    );
  return {
    config,
    ollamaVersion: version.version,
    model,
    capabilities: show.capabilities,
  };
}

/** Return a draft with cached or fresh local-model evidence; never update canonical cards. */
export async function extractPrintedFields(options: {
  config: unknown;
  imagePath: string;
  context: { cardId: string; setId: string; sourceCommit: string };
  cacheDir: string;
  fetch?: FetchFunction;
  repeat?: boolean;
}) {
  const config = ollamaConfigSchema.parse(options.config);
  const context = z
    .object({
      cardId: identifierSchema,
      setId: setIdentifierSchema,
      sourceCommit: commitSchema,
    })
    .strict()
    .parse(options.context);
  if (!context.cardId.startsWith(`${context.setId}-`))
    throw new Error("Extraction context card ID is outside its set");
  const fetcher = options.fetch ?? fetch;
  const installed = await inspectOllama(config, fetcher);
  const imageFile = Bun.file(options.imagePath);
  if (imageFile.size === 0 || imageFile.size > 25_000_000)
    throw new Error("Image must be 1..25,000,000 bytes");
  const image = new Uint8Array(await readFile(options.imagePath));
  if (image.length > 25_000_000 || image.length === 0)
    throw new Error("Image must be 1..25,000,000 bytes");
  const imageHash = sha256(image);
  const promptHash = sha256(EXTRACTION_PROMPT);
  const schemaHash = sha256(stableJson(extractionJsonSchema));
  // Cache identity includes the original bytes, known card context and all model inputs.
  const identity = {
    configHash: ollamaConfigHash(config),
    imageHash,
    promptHash,
    schemaHash,
    context,
    ollamaVersion: installed.ollamaVersion,
    preprocessing: "original-bytes-v1",
    settings: {
      temperature: 0,
      seed: config.seed,
      num_predict: config.numPredict,
      num_ctx: config.numCtx,
    },
  };
  const key = sha256(stableJson(identity));
  const path = resolve(options.cacheDir, key);
  const cached = Bun.file(resolve(path, "result.json"));
  if (!options.repeat && (await cached.exists())) {
    const result = await cached.json();
    if (result.key !== key || result.imageHash !== imageHash)
      throw new Error("Cached extraction identity mismatch");
    printedFieldsSchema.parse(result.candidate);
    return { ...result, cached: true };
  }
  // Repeats and retries keep separate evidence rather than overwrite previous attempts.
  const runPath = options.repeat
    ? `${path}-repeat-${crypto.randomUUID()}`
    : (await Bun.file(resolve(path, "input.json")).exists())
      ? `${path}-attempt-${crypto.randomUUID()}`
      : path;
  await mkdir(runPath, { recursive: true });
  await writeFile(resolve(runPath, "image.original"), image, { flag: "wx" });
  await writeJson(resolve(runPath, "input.json"), {
    ...identity,
    installed,
    prompt: EXTRACTION_PROMPT,
    schema: extractionJsonSchema,
  });
  // Preserve inputs before inference so failures still leave an inspectable record.
  const started = performance.now();
  let response: Record<string, unknown>;
  try {
    response = await request(config, "/api/generate", fetcher, {
      model: config.model,
      prompt: `${EXTRACTION_PROMPT}\nKnown context: ${JSON.stringify(context)}`,
      images: [Buffer.from(image).toString("base64")],
      format: extractionJsonSchema,
      stream: false,
      options: identity.settings,
    });
    await writeJson(resolve(runPath, "raw-response.json"), response);
    await inspectOllama(config, fetcher); // Reject mutable-tag changes during this extraction.
  } catch (cause) {
    await writeJson(resolve(runPath, "failure.json"), {
      message: cause instanceof Error ? cause.message : String(cause),
    });
    throw new Error(
      `Ollama extraction failed; evidence retained at ${runPath}`,
      { cause },
    );
  }
  if (response.done !== true || typeof response.response !== "string")
    throw new Error(
      `Ollama returned an incomplete extraction; evidence retained at ${runPath}`,
    );
  let decoded: unknown;
  try {
    decoded = JSON.parse(response.response);
  } catch {
    throw new Error(
      `Extraction JSON failed; raw evidence retained at ${runPath}`,
    );
  }
  const parsed = printedFieldsSchema.safeParse(decoded);
  if (!parsed.success) {
    await writeJson(
      resolve(runPath, "validation-errors.json"),
      parsed.error.issues,
    );
    throw new Error(
      `Extraction schema failed; evidence retained at ${runPath}`,
    );
  }
  // Schema-valid output remains a draft, including explicitly unreadable fields.
  const result = {
    schemaVersion: 1,
    key,
    imageHash,
    status: "draft",
    candidate: parsed.data,
    issues: parsed.data.unreadableFields,
    elapsedMs: performance.now() - started,
    evidencePath: runPath,
    humanCorrections: [],
    cached: false,
  };
  await writeJson(resolve(runPath, "result.json"), result);
  if (!options.repeat && runPath !== path)
    await writeJson(resolve(path, "result.json"), result);
  return result;
}

/** Compares manually checked expected JSON with repeated runs; never auto-approves a model. */
export function scoreExtractionRuns(
  runs: {
    expected: PrintedFields;
    actual: PrintedFields | null;
    correctionSeconds: number;
  }[],
) {
  if (!runs.length) throw new Error("Qualification corpus is empty");
  // Failed parses count against accuracy; repeatability needs a separate checked report.
  const valid = runs.filter((run) => run.actual !== null);
  /** Count exact values, including printed symbols and nested attack text. */
  const exact = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  return {
    schemaSuccess: valid.length / runs.length,
    identityAccuracy:
      valid.filter(
        (run) =>
          run.actual?.name === run.expected.name &&
          run.actual?.number === run.expected.number,
      ).length / runs.length,
    criticalAccuracy:
      valid.filter((run) =>
        [
          "name",
          "number",
          "hp",
          "attacks",
          "abilities",
          "rules",
          "weaknesses",
          "resistances",
        ].every((field) =>
          exact(
            run.actual?.[field as keyof PrintedFields],
            run.expected[field as keyof PrintedFields],
          ),
        ),
      ).length / runs.length,
    fullRecordAccuracy:
      valid.filter((run) => exact(run.actual, run.expected)).length /
      runs.length,
    correctionSeconds:
      runs.reduce((sum, run) => sum + run.correctionSeconds, 0) / runs.length,
    unreadableFields: valid.reduce(
      (sum, run) => sum + (run.actual?.unreadableFields.length ?? 0),
      0,
    ),
  };
}
