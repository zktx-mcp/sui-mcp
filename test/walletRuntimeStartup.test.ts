import { SERVER_VERSION } from "../src/mcp/serverInfo.js";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { WalletCommand, WalletEvent } from "../src/runtime/walletSdkIpc.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { createRuntimeApplication } from "../src/runtime/application.js";
import { loadBootConfig } from "../src/runtime/config.js";
import { TOOL_NAMES } from "../src/mcp/toolNames.js";
import { CARD_METADATA_KEY, CARD_TOOLS } from "../src/mcp-ui/contracts.js";
import { WALLETCONNECT_PROJECT_ID } from "../src/runtime/walletConnectConfig.js";
import { walletAvailabilitySchema, walletUnavailableReasonSchema } from "../src/core/session/walletConnection.js";
import { SUI_MAINNET_CHAIN_IDENTIFIER } from "../src/runtime/suiEndpoint.js";
import type { ControlIdentity } from "../src/runtime/shared/control.js";
import { seedWalletSdk, walletRelay } from "./fixtures/walletRelay.js";
import { acquireDataDirectoryOwner } from "../src/runtime/shared/ownerLease.js";
import type { WalletSessionObservation } from "../src/core/session/walletRuntime.js";
import type { SettingsView } from "../src/core/session/settingsOperation.js";
import type { UserAnswerUse } from "../src/core/evidence/userAnswerUse.js";
import Database from "better-sqlite3";
import { SqliteActivityStore } from "../src/core/activity/sqliteActivityStore.js";
import { validateSupportedAdapterLifecycle } from "../src/adapters/adapterLifecycleValidators.js";

// Fingerprint of the product owner's approved input, independent of the runtime constant.
const approvedProjectFingerprint = "0878d5895848f26e5631d667db9f5473ebaf875775af53f190467b50f810147d";
const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");

function expectReconciliationAnswer(data: { connectionReconciliationRequired?: true; userAnswerUse: UserAnswerUse }, required: boolean) {
  const code = "unrecorded_service_connection_requires_wallet_removal_and_confirmed_absence";
  const guide = data.userAnswerUse;
  if (required) {
    expect(data.connectionReconciliationRequired).toBe(true);
    expect(guide.canAnswer).toContain(code); expect(guide.cannotAnswer).not.toContain(code);
    expect(guide.preconditionFields).toContain("connectionReconciliationRequired");
    expect(guide.answerFields).toContain("connectionReconciliationRequired");
  } else {
    expect(data.connectionReconciliationRequired).toBeUndefined();
    expect(guide.canAnswer).not.toContain(code);
    expect(guide.preconditionFields).not.toContain("connectionReconciliationRequired");
    expect(guide.answerFields).not.toContain("connectionReconciliationRequired");
  }
  expect(guide.preconditionFields).toContain("walletAvailability");
  expect(guide.cannotAnswer).toEqual(expect.arrayContaining([
    "wallet_custody_or_authorization", "sdk_availability_or_recorded_connection_as_account_use_or_signing_authority",
    "last_service_observation_as_live_wallet_app_state", "wallet_unavailability_as_chain_failure_or_lost_stored_result"
  ]));
}

type StartupToolResult = CallToolResult & { structuredContent?: Record<string, unknown> };

const source = vi.hoisted(() => ({ failure: "", init: vi.fn(), connect: vi.fn(), request: vi.fn(),
  exits: 0, realRelay: "", commands: [] as string[], sessions: [] as WalletSessionObservation[], children: [] as ChildProcess[], leases: [] as Array<Mock<() => void>> }));
