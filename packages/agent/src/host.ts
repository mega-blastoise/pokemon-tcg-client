/** @module acp_host Runs Claude through the ACP adapter and exposes card tools over MCP. */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { McpBridge } from "./mcp.js";
import type { AgentEvent, ToolExecutor } from "./protocol.js";
import { TOOL_SERVER_NAME, toolDefinitions } from "./tools.js";

/** Instructions replace Claude Code's coding preset: this agent only searches cards. */
export const SYSTEM_PROMPT = `You are a Pokémon Trading Card Game catalog assistant. You answer questions by searching a pinned, offline card snapshot through your tools; you have no other data source and no web access.

How to work:
- Always use the tools before answering questions about specific cards, sets, or counts. Never invent card details, ids, or numbers.
- Translate natural language into literal filters: energy types, subtypes, rarities and supertypes are exact values; \`name\` is a substring; \`text\` requires every word to appear in rules/attack/ability text.
- Prefer several narrow searches over one broad one. Use list_sets to resolve set names ("Obsidian Flames", "151", "Base Set") to set ids. Use get_cards when you need attack text, weaknesses or legality details.
- HP and damage are not filterable; search by other filters and reason over the returned values, paging with offset when needed.
- The user sees every tool result as a visual card grid. Do not re-list every result; summarize, highlight the best matches, and explain your reasoning briefly.
- When you mention a specific card, include its id in backticks, e.g. \`base1-4\`, so the interface can link it.
- Legality fields are source-reported facts, not tournament rulings; say so if asked about legality. Prices are not available.
- Keep answers concise and use Markdown (short lists, bold names).`;

/** Configuration shared by every frontend. */
export interface CardAgentOptions {
  /** Claude model alias or id; defaults to the adapter's choice. */
  model?: string;
  /** Override the adapter command, e.g. ["claude-agent-acp"]. */
  command?: readonly string[];
  /** Receives adapter stderr and protocol diagnostics. */
  onLog?: (line: string) => void;
}

/** One running ACP adapter process plus the MCP bridge its sessions call back into. */
export class CardAgentHost {
  private sessions = new Set<CardAgentSession>();
  private constructor(
    private readonly child: ChildProcess,
    private readonly connection: acp.ClientConnection,
    private readonly bridge: McpBridge,
    private readonly cwd: string,
    readonly agentName: string,
    readonly options: CardAgentOptions,
  ) {}

  /** Spawn the adapter, negotiate ACP, and bind the tool bridge. */
  static async start(options: CardAgentOptions = {}): Promise<CardAgentHost> {
    const command = options.command ?? [
      // The adapter is a Node program; Bun runs it too, so reuse whichever runtime we are.
      process.env.TCG_ACP_RUNTIME ?? process.execPath,
      createRequire(import.meta.url).resolve(
        "@agentclientprotocol/claude-agent-acp/dist/index.js",
      ),
    ];
    const [program, ...args] = command;
    if (!program) throw new Error("Empty ACP adapter command");
    const child = spawn(program, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    await spawned;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split("\n").filter(Boolean))
        options.onLog?.(line);
    });
    // The adapter's own child (the Claude CLI) dies with it.
    const stream = acp.ndJsonStream(
      Writable.toWeb(
        child.stdin as Writable,
      ) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(
        child.stdout as Readable,
      ) as unknown as ReadableStream<Uint8Array>,
    );
    let host: CardAgentHost | undefined;
    const app = acp
      .client({ name: "tcg-chat" })
      .onNotification(acp.methods.client.session.update, () => {
        // ActiveSession routes updates; registering keeps unrouted ones from erroring.
      })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
        // Only the card tools may run; everything else is refused outright.
        const title = `${params.toolCall.title ?? ""} ${JSON.stringify(params.toolCall._meta ?? {})}`;
        const allowed = title.includes(`mcp__${TOOL_SERVER_NAME}__`);
        const option = params.options.find((o) =>
          allowed ? o.kind.startsWith("allow") : o.kind.startsWith("reject"),
        );
        host?.options.onLog?.(
          `permission ${allowed ? "granted" : "denied"}: ${params.toolCall.title}`,
        );
        return option
          ? { outcome: { outcome: "selected", optionId: option.optionId } }
          : { outcome: { outcome: "cancelled" } };
      });
    const connection = app.connect(stream);
    const exited = new Promise<never>((_, reject) =>
      child.once("exit", (code) =>
        reject(new Error(`Claude ACP adapter exited (${code}) during startup`)),
      ),
    );
    const init = await Promise.race([
      connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "tcg-chat", version: "0.0.0" },
      }),
      exited,
    ]);
    // Sessions share an empty scratch directory; no project files are in scope.
    const cwd = join(tmpdir(), "tcg-chat");
    await mkdir(cwd, { recursive: true });
    const bridge = await McpBridge.start();
    const agentInfo = init.agentInfo;
    host = new CardAgentHost(
      child,
      connection,
      bridge,
      cwd,
      agentInfo ? `${agentInfo.name} ${agentInfo.version}` : "claude-agent-acp",
      options,
    );
    return host;
  }

  /** Open a conversation whose tool calls run through `executor`. */
  async createSession(
    executor: ToolExecutor,
    onEvent: (event: AgentEvent) => void,
  ): Promise<CardAgentSession> {
    const abort = new AbortController();
    const endpoint = this.bridge.register(async (call) => {
      onEvent({ type: "tool_call", call });
      const outcome = await executor(call, abort.signal);
      onEvent({ type: "tool_result", call, outcome });
      return outcome;
    });
    const tools = toolDefinitions.map(
      (tool) => `mcp__${TOOL_SERVER_NAME}__${tool.name}`,
    );
    const active = await this.connection.agent
      .buildSession({
        cwd: this.cwd,
        mcpServers: [
          {
            type: "http",
            name: TOOL_SERVER_NAME,
            url: endpoint.url,
            headers: [],
          },
        ],
        _meta: {
          systemPrompt: SYSTEM_PROMPT,
          claudeCode: {
            options: {
              // No built-in tools, user settings, hooks, or user MCP servers.
              tools: [],
              allowedTools: tools,
              settingSources: [],
              strictMcpConfig: true,
              persistSession: false,
              ...(this.options.model ? { model: this.options.model } : {}),
            },
          },
        },
      })
      .start();
    const session = new CardAgentSession(
      this.connection,
      active,
      onEvent,
      () => {
        abort.abort();
        endpoint.dispose();
        this.sessions.delete(session);
      },
    );
    this.sessions.add(session);
    return session;
  }

  /** Model reported by the adapter for display, if configured. */
  get model(): string | null {
    return this.options.model ?? null;
  }

  /** Close every session, the bridge, and the adapter process. */
  async close(): Promise<void> {
    for (const session of this.sessions) session.close();
    this.connection.close();
    this.child.kill();
    await this.bridge.close();
  }
}

