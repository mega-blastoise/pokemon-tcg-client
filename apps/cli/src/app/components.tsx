/** @module components Ink building blocks: wordmark, markdown, card rows, detail panel, input. */
import type { DiagnosticResult } from "@johto-ai/tcg-agent/diagnostics";
import type {
  CardView,
  SetView,
  ToolCall,
  ToolOutcome,
} from "@johto-ai/tcg-agent/protocol";
import { Box, Text, useInput } from "ink";
import { type ReactNode, useEffect, useState } from "react";
import {
  ACCENT,
  BAD,
  BORDER,
  GRADIENT,
  INFO,
  MUTED,
  OK,
  rarityColor,
  TYPE_COLORS,
  typeColor,
} from "./theme.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Braille spinner; one shared cadence keeps redraws cheap. */
export function Spinner({ color = ACCENT }: { color?: string }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(
      () => setFrame((f) => (f + 1) % FRAMES.length),
      80,
    );
    return () => clearInterval(timer);
  }, []);
  return <Text color={color}>{FRAMES[frame]}</Text>;
}

/** Per-letter gradient wordmark. */
export function Wordmark({ text }: { text: string }) {
  const letters = [...text];
  return (
    <Text bold>
      {letters.map((letter, i) => (
        <Text
          // biome-ignore lint/suspicious/noArrayIndexKey: Letters are static and positional.
          key={i}
          color={
            GRADIENT[
              Math.floor(
                (i / Math.max(1, letters.length - 1)) * (GRADIENT.length - 1),
              )
            ] ?? ACCENT
          }
        >
          {letter}
        </Text>
      ))}
    </Text>
  );
}

/** Colored energy pip for a type name. */
export function Energy({ type }: { type: string }) {
  return <Text color={TYPE_COLORS[type] ?? MUTED}>●</Text>;
}

/** Inline markdown: **bold**, *italic*, and `code` (card ids glow). */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g);
  return (
    <Text>
      {parts.map((part, i) => {
        const key = `${i}-${part}`;
        if (part.startsWith("**") && part.endsWith("**") && part.length > 4)
          return (
            <Text key={key} bold color="white">
              {part.slice(2, -2)}
            </Text>
          );
        if (part.startsWith("`") && part.endsWith("`") && part.length > 2)
          return (
            <Text key={key} color={INFO}>
              {part.slice(1, -1)}
            </Text>
          );
        if (part.startsWith("*") && part.endsWith("*") && part.length > 2)
          return (
            <Text key={key} italic>
              {part.slice(1, -1)}
            </Text>
          );
        return <Text key={key}>{part}</Text>;
      })}
    </Text>
  );
}

/** Block markdown good enough for chat answers: headings, lists, fences. */
export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\n{3,}/g, "\n\n").split("\n");
  let fenced = false;
  const out: ReactNode[] = [];
  lines.forEach((line, i) => {
    const key = `${i}`;
    if (line.trim().startsWith("```")) {
      fenced = !fenced;
      return;
    }
    if (fenced) {
      out.push(
        <Text key={key} color={MUTED}>
          {"  "}
          {line}
        </Text>,
      );
      return;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      out.push(
        <Text key={key} bold color={ACCENT}>
          {heading[2]}
        </Text>,
      );
      return;
    }
    const bullet = /^(\s*)([-*•]|\d+\.)\s+(.*)$/.exec(line);
    if (bullet) {
      const depth = Math.floor((bullet[1]?.length ?? 0) / 2);
      const marker = /\d/.test(bullet[2] ?? "") ? bullet[2] : "•";
      out.push(
        <Box key={key} paddingLeft={depth * 2}>
          <Text color={ACCENT}>{marker} </Text>
          <Inline text={bullet[3] ?? ""} />
        </Box>,
      );
      return;
    }
    out.push(
      line.trim() ? <Inline key={key} text={line} /> : <Text key={key}> </Text>,
    );
  });
  return <Box flexDirection="column">{out}</Box>;
}