// The parent, supervisor, SQLite, tools and MCP are real. Only the operating
// system child/IPC is a double here; real child/SDK tests cover that boundary.
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  return { ...actual, fork: () => {
    if (source.realRelay) {
      const child = actual.fork(new URL("./fixtures/walletSdkChild.ts", import.meta.url), [], {
        execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: { ...process.env, FIXTURE_WALLET_RELAY: source.realRelay, FIXTURE_WALLET_SUBSCRIBED_READ: "1" }
      });
      const send = child.send.bind(child);
      child.send = ((message: WalletCommand, callback: (error: Error | null) => void) => {
        source.commands.push(message.type); return send(message, callback);
      }) as ChildProcess["send"];
      source.children.push(child); return child;
    }
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { connected: true, pid: 100, exitCode: null, signalCode: null });
    source.children.push(child);
    child.send = ((message: WalletCommand, callback: (error: Error | null) => void) => {
      source.commands.push(message.type);
      callback(null);
      if (message.type === "check_session") {
        // The external SDK peer answers the actual admission-time check. The
        // parent still validates the run, operation, revision and account.
        const observation = source.sessions.find((item) => item.topic === message.topic) ?? { topic: message.topic, version: 1, status: "absent" as const };
        queueMicrotask(() => child.emit("message", { packageVersion: SERVER_VERSION, runId: message.runId,
          requestId: message.requestId, operationId: message.operationId, type: "checked", observation,
          sequence: 1 /* The unchanged session is from the initial published snapshot. */ } satisfies WalletEvent));
        return true;
      }
      if (message.type !== "init") throw new Error("Unexpected SDK command in startup test");
      void (async () => {
        const envelope = { packageVersion: SERVER_VERSION, runId: message.runId };
        const emit = (event: WalletEvent) => child.emit("message", event);
        if (source.failure === "storage") { emit({ ...envelope, type: "failure", reason: "initialization_failed" }); return; }
        emit({ ...envelope, type: "stage", stage: "sdk_start" });
        try { await source.init({ ...message, logger: "silent", telemetryEnabled: false }); }
        catch { emit({ ...envelope, type: "failure", reason: "initialization_failed" }); return; }
        emit({ ...envelope, type: "stage", stage: "session_restore" });
        if (source.failure === "restore") { emit({ ...envelope, type: "failure", reason: "restoration_failed" }); return; }
        if (source.failure === "hold") return;
        emit({ ...envelope, type: "snapshot", ready: true, snapshot: { runId: message.runId, sequence: 1,
          observedAt: new Date().toISOString(), sessions: source.sessions } });
      })();
      return true;
    }) as ChildProcess["send"];
    child.kill = (() => { queueMicrotask(() => {
      Object.assign(child, { connected: false, signalCode: "SIGKILL" }); source.exits += 1; child.emit("exit", null, "SIGKILL");
    }); return true; }) as ChildProcess["kill"];
    return child;
  } };
});
vi.mock("../src/runtime/suiEndpoint.js", async (original) => {
  const actual = await original<typeof import("../src/runtime/suiEndpoint.js")>();
  const { SuiGrpcClient } = await import("@mysten/sui/grpc");
  return { ...actual, verifyMainnetGrpcEndpoint: async () => ({
    client: new SuiGrpcClient({ network: "mainnet", baseUrl: "https://example.invalid" }),
    chainIdentifier: actual.SUI_MAINNET_CHAIN_IDENTIFIER
  }) };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, readFile: (...args: Parameters<typeof actual.readFile>) => {
    if (source.failure === "metadata" && args[0] instanceof URL && args[0].pathname.endsWith("/package.json")) {
      return Promise.reject(new Error("PRIVATE-METADATA-DETAIL"));
    }
    return actual.readFile(...args);
  } };
});
vi.mock("../src/runtime/shared/ownerLease.js", async (original) => {
  const actual = await original<typeof import("../src/runtime/shared/ownerLease.js")>();
  return { ...actual, acquireDataDirectoryOwner: (path: string) => {
    const lease = actual.acquireDataDirectoryOwner(path), close = vi.fn(lease.close);
    source.leases.push(close); return { close };
  } };
});
// Replace only HTTP transport plumbing. The runtime factory, database, workflow,
// tool registration and MCP protocol are real, under the runtime's data guard.
vi.mock("../src/runtime/shared/mcpHttp.js", () => ({ createInternalMcpHandler: (factory: () => McpServer) => {
  let client: Client | undefined, server: McpServer | undefined;
  return {
    async handle(request: IncomingMessage, response: ServerResponse) {
      if (!client) {
        server = factory();
        client = new Client({ name: "startup-fixture", version: "1" }, { capabilities: { extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } } } });
        const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
      }
      const call = (request as unknown as { call: { name: string; arguments: Record<string, unknown> } }).call;
      const result = await client.callTool(call);
      const structured = result.structuredContent;
      if (structured !== undefined && (structured === null || typeof structured !== "object" || Array.isArray(structured))) {
        throw new Error("Sui MCP startup results must have object structured content.");
      }
      (response as unknown as { result: unknown }).result = result;
    },
    async close() { await client?.close(); await server?.close(); }
  };
} }));

beforeEach(() => {
  source.init.mockReset(); source.connect.mockReset(); source.request.mockReset(); source.failure = "";
  source.exits = 0;
  source.realRelay = ""; source.children = []; source.commands = []; source.sessions = [];
  source.init.mockImplementation(async () => {
    if (source.failure === "init") throw new Error("PRIVATE-SDK-DETAIL");
  });
});
afterEach(() => {
  for (const close of source.leases.splice(0)) close();
  vi.unstubAllEnvs();
});

