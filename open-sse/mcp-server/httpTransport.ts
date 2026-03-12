/**
 * MCP HTTP Transport Layer — Singleton server + SSE/Streamable HTTP handlers.
 *
 * Runs the MCP server **inside** the Next.js process so it can be toggled
 * from the dashboard without requiring `omniroute --mcp`.
 *
 * Transport modes:
 *   - SSE:             GET /api/mcp/sse (event stream)  +  POST /api/mcp/sse (messages)
 *   - Streamable HTTP: POST /api/mcp/stream (messages)  +  GET /api/mcp/stream (SSE stream)  +  DELETE /api/mcp/stream (session end)
 */

import { randomUUID } from "node:crypto";
import { createMcpServer } from "./server.ts";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ────── Singleton ──────────────────────────────────────────

let _server: McpServer | null = null;
let _transport: WebStandardStreamableHTTPServerTransport | null = null;
let _startedAt: number | null = null;
let _activeTransportMode: "sse" | "streamable-http" | null = null;

function ensureServer(mode: "sse" | "streamable-http"): {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
} {
  if (_server && _transport && _activeTransportMode === mode) {
    return { server: _server, transport: _transport };
  }

  // Shutdown previous if switching modes
  if (_transport) {
    try { _transport.close(); } catch { /* ignore */ }
  }

  _server = createMcpServer();
  _transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  _activeTransportMode = mode;
  _startedAt = Date.now();

  // Connect server to transport (fire-and-forget, will be ready by first request)
  void _server.connect(_transport);

  console.log(`[MCP] HTTP transport started (${mode})`);
  return { server: _server, transport: _transport };
}

// ────── Streamable HTTP Handler ────────────────────────────

/**
 * Handle Streamable HTTP requests (POST / GET / DELETE).
 * Used by the Next.js route at /api/mcp/stream.
 */
export async function handleMcpStreamableHTTP(request: Request): Promise<Response> {
  const { transport } = ensureServer("streamable-http");

  try {
    return await transport.handleRequest(request);
  } catch (err) {
    console.error("[MCP] Streamable HTTP error:", err);
    return new Response(
      JSON.stringify({ error: "MCP transport error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}

/**
 * Handle SSE requests.
 * SSE transport is implemented via Streamable HTTP transport with GET for SSE stream
 * and POST for messages (the Streamable HTTP transport supports both patterns).
 */
export async function handleMcpSSE(request: Request): Promise<Response> {
  const { transport } = ensureServer("sse");

  try {
    return await transport.handleRequest(request);
  } catch (err) {
    console.error("[MCP] SSE error:", err);
    return new Response(
      JSON.stringify({ error: "MCP SSE transport error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}

// ────── Status & Lifecycle ─────────────────────────────────

export function getMcpHttpStatus(): {
  online: boolean;
  transport: string | null;
  startedAt: number | null;
  uptime: string | null;
} {
  const online = _transport !== null && _activeTransportMode !== null;
  return {
    online,
    transport: _activeTransportMode,
    startedAt: _startedAt,
    uptime: _startedAt ? `${Math.floor((Date.now() - _startedAt) / 1000)}s` : null,
  };
}

export function shutdownMcpHttp(): void {
  if (_transport) {
    try { _transport.close(); } catch { /* ignore */ }
  }
  _server = null;
  _transport = null;
  _activeTransportMode = null;
  _startedAt = null;
  console.log("[MCP] HTTP transport shutdown");
}

export function isMcpHttpActive(): boolean {
  return _transport !== null;
}
