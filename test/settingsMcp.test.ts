import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SuiEndpointError } from "../src/core/suiEndpoint.js";
import { registerReadCards } from "../src/mcp-ui/tools.js";
import { registerSettingsTools } from "../src/mcp/tools/settings/index.js";
import { CARD_METADATA_KEY, CARD_RESOURCE_PREFIX, CARD_TOOLS, SETTINGS_FILE_METADATA_KEY, cardSnapshotSchema } from "../src/mcp-ui/contracts.js";
import { TOOL_NAMES } from "../src/mcp/toolNames.js";
import type { SettingsView } from "../src/core/session/settingsOperation.js";
import type { SettingsFileDisplay } from "../src/mcp-ui/contracts.js";
import type { CallToolResult, ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { settingsWorkflowFixture } from "./fixtures/settingsWorkflow.js";
import { deferred } from "./fixtures/walletWorkflow.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(ui = true, options: Parameters<typeof settingsWorkflowFixture>[0] = {}, clientOptions?: { name: string; capabilities: ClientCapabilities }) {
  const f = await settingsWorkflowFixture(options);
  const server = new McpServer({ name: "settings-fixture", version: "1" });
  const deps = { cards: { store: f.cards }, activityStore: f.wallet.activity, workflow: f.wallet.workflow,
    localSettings: f.localSettings, sessions: f.wallet.sessions, logger: f.wallet.logger };
  registerReadCards(server, deps);
  registerSettingsTools(server, deps);
  const client = new Client({ name: clientOptions?.name ?? "settings-ui-fixture", version: "1" }, { capabilities: clientOptions?.capabilities ?? (ui ? { extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } } } : {}) });
  const [transport, peer] = InMemoryTransport.createLinkedPair();
  const outgoing: unknown[] = [];
  const send = peer.send.bind(peer);
  peer.send = async (message, options) => { outgoing.push(message); await send(message, options); };
  await f.wallet.run(() => server.connect(peer)); await client.connect(transport);
  cleanup.push(async () => { await client.close(); await server.close(); await f.close(); });
  const call = (name: string, argumentsValue: Record<string, unknown>) => f.wallet.run(() => client.callTool({ name, arguments: argumentsValue })) as Promise<CallToolResult>;
  return { ...f, client, outgoing, call };
}
function card(result: CallToolResult) {
  const payload = result.structuredContent as { ok: boolean; data: unknown };
  expect(payload.ok).toBe(true); return cardSnapshotSchema.parse(payload.data);
}
function packet(result: CallToolResult) {
  const text = result.content.find((item) => item.type === "text");
  return (result.structuredContent ?? JSON.parse(text?.type === "text" ? text.text : "null")) as {
    ok: boolean; data?: unknown; error: { kind: string; details: { code?: string; reason?: string; snapshot?: unknown } }
  };
}

async function workflowClient(f: Awaited<ReturnType<typeof fixture>>) {
  const created = await f.call(TOOL_NAMES.settingsCreateLocalSettingsSession, {});
  const reference = created._meta![CARD_METADATA_KEY] as { cardId: string; permission: string };
  let snapshot = card(created);
  return { reference, get snapshot() { return snapshot; },
    async act(input: Record<string, unknown>, permission = reference.permission) {
      const result = await f.call(CARD_TOOLS.act, { ...reference, permission, revision: snapshot.revision, input });
      const payload = packet(result), next = payload.ok ? payload.data : payload.error.details.snapshot;
      if (next) snapshot = cardSnapshotSchema.parse(next);
      return result;
    } };
}

