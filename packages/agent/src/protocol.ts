/** @module agent_protocol Browser-safe event, tool, and transport shapes shared by every chat frontend. */
import type { PokemonTCGClient } from "@johto-ai/tcg-client";

/** Any runtime's client: the browser, Bun, and Node entries share this surface. */
export type TCGClient = Pick<
  PokemonTCGClient,
  "cards" | "sets" | "snapshot" | "close"
>;

/** The card fields a frontend needs to render a tile or a detail panel. */
export interface CardView {
  id: string;
  name: string;
  number: string;
  setId: string;
  setName: string | null;
  series: string | null;
  releaseDate: string | null;
  supertype: string;
  subtypes: string[];
  types: string[];
  hp: number | null;
  rarity: string | null;
  regulationMark: string | null;
  evolvesFrom: string | null;
  artist: string | null;
  flavorText: string | null;
  rules: string[];
  abilities: { name: string; text: string | null; type: string }[];
  attacks: {
    name: string;
    cost: string[];
    damage: string | null;
    text: string | null;
  }[];
  weaknesses: { type: string; value: string }[];
  resistances: { type: string; value: string }[];
  retreatCost: number;
  legalities: { standard: string; expanded: string; unlimited: string };
  images: { small: string | null; large: string | null };
}

/** Set metadata as shown in results and the snapshot panel. */
export interface SetView {
  id: string;
  name: string;
  series: string;
  releaseDate: string | null;
  cardCount: number;
  printedTotal: number | null;
  ptcgoCode: string | null;
  logo: string | null;
  symbol: string | null;
}

/** One model-requested call to a card tool. */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** What one client call produced: model-facing text plus structured data for UIs. */
export interface ToolOutcome {
  ok: boolean;
  /** One line for activity logs, e.g. "12 of 37 cards". */
  summary: string;
  /** Compact JSON handed back to the model. */
  content: string;
  cards?: CardView[];
  sets?: SetView[];
  total?: number;
  durationMs: number;
  error?: { code: string; message: string };
}

/** Runs a tool call against whichever client the frontend owns. */
export type ToolExecutor = (
  call: ToolCall,
  signal: AbortSignal,
) => Promise<ToolOutcome>;

/** Streamed turn activity; every frontend renders the same sequence. */
export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "thought"; delta: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "tool_result"; call: ToolCall; outcome: ToolOutcome }
  | { type: "usage"; used: number; size: number; costUsd: number | null }
  /** Claude's predicted next prompt; arrives after the turn it follows. */
  | { type: "suggestion"; text: string }
  | { type: "done"; stopReason: string; durationMs: number }
  | { type: "error"; message: string };

/** Agent connection lifecycle as reported to frontends. */
export type AgentStatus =
  | { state: "starting" }
  | { state: "ready"; agent: string; model: string | null }
  | { state: "error"; message: string };

/** Browser → server WebSocket messages. */
export type ClientMessage =
  | { type: "prompt"; text: string }
  | { type: "cancel" }
  | { type: "reset" }
  | { type: "tool_result"; callId: string; outcome: ToolOutcome };

/** Server → browser WebSocket messages. */
export type ServerMessage =
  | { type: "status"; status: AgentStatus }
  | { type: "event"; event: AgentEvent }
  | { type: "tool_request"; call: ToolCall };