it.each([
  { kind: "selected" }, { kind: "cleared" }, { kind: "different_source" }, { kind: "prior_owner" },
  { kind: "terminal", status: "failed" }, { kind: "terminal", status: "stopped" },
  { kind: "expiry", offset: -1 }, { kind: "expiry", offset: 0 }, { kind: "expiry", offset: 1 }
] as const)("publishes production qualification for $kind ($status $offset) without selecting an account", async (input) => {
  // A declared synthetic instant/session/journal; no wallet or mainnet proof.
  const at = new Date("2026-10-06T00:00:00.000Z"), account = `0x${"a".repeat(64)}`;
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(at);
  const directory = mkdtempSync(join(tmpdir(), "sui-production-qualification-"));
  const boot = loadBootConfig({ SUI_MCP_DATA_DIR: directory }), ownerId = "qualification-owner";
  const journal = new SqliteActivityStore({ databasePath: boot.activityDatabasePath, validateAdapterLifecycle: validateSupportedAdapterLifecycle });
  const prior = journal.createWalletWorkflowStore(input.kind === "prior_owner" ? "prior-owner" : ownerId, () => new Date());
  if (input.kind === "prior_owner") prior.setWalletRunId(randomUUID());
  const session = { topic: "qualification-topic", accounts: [account], methods: ["sui_signTransaction"],
    chain: "sui:mainnet" as const, expiresAt: new Date(at.getTime() + 60000).toISOString(), walletName: "Synthetic approved wallet" };
  const saved = prior.restoreConnection(session, at);
  let selectedConnectionId = saved.connection.connectionId;
  if (input.kind === "different_source") {
    const previous = prior.restoreConnection({ ...session, topic: "previous-same-address-topic" }, at);
    prior.updateConnection(previous.connection.connectionId, { status: "disconnected" }, at);
    selectedConnectionId = previous.connection.connectionId;
  }
  if (input.kind !== "cleared") await journal.setActiveAccount(account, "wallet_connection", at,
    { id: selectedConnectionId });
  source.sessions = [{ topic: session.topic, version: 1, status: "present", session }];
  source.failure = "hold";
  const app = await createRuntimeApplication(boot, { info() {}, warn() {}, error() {} }, ownerId);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = {} as { result: StartupToolResult };
    await app.handleMcp({ call: { name, arguments: args } } as unknown as IncomingMessage, response as unknown as ServerResponse);
    const failure = response.result.content.find((part) => part.type === "text");
    expect(response.result.isError, failure?.type === "text" ? failure.text.replace(/[A-Za-z0-9_-]{30,}/g, "[redacted]") : "No error text").not.toBe(true);
    expect(response.result.structuredContent!.ok).toBe(true);
    return response.result;
  };
  try {
    const initializing = await call(TOOL_NAMES.settingsCreateLocalSettingsSession);
    expect((initializing.structuredContent!.data as { data: SettingsView }).data.facts).toMatchObject({
      walletAvailability: { status: "initializing" }, assetReadAccount: { status: "address_required" } });
    const runId = source.init.mock.calls[0]![0].runId as string;
    source.children[0]!.emit("message", { packageVersion: SERVER_VERSION, runId, type: "snapshot", ready: true,
      snapshot: { runId, sequence: 1, observedAt: at.toISOString(), sessions: source.sessions } } satisfies WalletEvent);
    await vi.waitFor(async () => expect((await call(TOOL_NAMES.sessionGetInteractionStatus)).structuredContent!.data)
      .toMatchObject({ walletAvailability: { status: "available", walletRunId: runId } }));
    const records = journal.createWalletWorkflowStore(ownerId, () => new Date());
    expect(records.connection(saved.connection.connectionId)).toMatchObject({ ownerId, runId });
    if (input.kind === "terminal") records.updateConnection(saved.connection.connectionId,
      { status: input.status, reason: "The original synthetic operation did not complete." }, at);
    if (input.kind === "expiry") {
      records.updateConnection(saved.connection.connectionId, { expiresAt: new Date(at.getTime() + 1000).toISOString() }, at);
      vi.setSystemTime(at.getTime() + 1000 + input.offset);
    }
    const storedBefore = journal.getActiveAccountSync();
    // Settings is observed first: current-wallet maintenance cannot fix its input.
    const settings = await call(TOOL_NAMES.settingsCreateLocalSettingsSession);
    const settingsReference = settings._meta![CARD_METADATA_KEY] as Record<string, unknown>;
    const facts = (settings.structuredContent!.data as { data: SettingsView }).data.facts!;
    const available = input.kind === "selected" || input.kind === "prior_owner" || input.kind === "expiry" && input.offset < 0;
    const expected = available ? { status: "available", account } : { status: "address_required" };
    expect(facts.walletAvailability).toMatchObject({ status: "available", walletRunId: runId });
    expect(facts.assetReadAccount).toEqual(expected);
    expect(facts.readAddress).toBe(input.kind === "cleared" ? undefined : account);
    const reread = (await call(CARD_TOOLS.read, settingsReference)).structuredContent!.data as { data: SettingsView };
    expect(reread.data.facts!.assetReadAccount).toEqual(expected);
    expect(reread.data.facts!.walletAvailability).toMatchObject({ status: "available", walletRunId: runId });
    expect(reread.data.facts!.readAddress).toBe(input.kind === "cleared" ? undefined : account);
    const connect = (await call(TOOL_NAMES.sessionCreateWalletConnection, { intent: "manage" })).structuredContent!.data as { data: Record<string, any> };
    expect(connect.data.assetReadAccount).toEqual(expected);
    expect(connect.data.usableConnectionId).toBe(input.kind === "terminal" || input.kind === "expiry" && input.offset >= 0
      ? undefined : saved.connection.connectionId);
    expect(journal.getActiveAccountSync()).toEqual(storedBefore);
    expect(records.connection(saved.connection.connectionId)!.connection.status).toBe(input.kind === "terminal" ? input.status : "connected");
    if (input.kind === "different_source" || input.kind === "cleared") {
      const ref = (await call(TOOL_NAMES.sessionCreateWalletConnection, { intent: "manage" }));
      const card = ref.structuredContent!.data as { revision: number };
      await call(CARD_TOOLS.act, { ...ref._meta![CARD_METADATA_KEY] as object, revision: card.revision,
        input: { action: "use_account", walletRunId: runId, connectionId: saved.connection.connectionId, account } });
      const selected = (await call(TOOL_NAMES.settingsCreateLocalSettingsSession)).structuredContent!.data as { data: SettingsView };
      expect(selected.data.facts!.assetReadAccount).toEqual({ status: "available", account });
      const selectedRead = (await call(CARD_TOOLS.read, settingsReference)).structuredContent!.data as { data: SettingsView };
      expect(selectedRead.data.facts!.assetReadAccount).toEqual({ status: "available", account });
      expect(journal.getActiveAccountSync()).toMatchObject({ address: account, walletId: saved.connection.connectionId });
    }
    expect(source.commands).toEqual(input.kind === "different_source" || input.kind === "cleared" ? ["init", "check_session"] : ["init"]);
  } finally { await app.close(); journal.close(); vi.useRealTimers(); rmSync(directory, { recursive: true, force: true }); }
});