it.each(["signature", "lookup"] as const)("opens and reads Settings through authenticated MCP during a foreign %s deadline-write refusal", async (deadline) => {
  const f = await fixture(), w = f.wallet, signature = deferred<Awaited<ReturnType<typeof w.sign>>>();
  const db = new Database(join(w.directory, "activity.sqlite")); cleanup.push(async () => { db.close(); });
  let held = false;
  try {
    const { connection } = await w.approve(), ready = await w.prepare(connection.connectionId);
    if (deadline === "signature") { held = true; w.sign.mockImplementationOnce(() => signature.promise); }
    else w.chainRead.mockRejectedValue(Object.assign(new Error("Synthetic missing receipt"), { name: "TimeoutError" }));
    await w.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: w.account,
      reviewRevision: ready.session.reviewRevision });
    await vi.waitFor(() => {
      const request = w.run(() => w.records.currentRequest(ready.session.id))!;
      expect(request.requestStatus).toBe(deadline === "signature" ? "awaiting_signature" : "awaiting_chain_result");
      expect(w.run(() => w.records.authority(request.attemptId))).toMatchObject({ sdk_pending: deadline === "signature" ? 1 : 0, submit_pending: 0, lookup_pending: 0 });
    });
    const existing = await workflowClient(f), request = w.run(() => w.records.currentRequest(ready.session.id))!;
    const authority = w.run(() => w.records.authority(request.attemptId))!;
    w.advance(Date.parse(deadline === "signature" ? authority.signature_deadline : authority.lookup_deadline!) - w.now().getTime());
    db.exec(`CREATE TRIGGER refuse_mcp_foreign_deadline BEFORE UPDATE OF request_status ON review_requests
      WHEN OLD.attempt_id='${request.attemptId.replaceAll("'", "''")}' BEGIN SELECT RAISE(ABORT,'MCP foreign deadline refused'); END`);
    expect(() => w.run(() => w.workflow.reconcileConnectionContext())).toThrow("MCP foreign deadline refused");
    const before = w.run(() => ({ request: w.records.request(request.attemptId), authority: w.records.authority(request.attemptId) }));
    for (const value of [await f.call(CARD_TOOLS.read, existing.reference), await f.call(TOOL_NAMES.settingsCreateLocalSettingsSession, {})]) {
      expect(packet(value).ok).toBe(true);
      expect((card(value).data as SettingsView).facts).toMatchObject({ walletAvailability: { status: "available" },
        assetReadAccount: { status: "available", account: w.account }, counts: { outcomeUnknownRequests: 0 } });
    }
    expect(w.run(() => ({ request: w.records.request(request.attemptId), authority: w.records.authority(request.attemptId) }))).toEqual(before);
    db.exec("DROP TRIGGER refuse_mcp_foreign_deadline"); w.run(() => w.workflow.reconcileConnectionContext());
    expect(w.run(() => w.records.request(request.attemptId)?.requestStatus)).toBe(deadline === "signature" ? "request_failed" : "outcome_unknown");
    if (held) { signature.reject(new Error("Synthetic signing ended")); held = false;
      await vi.waitFor(() => expect(w.run(() => w.records.authority(request.attemptId)?.sdk_pending)).toBe(0)); }
    expect(w.connect).toHaveBeenCalledOnce(); expect(w.sign).toHaveBeenCalledOnce();
    expect(w.submit).toHaveBeenCalledTimes(deadline === "signature" ? 0 : 1);
  } finally { db.exec("DROP TRIGGER IF EXISTS refuse_mcp_foreign_deadline"); if (held) signature.reject(new Error("Synthetic signing teardown")); }
});

it("keeps authenticated endpoint validation local, rejects credentials before publication, and allows a new explicit confirmation", async () => {
  let verified = false;
  const verify = vi.fn(async () => { if (!verified) throw new SuiEndpointError("chain_identifier_mismatch", "PRIVATE_DIAGNOSTIC", { credential: "PRIVATE_CREDENTIAL" }); });
  const f = await fixture(true, { verifyEndpoint: verify }), ui = await workflowClient(f);
  const denied = await ui.act({ action: "settings_select", draft: { kind: "set_endpoint", endpoint: "grpc", value: "not-a-url" } }, "wrong");
  expect(packet(denied).error.details).not.toHaveProperty("snapshot");
  expect(JSON.stringify(denied)).not.toContain("endpoint URL is invalid");
  for (const value of ["not-a-url", "https://PRIVATE_CREDENTIAL@example.invalid:443"]) {
    const error = await ui.act({ action: "settings_select", draft: { kind: "set_endpoint", endpoint: "grpc", value } });
    expect(packet(error).error).toMatchObject({ kind: "input_invalid", details: { code: "invalid_card_input", snapshot: { data: { phase: "draft" } } } });
    expect(JSON.stringify(error)).not.toContain("PRIVATE_CREDENTIAL");
    expect((ui.snapshot.data as SettingsView).draft).toBeUndefined();
  }
  const value = "https://mainnet.example:9443";
  await ui.act({ action: "settings_select", draft: { kind: "set_endpoint", endpoint: "grpc", value } });
  const operationId = (ui.snapshot.data as SettingsView).operationId;
  await ui.act({ action: "settings_prepare", operationId });
  const error = await ui.act({ action: "settings_confirm", operationId, preparationId: (ui.snapshot.data as SettingsView).preparationId });
  expect(packet(error).error).toMatchObject({ kind: "input_invalid", details: { code: "invalid_card_input", snapshot: { data: { phase: "prepared" } } } });
  expect(JSON.stringify(error)).toContain("did not confirm Sui mainnet");
  expect(JSON.stringify(error)).not.toMatch(/PRIVATE_DIAGNOSTIC|PRIVATE_CREDENTIAL|stack/);
  expect(f.wallet.run(() => f.records.control().active_operation_id)).toBeNull();
  expect(f.wallet.run(() => f.wallet.cardRecords.get(ui.reference.cardId)?.acceptedInput)).toBeUndefined();
  const oldId = (ui.snapshot.data as SettingsView).preparationId;
  verified = true;
  await ui.act({ action: "settings_back", operationId });
  await ui.act({ action: "settings_prepare", operationId });
  expect((ui.snapshot.data as SettingsView).preparationId).not.toBe(oldId);
  expect((await ui.act({ action: "settings_confirm", operationId, preparationId: (ui.snapshot.data as SettingsView).preparationId })).isError).not.toBe(true);
  expect((ui.snapshot.data as SettingsView).result).toMatchObject({ outcome: "completed", details: { storedValue: value } });
  expect(verify).toHaveBeenCalledTimes(2); expect(f.wallet.sign).not.toHaveBeenCalled();
});

