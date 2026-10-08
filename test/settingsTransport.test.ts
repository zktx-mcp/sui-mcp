import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { expect, it, vi } from "vitest";
import { startSharedServer } from "../src/runtime/shared/server.js";
import { startSharedStdio } from "../src/runtime/shared/stdio.js";
import { createInternalMcpHandler } from "../src/runtime/shared/mcpHttp.js";
import { createAuthenticatedFetch } from "../src/runtime/shared/authenticatedFetch.js";
import { INTERNAL_MCP_PATH } from "../src/runtime/shared/control.js";
import { settingsWorkflowFixture } from "./fixtures/settingsWorkflow.js";
import { registerReadCards } from "../src/mcp-ui/tools.js";
import { registerSettingsTools } from "../src/mcp/tools/settings/index.js";
import { CARD_TOOLS, CARD_METADATA_KEY, cardSnapshotSchema } from "../src/mcp-ui/contracts.js";
import { TOOL_NAMES } from "../src/mcp/toolNames.js";
import { uploadSettingsFile } from "../src/mcp-ui/view/settingsFiles.js";
import type { SettingsViewTransport } from "../src/mcp-ui/view/lifecycle.js";
import type { SettingsView } from "../src/core/session/settingsOperation.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

async function fixture() {
  const f = await settingsWorkflowFixture(), control = { key: randomBytes(32).toString("base64url"), databaseId: "1".repeat(64), configurationId: "2".repeat(64) };
  const act = vi.spyOn(f.cards, "act");
  const handler = createInternalMcpHandler(() => {
    const server = new McpServer({ name: "settings-wire-fixture", version: "1" });
    const deps = { cards: { store: f.cards }, activityStore: f.wallet.activity, workflow: f.wallet.workflow,
      localSettings: f.localSettings, sessions: f.wallet.sessions, logger: f.wallet.logger };
    registerReadCards(server, deps); registerSettingsTools(server, deps); return server;
  });
  const runtime = await startSharedServer({ port: 0, control, onError() {}, createApplication: async () => ({
    handleMcp: (request, response) => f.wallet.run(() => handler.handle(request, response)),
    handleHttp: async (_request, response) => { response.writeHead(404).end(); }, close: handler.close }) });
  const capabilities = { extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } } };
  const client = new Client({ name: "settings-wire-client", version: "1" }, { capabilities });
  let targetSize: number | undefined, hostPadding = "";
  const bodies: string[] = [];
  const authenticated = createAuthenticatedFetch(runtime.port, control);
  const http = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${runtime.port}${INTERNAL_MCP_PATH}`), { fetch: async (url, init) => {
    if (typeof init?.body === "string") {
      const message = JSON.parse(init.body);
      if (message.method === "tools/call" && message.params.name === CARD_TOOLS.act && message.params.arguments.input.action === "settings_upload_chunk") {
        message.params._meta = { hostWrapping: "資料" + hostPadding };
        if (targetSize !== undefined) {
          const missing = targetSize - Buffer.byteLength(JSON.stringify(message));
          if (missing < 0) throw new Error("Wire-size fixture exceeds its requested boundary before padding");
          message.params._meta.hostWrapping += "x".repeat(missing);
        }
        const body = JSON.stringify(message); bodies.push(body); return authenticated(url, { ...init, body });
      }
    }
    return authenticated(url, init);
  } });
  const httpBridge: Transport = { start: () => http.start(), send: (message, options) => http.send(message, options),
    close: () => http.close(), setProtocolVersion: (version) => http.setProtocolVersion(version) };
  http.onmessage = (message) => httpBridge.onmessage?.(message);
  http.onerror = (error) => httpBridge.onerror?.(error); http.onclose = () => httpBridge.onclose?.();
  await client.connect(httpBridge);
  const [peer, upstream] = InMemoryTransport.createLinkedPair();
  const proxy = await startSharedStdio({ stdio: upstream, port: runtime.port, control, onError() {} });
  const stdio = new Client({ name: "settings-stdio-client", version: "1" }, { capabilities }); await stdio.connect(peer);
  const created = await f.wallet.run(() => client.callTool({ name: TOOL_NAMES.settingsCreateLocalSettingsSession, arguments: {} }));
  const reference = created._meta![CARD_METADATA_KEY] as { cardId: string; permission: string };
  let snapshot = cardSnapshotSchema.parse((created.structuredContent as { data: unknown }).data);
  const update = (result: CallToolResult) => { snapshot = cardSnapshotSchema.parse((result.structuredContent as { data: unknown }).data); return snapshot; };
  const actCard = (input: Record<string, unknown>) => f.wallet.run(async () => update(await client.callTool({ name: CARD_TOOLS.act, arguments: { ...reference, revision: snapshot.revision, input } }) as CallToolResult));
  return { ...f, act, bodies, stdio, reference, get snapshot() { return snapshot; }, actCard,
    setSize(size?: number) { targetSize = size; }, setPadding(value: string) { hostPadding = value; },
    async readCard() { return f.wallet.run(async () => update(await client.callTool({ name: CARD_TOOLS.read, arguments: reference }) as CallToolResult)); },
    async close() { await stdio.close(); await proxy.close(); await client.close(); await runtime.close(); f.close(); } };
}

it("enforces the actual authenticated wire limit before Settings dispatch, including Unicode Host metadata and the stdio proxy", async () => {
  const f = await fixture();
  try {
    await f.actCard({ action: "settings_select", draft: { kind: "import_local_data" } });
    const operationId = (f.snapshot.data as SettingsView).operationId;
    await f.actCard({ action: "settings_begin_upload", operationId, name: "資料.json", totalSize: 3, sha256: "0".repeat(64) });
    const fileId = (f.snapshot.data as SettingsView).file!.fileId;
    const input = { action: "settings_upload_chunk", operationId, fileId, offset: 0, chunkBase64: "YWJj" };
    for (const size of [65535, 65536]) {
      f.setSize(size); await f.actCard(input);
      expect(Buffer.byteLength(f.bodies.at(-1)!)).toBe(size);
      expect(f.wallet.run(() => f.records.file(fileId)?.receivedSize)).toBe(3);
    }
    const count = f.act.mock.calls.length, revision = f.snapshot.revision;
    f.setSize(65537);
    await expect(f.actCard(input)).rejects.toMatchObject({ code: -32600, data: { code: "settings_payload_too_large", maximumMessageSize: 65536 } });
    expect(Buffer.byteLength(f.bodies.at(-1)!)).toBe(65537); expect(f.act).toHaveBeenCalledTimes(count);
    expect(f.wallet.run(() => f.records.file(fileId))).toMatchObject({ receivedSize: 3, sealed: false });
    expect(f.wallet.run(() => f.records.control().active_operation_id)).toBeNull();
    await expect(f.wallet.run(() => f.stdio.callTool({ name: CARD_TOOLS.act, arguments: { ...f.reference, revision,
      input: { ...input, chunkBase64: "A".repeat(65536) } } }))).rejects.toMatchObject({ code: -32600,
        data: { code: "settings_payload_too_large", maximumMessageSize: 65536 } });
    expect(f.act).toHaveBeenCalledTimes(count);
  } finally { await f.close(); }
});

it("lets the actual card upload consumer reduce a rejected chunk at the same file/offset and finish sealing", async () => {
  const f = await fixture();
  try {
    await f.actCard({ action: "settings_select", draft: { kind: "import_local_data" } });
    const operationId = (f.snapshot.data as SettingsView).operationId;
    // Extra external Host framing makes the first 49,000-byte chunk too large.
    // It is measured by the real HTTP handler, not a fabricated budget error.
    f.setPadding("x".repeat(20000));
    const raw = Uint8Array.from({ length: 70001 }, (_, index) => index % 251), file = new File([raw], "資料.json");
    const active: boolean[] = [];
    const transport: SettingsViewTransport = { act: f.actCard, readCurrent: f.readCard, uploadChunkLimit: () => 49000,
      setFileTransferActive: (value: boolean) => { active.push(value); }, canDownload: () => false,
      readFile: async () => { throw new Error("Unexpected download during upload"); },
      download: async () => { throw new Error("Unexpected Host download during upload"); } };
    await uploadSettingsFile(file, transport, () => ({ operationId, cardId: f.snapshot.cardId }), () => true);
    const view = f.snapshot.data as SettingsView;
    expect(view).toMatchObject({ phase: "sealed", file: { totalSize: raw.length, receivedSize: raw.length, sealed: true } });
    expect(active).toEqual([true, false]);
    const sizes = f.bodies.map((body) => Buffer.byteLength(body));
    expect(sizes[0]).toBeGreaterThan(65536); expect(sizes.slice(1).every((size) => size <= 65536)).toBe(true);
    const sent = f.bodies.map((body) => JSON.parse(body).params.arguments.input);
    expect(sent[0].fileId).toBe(view.file!.fileId); expect(sent[1]).toMatchObject({ fileId: view.file!.fileId, offset: 0 });
    expect(Buffer.from(sent[1].chunkBase64, "base64").length).toBeLessThan(49000);
    const stored = f.wallet.run(() => f.records.file(view.file!.fileId))!;
    expect(await f.files.readUpload(stored)).toEqual(Buffer.from(raw));
    expect(f.wallet.sign).not.toHaveBeenCalled(); expect(f.wallet.submit).not.toHaveBeenCalled();
  } finally { await f.close(); }
});
