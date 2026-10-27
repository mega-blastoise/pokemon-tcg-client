/** @module web_app Layout, boot sequence, chat transcript, composer, and card drawer. */
import type {
  CardView,
  TCGClient,
  ToolCall,
  ToolOutcome,
} from "@johto-ai/tcg-agent/protocol";
import { toCardView } from "@johto-ai/tcg-agent/tools";
import {
  type CardFormat,
  STANDARD_REGULATION_MARKS,
} from "@johto-ai/tcg-client/browser";
import { useCallback, useEffect, useRef, useState } from "react";
import { CardDetail, CardGrid, SetList } from "./components/Cards.js";
import { Markdown } from "./components/Markdown.js";
import {
  ActivityPanel,
  DiagnosticsPanel,
  NetworkPanel,
  Palette,
  SnapshotPanel,
} from "./components/Panels.js";
import {
  createBrowserClient,
  type FetchRecord,
  type SnapshotInfo,
  type SnapshotSource,
} from "./tcg.js";
import { type Message, useAgent } from "./useAgent.js";

const STARTERS = [
  "Which Charizard ex cards exist, and how do they differ?",
  "Supporters that search your deck for Pokémon in Scarlet & Violet",
  "Strongest Basic Water Pokémon by HP in the newest set",
  "Show every Special Illustration Rare Pikachu",
];

function formatArgs(input: Record<string, unknown>): string {
  return Object.entries(input)
    .map(
      ([k, v]) =>
        `${k}: ${typeof v === "string" ? `"${v}"` : JSON.stringify(v)}`,
    )
    .join(", ");
}

