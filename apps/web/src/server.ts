#!/usr/bin/env bun
/** @module web_server Serves the GUI, mirrors snapshot JSON, and relays Claude's tool calls to the browser. */
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentStatus,
  CardAgentHost,
  type CardAgentSession,
  findLocalSnapshot,
} from "@johto-ai/tcg-agent";
import type {
  ClientMessage,
  ServerMessage,
  ToolOutcome,
} from "@johto-ai/tcg-agent/protocol";
import type { ServerWebSocket } from "bun";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "public");
const snapshot =
  (await findLocalSnapshot(
    process.env.TCG_SNAPSHOT_DIR
      ? { directory: process.env.TCG_SNAPSHOT_DIR }
      : {},
  )) ?? (await findLocalSnapshot({ from: here }));
if (!snapshot) {
  console.error(
    "No local snapshot found. Build one (bun run test:catalog) or set TCG_SNAPSHOT_DIR.",
  );
  process.exit(1);
}
const mirrorRoot = resolve(snapshot.directory);

// One adapter process serves every tab; each socket gets its own ACP session.
let status: AgentStatus = { state: "starting" };
const sockets = new Set<ServerWebSocket<Connection>>();
const model = process.env.TCG_MODEL;
const hostReady = CardAgentHost.start({
  ...(model ? { model } : {}),
  onLog: (line) => {
    if (process.env.TCG_DEBUG) console.error(`[acp] ${line}`);
  },
}).then(
  (host) => {
    // Each socket hears "ready" only once its own session exists (see openSession).
    status = { state: "ready", agent: host.agentName, model: host.model };
    return host;
  },
  (error: unknown) => {
    status = { state: "error", message: String(error) };
    broadcast({ type: "status", status });
    return null;
  },
);

interface Connection {
  session: CardAgentSession | null;
  pending: Map<string, (outcome: ToolOutcome) => void>;
}

function send(ws: ServerWebSocket<Connection>, message: ServerMessage) {
  ws.send(JSON.stringify(message));
}
function broadcast(message: ServerMessage) {
  for (const ws of sockets) send(ws, message);
}

/** A session whose tools execute in this socket's browser client. */
async function openSession(ws: ServerWebSocket<Connection>) {
  ws.data.session?.close();
  ws.data.session = null;
  send(ws, { type: "status", status: { state: "starting" } });
  const host = await hostReady;
  if (!host) return send(ws, { type: "status", status });
  ws.data.session = await host.createSession(
    (call, signal) =>
      new Promise<ToolOutcome>((resolveOutcome) => {
        const timeout = setTimeout(
          () => finish(failure("TIMEOUT", "Browser did not answer in 60s")),
          60_000,
        );
        const finish = (outcome: ToolOutcome) => {
          clearTimeout(timeout);
          ws.data.pending.delete(call.id);
          resolveOutcome(outcome);
        };
        signal.addEventListener("abort", () =>
          finish(failure("ABORTED", "Session closed")),
        );
        ws.data.pending.set(call.id, finish);
        send(ws, { type: "tool_request", call });
      }),
    (event) => send(ws, { type: "event", event }),
  );
  send(ws, { type: "status", status });
}

function failure(code: string, message: string): ToolOutcome {
  return {
    ok: false,
    summary: message,
    content: `Error ${code}: ${message}`,
    durationMs: 0,
    error: { code, message },
  };
}

// Gzip once per file; snapshot files are immutable for a given commit.
const gzipCache = new Map<string, Uint8Array<ArrayBuffer>>();
async function serveSnapshot(
  path: string,
  request: Request,
): Promise<Response> {
  const file = normalize(join(mirrorRoot, path));
  // Only the generated browser views are mirrored, never the database.
  if (!file.startsWith(`${join(mirrorRoot, "generated")}/`))
    return new Response("Not found", { status: 404 });
  const handle = Bun.file(file);
  if (!(await handle.exists()))
    return new Response("Not found", { status: 404 });
  const headers = {
    "content-type": "application/json",
    "cache-control": "public, max-age=31536000, immutable",
  };
  if (!request.headers.get("accept-encoding")?.includes("gzip"))
    return new Response(handle, { headers });
  let body = gzipCache.get(file);
  if (!body) {
    body = Bun.gzipSync(
      new Uint8Array(await handle.arrayBuffer()),
    ) as Uint8Array<ArrayBuffer>;
    gzipCache.set(file, body);
  }
  return new Response(body, {
    headers: { ...headers, "content-encoding": "gzip" },
  });
}

const server = Bun.serve<Connection>({
  port: Number(process.env.PORT ?? 4173),
  hostname: process.env.HOST ?? "localhost",
  async fetch(request, srv) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      const upgraded = srv.upgrade(request, {
        data: { session: null, pending: new Map() },
      });
      return upgraded
        ? undefined
        : new Response("Upgrade failed", { status: 400 });
    }
    if (url.pathname === "/api/snapshot")
      return Response.json({
        manifest: snapshot.manifest,
        directory: snapshot.directory,
        mirrorAvailable: true,
      });
    if (url.pathname.startsWith("/snapshot/"))
      return serveSnapshot(decodeURIComponent(url.pathname.slice(10)), request);
    const asset = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = normalize(join(publicDir, asset));
    if (file.startsWith(publicDir) && (await Bun.file(file).exists()))
      return new Response(Bun.file(file));
    return new Response(Bun.file(join(publicDir, "index.html")));
  },
  websocket: {
    async open(ws) {
      sockets.add(ws);
      await openSession(ws);
    },
    async message(ws, raw) {
      const message = JSON.parse(String(raw)) as ClientMessage;
      switch (message.type) {
        case "prompt":
          if (!ws.data.session) {
            send(ws, {
              type: "event",
              event: {
                type: "error",
                message:
                  status.state === "error"
                    ? `Claude is unavailable: ${status.message}`
                    : "Still connecting to Claude…",
              },
            });
            send(ws, {
              type: "event",
              event: { type: "done", stopReason: "error", durationMs: 0 },
            });
            return;
          }
          void ws.data.session.prompt(message.text);
          return;
        case "cancel":
          await ws.data.session?.cancel();
          return;
        case "reset":
          await openSession(ws);
          return;
        case "tool_result":
          ws.data.pending.get(message.callId)?.(message.outcome);
          return;
      }
    },
    close(ws) {
      sockets.delete(ws);
      ws.data.session?.close();
    },
  },
});

console.log(`◓ TCG Chat web → ${server.url}`);
console.log(
  `  snapshot ${snapshot.manifest.dataVersion} from ${snapshot.directory}`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    await (await hostReady)?.close();
    server.stop(true);
    process.exit(0);
  });
