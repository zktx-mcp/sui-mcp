import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";
import { startSharedServer } from "../src/runtime/shared/server.js";
import { createInternalMcpHandler } from "../src/runtime/shared/mcpHttp.js";
import type { ControlIdentity } from "../src/runtime/shared/control.js";
import { registerActionTools } from "../src/mcp/tools/action/prepareSuiActionReview.js";
import { walletWorkflowFixture } from "./fixtures/walletWorkflow.js";
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { TOOL_NAMES } from "../src/mcp/toolNames.js";
import { externalProposalSchema } from "../src/core/proposal/schemas.js";
import { MAX_JSON_BODY_BYTES } from "../src/runtime/shared/http.js";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { startSharedStdio } from "../src/runtime/shared/stdio.js";
import { registerMcpPrompts } from "../src/mcp/prompts.js";
import { ADAPTER_PROMPT_SURFACES } from "../src/adapters/adapterPromptSurfaces.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createAuthenticatedFetch } from "../src/runtime/shared/authenticatedFetch.js";
import { INTERNAL_MCP_PATH } from "../src/runtime/shared/control.js";
import type { Transport } from "@modelcontextprotocol/client";

const logger = { info() {}, warn() {}, error() {} };
it("enforces the complete SDK request-body bound before dispatch and preserves the stdio connection after rejection", async () => {
  // The adopted SDK 2.3.1 transport contract is 4 MiB per body, including
  // UTF-8 metadata. It is independent of the 64 KiB card-message budget.
  const maximum = 4 * 1024 * 1024;
  const control: ControlIdentity = { key: randomBytes(32).toString("base64url"), databaseId: "1".repeat(64), configurationId: "2".repeat(64) };
  const admitted: string[] = [];
  const handler = createInternalMcpHandler(() => {
    const server = new McpServer({ name: "request-size-fixture", version: "1" });
    server.registerTool("fixture.consume", { inputSchema: { text: z.string() } }, async ({ text }) => {
      admitted.push(text); return { content: [{ type: "text", text: "accepted" }] };
    });
    return server;
  });
  const runtime = await startSharedServer({ port: 0, control, onError() {}, createApplication: async () => ({
    handleMcp: handler.handle, handleHttp: async (_request, response) => { response.writeHead(404).end(); }, close: handler.close
  }) });
  let targetSize: number | undefined;
  const sizes: number[] = [];
  const authenticated = createAuthenticatedFetch(runtime.port, control);
  const http = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${runtime.port}${INTERNAL_MCP_PATH}`), {
    fetch: async (url, init) => {
      if (targetSize !== undefined && typeof init?.body === "string") {
        const message = JSON.parse(init.body);
        if (message.method === "tools/call") {
          message.params._meta = { hostWrapping: "資料", padding: "" };
          const missing = targetSize - Buffer.byteLength(JSON.stringify(message));
          if (missing < 0) throw new Error("Request-size fixture exceeds its boundary before padding");
          message.params._meta.padding = "x".repeat(missing);
          const body = JSON.stringify(message); sizes.push(Buffer.byteLength(body));
          return authenticated(url, { ...init, body });
        }
      }
      return authenticated(url, init);
    }
  });
  const client = new Client({ name: "request-size-http-client", version: "1" });
  // Keep the same Transport boundary used by the product gateway; the SDK's
  // optional sessionId accessor is wider than exactOptionalPropertyTypes.
  const connection: Transport = { start: () => http.start(), send: (message, options) => http.send(message, {
      ...(options?.resumptionToken === undefined ? {} : { resumptionToken: options.resumptionToken }),
      ...(options?.onresumptiontoken === undefined ? {} : { onresumptiontoken: options.onresumptiontoken }),
      ...(options?.requestSignal === undefined ? {} : { requestSignal: options.requestSignal }),
      ...(options?.onRequestStreamEnd === undefined ? {} : { onRequestStreamEnd: options.onRequestStreamEnd }),
      ...(options?.headers === undefined ? {} : { headers: options.headers })
    }),
    close: () => http.close(), setProtocolVersion: (version) => http.setProtocolVersion(version) };
  http.onmessage = (message) => connection.onmessage?.(message);
  http.onerror = (error) => connection.onerror?.(error); http.onclose = () => connection.onclose?.();
  const [peer, upstream] = InMemoryTransport.createLinkedPair();
  const proxy = await startSharedStdio({ stdio: upstream, port: runtime.port, control, onError() {} });
  const stdio = new Client({ name: "request-size-stdio-client", version: "1" });
  try {
    await client.connect(connection); await stdio.connect(peer);
    for (const size of [maximum - 1, maximum]) {
      targetSize = size;
      expect((await client.callTool({ name: "fixture.consume", arguments: { text: String(size) } })).isError).not.toBe(true);
    }
    targetSize = maximum + 1;
    await expect(client.callTool({ name: "fixture.consume", arguments: { text: "must-not-be-admitted" } }))
      .rejects.toMatchObject({ status: 413, message: expect.stringContaining("Payload Too Large") });
    expect(sizes).toEqual([maximum - 1, maximum, maximum + 1]);
    await expect(stdio.callTool({ name: "fixture.consume", arguments: { text: "must-not-be-admitted" },
      _meta: { hostWrapping: "資料" + "x".repeat(maximum) } }))
      .rejects.toMatchObject({ code: 413, message: expect.stringContaining("Payload Too Large") });
    expect(admitted).toEqual([String(maximum - 1), String(maximum)]);
    expect((await stdio.callTool({ name: "fixture.consume", arguments: { text: "after-rejection" } })).isError).not.toBe(true);
    expect(admitted).toEqual([String(maximum - 1), String(maximum), "after-rejection"]);
  } finally { await stdio.close(); await proxy.close(); await client.close(); await runtime.close(); }
});

it("preserves a valid external proposal larger than the card/HTTP body limit over authenticated MCP", async () => {
  const control: ControlIdentity = { key: randomBytes(32).toString("base64url"), databaseId: "1".repeat(64), configurationId: "2".repeat(64) };
  const f = await walletWorkflowFixture();
  const { activity: activityStore, sessions, cards } = f;
  const handler = createInternalMcpHandler(() => {
    const server = new McpServer({ name: "proposal-transport-fixture", version: "1" });
    registerActionTools(server, { sessions, activityStore, cards: { store: cards }, logger });
    return server;
  });
  const runtime = await startSharedServer({ port: 0, control, onError: () => {}, createApplication: async () => ({
    handleMcp: (request, response) => f.run(() => handler.handle(request, response)), handleHttp: async (_request, response) => { response.writeHead(404).end(); }, close: handler.close
  }) });
  const client = new Client({ name: "proposal-transport-test", version: "1" }, { capabilities: { extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } } } });
  const [clientTransport, proxyTransport] = InMemoryTransport.createLinkedPair();
  const proxy = await startSharedStdio({ stdio: proxyTransport, port: runtime.port, control, onError: () => {} });
  try {
    await client.connect(clientTransport);
    const proposal = externalProposalSchema.parse({ type: "sui_action", id: "large-structured-proposal", source: { kind: "user", name: "Test input" },
      network: "sui:mainnet", createdAt: "2026-09-22T00:00:00.000Z", purpose: "Structured proposal transport test",
      assumptions: Array.from({ length: 20 }, () => "가".repeat(512)), requiredUserChoices: Array.from({ length: 20 }, () => "나".repeat(512)),
      action: { actionKind: "inspection", target: { label: "Untrusted target" }, assetFlow: Array.from({ length: 20 }, () => ({ direction: "outgoing", amount: { amountDisplay: "1", symbol: "SUI" }, description: "다".repeat(512) })) }
    });
    expect(Buffer.byteLength(JSON.stringify(proposal))).toBeGreaterThan(MAX_JSON_BODY_BYTES);
    const result = await client.callTool({ name: TOOL_NAMES.actionCreateProposalReview, arguments: { proposal } });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain("proposal_review_only");
    expect(JSON.stringify(result.structuredContent)).not.toContain('"transactionBytes":');
  } finally { await client.close(); await proxy.close(); await runtime.close(); f.close(); }
});

it("preserves MCP discovery, completions and private results across clients and owner replacement without replay", async () => {
  const control: ControlIdentity = { key: randomBytes(32).toString("base64url"), databaseId: "1".repeat(64), configurationId: "2".repeat(64) };
  const calls: Array<{ owner: string; caller: string | undefined; hold: boolean }> = [];
  let dispatched!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { dispatched = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  async function startOwner(port: number, id: string) {
    const handler = createInternalMcpHandler(() => {
      const server = new McpServer({ name: "shared-transport-fixture", version: "1" });
      registerMcpPrompts(server, ADAPTER_PROMPT_SURFACES);
      server.registerResource("fixture", "fixture://state", {}, async () => ({ contents: [{ uri: "fixture://state", text: id }] }));
      server.registerTool("fixture.call", { inputSchema: { hold: z.boolean() } }, async ({ hold }) => {
        calls.push({ owner: id, caller: server.server.getClientVersion()?.name, hold });
        if (hold) { dispatched(); await held; }
        return { content: [{ type: "text", text: id }], structuredContent: { owner: id }, _meta: { privateSentinel: "view-only" } };
      });
      return server;
    });
    return startSharedServer({ port, control, onError: () => {}, createApplication: async () => ({
      handleMcp: handler.handle, handleHttp: async (_request, response) => { response.writeHead(404).end(); }, close: handler.close
    }) });
  }
  const first = await startOwner(0, "first");
  let second: Awaited<ReturnType<typeof startOwner>> | undefined;
  const bridges: Awaited<ReturnType<typeof startSharedStdio>>[] = [];
  const clients: Client[] = [];
  try {
    for (const name of ["client-a", "client-b"]) {
      const [clientTransport, proxyTransport] = InMemoryTransport.createLinkedPair();
      bridges.push(await startSharedStdio({ stdio: proxyTransport, port: first.port, control, onError: () => {} }));
      const client = new Client({ name, version: "1" }); clients.push(client);
      await client.connect(clientTransport);
    }
    const [a, b] = clients as [Client, Client];
    expect((await a.listTools()).tools.map((tool) => tool.name)).toEqual(["fixture.call"]);
    expect((await a.listResources()).resources.map((resource) => resource.uri)).toEqual(["fixture://state"]);
    expect((await a.listResourceTemplates()).resourceTemplates).toEqual([]);
    expect((await a.readResource({ uri: "fixture://state" })).contents).toEqual([{ uri: "fixture://state", text: "first" }]);
    expect((await a.listPrompts()).prompts.some((prompt) => prompt.name === "swap")).toBe(true);
    expect(JSON.stringify(await a.getPrompt({ name: "swap", arguments: { intent: "10 sui to usdc" } }))).toContain("action_start_review");
    expect((await a.complete({ ref: { type: "ref/prompt", name: "swap" }, argument: { name: "intent", value: "" } })).completion.values).toEqual(["10 sui to usdc", "10 수이 usdc로 환전"]);
    const result = await b.callTool({ name: "fixture.call", arguments: { hold: false } });
    expect(result.structuredContent).toEqual({ owner: "first" });
    expect(result._meta).toEqual({ privateSentinel: "view-only" });
    const inFlight = a.callTool({ name: "fixture.call", arguments: { hold: true } })
      .then(() => "unexpected-success", () => "connection-failed");
    await started;
    await first.close();
    expect(await inFlight).toBe("connection-failed");
    second = await startOwner(first.port, "second");
    expect((await b.callTool({ name: "fixture.call", arguments: { hold: false } })).structuredContent).toEqual({ owner: "second" });
    release();
    expect(calls).toEqual([
      { owner: "first", caller: "client-b", hold: false },
      { owner: "first", caller: "client-a", hold: true },
      { owner: "second", caller: "client-b", hold: false }
    ]);
  } finally {
    release();
    await Promise.all(clients.map((client) => client.close()));
    await Promise.all(bridges.map((bridge) => bridge.close()));
    await second?.close(); await first.close();
  }
});