/** A single multi-turn conversation. */
export class CardAgentSession {
  private stopSeen: (() => void) | undefined;
  private closed = false;
  private busy = false;

  constructor(
    private readonly connection: acp.ClientConnection,
    private readonly active: acp.ActiveSession,
    private readonly onEvent: (event: AgentEvent) => void,
    private readonly release: () => void,
  ) {
    void this.pump();
  }

  get id(): string {
    return this.active.sessionId;
  }

  /** Whether a turn is in flight. */
  get running(): boolean {
    return this.busy;
  }

  /** Translate ACP updates into frontend events for the session's lifetime. */
  private async pump(): Promise<void> {
    while (!this.closed) {
      let message: acp.ActiveSessionMessage;
      try {
        message = await this.active.nextUpdate();
      } catch {
        return;
      }
      if (message.kind === "stop") {
        this.stopSeen?.();
        continue;
      }
      const update = message.update;
      switch (update.sessionUpdate) {
        case "agent_message_chunk":
        case "agent_thought_chunk":
          if (update.content.type === "text")
            this.onEvent({
              type:
                update.sessionUpdate === "agent_message_chunk"
                  ? "text"
                  : "thought",
              delta: update.content.text,
            });
          break;
        case "usage_update":
          this.onEvent({
            type: "usage",
            used: update.used,
            size: update.size,
            costUsd:
              update.cost && update.cost.currency === "USD"
                ? update.cost.amount
                : null,
          });
          break;
        case "session_info_update": {
          const meta = update._meta?.promptSuggestions as
            | { suggestions?: { text: string }[] }
            | undefined;
          const text = meta?.suggestions?.[0]?.text?.trim();
          if (text) this.onEvent({ type: "suggestion", text });
          break;
        }
      }
    }
  }

  /** Run one turn; events stream through the session's listener. */
  async prompt(text: string): Promise<void> {
    if (this.busy) throw new Error("A turn is already running");
    this.busy = true;
    const started = performance.now();
    const stopped = new Promise<void>((resolve) => {
      this.stopSeen = resolve;
    });
    let stopReason = "error";
    try {
      const response = await this.active.prompt(text);
      // Drain queued updates before reporting completion so order holds.
      await stopped;
      stopReason = response.stopReason;
    } catch (error) {
      this.onEvent({ type: "error", message: describe(error) });
    } finally {
      this.busy = false;
      this.onEvent({
        type: "done",
        stopReason,
        durationMs: Math.round(performance.now() - started),
      });
    }
  }

  /** Ask the agent to stop the current turn. */
  async cancel(): Promise<void> {
    if (!this.busy) return;
    await this.connection.agent.notify(acp.methods.agent.session.cancel, {
      sessionId: this.id,
    });
  }

  /** Stop routing and release this session's tool endpoint. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.active.dispose();
    this.release();
  }
}

/** Turn JSON-RPC errors (auth, rate limits) into one readable line. */
function describe(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as { message?: unknown; data?: unknown };
    const data =
      record.data && typeof record.data === "object"
        ? JSON.stringify(record.data)
        : record.data;
    const message = String(record.message ?? error);
    if (/auth/i.test(message) || /auth/i.test(String(data ?? "")))
      return `${message}. Sign in with \`claude /login\` and retry.`;
    return data ? `${message}: ${data}` : message;
  }
  return String(error);
}