it.each([
  { name: "JSON", bytes: Buffer.from("{"), message: "incomplete or incorrectly formatted" },
  { name: "UTF-8", bytes: Buffer.from([0xc3, 0x28]), message: "text that Sui MCP cannot read" },
  { name: "backup shape", bytes: Buffer.from("{}"), message: "not a supported Sui MCP backup" }
])("returns a current card for invalid $name and permits an explicit replacement upload", async ({ bytes, message }) => {
  const f = await fixture(), ui = await workflowClient(f);
  const upload = async (data: Buffer) => {
    await ui.act({ action: "settings_select", draft: { kind: "import_local_data" } });
    const operationId = (ui.snapshot.data as SettingsView).operationId;
    await ui.act({ action: "settings_begin_upload", operationId, name: "backup.json", totalSize: data.length, sha256: createHash("sha256").update(data).digest("hex") });
    const fileId = (ui.snapshot.data as SettingsView).file!.fileId;
    await ui.act({ action: "settings_upload_chunk", operationId, fileId, offset: 0, chunkBase64: data.toString("base64") });
    await ui.act({ action: "settings_seal_upload", operationId, fileId });
    return { operationId, fileId };
  };
  const prior = await upload(bytes);
  expect((ui.snapshot.data as SettingsView).restoreCheck).toMatchObject({ status: "cannot_restore", reason: "invalid_backup",
    message: expect.stringContaining(message) });
  expect((ui.snapshot.data as SettingsView).allowedActions).not.toContain("settings_confirm");
  expect((ui.snapshot.data as SettingsView).allowedActions).toContain("settings_select");
  expect(f.wallet.run(() => f.records.control())).toMatchObject({ data_epoch: 0, active_operation_id: null });
  const good = Buffer.from(JSON.stringify(await f.wallet.run(() => f.localData.exportLocalData())));
  const next = await upload(good);
  expect(next.fileId).not.toBe(prior.fileId);
  expect(f.wallet.run(() => f.records.file(prior.fileId))).toMatchObject({ invalidated: true, cleanup: "complete" });
  expect(ui.snapshot.data as SettingsView).toMatchObject({ phase: "prepared", restoreCheck: { status: "can_restore" } });
  expect(f.wallet.sign).not.toHaveBeenCalled();
});

