/** @module use_agent Chat state over the server socket; tool calls execute in this tab's client. */
import type {
  AgentEvent,
  AgentStatus,
  ClientMessage,
  ServerMessage,
  TCGClient,
  ToolCall,
  ToolOutcome,
} from "@johto-ai/tcg-agent/protocol";
import { executeTool, type ToolOptions } from "@johto-ai/tcg-agent/tools";
import { useCallback, useEffect, useRef, useState } from "react";

export type Part =
  | { kind: "text"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "tool"; call: ToolCall; outcome?: ToolOutcome }
  | { kind: "error"; text: string };

export type Message =
  | { id: number; role: "user"; text: string }
  | {
      id: number;
      role: "assistant";
      parts: Part[];
      done: boolean;
      durationMs?: number;
      stopReason?: string;
    };

export interface ToolActivity {
  call: ToolCall;
  outcome?: ToolOutcome;
  at: number;
}

let nextId = 0;

/** Fold one streamed event into the assistant message. */
function apply(
  message: Extract<Message, { role: "assistant" }>,
  event: AgentEvent,
): Extract<Message, { role: "assistant" }> {
  const parts = [...message.parts];
  const last = parts.at(-1);
  switch (event.type) {
    case "text":
    case "thought":
      if (last?.kind === event.type)
        parts[parts.length - 1] = {
          kind: event.type,
          text: last.text + event.delta,
        };
      else parts.push({ kind: event.type, text: event.delta });
      return { ...message, parts };
    case "tool_call":
      return {
        ...message,
        parts: [...parts, { kind: "tool", call: event.call }],
      };
    case "tool_result":
      return {
        ...message,
        parts: parts.map((p) =>
          p.kind === "tool" && p.call.id === event.call.id
            ? { ...p, outcome: event.outcome }
            : p,
        ),
      };
    case "error":
      return {
        ...message,
        parts: [...parts, { kind: "error", text: event.message }],
      };
    case "done":
      return {
        ...message,
        done: true,
        durationMs: event.durationMs,
        stopReason: event.stopReason,
      };
    default:
      return message;
  }
}

/** Connect to the server, answer its tool requests locally, and expose the transcript. */
export function useAgent(client: TCGClient | null, options: ToolOptions = {}) {
  const [status, setStatus] = useState<AgentStatus>({ state: "starting" });
  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [activity, setActivity] = useState<ToolActivity[]>([]);
  const [suggestion, setSuggestion] = useState<string>();
  const [usage, setUsage] = useState({ used: 0, size: 0, cost: 0 });
  const socket = useRef<WebSocket | null>(null);
  const clientRef = useRef(client);
  clientRef.current = client;
  // Read at call time so a toggle applies to the next tool call, mid-turn included.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const inflight = useRef(new Map<string, AbortController>());

  const send = useCallback((message: ClientMessage) => {
    socket.current?.send(JSON.stringify(message));
  }, []);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws`);
      socket.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 1000);
      };
      ws.onmessage = async (raw) => {
        const message = JSON.parse(String(raw.data)) as ServerMessage;
        if (message.type === "status") return setStatus(message.status);
        if (message.type === "tool_request") {
          const { call } = message;
          const current = clientRef.current;
          const abort = new AbortController();
          inflight.current.set(call.id, abort);
          const outcome: ToolOutcome = current
            ? await executeTool(current, call, abort.signal, optionsRef.current)
            : {
                ok: false,
                summary: "Browser client not ready",
                content: "Error NOT_READY: the browser client is still loading",
                durationMs: 0,
              };
          inflight.current.delete(call.id);
          ws.send(
            JSON.stringify({ type: "tool_result", callId: call.id, outcome }),
          );
          return;
        }
        const { event } = message;
        if (event.type === "usage")
          return setUsage((u) => ({
            used: event.used,
            size: event.size,
            cost: event.costUsd !== null ? u.cost + event.costUsd : u.cost,
          }));
        if (event.type === "suggestion") return setSuggestion(event.text);
        if (event.type === "tool_call")
          setActivity((a) =>
            [{ call: event.call, at: Date.now() }, ...a].slice(0, 50),
          );
        if (event.type === "tool_result")
          setActivity((a) =>
            a.map((item) =>
              item.call.id === event.call.id
                ? { ...item, outcome: event.outcome }
                : item,
            ),
          );
        setMessages((list) => {
          const last = list.at(-1);
          if (last?.role !== "assistant" || last.done) return list;
          return [...list.slice(0, -1), apply(last, event)];
        });
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      socket.current?.close();
    };
  }, []);

  const busy =
    messages.at(-1)?.role === "assistant" &&
    !(messages.at(-1) as { done: boolean }).done;

  const prompt = useCallback(
    (text: string) => {
      setSuggestion(undefined);
      setMessages((list) => [
        ...list,
        { id: ++nextId, role: "user", text },
        { id: ++nextId, role: "assistant", parts: [], done: false },
      ]);
      send({ type: "prompt", text });
    },
    [send],
  );
  const cancel = useCallback(() => {
    for (const abort of inflight.current.values()) abort.abort();
    send({ type: "cancel" });
  }, [send]);
  const reset = useCallback(() => {
    setMessages([]);
    setSuggestion(undefined);
    setUsage({ used: 0, size: 0, cost: 0 });
    // Block prompts until the server confirms the replacement session.
    setStatus({ state: "starting" });
    send({ type: "reset" });
  }, [send]);

  return {
    status,
    connected,
    messages,
    activity,
    suggestion,
    usage,
    busy,
    prompt,
    cancel,
    reset,
  };
}