it("publishes production Settings reconciliation facts from the same current connection evaluation without dispatching wallet work", async () => {
  const topic = "unrecorded-startup-session", address = `0x${"a".repeat(64)}`;
  source.sessions = [{ topic, version: 1, status: "present", session: { topic, accounts: [address],
    methods: ["sui_signTransaction"], chain: "sui:mainnet", expiresAt: new Date(Date.now() + 60000).toISOString() } }];
  const directory = mkdtempSync(join(tmpdir(), "sui-settings-current-facts-"));
  const app = await createRuntimeApplication(loadBootConfig({ SUI_MCP_DATA_DIR: directory }), { info() {}, warn() {}, error() {} });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = {} as { result: StartupToolResult };
    await app.handleMcp({ call: { name, arguments: args } } as unknown as IncomingMessage, response as unknown as ServerResponse);
    expect(response.result.isError).not.toBe(true); return response.result;
  };
  try {
    let interaction: Record<string, any> = {};
    await vi.waitFor(async () => {
      interaction = (await call(TOOL_NAMES.sessionGetInteractionStatus)).structuredContent!.data as Record<string, any>;
      expect(interaction.walletAvailability.status).toBe("available"); expect(interaction.connectionReconciliationRequired).toBe(true);
    });
    expectReconciliationAnswer(interaction as { connectionReconciliationRequired?: true; userAnswerUse: UserAnswerUse }, true);
    const created = await call(TOOL_NAMES.settingsCreateLocalSettingsSession);
    const snapshot = created.structuredContent!.data as { data: SettingsView };
    expect(snapshot.data.facts).toMatchObject({ walletAvailability: interaction.walletAvailability,
      connectionReconciliationRequired: true, assetReadAccount: { status: "address_required" } });
    expect(JSON.stringify(created.structuredContent)).not.toContain(topic);
    const reference = created._meta![CARD_METADATA_KEY] as { cardId: string; permission: string };
    await call(CARD_TOOLS.read, reference);
    expect(source.commands).toEqual(["init"]);
    source.children[0]!.emit("message", { packageVersion: SERVER_VERSION, runId: interaction.walletAvailability.walletRunId,
      type: "snapshot", ready: false, snapshot: { runId: interaction.walletAvailability.walletRunId, sequence: 2,
        observedAt: new Date().toISOString(), sessions: [{ topic, version: 2, status: "absent" }] } } satisfies WalletEvent);
    const current = (await call(CARD_TOOLS.read, reference)).structuredContent!.data as { data: SettingsView };
    expect(current.data.facts?.connectionReconciliationRequired).toBeUndefined();
    expect(current.data.facts?.walletAvailability.status).toBe("available");
    const absence = (await call(TOOL_NAMES.sessionGetInteractionStatus)).structuredContent!;
    expect(absence.ok).toBe(true);
    expectReconciliationAnswer(absence.data as { connectionReconciliationRequired?: true; userAnswerUse: UserAnswerUse }, false);
    expect(source.commands).toEqual(["init"]);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

it("keeps ordinary MCP and Settings diagnosis neutral while an observed ready snapshot cannot commit", async () => {
  const topic = "unrecorded-state-sync-session", account = `0x${"b".repeat(64)}`;
  source.sessions = [{ topic, version: 1, status: "present", session: { topic, accounts: [account], methods: ["sui_signTransaction"],
    chain: "sui:mainnet", expiresAt: new Date(Date.now() + 60000).toISOString() } }];
  const directory = mkdtempSync(join(tmpdir(), "sui-state-sync-answer-"));
  const boot = loadBootConfig({ SUI_MCP_DATA_DIR: directory });
  const app = await createRuntimeApplication(boot, { info() {}, warn() {}, error() {} });
  const db = new Database(boot.activityDatabasePath);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = {} as { result: StartupToolResult };
    await app.handleMcp({ call: { name, arguments: args } } as unknown as IncomingMessage, response as unknown as ServerResponse);
    expect(response.result.isError).not.toBe(true); expect(response.result.structuredContent!.ok).toBe(true); return response.result;
  };
  try {
    await vi.waitFor(async () => expect((await call(TOOL_NAMES.sessionGetInteractionStatus)).structuredContent!.data).toMatchObject({ walletAvailability: { status: "available" } }));
    const created = await call(TOOL_NAMES.settingsCreateLocalSettingsSession), reference = created._meta![CARD_METADATA_KEY] as Record<string, unknown>;
    let card = created.structuredContent!.data as { revision: number; data: SettingsView };
    const act = async (input: Record<string, unknown>) => { card = (await call(CARD_TOOLS.act, { ...reference, revision: card.revision, input })).structuredContent!.data as typeof card; };
    await act({ action: "settings_select", draft: { kind: "restart_wallet_service" } });
    await act({ action: "settings_prepare", operationId: card.data.operationId });
    const id = card.data.operationId;
    db.exec(`CREATE TRIGGER refuse_ready_answer BEFORE UPDATE ON settings_operations
      WHEN NEW.operation_id='${id.replaceAll("'", "''")}' AND NEW.phase='terminal'
      BEGIN SELECT RAISE(ABORT,'ready answer result refused'); END`);
    source.failure = "hold";
    await act({ action: "settings_confirm", operationId: id, preparationId: card.data.preparationId });
    let startingRun = "";
    await vi.waitFor(async () => {
      const starting = (await call(TOOL_NAMES.sessionGetInteractionStatus)).structuredContent!.data as Record<string, any>;
      expect(source.children).toHaveLength(2); expect(starting.walletAvailability.status).toBe("initializing");
      startingRun = starting.walletAvailability.walletRunId;
    });
    source.children[1]!.emit("message", { packageVersion: SERVER_VERSION, runId: startingRun, type: "snapshot", ready: true,
      snapshot: { runId: startingRun, sequence: 1, observedAt: new Date().toISOString(), sessions: source.sessions } } satisfies WalletEvent);
    let pending: Record<string, any> = {};
    await vi.waitFor(async () => {
      pending = (await call(TOOL_NAMES.sessionGetInteractionStatus)).structuredContent!.data as Record<string, any>;
      expect(pending.walletAvailability).toMatchObject({ status: "initializing", stage: "state_sync" });
    });
    expectReconciliationAnswer(pending as { connectionReconciliationRequired?: true; userAnswerUse: UserAnswerUse }, false);
    const diagnostic = (await call(TOOL_NAMES.settingsCreateLocalSettingsSession)).structuredContent!.data as { data: SettingsView };
    expect(diagnostic.data.facts).toMatchObject({ walletAvailability: { status: "initializing", stage: "state_sync" }, assetReadAccount: { status: "address_required" } });
    expect(diagnostic.data.facts?.connectionReconciliationRequired).toBeUndefined();
    expect(source.commands).toEqual(["init", "init"]);
    const ownRefused = {} as { result: StartupToolResult };
    await app.handleMcp({ call: { name: CARD_TOOLS.read, arguments: reference } } as unknown as IncomingMessage, ownRefused as unknown as ServerResponse);
    expect(ownRefused.result.isError).toBe(true);
    db.exec("DROP TRIGGER refuse_ready_answer");
    await vi.waitFor(async () => {
      const ready = (await call(TOOL_NAMES.sessionGetInteractionStatus)).structuredContent!.data as Record<string, any>;
      expect(ready.walletAvailability.status).toBe("available");
      expectReconciliationAnswer(ready as { connectionReconciliationRequired?: true; userAnswerUse: UserAnswerUse }, true);
    });
    expect(source.commands).toEqual(["init", "init"]);
  } finally { db.exec("DROP TRIGGER IF EXISTS refuse_ready_answer"); db.close(); await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

it.each([
  { label: "unset environment", failure: "none", project: undefined, initCalls: 1, reason: undefined, message: undefined },
  { label: "invalid environment", failure: "none", project: "not-a-project-id", initCalls: 1, reason: undefined, message: undefined },
  { label: "different environment", failure: "none", project: "1".repeat(32), initCalls: 1, reason: undefined, message: undefined },
  { label: "metadata failure", failure: "metadata", project: undefined, initCalls: 0, reason: "initialization_failed", message: "could not start" },
  { label: "storage failure", failure: "storage", project: undefined, initCalls: 0, reason: "initialization_failed", message: "could not start" },
  { label: "SDK failure", failure: "init", project: undefined, initCalls: 1, reason: "initialization_failed", message: "could not start" },
  { label: "restore failure", failure: "restore", project: undefined, initCalls: 1, reason: "restoration_failed", message: "could not be restored" }
])("handles $label through the real runtime and MCP cards", async ({ failure, project, initCalls, reason, message }) => {
  source.failure = failure; vi.stubEnv("SUI_MCP_WALLETCONNECT_PROJECT_ID", project);
  const directory = mkdtempSync(join(tmpdir(), "say-startup-"));
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const app = await createRuntimeApplication(loadBootConfig({ SUI_MCP_DATA_DIR: directory }), logger);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = {} as { result: StartupToolResult };
    await app.handleMcp({ call: { name, arguments: args } } as unknown as IncomingMessage, response as unknown as ServerResponse);
    return response.result;
  };
  try {
    const created = await call(TOOL_NAMES.sessionCreateWalletConnection);
    expect(source.init).toHaveBeenCalledTimes(initCalls);
    expect(fingerprint(WALLETCONNECT_PROJECT_ID)).toBe(approvedProjectFingerprint);
    if (initCalls) {
      expect(fingerprint(source.init.mock.calls[0]![0].projectId)).toBe(approvedProjectFingerprint);
      expect(source.init.mock.calls[0]![0].metadata).toMatchObject({
        name: "@zktx.io/sui-mcp",
        url: "https://github.com/zktx-mcp/sui-mcp#readme"
      });
    }
    if (message) expect(JSON.stringify(created)).toContain(message);
    expect(created.isError).not.toBe(true);
    const interaction = await call(TOOL_NAMES.sessionGetInteractionStatus);
    const availability = (interaction.structuredContent as { data: { walletAvailability: unknown } }).data.walletAvailability;
    expect(walletAvailabilitySchema.parse(availability)).toMatchObject(reason ? { status: "unavailable", reason } : { status: "available" });
    {
      const card = (created.structuredContent as { data: { cardId: string; revision: number; state: string } }).data;
      expect(card.state).toBe("ready");
      if (message) {
        expect(JSON.stringify(await call(TOOL_NAMES.sessionGetWalletConnection, { cardId: card.cardId }))).toContain(message);
        expect(JSON.stringify(await call(TOOL_NAMES.sessionWaitWalletConnection, { cardId: card.cardId, timeoutMs: 1 }))).toContain(message);
        const ref = created._meta![CARD_METADATA_KEY] as Record<string, unknown>;
        expect(JSON.stringify(await call(CARD_TOOLS.act, { ...ref, revision: card.revision, input: { action: "connect", walletRunId: (availability as { walletRunId: string }).walletRunId } }))).toContain(message);
      }
    }
    expect((await call(TOOL_NAMES.accountGetActiveAccount)).isError).not.toBe(true);
    const receipt = await call(CARD_TOOLS.receipt);
    expect(receipt.isError).not.toBe(true);
    expect(receipt.structuredContent).toEqual({ ok: true, data: { kind: "receipt", status: "input_required", field: "digest", message: "Please provide a transaction hash in chat." } });
    expect(receipt._meta).toBeUndefined();
    expect(source.connect).not.toHaveBeenCalled(); expect(source.request).not.toHaveBeenCalled();
    expect(JSON.stringify([created, logger.error.mock.calls])).not.toContain("PRIVATE-");
    expect(JSON.stringify([created, logger.error.mock.calls]).includes(WALLETCONNECT_PROJECT_ID)).toBe(false);
    if (project) expect(JSON.stringify([created, logger.error.mock.calls])).not.toContain(project);
  } finally {
    await app.close();
    expect(source.leases.at(-1)).toHaveBeenCalledOnce();
    expect(source.exits).toBe(failure === "metadata" ? 0 : 1);
    for (const close of source.leases.splice(0)) close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("uses the same approved project identity for stdio peers regardless of old environment settings", async () => {
  const directory = mkdtempSync(join(tmpdir(), "say-startup-identity-"));
  const controls: ControlIdentity[] = [];
  const processListeners = new Map((["SIGINT", "SIGTERM"] as const).map((event) => [event, new Set(process.listeners(event))]));
  const inputListeners = new Map(["end", "close"].map((event) => [event, new Set(process.stdin.listeners(event))]));
  // Exercise start.ts and real control-key/identity generation. Only ownership
  // acquisition and the stdio bridge are replaced; no relay or port is opened.
  vi.doMock("../src/runtime/reviewServerAcquire.js", () => ({
    startOrDeferReviewServer: async () => ({ deferred: true, close: async () => {} })
  }));
  vi.doMock("../src/runtime/shared/stdio.js", () => ({
    startSharedStdio: async ({ control }: { control: ControlIdentity | Promise<ControlIdentity> }) => {
      controls.push(await control);
      return { close: async () => {} };
    }
  }));
  vi.stubEnv("SUI_MCP_DATA_DIR", directory);
  vi.stubEnv("SUI_GRPC_URL", undefined); vi.stubEnv("SUI_GRAPHQL_URL", undefined);
  try {
    for (const [index, project] of [undefined, "not-a-project-id", "1".repeat(32)].entries()) {
      vi.stubEnv("SUI_MCP_WALLETCONNECT_PROJECT_ID", project);
      vi.resetModules();
      await import("../src/runtime/start.js");
      await vi.waitFor(() => expect(controls).toHaveLength(index + 1));
      expect(process.listenerCount("SIGTERM")).toBe(processListeners.get("SIGTERM")!.size + index + 1);
    }
    const expected = fingerprint(JSON.stringify({ network: "mainnet", chainIdentifier: SUI_MAINNET_CHAIN_IDENTIFIER,
      walletConnectProjectId: WALLETCONNECT_PROJECT_ID, grpcOverride: null, graphqlOverride: null }));
    expect(fingerprint(WALLETCONNECT_PROJECT_ID)).toBe(approvedProjectFingerprint);
    expect(controls.map((control) => control.configurationId)).toEqual([expected, expected, expected]);
    expect(new Set(controls.map((control) => control.databaseId)).size).toBe(1);
    expect(new Set(controls.map((control) => control.key)).size).toBe(1);
    expect(source.init.mock.calls.length).toBe(0);
  } finally {
    for (const [event, before] of processListeners) {
      for (const listener of process.listeners(event)) if (!before.has(listener)) process.removeListener(event, listener);
    }
    for (const [event, before] of inputListeners) {
      for (const listener of process.stdin.listeners(event)) if (!before.has(listener)) process.stdin.removeListener(event, listener as (...args: unknown[]) => void);
    }
    vi.doUnmock("../src/runtime/reviewServerAcquire.js"); vi.doUnmock("../src/runtime/shared/stdio.js"); vi.resetModules();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("accepts only backend initialization, restoration and state failures in the public reason contract", () => {
  expect(walletUnavailableReasonSchema.options).toEqual(["initialization_failed", "restoration_failed", "wallet_state_unavailable"]);
  for (const reason of ["configuration_missing", "configuration_invalid"]) {
    expect(walletUnavailableReasonSchema.safeParse(reason).success).toBe(false);
  }
});

it.each(["expired_pairing", "inactive_pairing"] as const)("recovers the initial real SDK %s cleanup only through scoped Settings", async (kind) => {
  const directory = mkdtempSync(join(tmpdir(), "say-runtime-sdk-held-")), relay = await walletRelay();
  source.realRelay = relay.url;
  await seedWalletSdk(directory, kind);
  const app = await createRuntimeApplication(loadBootConfig({ SUI_MCP_DATA_DIR: directory }), { info() {}, warn() {}, error() {} });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = {} as { result: StartupToolResult };
    await app.handleMcp({ call: { name, arguments: args } } as unknown as IncomingMessage, response as unknown as ServerResponse);
    return response.result;
  };
  const payload = (result: CallToolResult) => {
    expect(result.isError).not.toBe(true);
    return (result.structuredContent as { data: Record<string, any> }).data;
  };
  try {
    // This request finishes while the real SDK's cleanup cannot finish.
    const interaction = payload(await call(TOOL_NAMES.sessionGetInteractionStatus));
    expect(interaction.walletAvailability.status).toBe("initializing");
    expect(interaction.assetReadAccount.status).toBe("address_required");
    await vi.waitFor(() => expect(relay.calls.some((request) => request.method === "irn_unsubscribe")).toBe(true), { timeout: 10000 });
    const created = await call(TOOL_NAMES.sessionCreateWalletConnection, { intent: "manage" });
    const reference = created._meta![CARD_METADATA_KEY] as Record<string, unknown>;
    const current = payload(await call(CARD_TOOLS.read, reference));
    expect(current.state).toBe("ready"); expect(current.data.allowedActions).not.toContain("restart_wallet_service");
    expect(() => acquireDataDirectoryOwner(join(directory, "activity.sqlite"))).toThrow("runtime owner");
    const priorRunId = current.data.walletAvailability.walletRunId;
    const refused = await call(CARD_TOOLS.act, { ...reference, revision: current.revision,
      input: { action: "restart_wallet_service", walletRunId: priorRunId } });
    expect(refused.isError).toBe(true);
    expect(source.children).toHaveLength(1); expect(source.children[0]!.exitCode).toBeNull();
    expect(source.commands).toEqual(["init"]);
    expect(() => acquireDataDirectoryOwner(join(directory, "activity.sqlite"))).toThrow("runtime owner");
    expect(payload(await call(TOOL_NAMES.accountGetActiveAccount))).toBeDefined();
    const settings = await call(TOOL_NAMES.settingsCreateLocalSettingsSession);
    const settingsRef = settings._meta![CARD_METADATA_KEY] as Record<string, unknown>;
    let control = payload(await call(CARD_TOOLS.read, settingsRef));
    control = payload(await call(CARD_TOOLS.act, { ...settingsRef, revision: control.revision,
      input: { action: "settings_select", draft: { kind: "restart_wallet_service" } } }));
    control = payload(await call(CARD_TOOLS.act, { ...settingsRef, revision: control.revision,
      input: { action: "settings_prepare", operationId: control.data.operationId } }));
    expect(control.data.priorRunId).toBe(priorRunId);
    control = payload(await call(CARD_TOOLS.act, { ...settingsRef, revision: control.revision,
      input: { action: "settings_confirm", operationId: control.data.operationId, preparationId: control.data.preparationId } }));
    await vi.waitFor(() => expect(source.children[0]!.signalCode).toBe("SIGKILL"), { timeout: 10000 });
    // The old process really ended before the external cleanup response is
    // released for the newly reserved SDK run. No init readiness is synthesized.
    relay.release();
    await vi.waitFor(async () => {
      control = payload(await call(CARD_TOOLS.read, settingsRef));
      expect(control.data.result?.outcome).toBe("completed");
    }, { timeout: 10000 });
    expect(control.data.nextRunId).not.toBe(priorRunId);
    expect(source.children).toHaveLength(2); expect(source.commands).toEqual(["init", "init"]);
    expect(payload(await call(TOOL_NAMES.sessionGetInteractionStatus)).walletAvailability.status).toBe("available");
  } finally {
    await app.close(); await relay.close(); rmSync(directory, { recursive: true, force: true });
  }
}, 25000);

it("keeps an unrecorded SDK session blocked after Settings restart and Reset without fabricating approval", async () => {
  const directory = mkdtempSync(join(tmpdir(), "sui-runtime-reconciliation-")), relay = await walletRelay();
  source.realRelay = relay.url; relay.release(); await seedWalletSdk(directory, "session");
  const app = await createRuntimeApplication(loadBootConfig({ SUI_MCP_DATA_DIR: directory }), { info() {}, warn() {}, error() {} });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = {} as { result: StartupToolResult };
    await app.handleMcp({ call: { name, arguments: args } } as unknown as IncomingMessage, response as unknown as ServerResponse);
    return response.result;
  };
  const data = (result: CallToolResult) => {
    expect(result.isError).not.toBe(true); return (result.structuredContent as { data: Record<string, any> }).data;
  };
  const applySettings = async (kind: "restart_wallet_service" | "reset_local_data") => {
    const created = await call(TOOL_NAMES.settingsCreateLocalSettingsSession);
    const reference = created._meta![CARD_METADATA_KEY] as Record<string, unknown>;
    let card = data(await call(CARD_TOOLS.read, reference));
    card = data(await call(CARD_TOOLS.act, { ...reference, revision: card.revision, input: { action: "settings_select", draft: { kind } } }));
    card = data(await call(CARD_TOOLS.act, { ...reference, revision: card.revision, input: { action: "settings_prepare", operationId: card.data.operationId } }));
    card = data(await call(CARD_TOOLS.act, { ...reference, revision: card.revision, input: { action: "settings_confirm", operationId: card.data.operationId, preparationId: card.data.preparationId } }));
    await vi.waitFor(async () => { card = data(await call(CARD_TOOLS.read, reference)); expect(card.data.result?.outcome).toBe("completed"); }, { timeout: 10000 });
    return card;
  };
  try {
    let context: Record<string, any> = {};
    await vi.waitFor(async () => { context = data(await call(TOOL_NAMES.sessionGetInteractionStatus)); expect(context.walletAvailability.status).toBe("available"); }, { timeout: 10000 });
    expect(context).toMatchObject({ connections: [], manageableConnectionIds: [], connectionReconciliationRequired: true, assetReadAccount: { status: "address_required" } });
    const connect = await call(TOOL_NAMES.sessionCreateWalletConnection, { intent: "manage" });
    const reference = connect._meta![CARD_METADATA_KEY] as Record<string, unknown>;
    const card = data(await call(CARD_TOOLS.read, reference));
    expect(card.data.allowedActions).toEqual(["cancel"]); expect(card.data.automaticAction).toBeUndefined();
    const refused = await call(CARD_TOOLS.act, { ...reference, revision: card.revision,
      input: { action: "connect", walletRunId: context.walletAvailability.walletRunId } });
    expect(refused.isError).toBe(true); expect(JSON.stringify(refused.content)).toContain("card_conflict");
    const recovered = await applySettings("restart_wallet_service");
    expect(recovered.data.nextRunId).not.toBe(context.walletAvailability.walletRunId);
    expect(source.children).toHaveLength(2); expect(source.children[0]!.signalCode).toBe("SIGKILL");
    context = data(await call(TOOL_NAMES.sessionGetInteractionStatus));
    expect(context).toMatchObject({ connectionReconciliationRequired: true, connections: [], manageableConnectionIds: [],
      assetReadAccount: { status: "address_required" } });
    await applySettings("reset_local_data");
    const resetContext = data(await call(TOOL_NAMES.sessionGetInteractionStatus));
    expect(resetContext).toMatchObject({ connectionReconciliationRequired: true, connections: [], manageableConnectionIds: [],
      assetReadAccount: { status: "address_required" } });
    expect(source.commands).toEqual(["init", "init"]);
  } finally { await app.close(); await relay.close(); rmSync(directory, { recursive: true, force: true }); }
}, 25000);
