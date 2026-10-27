/** @module app Interactive chat: transcript, live turn, slash commands, and status bar. */
import {
  type CardAgentHost,
  type CardAgentSession,
  type DiagnosticResult,
  executeTool,
  runDiagnostics,
  toCardView,
} from "@johto-ai/tcg-agent";
import type {
  AgentEvent,
  CardView,
  TCGClient,
  ToolCall,
  ToolOutcome,
} from "@johto-ai/tcg-agent/protocol";
import {
  type CardFormat,
  STANDARD_REGULATION_MARKS,
} from "@johto-ai/tcg-client";
import { Box, Static, Text, useApp, useInput, useWindowSize } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CardDetail,
  DoctorTable,
  Markdown,
  PromptInput,
  Spinner,
  ToolBlock,
  Wordmark,
} from "./components.js";
import { ACCENT, ACCENT_2, BAD, INFO, MUTED, OK } from "./theme.js";

/** Everything the runtime entry decided before the UI starts. */
export interface AppContext {
  client: TCGClient;
  createClient: () => Promise<TCGClient>;
  runtime: string;
  adapter: string;
  source: string;
  startHost: () => Promise<CardAgentHost>;
  /** Format every card search starts limited to; `/format` changes it. */
  format?: CardFormat | undefined;
}

type Part =
  | { kind: "text"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "tool"; call: ToolCall; outcome?: ToolOutcome }
  | { kind: "error"; text: string };

type Entry =
  | { id: number; kind: "banner" }
  | { id: number; kind: "user"; text: string }
  | {
      id: number;
      kind: "assistant";
      parts: Part[];
      done: boolean;
      durationMs?: number;
      stopReason?: string;
    }
  | { id: number; kind: "notice"; tone: "info" | "error" | "ok"; text: string }
  | { id: number; kind: "card"; card: CardView }
  | { id: number; kind: "tool"; call: ToolCall; outcome: ToolOutcome }
  | { id: number; kind: "doctor"; results: DiagnosticResult[]; done: boolean }
  | { id: number; kind: "help" };

type AgentState =
  | { state: "starting" }
  | { state: "ready"; name: string }
  | { state: "error"; message: string };

let nextId = 0;
const id = () => ++nextId;

const COMMANDS: [string, string][] = [
  ["/doctor", "verify the client contract against this snapshot"],
  ["/card <id>", "show one card, read directly through the client"],
  ["/find <name>", "search by name without the model"],
  ["/sets [name]", "list sets without the model"],
  ["/format [standard|off]", "limit every card search to a format, or toggle"],
  ["/clear", "start a new conversation"],
  ["/exit", "quit (or ctrl+c)"],
];

/** Apply one streamed event to the live assistant entry. */
function applyEvent(
  entry: Extract<Entry, { kind: "assistant" }>,
  event: AgentEvent,
): Extract<Entry, { kind: "assistant" }> {
  const parts = [...entry.parts];
  const last = parts.at(-1);
  switch (event.type) {
    case "text":
    case "thought": {
      const kind = event.type;
      if (last?.kind === kind)
        parts[parts.length - 1] = { kind, text: last.text + event.delta };
      else parts.push({ kind, text: event.delta });
      return { ...entry, parts };
    }
    case "tool_call":
      parts.push({ kind: "tool", call: event.call });
      return { ...entry, parts };
    case "tool_result":
      return {
        ...entry,
        parts: parts.map((part) =>
          part.kind === "tool" && part.call.id === event.call.id
            ? { ...part, outcome: event.outcome }
            : part,
        ),
      };
    case "error":
      parts.push({ kind: "error", text: event.message });
      return { ...entry, parts };
    case "done":
      return {
        ...entry,
        parts,
        done: true,
        durationMs: event.durationMs,
        stopReason: event.stopReason,
      };
    default:
      return entry;
  }
}