/** Fit text to a column, marking truncation. */
function fit(value: string, width: number): string {
  if (value.length <= width) return value.padEnd(width);
  return `${value.slice(0, Math.max(0, width - 1))}…`;
}

/** Compact result table; long lists collapse to the first rows. */
export function CardRows({
  cards,
  total,
  width,
  max = 8,
}: {
  cards: readonly CardView[];
  total?: number | undefined;
  width: number;
  max?: number;
}) {
  const nameWidth = Math.max(14, Math.min(28, width - 70));
  const setWidth = Math.max(10, Math.min(24, width - nameWidth - 52));
  const shown = cards.slice(0, max);
  const rest = (total ?? cards.length) - shown.length;
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {shown.map((card) => (
        <Box key={card.id} gap={1}>
          <Text color={typeColor(card.types)}>▍</Text>
          <Text color={INFO}>{fit(card.id, 12)}</Text>
          <Text bold>{fit(card.name, nameWidth)}</Text>
          <Text color={typeColor(card.types)}>
            {fit(card.types.join("/") || card.supertype, 10)}
          </Text>
          <Text color={MUTED}>{fit(card.hp ? `${card.hp} HP` : "", 6)}</Text>
          <Text color={rarityColor(card.rarity)}>
            {fit(card.rarity ?? "—", 16)}
          </Text>
          <Text color={MUTED}>{fit(card.setName ?? card.setId, setWidth)}</Text>
        </Box>
      ))}
      {rest > 0 && (
        <Text color={MUTED}>
          {"  "}+ {rest.toLocaleString()} more
        </Text>
      )}
    </Box>
  );
}

/** Set listing rows. */
export function SetRows({ sets }: { sets: readonly SetView[] }) {
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {sets.map((set) => (
        <Box key={set.id} gap={1}>
          <Text color={ACCENT}>▍</Text>
          <Text color={INFO}>{fit(set.id, 10)}</Text>
          <Text bold>{fit(set.name, 30)}</Text>
          <Text color={MUTED}>{fit(set.series, 18)}</Text>
          <Text color={MUTED}>{fit(set.releaseDate ?? "", 10)}</Text>
          <Text color={MUTED}>{set.cardCount} cards</Text>
        </Box>
      ))}
    </Box>
  );
}

/** Human-readable tool arguments: `name="pikachu" type=Fire`. */
function formatArgs(input: Record<string, unknown>): string {
  return Object.entries(input)
    .map(
      ([k, v]) =>
        `${k}=${typeof v === "string" ? `"${v}"` : JSON.stringify(v)}`,
    )
    .join(" ");
}

/** One tool call with live status, then its results. */
export function ToolBlock({
  call,
  outcome,
  width,
}: {
  call: ToolCall;
  outcome?: ToolOutcome | undefined;
  width: number;
}) {
  return (
    <Box flexDirection="column">
      <Box gap={1}>
        {outcome ? (
          <Text color={outcome.ok ? OK : BAD}>{outcome.ok ? "✓" : "✗"}</Text>
        ) : (
          <Spinner color={INFO} />
        )}
        <Text color={INFO} bold>
          {call.name}
        </Text>
        <Text color={MUTED} wrap="truncate-end">
          {formatArgs(call.input)}
        </Text>
        {outcome && (
          <Text color={outcome.ok ? MUTED : BAD}>
            → {outcome.summary} · {outcome.durationMs}ms
          </Text>
        )}
      </Box>
      {outcome?.cards && outcome.cards.length > 0 && (
        <CardRows cards={outcome.cards} total={outcome.total} width={width} />
      )}
      {outcome?.sets && outcome.sets.length > 0 && (
        <SetRows sets={outcome.sets} />
      )}
    </Box>
  );
}

