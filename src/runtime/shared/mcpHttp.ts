import { CARD_TOOLS } from "../../mcp-ui/contracts.js";
import type { Transport } from "@modelcontextprotocol/server";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { isJSONRPCRequest } from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { MAX_JSON_BODY_BYTES, sendJson } from "./http.js";
import { settingsUploadMessageBudget } from "../../core/session/settingsFileProtocol.js";

export function createInternalMcpHandler(createServer: () => McpServer) {
  const sessions = new Map<string, { server: McpServer; transport: NodeStreamableHTTPServerTransport }>();
  const connections = new Set<McpServer>();
  return {
    async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
      // This product has no unsolicited server requests. POST returns JSON, and
      // clients do not create a reconnecting SSE channel or replay requests.
      if (request.method === "GET") { response.setHeader("Allow", "POST, DELETE"); sendJson(response, 405, { error: "method_not_allowed" }); return; }
      const sessionId = request.headers["mcp-session-id"];
      if (sessionId !== undefined && typeof sessionId !== "string") { sendJson(response, 400, { error: "invalid_session" }); return; }
      if (sessionId !== undefined) {
        const session = sessions.get(sessionId);
        if (!session) { sendJson(response, 404, { error: "mcp_session_unavailable" }); return; }
        await session.transport.handleRequest(request, response);
        return;
      }
      if (request.method !== "POST") { sendJson(response, 400, { error: "mcp_initialize_required" }); return; }
      const server = createServer();
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: true,
        onsessioninitialized: (id) => { sessions.set(id, { server, transport }); },
        onsessionclosed: (id) => { sessions.delete(id); connections.delete(server); }
      });
      connections.add(server);
      try {
        const connection: Transport = {
          start: () => transport.start(),
          send: (message, options) => transport.send(message, options?.relatedRequestId === undefined ? undefined : { relatedRequestId: options.relatedRequestId }),
          close: () => transport.close()
        };
        transport.onmessage = (message, extra) => {
          // The SDK enforces its 4 MiB HTTP body limit before this callback.
          // Card calls additionally have a 64 KiB JSON-RPC envelope budget;
          // ordinary MCP calls do not inherit that smaller card limit.
          if (isJSONRPCRequest(message) && message.method === "tools/call" &&
              Object.values(CARD_TOOLS).some((name) => name === message.params?.name) &&
              Buffer.byteLength(JSON.stringify(message)) > MAX_JSON_BODY_BYTES) {
            const budget = settingsUploadMessageBudget(message);
            void transport.send({ jsonrpc: "2.0", id: message.id, error: { code: -32600,
              message: budget === undefined ? "Card request exceeds the JSON body limit." : "settings_payload_too_large",
              ...(budget === undefined ? {} : { data: { code: "settings_payload_too_large", maximumMessageSize: MAX_JSON_BODY_BYTES, rawChunkLimit: budget } }) } });
            return;
          }
          connection.onmessage?.(message, extra);
        };
        transport.onerror = (error) => connection.onerror?.(error);
        transport.onclose = () => connection.onclose?.();
        await server.connect(connection);
        await transport.handleRequest(request, response);
        if (transport.sessionId === undefined) { connections.delete(server); await server.close(); }
      } catch (error) {
        if (transport.sessionId !== undefined) sessions.delete(transport.sessionId);
        connections.delete(server); await server.close(); throw error;
      }
    },
    async close(): Promise<void> {
      await Promise.all([...connections].map((server) => server.close()));
      connections.clear(); sessions.clear();
    }
  };
}
