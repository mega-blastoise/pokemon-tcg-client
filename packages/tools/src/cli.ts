#!/usr/bin/env bun
/** @module cli Dispatch maintainer commands with explicit draft, network and write boundaries. */
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { prepareAssets, verifyPublishedAssets } from "./assets.js";
import { loadBaseline } from "./baseline.js";
import { writeJson } from "./files.js";
import {
  extractPrintedFields,
  inspectOllama,
  ollamaConfigSchema,
  printedFieldsSchema,
  requireQualification,
  scoreExtractionRuns,
} from "./ollama.js";
import { prepareReview, submitDraftPR, validateBatch } from "./review.js";
import { buildSnapshot, verifySnapshot } from "./snapshot.js";
import { importTCGdex } from "./tcgdex.js";

/** Run one command; audit/review use status 2 for unfinished data, while failures throw. */
export async function main(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      source: { type: "string" },
      "source-config": { type: "string", default: "dataset-source.json" },
      output: { type: "string" },
      snapshot: { type: "string" },
      "release-version": { type: "string" },
      "release-ready": { type: "boolean", default: false },
      "builder-version": { type: "string" },
      "builder-commit": { type: "string" },
      "inventories-dir": { type: "string" },
      "asset-manifest": { type: "string" },
      "asset-origin": { type: "string" },
      acquire: { type: "boolean", default: false },
      "verify-published": { type: "boolean", default: false },
      "tcgdex-source": { type: "string" },
      mapping: { type: "string" },
      batch: { type: "string" },
      inventory: { type: "string" },
      branch: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
      execute: { type: "boolean", default: false },
      config: { type: "string" },
      image: { type: "string" },
      "card-id": { type: "string" },
      "set-id": { type: "string" },
      "source-commit": { type: "string" },
      cache: { type: "string" },
      repeat: { type: "boolean", default: false },
      qualification: { type: "string" },
      inputs: { type: "string" },
      runs: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  /** Require a nonempty string option before a command reads files or starts work. */
  const required = (name: keyof typeof values): string => {
    const value = values[name];
    if (typeof value !== "string" || !value)
      throw new Error(`--${name} is required`);
    return value;
  };
  /** Read named JSON input; the receiving operation validates its own schema. */
  const json = async (name: keyof typeof values): Promise<unknown> =>
    Bun.file(resolve(required(name))).json();
  /** Load the configured fork commit; asset artifact pins belong to release handoff. */
  const baseline = async () => {
    const config = z
      .object({
        repository: z.string(),
        commit: z.string(),
        baselineCommit: z.string().optional(),
        assetBundle: z
          .object({
            runId: z.number().int().positive(),
            artifactId: z.number().int().positive(),
            manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict()
          .optional(),
      })
      .strict()
      .parse(await json("source-config"));
    return loadBaseline({
      sourceDir: required("source"),
      source: { repository: config.repository, commit: config.commit },
      ...(config.baselineCommit
        ? { baselineCommit: config.baselineCommit }
        : {}),
    });
  };
  /** Keep command results machine-readable on stdout. */
  const print = (result: unknown) =>
    console.log(JSON.stringify(result, null, 2));
  if (values.help || !positionals.length) {
    console.log(
      "tcg-tools <audit|build-snapshot|verify-snapshot|assets|import|validate|prepare|submit|ollama-inspect|extract|extract-batch|score> [options]\nSee docs/maintainers.md. All source builds pin dataset-source.json; import/extraction create drafts only. Network image acquisition and PR submission require explicit flags.",
    );
    return 0;
  }
  if (positionals.length !== 1)
    throw new Error("Exactly one command is required");
  switch (positionals[0]) {
    case "audit": {
      // Audit writes unapproved candidates to a new directory, never to the fork.
      const data = await baseline();
      const output = resolve(required("output"));
      await mkdir(dirname(output), { recursive: true });
      await mkdir(output, { recursive: false });
      await writeJson(resolve(output, "audit.json"), {
        ...data.audit,
        issues: data.issues,
      });
      for (const inventory of data.candidateInventories)
        await writeJson(
          resolve(output, "inventories/en", `${inventory.setId}.json`),
          inventory,
        );
      for (const receipt of data.candidateProvenance)
        await writeJson(
          resolve(output, "provenance/en", `${receipt.setId}.json`),
          receipt,
        );
      print({
        output,
        counts: data.audit.counts,
        issues: data.issues,
        warnings: data.audit.warnings,
        reviewStatus: "unreviewed-candidates",
      });
      return data.issues.length ? 2 : 0;
    }
    case "build-snapshot": {
      // Draft generation is allowed; publication readiness must be requested and checked.
      print(
        await buildSnapshot({
          baseline: await baseline(),
          outputDir: required("output"),
          dataVersion: required("release-version"),
          releaseReady: values["release-ready"],
          ...(values["builder-version"]
            ? { builderVersion: values["builder-version"] }
            : {}),
          ...(values["builder-commit"]
            ? { builderCommit: values["builder-commit"] }
            : {}),
          ...(values["inventories-dir"]
            ? { inventoriesDir: values["inventories-dir"] }
            : {}),
          ...(values["asset-manifest"]
            ? { assetManifestPath: values["asset-manifest"] }
            : {}),
          ...(values["asset-origin"]
            ? { assetOrigin: values["asset-origin"] }
            : {}),
        }),
      );
      return 0;
    }
    case "verify-snapshot": {
      // Release verification needs pinned source evidence, not only matching output hashes.
      const data = values.source ? await baseline() : undefined;
      const manifest = await verifySnapshot(required("snapshot"), {
        releaseReady: values["release-ready"],
        ...(data ? { baseline: data } : {}),
      });
      if (values["release-ready"] && !data)
        throw new Error(
          "Release verification requires --source and its pinned source configuration",
        );
      print(manifest);
      return 0;
    }
    case "assets": {
      // URL checks contact owned hosting; provider acquisition needs the separate --acquire flag.
      if (values["verify-published"])
        print(await verifyPublishedAssets(required("asset-manifest")));
      else
        print(
          await prepareAssets({
            baseline: await baseline(),
            outputDir: required("output"),
            allowNetwork: values.acquire,
            ...(values["asset-origin"]
              ? { origin: values["asset-origin"] }
              : {}),
          }),
        );
      return 0;
    }
    case "import": {
      // Import reads local pinned provider data and writes drafts, not accepted fork records.
      const result = await importTCGdex({
        sourceDir: required("tcgdex-source"),
        crosswalk: await json("mapping"),
        canonicalDir: required("source"),
        outputDir: required("output"),
      });
      print({
        status: "draft",
        cards: result.records.length,
        issues: result.issues,
        output: required("output"),
      });
      return 0;
    }
    case "validate":
    case "prepare": {
      // A clean proposal is ready for human review, not approved for publication.
      const inventory = await json("inventory");
      const report =
        positionals[0] === "prepare"
          ? await prepareReview(
              required("batch"),
              inventory,
              required("output"),
            )
          : await validateBatch(required("batch"), inventory);
      print(report);
      return report.status === "draft" ? 2 : 0;
    }
    case "submit": {
      // This is the external write boundary: --execute creates only a draft PR.
      print(
        await submitDraftPR({
          branch: required("branch"),
          title: required("title"),
          bodyFile: required("body"),
          execute: values.execute,
        }),
      );
      return 0;
    }
    case "ollama-inspect": {
      print(await inspectOllama(await json("config")));
      return 0;
    }
    case "extract": {
      // One extraction may aid evaluation before a model qualifies for bulk use.
      const context = {
        cardId: required("card-id"),
        setId: required("set-id"),
        sourceCommit: required("source-commit"),
      };
      print(
        await extractPrintedFields({
          config: await json("config"),
          imagePath: required("image"),
          cacheDir: required("cache"),
          context,
          repeat: values.repeat,
        }),
      );
      return 0;
    }
    case "extract-batch": {
      // A matching approved qualification is mandatory before any bulk model requests.
      const config = ollamaConfigSchema.parse(await json("config"));
      requireQualification(config, await json("qualification"));
      const inputs = z
        .array(
          z
            .object({
              imagePath: z.string(),
              cardId: z.string(),
              setId: z.string(),
              sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
            })
            .strict(),
        )
        .parse(await json("inputs"));
      // Process serially to avoid unqualified changes in model concurrency and memory use.
      const results = [];
      for (const input of inputs)
        results.push(
          await extractPrintedFields({
            config,
            imagePath: input.imagePath,
            cacheDir: required("cache"),
            context: {
              cardId: input.cardId,
              setId: input.setId,
              sourceCommit: input.sourceCommit,
            },
          }),
        );
      print({ status: "draft", results });
      return 0;
    }
    case "score": {
      // Metrics inform maintainer judgment; this command never issues qualification approval.
      const runs = z
        .array(
          z
            .object({
              expected: printedFieldsSchema,
              actual: printedFieldsSchema.nullable(),
              correctionSeconds: z.number().nonnegative(),
            })
            .strict(),
        )
        .parse(await json("runs"));
      const report = {
        schemaVersion: 1,
        qualified: false,
        metrics: scoreExtractionRuns(runs),
        note: "Requires repeated warm/cold/restart/concurrency runs, repeatability analysis, explicit criteria and maintainer approval; scoring never auto-enables bulk extraction.",
      };
      if (values.output) await writeJson(resolve(values.output), report);
      print(report);
      return 0;
    }
    default:
      throw new Error(`Unknown command: ${positionals[0]}`);
  }
}

// Importing the tools library does not execute a command or open a network connection.
if (import.meta.main) {
  try {
    process.exitCode = await main(Bun.argv.slice(2));
  } catch (error) {
    console.error(
      JSON.stringify({
        error: "TCG_TOOLS_FAILED",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  }
}
