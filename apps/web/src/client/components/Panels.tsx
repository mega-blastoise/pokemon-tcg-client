/** @module panels Sidebar panels that make the browser client's behavior visible. */
import {
  type DiagnosticResult,
  runDiagnostics,
} from "@johto-ai/tcg-agent/diagnostics";
import type {
  AgentStatus,
  CardView,
  TCGClient,
} from "@johto-ai/tcg-agent/protocol";
import { toCardView } from "@johto-ai/tcg-agent/tools";
import type { CardFormat } from "@johto-ai/tcg-client/browser";
import { useEffect, useRef, useState } from "react";
import type { FetchRecord, SnapshotSource } from "../tcg.js";
import type { ToolActivity } from "../useAgent.js";

function bytes(n: number | null): string {
  if (n === null) return "…";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** Snapshot identity and agent connection. */
export function SnapshotPanel({
  client,
  source,
  onSource,
  status,
  connected,
  usage,
}: {
  client: TCGClient | null;
  source: SnapshotSource;
  onSource: (source: SnapshotSource) => void;
  status: AgentStatus;
  connected: boolean;
  usage: { used: number; size: number; cost: number };
}) {
  const snapshot = client?.snapshot;
  return (
    <section className="panel">
      <header className="panel-head">
        <h3>Snapshot</h3>
        {snapshot && !snapshot.releaseReady && (
          <span className="tag warn">draft</span>
        )}
      </header>
      {snapshot ? (
        <dl className="kv">
          <dt>version</dt>
          <dd>{snapshot.dataVersion}</dd>
          <dt>commit</dt>
          <dd>
            <code>{snapshot.source.commit.slice(0, 10)}</code>
          </dd>
          <dt>catalog</dt>
          <dd>
            {snapshot.counts.sets.toLocaleString()} sets ·{" "}
            {snapshot.counts.cards.toLocaleString()} cards
          </dd>
          <dt>adapter</dt>
          <dd>browser · fetch + Web Crypto</dd>
        </dl>
      ) : (
        <div className="skeleton" />
      )}
      <fieldset className="segmented" aria-label="Snapshot transport">
        {(["mirror", "github"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={source === value}
            className={source === value ? "on" : ""}
            onClick={() => onSource(value)}
          >
            {value === "mirror" ? "Local mirror" : "GitHub raw"}
          </button>
        ))}
      </fieldset>
      <p className="hint">
        Either way the client verifies every file's SHA-256 against the pinned
        descriptor.
      </p>
      <header className="panel-head">
        <h3>Agent</h3>
      </header>
      <div className="agent-line">
        <span
          className={`dot ${!connected ? "bad" : status.state === "ready" ? "ok" : status.state === "error" ? "bad" : "wait"}`}
        />
        <span>
          {!connected
            ? "Reconnecting to server…"
            : status.state === "ready"
              ? status.agent
              : status.state === "error"
                ? status.message
                : "Starting Claude via ACP…"}
        </span>
      </div>
      {usage.used > 0 && (
        <div
          className="meter"
          title={`${usage.used.toLocaleString()} / ${usage.size.toLocaleString()} tokens`}
        >
          <div
            style={{
              width: `${Math.min(100, (usage.used / Math.max(1, usage.size)) * 100)}%`,
            }}
          />
          <span>
            {(usage.used / 1000).toFixed(1)}k ctx
            {usage.cost ? ` · $${usage.cost.toFixed(3)}` : ""}
          </span>
        </div>
      )}
    </section>
  );
}

/** Run the shared contract checks in this tab. */
export function DiagnosticsPanel({
  client,
  createClient,
}: {
  client: TCGClient | null;
  createClient: () => Promise<TCGClient>;
}) {
  const [results, setResults] = useState<DiagnosticResult[]>([]);
  const [running, setRunning] = useState(false);
  const run = async () => {
    if (!client) return;
    setRunning(true);
    setResults([]);
    for await (const result of runDiagnostics(client, { createClient }))
      setResults((r) => [...r, result]);
    setRunning(false);
  };
  const failed = results.filter((r) => !r.ok).length;
  return (
    <section className="panel">
      <header className="panel-head">
        <h3>Diagnostics</h3>
        <button
          type="button"
          className="small-btn"
          disabled={!client || running}
          onClick={run}
        >
          {running ? "Running…" : results.length ? "Run again" : "Run checks"}
        </button>
      </header>
      {results.length === 0 && !running && (
        <p className="hint">
          Verifies counts, lookups, nulls, ordering, paging, folding, errors and
          lifecycle.
        </p>
      )}
      <ul className="checks">
        {results.map((r) => (
          <li key={r.id} className={r.ok ? "ok" : "bad"} title={r.detail}>
            <span className="mark">{r.ok ? "✓" : "✗"}</span>
            <span className="label">{r.label}</span>
            <span className="ms">{r.durationMs}ms</span>
            <span className="detail">{r.detail}</span>
          </li>
        ))}
        {running && <li className="pending">running…</li>}
      </ul>
      {!running && results.length > 0 && (
        <div className={`summary ${failed ? "bad" : "ok"}`}>
          {failed
            ? `${failed} of ${results.length} failed`
            : `All ${results.length} checks passed`}
        </div>
      )}
    </section>
  );
}

/** Every snapshot file the client fetched, with size and timing. */
export function NetworkPanel({ records }: { records: readonly FetchRecord[] }) {
  const total = records.reduce((sum, r) => sum + (r.bytes ?? 0), 0);
  return (
    <section className="panel">
      <header className="panel-head">
        <h3>Snapshot fetches</h3>
        <span className="muted small">
          {records.length} · {bytes(total)}
        </span>
      </header>
      <ul className="net">
        {records.map((r) => (
          <li
            key={r.id}
            className={
              r.error || (r.status ?? 200) >= 400
                ? "bad"
                : r.status === null
                  ? "pending"
                  : ""
            }
          >
            <span className="path" title={r.url}>
              {r.path.replace(/^generated\/v1\//, "")}
            </span>
            <span className="muted">{r.error ? "error" : bytes(r.bytes)}</span>
            <span className="muted">{r.ms === null ? "…" : `${r.ms}ms`}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Tool calls Claude made, as executed by this tab. */
export function ActivityPanel({
  activity,
}: {
  activity: readonly ToolActivity[];
}) {
  if (!activity.length) return null;
  return (
    <section className="panel">
      <header className="panel-head">
        <h3>Tool calls</h3>
      </header>
      <ul className="activity">
        {activity.map(({ call, outcome }) => (
          <li
            key={call.id}
            className={outcome ? (outcome.ok ? "ok" : "bad") : "pending"}
          >
            <code>{call.name}</code>
            <span className="muted">
              {outcome
                ? `${outcome.summary} · ${outcome.durationMs}ms`
                : "running…"}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** ⌘K quick search straight through the client, no model involved. */
export function Palette({
  client,
  format,
  onClose,
  onOpen,
}: {
  client: TCGClient | null;
  format?: CardFormat | undefined;
  onClose: () => void;
  onOpen: (card: CardView) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CardView[]>([]);
  const [meta, setMeta] = useState<{ total: number; ms: number } | null>(null);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    if (!client || query.trim().length < 2) {
      setResults([]);
      setMeta(null);
      return;
    }
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      const started = performance.now();
      try {
        const page = await client.cards.search(
          { name: query.trim(), limit: 12, ...(format ? { format } : {}) },
          { signal: abort.signal },
        );
        const sets = new Map(
          await Promise.all(
            [...new Set(page.items.map((c) => c.setId))].map(
              async (id) => [id, await client.sets.get(id)] as const,
            ),
          ),
        );
        setResults(
          page.items.map((c) => toCardView(c, sets.get(c.setId) ?? null)),
        );
        setMeta({
          total: page.total,
          ms: Math.round(performance.now() - started),
        });
        setActive(0);
      } catch {
        // Superseded by a newer keystroke.
      }
    }, 120);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [client, query, format]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Pointer dismissal only; Escape in the input is the keyboard path.
    <div className="palette-backdrop" onMouseDown={onClose} role="presentation">
      <div
        className="palette"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Quick card search"
      >
        <input
          ref={input}
          value={query}
          placeholder="Search card names directly through the browser client…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "ArrowDown")
              setActive((a) => Math.min(results.length - 1, a + 1));
            if (e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
            if (e.key === "Enter" && results[active]) onOpen(results[active]);
          }}
        />
        <ul>
          {results.map((card, i) => (
            <li key={card.id}>
              <button
                type="button"
                className={i === active ? "on" : ""}
                onMouseEnter={() => setActive(i)}
                onClick={() => onOpen(card)}
              >
                {card.images.small && <img src={card.images.small} alt="" />}
                <span>
                  <strong>{card.name}</strong>
                  <span className="muted">
                    {card.setName} · #{card.number} · {card.rarity ?? "—"}
                  </span>
                </span>
                <code>{card.id}</code>
              </button>
            </li>
          ))}
        </ul>
        <footer>
          {meta
            ? `${meta.total.toLocaleString()} matches in ${meta.ms}ms · cards.search({ name${format ? ", format" : ""} })`
            : "Type at least two letters"}
          <span>↑↓ to move · ↵ to open · esc to close</span>
        </footer>
      </div>
    </div>
  );
}