/** Header shown once at the top of the scrollback. */
function Banner({ context }: { context: AppContext }) {
  const { snapshot } = context.client;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box gap={1}>
        <Wordmark text="◓ TCG CHAT" />
        <Text color={MUTED}>conversational card search · Claude via ACP</Text>
      </Box>
      <Text color={MUTED}>
        <Text color={INFO}>{context.runtime}</Text> · {context.adapter} ·{" "}
        snapshot <Text color="white">{snapshot.dataVersion}</Text> @{" "}
        {snapshot.source.commit.slice(0, 7)} ·{" "}
        {snapshot.counts.sets.toLocaleString()} sets ·{" "}
        {snapshot.counts.cards.toLocaleString()} cards
        {snapshot.releaseReady ? "" : <Text color={ACCENT_2}> · DRAFT</Text>}
      </Text>
      <Text color={MUTED}>source {context.source}</Text>
      <Text color={MUTED}>
        Try “strongest Fire ex in Scarlet & Violet” · /help for commands
      </Text>
    </Box>
  );
}

/** Render a transcript entry; live entries animate, committed ones are static. */
function EntryView({
  entry,
  context,
  width,
}: {
  entry: Entry;
  context: AppContext;
  width: number;
}) {
  switch (entry.kind) {
    case "banner":
      return <Banner context={context} />;
    case "user":
      return (
        <Box marginTop={1}>
          <Text color={ACCENT} bold>
            you ▸{" "}
          </Text>
          <Text>{entry.text}</Text>
        </Box>
      );
    case "assistant": {
      const thinking =
        !entry.done &&
        entry.parts.at(-1)?.kind !== "text" &&
        entry.parts.at(-1)?.kind !== "tool";
      return (
        <Box flexDirection="column" marginTop={1}>
          {entry.parts.map((part, i) => {
            const key = `${entry.id}-${i}`;
            if (part.kind === "text")
              return (
                <Box key={key} marginBottom={1}>
                  <Markdown text={part.text.trim()} />
                </Box>
              );
            if (part.kind === "thought")
              return entry.done ? null : (
                <Text key={key} color={MUTED} italic wrap="truncate-end">
                  ✻ {part.text.trim().split("\n").at(-1)}
                </Text>
              );
            if (part.kind === "error")
              return (
                <Text key={key} color={BAD}>
                  ✗ {part.text}
                </Text>
              );
            return (
              <ToolBlock
                key={key}
                call={part.call}
                outcome={part.outcome}
                width={width}
              />
            );
          })}
          {thinking && (
            <Box gap={1}>
              <Spinner />
              <Text color={MUTED}>
                {entry.parts.length ? "thinking" : "asking Claude"}… esc to stop
              </Text>
            </Box>
          )}
          {entry.done && (
            <Text color={MUTED}>
              ── {((entry.durationMs ?? 0) / 1000).toFixed(1)}s
              {entry.stopReason && entry.stopReason !== "end_turn"
                ? ` · ${entry.stopReason}`
                : ""}
            </Text>
          )}
        </Box>
      );
    }
    case "notice":
      return (
        <Text
          color={
            entry.tone === "error" ? BAD : entry.tone === "ok" ? OK : MUTED
          }
        >
          {entry.tone === "error" ? "✗ " : "· "}
          {entry.text}
        </Text>
      );
    case "card":
      return (
        <Box marginTop={1}>
          <CardDetail card={entry.card} />
        </Box>
      );
    case "tool":
      return (
        <Box marginTop={1}>
          <ToolBlock call={entry.call} outcome={entry.outcome} width={width} />
        </Box>
      );
    case "doctor":
      return (
        <Box marginTop={1}>
          <DoctorTable
            results={entry.results}
            running={!entry.done}
            label={`${context.runtime} · ${context.adapter}`}
          />
        </Box>
      );
    case "help":
      return (
        <Box flexDirection="column" marginTop={1}>
          {COMMANDS.map(([command, help]) => (
            <Text key={command}>
              <Text color={ACCENT}>{command.padEnd(24)}</Text>
              <Text color={MUTED}>{help}</Text>
            </Text>
          ))}
          <Text color={MUTED}>
            ↑/↓ history · ⇥ accept suggestion · esc stop turn · anything else
            goes to Claude
          </Text>
        </Box>
      );
  }
}