/** Model-facing content is JSON on success and plain text on error. */
function parseContent(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

/** A tool call card: what Claude asked for, what the client returned, and how fast. */
function ToolCallView({
  call,
  outcome,
  onOpen,
}: {
  call: ToolCall;
  outcome?: ToolOutcome | undefined;
  onOpen: (card: CardView) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={`tool ${outcome ? (outcome.ok ? "ok" : "bad") : "running"}`}
    >
      <button
        type="button"
        className="tool-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="tool-icon">
          {outcome ? outcome.ok ? "✓" : "✗" : <span className="spin" />}
        </span>
        <code className="tool-name">{call.name}</code>
        <span className="tool-args">{formatArgs(call.input)}</span>
        {outcome && (
          <span className="tool-meta">
            {outcome.summary} · {outcome.durationMs}ms
          </span>
        )}
      </button>
      {open && (
        <pre className="tool-raw">
          {JSON.stringify(
            {
              input: call.input,
              result: outcome ? parseContent(outcome.content) : null,
            },
            null,
            2,
          )}
        </pre>
      )}
      {outcome?.cards && outcome.cards.length > 0 && (
        <CardGrid cards={outcome.cards} total={outcome.total} onOpen={onOpen} />
      )}
      {outcome?.sets && outcome.sets.length > 0 && (
        <SetList sets={outcome.sets} />
      )}
    </div>
  );
}

function MessageView({
  message,
  onOpen,
  onCard,
}: {
  message: Message;
  onOpen: (card: CardView) => void;
  onCard: (id: string) => void;
}) {
  if (message.role === "user")
    return (
      <div className="msg user">
        <div className="bubble">{message.text}</div>
      </div>
    );
  const last = message.parts.at(-1);
  const waiting = !message.done && (!last || last.kind === "thought");
  return (
    <div className="msg assistant">
      <div className="avatar" aria-hidden>
        ◓
      </div>
      <div className="body">
        {message.parts.map((part, i) => {
          const key = `${message.id}-${i}`;
          switch (part.kind) {
            case "text":
              return <Markdown key={key} text={part.text} onCard={onCard} />;
            case "thought":
              return message.done ? null : (
                <div key={key} className="thought">
                  {part.text.trim().split("\n").at(-1)}
                </div>
              );
            case "error":
              return (
                <div key={key} className="error">
                  {part.text}
                </div>
              );
            default:
              return (
                <ToolCallView
                  key={key}
                  call={part.call}
                  outcome={part.outcome}
                  onOpen={onOpen}
                />
              );
          }
        })}
        {waiting && (
          <div className="typing">
            <span />
            <span />
            <span />
            <em>{message.parts.length ? "thinking" : "asking Claude"}</em>
          </div>
        )}
        {message.done && (
          <div className="msg-foot">
            {((message.durationMs ?? 0) / 1000).toFixed(1)}s
            {message.stopReason && message.stopReason !== "end_turn"
              ? ` · ${message.stopReason}`
              : ""}
          </div>
        )}
      </div>
    </div>
  );
}

export function App() {
  const params = new URLSearchParams(location.search);
  const [source, setSource] = useState<SnapshotSource>(
    params.get("source") === "github" ? "github" : "mirror",
  );
  const [info, setInfo] = useState<SnapshotInfo | null>(null);
  const [client, setClient] = useState<TCGClient | null>(null);
  const [bootError, setBootError] = useState<string>();
  const [fetches, setFetches] = useState<FetchRecord[]>([]);
  const [drawer, setDrawer] = useState<CardView | null>(null);
  const [palette, setPalette] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [draft, setDraft] = useState("");
  const [format, setFormat] = useState<CardFormat | undefined>(
    params.get("format") === "standard" ? "standard" : undefined,
  );
  const agent = useAgent(client, { format });
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);

  const record = useCallback((r: FetchRecord) => {
    setFetches((list) => {
      const index = list.findIndex((x) => x.id === r.id);
      if (index < 0) return [r, ...list];
      const next = [...list];
      next[index] = r;
      return next;
    });
  }, []);

  useEffect(() => {
    fetch("/api/snapshot")
      .then((r) => r.json() as Promise<SnapshotInfo>)
      .then(setInfo)
      .catch((e: unknown) => setBootError(String(e)));
  }, []);

  // Rebuild the client whenever the transport changes; the old one is closed.
  useEffect(() => {
    if (!info) return;
    let current: TCGClient | null = null;
    let cancelled = false;
    setClient(null);
    setBootError(undefined);
    setFetches([]);
    createBrowserClient(info, source, record)
      .then((created) => {
        current = created;
        if (cancelled) return void created.close();
        setClient(created);
        // Warm the search index so the first question does not wait on it.
        void created.cards.search({ limit: 1 }).catch(() => {});
      })
      .catch((e: unknown) =>
        setBootError(
          e instanceof Error ? `${e.name}: ${e.message}` : String(e),
        ),
      );
    const url = new URL(location.href);
    if (source === "github") url.searchParams.set("source", "github");
    else url.searchParams.delete("source");
    history.replaceState(null, "", url);
    return () => {
      cancelled = true;
      void current?.close();
    };
  }, [info, source, record]);

  // Keep the format toggle in the URL, like the snapshot source, so a reload keeps it.
  useEffect(() => {
    const url = new URL(location.href);
    if (format) url.searchParams.set("format", format);
    else url.searchParams.delete("format");
    history.replaceState(null, "", url);
  }, [format]);

  const createClient = useCallback(async () => {
    if (!info) throw new Error("No snapshot");
    return createBrowserClient(info, source, () => {});
  }, [info, source]);

  const openCardId = useCallback(
    async (id: string) => {
      if (!client) return;
      const card = await client.cards.get(id).catch(() => null);
      if (card) setDrawer(toCardView(card, await client.sets.get(card.setId)));
    },
    [client],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette((p) => !p);
      }
      if (event.key === "Escape") {
        if (agent.busy) agent.cancel();
        setDrawer(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [agent]);

  // Stick to the bottom while streaming unless the reader scrolled up.
  const lastMessage = agent.messages.at(-1);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Re-run on every streamed change.
  useEffect(() => {
    const el = scroller.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 240)
      el.scrollTo({ top: el.scrollHeight });
  }, [lastMessage]);

  const submit = (text = draft) => {
    const value = text.trim();
    if (!value || agent.busy) return;
    agent.prompt(value);
    setDraft("");
  };

  const ready = agent.connected && agent.status.state === "ready";
  return (
    <div className={`app${drawer ? " with-drawer" : ""}`}>
      <aside className={`sidebar${sidebar ? " open" : ""}`}>
        <div className="brand">
          <span className="logo">◓</span>
          <div>
            <strong>TCG Chat</strong>
            <span className="muted small">browser client · Claude via ACP</span>
          </div>
        </div>
        <SnapshotPanel
          client={client}
          source={source}
          onSource={setSource}
          status={agent.status}
          connected={agent.connected}
          usage={agent.usage}
        />
        <DiagnosticsPanel client={client} createClient={createClient} />
        <ActivityPanel activity={agent.activity} />
        <NetworkPanel records={fetches} />
      </aside>

      {sidebar && (
        <div className="scrim" onClick={() => setSidebar(false)} aria-hidden />
      )}
      <main className="main">
        <header className="topbar">
          <button
            type="button"
            className="icon-btn menu"
            onClick={() => setSidebar((s) => !s)}
            aria-label="Toggle panels"
          >
            ☰
          </button>
          <div className="status-pill">
            <span
              className={`dot ${client ? "ok" : bootError ? "bad" : "wait"}`}
            />
            {client
              ? "client verified"
              : bootError
                ? "client failed"
                : "verifying snapshot…"}
          </div>
          <div className="status-pill">
            <span
              className={`dot ${ready ? "ok" : agent.status.state === "error" ? "bad" : "wait"}`}
            />
            {ready
              ? "Claude ready"
              : agent.status.state === "error"
                ? "Claude unavailable"
                : "connecting…"}
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={format === "standard"}
            className={`format-toggle${format === "standard" ? " on" : ""}`}
            onClick={() =>
              setFormat((f) => (f === "standard" ? undefined : "standard"))
            }
            title={`Limit every card search to Standard (regulation marks ${STANDARD_REGULATION_MARKS.join(", ")})`}
          >
            <span className="track" aria-hidden>
              <span className="thumb" />
            </span>
            Standard
          </button>
          <span className="spacer" />
          <button
            type="button"
            className="kbd-btn"
            onClick={() => setPalette(true)}
          >
            Quick search <kbd>⌘K</kbd>
          </button>
          <button
            type="button"
            className="ghost"
            onClick={agent.reset}
            disabled={!agent.messages.length}
          >
            New chat
          </button>
        </header>

        <div className="scroll" ref={scroller}>
          {bootError && (
            <div className="banner bad">
              <strong>The browser client could not open this snapshot.</strong>
              <code>{bootError}</code>
              {source === "github" && (
                <span>
                  The pinned commit may not publish generated views yet.{" "}
                  <button
                    type="button"
                    className="link"
                    onClick={() => setSource("mirror")}
                  >
                    Use the local mirror
                  </button>
                </span>
              )}
            </div>
          )}
          {agent.messages.length === 0 ? (
            <div className="hero">
              <div className="orb" />
              <h1>
                Ask anything about{" "}
                <span className="gradient">every card ever printed</span>.
              </h1>
              <p className="muted">
                Claude plans the searches; this tab runs them with{" "}
                <code>@johto-ai/tcg-client/browser</code> and verifies every
                byte against the pinned snapshot.
              </p>
              <div className="starters">
                {STARTERS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="starter"
                    disabled={!ready || !client}
                    onClick={() => submit(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="thread">
              {agent.messages.map((m) => (
                <MessageView
                  key={m.id}
                  message={m}
                  onOpen={setDrawer}
                  onCard={openCardId}
                />
              ))}
            </div>
          )}
        </div>

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {agent.suggestion && !draft && !agent.busy && (
            <button
              type="button"
              className="suggestion"
              onClick={() => setDraft(agent.suggestion ?? "")}
            >
              ✦ {agent.suggestion}
            </button>
          )}
          <div className="composer-box">
            <textarea
              ref={composer}
              rows={1}
              value={draft}
              placeholder={
                client
                  ? "Ask about cards, sets, attacks, artists…"
                  : "Verifying the snapshot…"
              }
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
                if (e.key === "Tab" && !draft && agent.suggestion) {
                  e.preventDefault();
                  setDraft(agent.suggestion);
                }
              }}
            />
            {agent.busy ? (
              <button
                type="button"
                className="send stop"
                onClick={agent.cancel}
                aria-label="Stop"
              >
                ■
              </button>
            ) : (
              <button
                type="submit"
                className="send"
                disabled={!draft.trim() || !ready || !client}
                aria-label="Send"
              >
                ↑
              </button>
            )}
          </div>
          <div className="composer-hint muted small">
            Enter to send · Shift+Enter for newline · Esc to stop · Tab accepts
            suggestion
          </div>
        </form>
      </main>

      {drawer && (
        <aside className="drawer" aria-label="Card detail">
          <button
            type="button"
            className="icon-btn close"
            onClick={() => setDrawer(null)}
            aria-label="Close"
          >
            ✕
          </button>
          <CardDetail card={drawer} />
        </aside>
      )}
      {palette && (
        <Palette
          client={client}
          format={format}
          onClose={() => setPalette(false)}
          onOpen={(card) => {
            setPalette(false);
            setDrawer(card);
          }}
        />
      )}
    </div>
  );
}
