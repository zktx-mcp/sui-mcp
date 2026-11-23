import { Client, ProtocolError, SdkHttpError } from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Tool, Transport } from "@modelcontextprotocol/client";
import { SERVER_INSTRUCTIONS, SERVER_NAME, SERVER_VERSION } from "../../mcp/serverInfo.js";
import { createAuthenticatedFetch, probeAuthenticatedServer } from "./authenticatedFetch.js";
import { INTERNAL_MCP_PATH, type ControlIdentity } from "./control.js";

// The SDK owns request IDs, initialization, cancellation and response parsing.
// This proxy has no domain services or writable stores. A new request may open a
// new MCP session after ownership changes; an already dispatched call is never replayed.
export async function startSharedStdio(input: {
  stdio: Transport; port: number; control: ControlIdentity | Promise<ControlIdentity>; ready?: Promise<void>; onError(error: Error): void;
}) {
  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, {
    capabilities: { tools: {}, resources: {}, prompts: {}, completions: {} }, instructions: SERVER_INSTRUCTIONS
  });
  let connection: { instanceId: string; client: Client; tools?: readonly Tool[] } | undefined;
  let connecting: Promise<Client> | undefined;
  let closed = false;
  const lifetime = new AbortController();
  function waiting<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new Error("MCP connection was closed or cancelled."));
      signal.addEventListener("abort", abort, { once: true });
      void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }
  async function owner(signal?: AbortSignal): Promise<Client> {
    if (closed) throw new Error("MCP connection is closed.");
    signal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    const [control] = await waiting(Promise.all([input.control, input.ready]), signal);
    if (connecting) return connecting;
    const identity = await probeAuthenticatedServer(input.port, control);
    signal?.throwIfAborted();
    if (connection?.instanceId === identity.instanceId) return connection.client;
    if (connecting) return connecting;
    const open = (async () => {
      await connection?.client.close(); connection = undefined;
      if (closed) throw new Error("MCP connection is closed.");
      const clientInfo = server.getClientVersion();
      if (!clientInfo) throw new Error("MCP client initialization is required.");
      const client = new Client(clientInfo, { capabilities: server.getClientCapabilities() ?? {} });
      const http = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${input.port}${INTERNAL_MCP_PATH}`), {
        fetch: createAuthenticatedFetch(input.port, control, identity.instanceId)
      });
      const transport: Transport = {
        start: () => http.start(), send: async (message, options) => {
          try {
            await http.send(message, {
              ...(options?.resumptionToken === undefined ? {} : { resumptionToken: options.resumptionToken }),
              ...(options?.onresumptiontoken === undefined ? {} : { onresumptiontoken: options.onresumptiontoken }),
              ...(options?.requestSignal === undefined ? {} : { requestSignal: options.requestSignal }),
              ...(options?.onRequestStreamEnd === undefined ? {} : { onRequestStreamEnd: options.onRequestStreamEnd }),
              ...(options?.headers === undefined ? {} : { headers: options.headers })
            });
          } catch (error) {
            // Keep the observed HTTP status on the forwarded MCP error. SDK 2
            // identifies local HTTP failures with a string code instead.
            if (error instanceof SdkHttpError) throw new ProtocolError(error.status, error.message);
            throw error;
          }
        },
        setProtocolVersion: (version) => http.setProtocolVersion(version),
        close: async () => { try { await http.terminateSession(); } catch { /* The prior owner may already be gone. */ } await http.close(); }
      };
      http.onmessage = (message) => {
        if (http.sessionId !== undefined) transport.sessionId = http.sessionId;
        if ("method" in message && message.method === "notifications/tools/list_changed" && connection?.client === client) {
          delete connection.tools;
        }
        transport.onmessage?.(message);
      };
      http.onerror = (error) => transport.onerror?.(error);
      http.onclose = () => transport.onclose?.();
      try {
        await client.connect(transport, signal === undefined ? undefined : { signal });
        if (closed) { await client.close(); throw new Error("MCP connection is closed."); }
        connection = { instanceId: identity.instanceId, client };
        return client;
      } catch (error) { await client.close(); throw error; }
    })();
    connecting = open;
    try { return await open; } finally { if (connecting === open) connecting = undefined; }
  }
  server.setRequestHandler("tools/list", async (request, extra) => {
    const client = await owner(extra.mcpReq.signal);
    const result = await client.listTools(request.params, { signal: extra.mcpReq.signal });
    // The SDK aggregates every page on an initial list. Keep its precise
    // definitions only for this connection to this backend instance.
    if (request.params?.cursor === undefined && result.nextCursor === undefined && connection?.client === client) connection.tools = result.tools;
    return result;
  });
  server.setRequestHandler("tools/call", async (request, extra) => {
    const client = await owner(extra.mcpReq.signal);
    const directory = connection?.client === client ? connection.tools : undefined;
    const tool = directory?.find(item => item.name === request.params.name);
    if (directory && !tool) {
      // There is no announced output schema for this name. The server still
      // decides whether the request is supported and enforces its own admission.
      return client.request({ method: "tools/call", params: request.params }, { signal: extra.mcpReq.signal });
    }
    // An explicit definition validates the requested output before returning
    // it, without compiling the entire directory during a concurrent Host read.
    return client.callTool(request.params, { signal: extra.mcpReq.signal, ...(tool ? { toolDefinition: tool } : {}) });
  });
  server.setRequestHandler("resources/list", async (request, extra) =>
    (await owner(extra.mcpReq.signal)).listResources(request.params, { signal: extra.mcpReq.signal }));
  server.setRequestHandler("resources/templates/list", async (request, extra) =>
    (await owner(extra.mcpReq.signal)).listResourceTemplates(request.params, { signal: extra.mcpReq.signal }));
  server.setRequestHandler("resources/read", async (request, extra) =>
    (await owner(extra.mcpReq.signal)).readResource(request.params, { signal: extra.mcpReq.signal }));
  server.setRequestHandler("prompts/list", async (request, extra) =>
    (await owner(extra.mcpReq.signal)).listPrompts(request.params, { signal: extra.mcpReq.signal }));
  server.setRequestHandler("prompts/get", async (request, extra) =>
    (await owner(extra.mcpReq.signal)).getPrompt(request.params, { signal: extra.mcpReq.signal }));
  server.setRequestHandler("completion/complete", async (request, extra) =>
    (await owner(extra.mcpReq.signal)).complete(request.params, { signal: extra.mcpReq.signal }));
  server.onerror = input.onError;
  await server.connect(input.stdio);
  return {
    async close(): Promise<void> {
      if (closed) return;
      closed = true; lifetime.abort();
      await server.close();
      try { await connecting; } catch { /* Initialization was cancelled with the stdio connection. */ }
      await connection?.client.close(); connection = undefined;
    }
  };
}