/** Full card panel for /card. */
export function CardDetail({ card }: { card: CardView }) {
  const color = typeColor(card.types);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color}
      paddingX={1}
      width={72}
    >
      <Box justifyContent="space-between">
        <Text bold color="white">
          {card.name}
          <Text color={MUTED}> {card.subtypes.join(" · ")}</Text>
        </Text>
        <Text bold color={color}>
          {card.hp ? `${card.hp} HP ` : ""}
          {card.types.map((t) => (
            <Energy key={t} type={t} />
          ))}
        </Text>
      </Box>
      <Text color={MUTED}>
        {card.setName ?? card.setId} · #{card.number} ·{" "}
        <Text color={rarityColor(card.rarity)}>
          {card.rarity ?? "no rarity"}
        </Text>
        {card.regulationMark ? ` · Reg ${card.regulationMark}` : ""}
        {card.evolvesFrom ? ` · evolves from ${card.evolvesFrom}` : ""}
      </Text>
      {card.abilities.map((ability) => (
        <Box key={ability.name} flexDirection="column" marginTop={1}>
          <Text>
            <Text color="#F87171" bold>
              {ability.type}
            </Text>{" "}
            <Text bold>{ability.name}</Text>
          </Text>
          {ability.text && <Text color="#CBD5E1">{ability.text}</Text>}
        </Box>
      ))}
      {card.attacks.map((attack) => (
        <Box key={attack.name} flexDirection="column" marginTop={1}>
          <Box justifyContent="space-between">
            <Text>
              {attack.cost.map((c, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: Energy costs repeat.
                <Energy key={i} type={c} />
              ))}{" "}
              <Text bold>{attack.name}</Text>
            </Text>
            <Text bold>{attack.damage ?? ""}</Text>
          </Box>
          {attack.text && <Text color="#CBD5E1">{attack.text}</Text>}
        </Box>
      ))}
      {card.rules.map((rule) => (
        <Box key={rule} marginTop={1}>
          <Text color="#CBD5E1" italic>
            {rule}
          </Text>
        </Box>
      ))}
      <Box marginTop={1} gap={2}>
        <Text color={MUTED}>
          weak{" "}
          {card.weaknesses.length
            ? card.weaknesses.map((w) => (
                <Text key={w.type}>
                  <Energy type={w.type} />
                  {w.value}{" "}
                </Text>
              ))
            : "—"}
        </Text>
        <Text color={MUTED}>
          resist{" "}
          {card.resistances.length
            ? card.resistances.map((r) => (
                <Text key={r.type}>
                  <Energy type={r.type} />
                  {r.value}{" "}
                </Text>
              ))
            : "—"}
        </Text>
        <Text color={MUTED}>retreat {"○".repeat(card.retreatCost) || "—"}</Text>
      </Box>
      <Text color={MUTED}>
        std <Legal status={card.legalities.standard} /> · exp{" "}
        <Legal status={card.legalities.expanded} /> · unl{" "}
        <Legal status={card.legalities.unlimited} />
        {card.artist ? ` · illus. ${card.artist}` : ""}
      </Text>
      {card.flavorText && (
        <Text color={MUTED} italic>
          “{card.flavorText}”
        </Text>
      )}
      {card.images.large && (
        <Text color={MUTED} wrap="truncate-end">
          {card.images.large}
        </Text>
      )}
    </Box>
  );
}

function Legal({ status }: { status: string }) {
  const color = status === "legal" ? OK : status === "banned" ? BAD : MUTED;
  return <Text color={color}>{status}</Text>;
}