/** The whole interactive program. */
export function App({ context }: { context: AppContext }) {
  const { exit } = useApp();
  const { columns } = useWindowSize();
  const [committed, setCommitted] = useState<Entry[]>([
    { id: id(), kind: "banner" },
  ]);
  const [live, setLive] = useState<Entry | null>(null);
  const [agent, setAgent] = useState<AgentState>({ state: "starting" });
  const [history, setHistory] = useState<string[]>([]);
  const [suggestion, setSuggestion] = useState<string>();
  const [usage, setUsage] = useState<{ used: number; cost: number }>({
    used: 0,
    cost: 0,
  });
  const [format, setFormat] = useState<CardFormat | undefined>(context.format);
  // Sessions capture their tool executor once; read the toggle at call time.
  const formatRef = useRef(format);
  formatRef.current = format;
  const host = useRef<CardAgentHost | null>(null);
  const session = useRef<CardAgentSession | null>(null);

  const commit = useCallback((entry: Entry) => {
    setCommitted((list) => [...list, entry]);
  }, []);

  /** Route session events into the live entry; `done` moves it to scrollback. */
  const onEvent = useCallback(
    (event: AgentEvent) => {
      if (event.type === "usage") {
        setUsage((u) => ({
          used: event.used,
          cost: event.costUsd !== null ? u.cost + event.costUsd : u.cost,
        }));
        return;
      }
      if (event.type === "suggestion") return setSuggestion(event.text);
      setLive((current) => {
        if (current?.kind !== "assistant") return current;
        const next = applyEvent(current, event);
        if (next.done) {
          commit(next);
          return null;
        }
        return next;
      });
    },
    [commit],
  );

  const openSession = useCallback(async () => {
    if (!host.current) return;
    session.current?.close();
    session.current = await host.current.createSession(
      (call, signal) =>
        executeTool(context.client, call, signal, {
          format: formatRef.current,
        }),
      onEvent,
    );
  }, [context.client, onEvent]);

  useEffect(() => {
    let cancelled = false;
    context
      .startHost()
      .then(async (started) => {
        if (cancelled) return started.close();
        host.current = started;
        await openSession();
        setAgent({ state: "ready", name: started.agentName });
      })
      .catch((error: unknown) =>
        setAgent({
          state: "error",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    return () => {
      cancelled = true;
      void host.current?.close();
    };
  }, [context, openSession]);

  useInput((_, key) => {
    if (key.escape && session.current?.running) void session.current.cancel();
  });

  const doctor = useCallback(async () => {
    const entry: Extract<Entry, { kind: "doctor" }> = {
      id: id(),
      kind: "doctor",
      results: [],
      done: false,
    };
    setLive(entry);
    for await (const result of runDiagnostics(context.client, {
      createClient: context.createClient,
    })) {
      entry.results = [...entry.results, result];
      setLive({ ...entry });
    }
    setLive(null);
    commit({ ...entry, done: true });
  }, [context, commit]);

  /** Direct client paths bypass the model so each layer can be checked alone. */
  const direct = useCallback(
    async (name: string, input: Record<string, unknown>) => {
      const call = { id: String(id()), name, input };
      const outcome = await executeTool(
        context.client,
        call,
        new AbortController().signal,
        { format: formatRef.current },
      );
      commit({ id: id(), kind: "tool", call, outcome });
    },
    [context.client, commit],
  );

  const submit = useCallback(
    async (text: string) => {
      setHistory((h) => [...h.filter((x) => x !== text), text]);
      setSuggestion(undefined);
      const [command, ...rest] = text.split(/\s+/);
      const argument = rest.join(" ");
      switch (command) {
        case "/exit":
        case "/quit":
          return exit();
        case "/help":
          return commit({ id: id(), kind: "help" });
        case "/doctor":
          return doctor();
        case "/clear":
          setCommitted([{ id: id(), kind: "banner" }]);
          await openSession();
          return commit({
            id: id(),
            kind: "notice",
            tone: "info",
            text: "New conversation",
          });
        case "/card": {
          if (!argument)
            return commit({
              id: id(),
              kind: "notice",
              tone: "error",
              text: "Usage: /card <id>",
            });
          try {
            const card = await context.client.cards.get(argument);
            if (!card)
              return commit({
                id: id(),
                kind: "notice",
                tone: "error",
                text: `No card ${argument}`,
              });
            const set = await context.client.sets.get(card.setId);
            return commit({
              id: id(),
              kind: "card",
              card: toCardView(card, set),
            });
          } catch (error) {
            return commit({
              id: id(),
              kind: "notice",
              tone: "error",
              text: String(error),
            });
          }
        }
        case "/format": {
          const next =
            argument === "standard"
              ? "standard"
              : argument === "off"
                ? undefined
                : argument
                  ? null
                  : formatRef.current
                    ? undefined
                    : "standard";
          if (next === null)
            return commit({
              id: id(),
              kind: "notice",
              tone: "error",
              text: "Usage: /format [standard|off]",
            });
          setFormat(next);
          formatRef.current = next;
          return commit({
            id: id(),
            kind: "notice",
            tone: "info",
            text: next
              ? `Card searches limited to Standard (regulation marks ${STANDARD_REGULATION_MARKS.join(", ")})`
              : "Card searches include every format",
          });
        }
        case "/find":
          return direct("search_cards", { name: argument, limit: 15 });
        case "/sets":
          return direct(
            "list_sets",
            argument ? { name: argument } : { limit: 15 },
          );
      }
      if (text.startsWith("/"))
        return commit({
          id: id(),
          kind: "notice",
          tone: "error",
          text: `Unknown command ${command}`,
        });
      if (!session.current)
        return commit({
          id: id(),
          kind: "notice",
          tone: "error",
          text:
            agent.state === "error"
              ? `Claude is unavailable: ${agent.message}`
              : "Still connecting to Claude…",
        });
      commit({ id: id(), kind: "user", text });
      setLive({ id: id(), kind: "assistant", parts: [], done: false });
      void session.current.prompt(text);
    },
    [agent, commit, context.client, direct, doctor, exit, openSession],
  );

  const busy = live !== null;
  const width = columns ?? 100;
  return (
    <Box flexDirection="column">
      <Static items={committed}>
        {(entry) => (
          <EntryView
            key={entry.id}
            entry={entry}
            context={context}
            width={width}
          />
        )}
      </Static>
      {live && <EntryView entry={live} context={context} width={width} />}
      <Box marginTop={1} flexDirection="column">
        <PromptInput
          onSubmit={(value) => void submit(value)}
          disabled={busy}
          history={history}
          suggestion={suggestion}
          placeholder="Ask about cards, or /help"
        />
        <Box justifyContent="space-between" paddingX={1}>
          <Text color={MUTED}>
            {agent.state === "starting" ? (
              <Text>
                <Spinner /> connecting to Claude via ACP…
              </Text>
            ) : agent.state === "ready" ? (
              <Text>
                <Text color={OK}>●</Text> {agent.name}
              </Text>
            ) : (
              <Text color={BAD}>● {agent.message}</Text>
            )}
          </Text>
          <Text color={MUTED}>
            {format ? (
              <Text color={ACCENT_2}>
                Standard{usage.used || usage.cost ? " · " : ""}
              </Text>
            ) : (
              ""
            )}
            {usage.used ? `${(usage.used / 1000).toFixed(1)}k ctx` : ""}
            {usage.cost ? ` · $${usage.cost.toFixed(3)}` : ""}
            {" · "}
            <Text color={ACCENT}>{context.runtime}</Text>
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
