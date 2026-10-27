/** @module run Shared CLI driver: flags, snapshot selection, headless modes, and the Ink app. */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  CardAgentHost,
  executeTool,
  findLocalSnapshot,
  runDiagnostics,
} from "@johto-ai/tcg-agent";
import type { TCGClient } from "@johto-ai/tcg-agent/protocol";
import {
  type ClientOptions,
  STANDARD_REGULATION_MARKS,
} from "@johto-ai/tcg-client";
import { render } from "ink";
import { App } from "./App.js";

/** What each runtime entry supplies; everything else is shared. */
export interface RuntimeEntry {
  /** Binary name for help text. */
  bin: string;
  /** e.g. "bun 1.4.3". */
  runtime: string;
  /** Native adapter the client selected, e.g. "bun:sqlite". */
  adapter: string;
  /** The runtime's PokemonTCGClient factory. */
  create: (options: ClientOptions) => Promise<TCGClient>;
}

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  green: (s: string) => `\x1b[32m${s}\x1b[39m`,
  red: (s: string) => `\x1b[31m${s}\x1b[39m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[39m`,
};

/** Parse flags, open the client, then run the requested mode. */
export async function run(entry: RuntimeEntry): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      snapshot: { type: "string" },
      model: { type: "string" },
      format: { type: "string" },
      prompt: { type: "string", short: "p" },
      doctor: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(`${c.bold(entry.bin)} — conversational Pokémon TCG card search (${entry.runtime})

Usage:
  ${entry.bin}                    interactive chat
  ${entry.bin} -p "question"      one answer, streamed to stdout
  ${entry.bin} --doctor           verify the client contract, exit 1 on failure

Options:
  --snapshot <dir>   snapshot directory (manifest.json + SQLite); also TCG_SNAPSHOT_DIR
  --model <name>     Claude model alias or id; also TCG_MODEL
  --format standard  limit every card search to Standard (regulation marks ${STANDARD_REGULATION_MARKS.join(", ")});
                     toggle in chat with /format

Without --snapshot the newest .local/catalog-check build is used, then the
installed @johto-ai/tcg-data package. Claude runs through the ACP adapter
using your Claude Code login.`);
    return;
  }

  if (values.format !== undefined && values.format !== "standard") {
    console.error(`${entry.bin}: --format must be "standard"`);
    process.exitCode = 2;
    return;
  }
  const format = values.format === "standard" ? "standard" : undefined;

  // Search from the working directory first, then from this package's install.
  const local =
    (await findLocalSnapshot(
      values.snapshot ? { directory: values.snapshot } : {},
    )) ??
    (await findLocalSnapshot({
      from: dirname(fileURLToPath(import.meta.url)),
    }));
  const options: ClientOptions = local
    ? {
        manifestPath: local.manifestPath,
        databasePath: local.databasePath,
        allowDraft: true,
      }
    : { allowDraft: true };
  const source = local ? local.directory : "@johto-ai/tcg-data";
  const create = () => entry.create(options);
  const client = await create();
  const model = values.model ?? process.env.TCG_MODEL;
  const startHost = () =>
    CardAgentHost.start({
      ...(model ? { model } : {}),
      onLog: (line) => {
        if (process.env.TCG_DEBUG) process.stderr.write(`[acp] ${line}\n`);
      },
    });

  try {
    if (values.doctor) {
      console.log(
        `${c.bold("Client diagnostics")} ${c.dim(`· ${entry.runtime} · ${entry.adapter} · ${source}`)}`,
      );
      let failed = 0;
      for await (const result of runDiagnostics(client, {
        createClient: create,
      })) {
        if (!result.ok) failed++;
        console.log(
          `${result.ok ? c.green("✓") : c.red("✗")} ${result.label.padEnd(42)} ${c.dim(`${result.durationMs}ms`.padStart(8))}  ${result.ok ? c.dim(result.detail) : c.red(result.detail)}`,
        );
      }
      console.log(
        failed ? c.red(`${failed} failed`) : c.green("All checks passed"),
      );
      process.exitCode = failed ? 1 : 0;
      return;
    }

    if (values.prompt) {
      const host = await startHost();
      try {
        const session = await host.createSession(
          (call, signal) => executeTool(client, call, signal, { format }),
          (event) => {
            if (event.type === "text") process.stdout.write(event.delta);
            else if (event.type === "tool_result")
              process.stderr.write(
                c.dim(
                  `\n${event.outcome.ok ? "✓" : "✗"} ${event.call.name} ${JSON.stringify(event.call.input)} → ${event.outcome.summary} · ${event.outcome.durationMs}ms\n`,
                ),
              );
            else if (event.type === "error") {
              process.stderr.write(c.red(`\n${event.message}\n`));
              process.exitCode = 1;
            }
          },
        );
        await session.prompt(values.prompt);
        process.stdout.write("\n");
      } finally {
        await host.close();
      }
      return;
    }

    if (!process.stdin.isTTY) {
      console.error(
        `${entry.bin}: interactive mode needs a TTY; use -p or --doctor`,
      );
      process.exitCode = 2;
      return;
    }
    const app = render(
      <App
        context={{
          client,
          createClient: create,
          runtime: entry.runtime,
          adapter: entry.adapter,
          source,
          startHost,
          format,
        }}
      />,
      { exitOnCtrlC: true },
    );
    await app.waitUntilExit();
  } finally {
    await client.close();
  }
}