it("does not disguise physical file or SQLite result failures as validation or success", async () => {
  const f = await fixture(), ui = await workflowClient(f);
  await ui.act({ action: "settings_select", draft: { kind: "import_local_data" } });
  const operationId = (ui.snapshot.data as SettingsView).operationId, bytes = Buffer.from(JSON.stringify(await f.wallet.run(() => f.localData.exportLocalData())));
  await ui.act({ action: "settings_begin_upload", operationId, name: "backup.json", totalSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  const fileId = (ui.snapshot.data as SettingsView).file!.fileId;
  await ui.act({ action: "settings_upload_chunk", operationId, fileId, offset: 0, chunkBase64: bytes.toString("base64") });
  await ui.act({ action: "settings_seal_upload", operationId, fileId });
  expect((ui.snapshot.data as SettingsView).restoreCheck).toEqual({ status: "can_restore" });
  await ui.act({ action: "settings_back", operationId });
  await unlink(join(f.wallet.directory, ".settings-staging", `${fileId}.upload`));
  const missing = await ui.act({ action: "settings_prepare", operationId });
  expect(missing.isError).not.toBe(true);
  expect((ui.snapshot.data as SettingsView).restoreCheck).toMatchObject({ status: "cannot_restore", reason: "file_unavailable" });
  expect((ui.snapshot.data as SettingsView).allowedActions).not.toContain("settings_confirm");
  expect(JSON.stringify(missing)).not.toMatch(/ENOENT|\.settings-staging/);
  await ui.act({ action: "settings_select", draft: { kind: "set_endpoint", endpoint: "grpc", value: "https://mainnet.example:9443" } });
  await ui.act({ action: "settings_prepare", operationId });
  const db = new Database(join(f.wallet.directory, "activity.sqlite")); cleanup.push(async () => { db.close(); });
  db.exec("CREATE TRIGGER reject_result BEFORE UPDATE ON settings_operations WHEN NEW.phase='terminal' BEGIN SELECT RAISE(ABORT,'PRIVATE_STORAGE_DIAGNOSTIC'); END");
  const error = await ui.act({ action: "settings_confirm", operationId, preparationId: (ui.snapshot.data as SettingsView).preparationId });
  expect(packet(error).error.kind).toBe("internal_error");
  expect(JSON.stringify(error)).not.toContain("PRIVATE_STORAGE_DIAGNOSTIC");
  expect(f.wallet.run(() => f.records.get(operationId)?.result)).toBeUndefined();
  expect(f.wallet.run(() => f.records.control().active_operation_id)).toBeNull();
  expect((await f.wallet.run(() => f.localSettings.getLocalSettings())).suiGrpcUrl.storedValue).toBe("https://fullnode.mainnet.sui.io:443");
});

it("preserves the Settings gateway name, creates only draft input, and keeps file and action tools app-only", async () => {
  const f = await fixture();
  const created = await f.call(TOOL_NAMES.settingsCreateLocalSettingsSession, {});
  expect(card(created)).toMatchObject({ kind: "settings", state: "ready", data: { phase: "draft" } });
  expect(JSON.stringify(created.structuredContent)).not.toMatch(/settingsUrl|system_browser|permission/);
  expect(f.wallet.connect).not.toHaveBeenCalled(); expect(f.wallet.sign).not.toHaveBeenCalled();
  const tools = (await f.client.listTools()).tools;
  expect(tools.find((item) => item.name === CARD_TOOLS.act)?._meta).toMatchObject({ ui: { visibility: ["app"] } });
  expect(tools.find((item) => item.name === CARD_TOOLS.readSettingsFile)?._meta).toMatchObject({ ui: { visibility: ["app"] } });
  expect(tools.some((item) => item.name === "settings.open_settings")).toBe(false);
  const reference = created._meta![CARD_METADATA_KEY] as { cardId: string; permission: string };
  const saved = await f.wallet.run(() => f.client.readResource({ uri: `${CARD_RESOURCE_PREFIX}${reference.cardId}` }));
  expect(JSON.stringify(saved)).not.toContain(reference.permission);
  const denied = await f.call(CARD_TOOLS.act, { ...reference, permission: "wrong", revision: card(created).revision,
    input: { action: "settings_select", draft: { kind: "reset_local_data" } } });
  expect(denied.isError).toBe(true);
  expect((await f.read({ snapshot: card(created), permission: reference.permission })).snapshot.state).toBe("ready");
});

it("does not fall back to an external Settings URL when the host has no card capability", async () => {
  const f = await fixture(false);
  const result = await f.call(TOOL_NAMES.settingsCreateLocalSettingsSession, {});
  expect(result.isError).toBe(true); expect(result.structuredContent).toBeUndefined();
  expect(JSON.stringify(result)).toContain("ui_unavailable"); expect(result._meta).toBeUndefined();
});

it("preserves the 16 MiB raw upload limit at the new app-only entry without creating an oversized file", async () => {
  const f = await fixture(), ui = await workflowClient(f);
  await ui.act({ action: "settings_select", draft: { kind: "import_local_data" } });
  const operationId = (ui.snapshot.data as SettingsView).operationId;
  const maximum = 16 * 1024 * 1024;
  expect((await ui.act({ action: "settings_begin_upload", operationId, name: "backup.json", totalSize: maximum, sha256: "0".repeat(64) })).isError).not.toBe(true);
  const fileId = (ui.snapshot.data as SettingsView).file!.fileId;
  expect((ui.snapshot.data as SettingsView).file).toMatchObject({ totalSize: maximum, receivedSize: 0 });
  // This violates the outer MCP schema, so the SDK response is not the
  // authenticated domain-error JSON that workflowClient consumes.
  const oversized = await f.call(CARD_TOOLS.act, { ...ui.reference, revision: ui.snapshot.revision,
    input: { action: "settings_begin_upload", operationId, name: "oversized.json", totalSize: maximum + 1, sha256: "0".repeat(64) } });
  expect(oversized.isError).toBe(true);
  expect(f.wallet.run(() => f.records.get(operationId)!.fileId)).toBe(fileId);
  expect(f.wallet.run(() => f.records.control())).toMatchObject({ file_io_id: null, active_operation_id: null });
});

it("transfers backup bytes only in UI metadata and keeps every actual serialized response within 64 KiB", async () => {
  const f = await fixture();
  // Enough real account history to require more than one encoded response.
  for (let id = 1; id <= 350; id++) await f.wallet.run(() => f.wallet.activity.setActiveAccount(`0x${id.toString(16).padStart(64, "0")}`, "wallet_connection", f.wallet.now()));
  const prepared = await f.create(); await f.download(prepared);
  let completed = await f.read(prepared);
  await vi.waitFor(async () => { completed = await f.read(prepared); expect((completed.snapshot.data as SettingsView).result?.outcome).toBe("completed"); });
  const file = (completed.snapshot.data as SettingsView).file!, target = { cardId: completed.snapshot.cardId, permission: completed.permission,
    operationId: (completed.snapshot.data as SettingsView).operationId, fileId: file.fileId,
    attemptId: (completed.snapshot.data as SettingsView).download!.currentAttemptId };
  const chunks: Buffer[] = []; let offset = 0;
  while (offset < file.totalSize) {
    const response = await f.call(CARD_TOOLS.readSettingsFile, { ...target, offset });
    expect(response.isError).not.toBe(true);
    const value = response._meta![SETTINGS_FILE_METADATA_KEY] as SettingsFileDisplay;
    expect(value).toMatchObject({ cardId: target.cardId, operationId: target.operationId, fileId: file.fileId, offset, sha256: file.sha256 });
    expect(JSON.stringify(response.content)).not.toContain(value.chunkBase64);
    expect(JSON.stringify(response.structuredContent)).not.toContain(value.chunkBase64);
    const chunk = Buffer.from(value.chunkBase64, "base64"); expect(chunk.length).toBeGreaterThan(0);
    chunks.push(chunk); offset += chunk.length;
  }
  const assembled = Buffer.concat(chunks);
  expect(chunks.length).toBeGreaterThan(1);
  expect(createHash("sha256").update(assembled).digest("hex")).toBe(file.sha256);
  const path = join(f.wallet.directory, ".settings-staging", `${file.fileId}.download`);
  expect(assembled).toEqual(await readFile(path));
  const responses = f.outgoing.filter((value) => value && typeof value === "object" && "result" in value &&
    (value as { result?: CallToolResult }).result?._meta?.[SETTINGS_FILE_METADATA_KEY] !== undefined);
  expect(responses.length).toBe(chunks.length);
  for (const response of responses) expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(65536);
  expect((await f.call(CARD_TOOLS.readSettingsFile, { ...target, permission: "wrong", offset: 0 })).isError).toBe(true);
  expect((await f.call(CARD_TOOLS.readSettingsFile, { ...target, operationId: "00000000-0000-4000-8000-000000000000", offset: 0 })).isError).toBe(true);
});


it.each(["codex-mcp-client", "claude-ai", "Arbitrary standard client"])(
  "keeps Settings card authority tied to UI capability rather than client name (%s)", async (name) => {
    for (const advertised of [true, false]) {
      const f = await fixture(false, {}, { name, capabilities: advertised ? { extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } } } : {} });
      const create = vi.spyOn(f.cards, "create");
      const response = await f.call(TOOL_NAMES.settingsCreateLocalSettingsSession, {});
      if (advertised) {
        expect(card(response)).toMatchObject({ kind: "settings", state: "ready", data: { phase: "draft" } });
        expect(response._meta?.[CARD_METADATA_KEY]).toMatchObject({ cardId: card(response).cardId, permission: expect.any(String) });
        expect(create).toHaveBeenCalledOnce();
      } else {
        expect(packet(response)).toMatchObject({ ok: false, error: { kind: "ui_unavailable" } });
        expect(response._meta).toBeUndefined(); expect(create).not.toHaveBeenCalled();
      }
      expect(f.wallet.sign).not.toHaveBeenCalled(); expect(f.wallet.submit).not.toHaveBeenCalled();
      expect(f.wallet.connect).not.toHaveBeenCalled();
    }
  }
);