/** Live diagnostics table. */
export function DoctorTable({
  results,
  running,
  label,
}: {
  results: readonly DiagnosticResult[];
  running: boolean;
  label: string;
}) {
  const failed = results.filter((r) => !r.ok).length;
  const total = results.reduce((sum, r) => sum + r.durationMs, 0);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={failed ? BAD : running ? BORDER : OK}
      paddingX={1}
    >
      <Text bold>
        Client diagnostics <Text color={MUTED}>· {label}</Text>
      </Text>
      {results.map((r) => (
        <Box key={r.id} gap={1}>
          <Text color={r.ok ? OK : BAD}>{r.ok ? "✓" : "✗"}</Text>
          <Text>{fit(r.label, 40)}</Text>
          <Text color={MUTED}>{fit(`${r.durationMs}ms`, 9)}</Text>
          <Text color={r.ok ? MUTED : BAD} wrap="truncate-end">
            {r.detail}
          </Text>
        </Box>
      ))}
      {running ? (
        <Box gap={1}>
          <Spinner />
          <Text color={MUTED}>running…</Text>
        </Box>
      ) : (
        <Text color={failed ? BAD : OK} bold>
          {failed
            ? `${failed} of ${results.length} checks failed`
            : `All ${results.length} checks passed`}
          <Text color={MUTED}> in {Math.round(total)}ms</Text>
        </Text>
      )}
    </Box>
  );
}

/** Single-line editor with history, word-jumps, and paste. */
export function PromptInput({
  onSubmit,
  disabled,
  placeholder,
  history,
  suggestion,
}: {
  onSubmit: (value: string) => void;
  disabled: boolean;
  placeholder: string;
  history: readonly string[];
  suggestion?: string | undefined;
}) {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [index, setIndex] = useState(-1);
  const set = (next: string, at = next.length) => {
    setValue(next);
    setCursor(Math.max(0, Math.min(at, next.length)));
  };
  useInput(
    (input, key) => {
      if (key.return) {
        if (value.trim()) onSubmit(value.trim());
        set("");
        setIndex(-1);
        return;
      }
      if (key.tab && !value && suggestion) return set(suggestion);
      if (key.upArrow && history.length) {
        const next = Math.min(history.length - 1, index + 1);
        setIndex(next);
        return set(history[history.length - 1 - next] ?? "");
      }
      if (key.downArrow) {
        const next = Math.max(-1, index - 1);
        setIndex(next);
        return set(next < 0 ? "" : (history[history.length - 1 - next] ?? ""));
      }
      if (key.leftArrow) return setCursor((c) => Math.max(0, c - 1));
      if (key.rightArrow)
        return setCursor((c) => Math.min(value.length, c + 1));
      if (key.home || (key.ctrl && input === "a")) return setCursor(0);
      if (key.end || (key.ctrl && input === "e"))
        return setCursor(value.length);
      if (key.ctrl && input === "u") return set(value.slice(cursor), 0);
      if (key.ctrl && input === "w") {
        const head = value.slice(0, cursor).replace(/\S+\s*$/, "");
        return set(head + value.slice(cursor), head.length);
      }
      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        return set(
          value.slice(0, cursor - 1) + value.slice(cursor),
          cursor - 1,
        );
      }
      if (key.ctrl || key.meta || key.escape || key.tab) return;
      if (input) {
        // Pastes arrive as one chunk: inner newlines become spaces, a trailing one submits.
        const text = input.replace(/[\r\n]+$/, "").replace(/[\r\n]+/g, " ");
        const next = value.slice(0, cursor) + text + value.slice(cursor);
        if (/[\r\n]$/.test(input)) {
          if (next.trim()) onSubmit(next.trim());
          set("");
          setIndex(-1);
          return;
        }
        set(next, cursor + text.length);
      }
    },
    { isActive: !disabled },
  );
  const before = value.slice(0, cursor);
  const at = value[cursor] ?? " ";
  const after = value.slice(cursor + 1);
  return (
    <Box
      borderStyle="round"
      borderColor={disabled ? BORDER : ACCENT}
      paddingX={1}
    >
      <Text color={disabled ? MUTED : ACCENT} bold>
        ❯{" "}
      </Text>
      {value ? (
        <Text>
          {before}
          <Text inverse={!disabled}>{at}</Text>
          {after}
        </Text>
      ) : (
        <Text color={MUTED}>
          <Text inverse={!disabled}> </Text>
          {suggestion && !disabled ? `${suggestion}  ⇥` : placeholder}
        </Text>
      )}
    </Box>
  );
}
