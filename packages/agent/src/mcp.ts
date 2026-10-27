/** @module mcp_bridge Minimal stateless Streamable-HTTP MCP server routing tool calls to frontends. */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ToolCall, ToolOutcome } from "./protocol.js";
import { TOOL_SERVER_NAME, toolDefinitions } from "./tools.js";

/** Receives one session's calls; the bridge only speaks MCP. */
export type ToolHandler = (call: ToolCall) => Promise<ToolOutcome>;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

/** Read a bounded request body; tool arguments are small JSON objects. */
async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new Error("MCP request too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Serves `/mcp/<token>` on loopback. Each chat session registers a random
 * token, so one bridge serves many sessions without sharing their clients.
 */
export class McpBridge {
  private readonly handlers = new Map<string, ToolHandler>();
  private constructor(
    private readonly server: Server,
    readonly origin: string,
  ) {}

  /** Bind an ephemeral loopback port. */
  static async start(): Promise<McpBridge> {
    let bridge: McpBridge | undefined;
    const server = createServer((request, response) => {
      void bridge?.handle(request).then(
        ({ status, payload }) => {
          response.writeHead(
            status,
            payload ? { "content-type": "application/json" } : {},
          );
          response.end(payload ? JSON.stringify(payload) : undefined);
        },
        (error: unknown) => {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32603, message: String(error) },
            }),
          );
        },
      );
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    bridge = new McpBridge(server, `http://127.0.0.1:${port}`);
    return bridge;
  }

  /** Register a session; the returned URL is that session's MCP endpoint. */
  register(handler: ToolHandler): { url: string; dispose: () => void } {
    const token = randomUUID();
    this.handlers.set(token, handler);
    return {
      url: `${this.origin}/mcp/${token}`,
      dispose: () => this.handlers.delete(token),
    };
  }

  /** Dispatch one HTTP request; JSON responses keep the transport stateless. */
  private async handle(
    request: IncomingMessage,
  ): Promise<{ status: number; payload?: unknown }> {
    const token = /^\/mcp\/([\w-]+)$/.exec(request.url ?? "")?.[1];
    const handler = token ? this.handlers.get(token) : undefined;
    if (!handler) return { status: 404 };
    // No server-initiated stream: tools never notify, so GET has nothing to offer.
    if (request.method === "GET") return { status: 405 };
    if (request.method === "DELETE") return { status: 200 };
    if (request.method !== "POST") return { status: 405 };
    const parsed = JSON.parse(await body(request)) as
      | JsonRpcRequest
      | JsonRpcRequest[];
    const batch = Array.isArray(parsed) ? parsed : [parsed];
    const replies = (
      await Promise.all(batch.map((message) => this.dispatch(message, handler)))
    ).filter((reply) => reply !== undefined);
    if (!replies.length) return { status: 202 };
    return {
      status: 200,
      payload: Array.isArray(parsed) ? replies : replies[0],
    };
  }

  /** Answer the handful of MCP methods a tools-only server needs. */
  private async dispatch(
    message: JsonRpcRequest,
    handler: ToolHandler,
  ): Promise<unknown> {
    // Notifications (no id) such as notifications/initialized need no reply.
    if (message.id === undefined || message.id === null) return undefined;
    const reply = (result: unknown) => ({
      jsonrpc: "2.0",
      id: message.id,
      result,
    });
    switch (message.method) {
      case "initialize":
        return reply({
          protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: TOOL_SERVER_NAME, version: "0.0.0" },
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: toolDefinitions });
      case "tools/call": {
        const outcome = await handler({
          id: randomUUID(),
          name: String(message.params?.name ?? ""),
          input: (message.params?.arguments ?? {}) as Record<string, unknown>,
        });
        return reply({
          content: [{ type: "text", text: outcome.content }],
          isError: !outcome.ok,
        });
      }
      default:
        return {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `Unknown method ${message.method}` },
        };
    }
  }

  /** Stop accepting calls and release the port. */
  async close(): Promise<void> {
    this.handlers.clear();
    await new Promise<void>((done) => this.server.close(() => done()));
  }
}
