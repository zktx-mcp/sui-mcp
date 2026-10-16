import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { join } from "node:path";
import { settingsWorkflowFixture } from "./fixtures/settingsWorkflow.js";
import { suiGrants } from "./fixtures/walletGrants.js";
import { deferred } from "./fixtures/walletWorkflow.js";
import { workflowViewSchema, connectViewSchema, closedWalletCardSchema } from "../src/core/session/workflowView.js";
import type { WalletSession } from "../src/core/session/walletConnection.js";
import type { WalletChainId } from "../src/core/session/chainAccounts.js";
import { waitForWalletConnection } from "../src/core/session/wait.js";
import { WalletWorkflow } from "../src/core/session/walletWorkflow.js";
import { FixtureWalletRuntime } from "./fixtures/walletRuntime.js";

const close: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of close.splice(0).reverse()) await cleanup(); });
async function fixture() { const f = await settingsWorkflowFixture(); close.push(f.close); return f; }
const ethereum = "eip155:1" as const, solana = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const;
const evmAddress = `0x${"ab".repeat(20)}`, solanaAddress = "11111111111111111111111111111111";
const otherSui = `0x${"b".repeat(64)}`;
function session(account: string, topic: string = randomUUID()): WalletSession {
  return { topic, grants: suiGrants([account]), expiresAt: "2099-01-01T00:00:00.000Z", walletName: "Same wallet" };
}
async function networks(f: Awaited<ReturnType<typeof fixture>>, chains: WalletChainId[]) {
  const card = await f.create();
  expect((await f.saveNetworks(card, chains)).error).toBeUndefined();
}

it("saves the exact networks in one admitted action and returns the same immutable result on retry", async () => {
  const f = await fixture(), card = await f.create();
  const before = f.wallet.run(() => f.records.forCard(f.wallet.cardRecords.get(card.snapshot.cardId)!));
  expect(before.phase).toBe("draft");
  const input = { action: "settings_save_wallet_networks", operationId: before.operationId,
    chains: [ethereum, "sui:mainnet"], expectedChains: ["sui:mainnet"] };
  const saved = await f.act(card, input);
  expect(saved.error).toBeUndefined();
  expect(saved.snapshot).toMatchObject({ state: "closed", reason: "completed", data: {
    phase: "terminal", allowedActions: [], result: { outcome: "completed", details: {
      walletConnectionChains: ["sui:mainnet", ethereum], previousWalletConnectionChains: ["sui:mainnet"], appliesTo: "new_connections"
    } }
  } });
  expect(await f.act(card, input)).toEqual(saved);
  expect((await f.act(card, { ...input, chains: [] })).error?.code).toBe("card_conflict");
  expect(f.wallet.run(() => f.preferences.getWalletConnectionChainsSync())).toEqual(["sui:mainnet", ethereum]);
  expect(f.wallet.connect).not.toHaveBeenCalled(); expect(f.wallet.sign).not.toHaveBeenCalled();
});

it("rejects stale saved-network assumptions, expired cards and invalid scope without writing settings", async () => {
  const f = await fixture(), old = await f.create();
  await networks(f, [ethereum]);
  expect((await f.saveNetworks(old, [solana])).error?.code).toBe("card_conflict");
  expect(f.wallet.run(() => f.preferences.getWalletConnectionChainsSync())).toEqual([ethereum]);
  const fresh = await f.create();
  const operationId = f.wallet.run(() => f.records.forCard(f.wallet.cardRecords.get(fresh.snapshot.cardId)!)).operationId;
  expect((await f.act(fresh, { action: "settings_save_wallet_networks", operationId,
    chains: [ethereum, ethereum], expectedChains: [ethereum] })).error?.code).toBe("invalid_card_input");
  f.wallet.advance(Date.parse(fresh.snapshot.expiresAt) - f.wallet.now().getTime());
  expect((await f.saveNetworks(fresh, [])).error?.code).toBe("card_conflict");
  expect(f.wallet.run(() => f.preferences.getWalletConnectionChainsSync())).toEqual([ethereum]);
  expect(f.wallet.connect).not.toHaveBeenCalled();
});

it("rolls back the network setting and card admission when saving the result fails", async () => {
  const f = await fixture(), card = await f.create(), db = new Database(join(f.wallet.directory, "activity.sqlite"));
  try {
    db.exec("CREATE TRIGGER reject_network_result BEFORE UPDATE OF result_json ON settings_operations WHEN NEW.kind='set_wallet_networks' AND NEW.result_json IS NOT NULL BEGIN SELECT RAISE(ABORT, 'synthetic result failure'); END");
    await expect(f.saveNetworks(card, [ethereum])).rejects.toThrow("synthetic result failure");
    expect(f.wallet.run(() => f.preferences.getWalletConnectionChainsSync())).toEqual(["sui:mainnet"]);
    const record = f.wallet.run(() => f.wallet.cardRecords.get(card.snapshot.cardId)!);
    expect(record.state).toMatchObject({ state: "ready", revision: card.snapshot.revision });
    expect(record.acceptedInput).toBeUndefined();
    expect(f.wallet.run(() => f.records.control().active_operation_id)).toBeNull();
    db.exec("DROP TRIGGER reject_network_result");
    expect((await f.saveNetworks(card, [])).error).toBeUndefined();
    expect(f.wallet.run(() => f.preferences.getWalletConnectionChainsSync())).toEqual([]);
  } finally { db.close(); }
});

it("uses saved optional scope, preserves partial approval, and freezes its one connection", async () => {
  const f = await fixture(), w = f.wallet;
  await networks(f, ["sui:mainnet", ethereum]);
  const approval = session(w.account);
  approval.grants.push({ chainId: solana, accounts: [{ address: solanaAddress, methods: [], events: [] }] });
  const a = await w.connectSession(approval);
  expect(w.connect).toHaveBeenLastCalledWith(["sui:mainnet", ethereum]);
  expect(a.connection.chainResults).toEqual([{ chainId: "sui:mainnet", status: "bound", address: w.account }, { chainId: ethereum, status: "not_approved" }]);
  expect(w.run(() => w.workflow.currentConnectionContext()).connection?.chainStates).toEqual(expect.arrayContaining([
    expect.objectContaining({ chainId: ethereum, status: "not_approved" })
  ]));
  await networks(f, [solana]);
  expect(w.run(() => w.records.currentConnection()?.connection.requestedChains)).toEqual(["sui:mainnet", ethereum]);
  expect(closedWalletCardSchema.parse((await w.createConnection()).snapshot.data).allowedActions).toEqual([]);
  expect(w.sign).not.toHaveBeenCalled(); expect(w.submit).not.toHaveBeenCalled();
});

it("rejects a stale requested scope before pairing and treats an empty setting as no new request", async () => {
  const f = await fixture(), w = f.wallet, card = await w.createConnection();
  const original = w.connectionInput(card, { action: "connect" });
  await networks(f, []);
  const ended = w.run(() => w.cardRecords.get(card.snapshot.cardId)!.state);
  expect(ended).toMatchObject({ state: "closed", reason: "failed" });
  // Restoring the earlier value before any card read must not restore authority.
  await networks(f, ["sui:mainnet"]);
  expect(w.run(() => w.cardRecords.get(card.snapshot.cardId)!.state)).toEqual(ended);
  await networks(f, []);
  expect((await w.act(card, original)).error?.code).toBe("card_conflict");
  const current = await w.read(card);
  expect((current.snapshot.data as { automaticAction?: unknown }).automaticAction).toBeUndefined();
  expect((current.snapshot.data as { allowedActions: string[] }).allowedActions).not.toContain("connect");
  expect(w.connect).not.toHaveBeenCalled();
  await networks(f, [ethereum]);
  const changed = await w.read(card);
  expect((changed.snapshot.data as { automaticAction?: unknown }).automaticAction).toBeUndefined();
  expect((await w.act(changed, { action: "connect" })).error).toBeDefined();
  const replacement = await w.createConnection();
  expect((await w.act(replacement, { action: "connect" })).error).toBeUndefined();
  expect(w.connect).toHaveBeenCalledExactlyOnceWith([ethereum]);
});

it("isolates other-chain and metadata changes while Sui grant changes remain irreversible", async () => {
  const f = await fixture(), w = f.wallet;
  await networks(f, ["sui:mainnet", ethereum]);
  const { connection: a } = await w.approve(), ready = await w.prepare(a.connectionId);
  const original = w.transport.session("fixture-topic")!;
  const changed = { ...original, walletName: "Renamed wallet", grants: [...original.grants,
    { chainId: ethereum, accounts: [{ address: evmAddress, methods: [], events: [] }] }] };
  const revision = w.run(() => w.records.connection(a.connectionId)!.connection.grantRevisions["sui:mainnet"]);
  w.notify(changed, [ethereum]);
  expect(w.run(() => w.records.connection(a.connectionId)!.connection.grantRevisions["sui:mainnet"])).toBe(revision);
  expect(workflowViewSchema.parse((await w.read(ready.card)).snapshot.data).allowedActions).toContain("request_signature");
  expect(w.run(() => w.records.currentConnection()?.connection.chainResults)).toEqual(a.chainResults);
  w.notify(changed, ["sui:mainnet"]); w.notify(original);
  expect(w.run(() => w.records.connection(a.connectionId)!.connection.grantRevisions["sui:mainnet"])).toBeGreaterThan(revision);
  expect(workflowViewSchema.parse((await w.read(ready.card)).snapshot.data).allowedActions).not.toContain("request_signature");
});

it("keeps one effect per card and reads its current settlement separately from its frozen result", async () => {
  const f = await fixture(), w = f.wallet, first = await w.approve(), frozen = structuredClone(first.card.snapshot);
  const firstOperation = w.run(() => w.records.operation(String(first.card.snapshot.input.operationId)))!;
  expect((await w.act(first.card, { action: "disconnect", connectionId: first.connection.connectionId })).error).toBeDefined();
  const held = deferred<void>(), actualDisconnect = w.transport.disconnect;
  w.transport.disconnect = vi.fn(async (topic) => { await held.promise; await actualDisconnect(topic); });
  const card = await w.createDisconnection(), command = w.connectionInput(card, { action: "disconnect", connectionId: first.connection.connectionId });
  expect((await w.act(card, command)).error).toBeUndefined();
  const pending = await w.run(() => waitForWalletConnection(w.cards, card.snapshot.cardId, { timeoutMs: 0 }));
  expect(pending.operation).toMatchObject({ action: "disconnect", status: "running", settlementPending: true });
  held.resolve();
  await vi.waitFor(() => expect(w.run(() => w.records.connection(first.connection.connectionId)?.sdkPending)).toBe(false));
  const wait = await w.run(() => waitForWalletConnection(w.cards, card.snapshot.cardId, { timeoutMs: 0 }));
  expect(wait.waitOutcome).toBe("status_reached"); expect(wait.operation).toMatchObject({ action: "disconnect", status: "completed", settlementPending: false });
  expect(wait.card.state).toBe("closed"); expect(wait.card.data).not.toHaveProperty("connection");
  expect((await w.read(first.card)).snapshot).toEqual(frozen);
  const original = await w.run(() => w.cards.readWalletOperation(first.card.snapshot.cardId));
  expect(original.operation?.operationId).toBe(firstOperation.operationId);
  expect(original.card).toEqual(frozen); expect(original.operation?.action).toBe("connect");
  expect((await w.act(card, command)).error).toBeUndefined(); expect(w.transport.disconnect).toHaveBeenCalledOnce();
});

it("does not reinterpret reused IDs after restore and requires disconnecting the retained epoch", async () => {
  const f = await fixture(), w = f.wallet, { connection } = await w.approve();
  const backup = await w.run(() => w.localData.exportLocalData()), id = backup.data.accounts[0]!.id;
  expect(backup.data).not.toHaveProperty("chainAccountContexts");
  backup.data.accounts[0]!.address = otherSui;
  await w.run(() => w.localData.importLocalDataReplace(backup));
  expect((await w.run(() => w.activity.getKnownAccount(otherSui)))?.id).toBe(id);
  expect(w.run(() => w.workflow.currentConnectionContext()).assetReadAccount).toEqual({ status: "address_required" });
  expect(w.run(() => w.records.currentConnection()?.connection.chainResults)).toEqual([{ chainId: "sui:mainnet", status: "bound", address: w.account }]);
  const card = await w.run(() => w.cards.create("disconnect", {}));
  expect((await w.act(card, { action: "disconnect", connectionId: connection.connectionId })).error).toBeUndefined();
  await vi.waitFor(() => expect(w.run(() => w.records.currentConnection()?.sdkPending)).toBe(false));
  const next = await w.connectSession(session(w.account, "new-after-restore"));
  expect(next.connection.connectionId).not.toBe(connection.connectionId);
  expect((await w.run(() => w.activity.getKnownAccount(otherSui)))?.id).toBe(id);
  expect(await w.run(() => w.activity.getActiveAccount())).toMatchObject({ address: w.account, connectionId: next.connection.connectionId });
});

it("keeps the approved session owned for cleanup when its success publication rolls back", async () => {
  const f = await fixture(), w = f.wallet, card = await w.createConnection(), approval = session(w.account, "publication");
  const started = await w.act(card, { action: "connect" }), operation = connectViewSchema.parse(started.snapshot.data).operation!;
  const db = new Database(join(w.directory, "activity.sqlite")), cleanup = deferred<void>(), disconnect = w.transport.disconnect;
  w.transport.disconnect = vi.fn(async (topic) => { await cleanup.promise; await disconnect(topic); });
  try {
    db.exec("CREATE TRIGGER refuse_result BEFORE UPDATE OF result_json ON wallet_connection_operations WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT,'synthetic publication failure'); END");
    w.approval.resolve(approval);
    await vi.waitFor(() => expect(w.transport.disconnect).toHaveBeenCalledExactlyOnceWith(approval.topic));
    expect(w.run(() => w.records.currentConnection())).toMatchObject({ topic: approval.topic, sdkPending: true, connection: { status: "failed" } });
    expect(w.run(() => w.records.currentConnection()?.connection.chainResults)).toEqual([]);
    expect(await w.run(() => w.activity.getKnownAccount(w.account))).toBeUndefined();
    expect(w.run(() => w.records.operation(operation.operationId))).toMatchObject({ status: "failed", settlementPending: true,
      message: "The wallet connection could not be recorded as approved." });
    const result = db.prepare("SELECT result_json FROM wallet_connection_operations WHERE operation_id=?").get(operation.operationId);
    const ended = (await w.read(card)).snapshot;
    expect(closedWalletCardSchema.parse(ended.data).result.pendingWork).toBe("session_removal");
    expect(closedWalletCardSchema.parse(ended.data).allowedActions).not.toContain("connect");
    cleanup.resolve();
    await vi.waitFor(() => expect(w.run(() => w.records.currentConnection()?.sdkPending)).toBe(false));
    expect(w.run(() => w.records.currentConnection())).toMatchObject({ topic: approval.topic, connection: { status: "disconnected", chainResults: [] } });
    expect(db.prepare("SELECT result_json FROM wallet_connection_operations WHERE operation_id=?").get(operation.operationId)).toEqual(result);
    expect(w.runtime.snapshot()?.sessions.find((s) => s.topic === approval.topic)?.status).toBe("absent");
    expect(closedWalletCardSchema.parse((await w.read(card)).snapshot.data).allowedActions).toEqual([]);
    expect((await w.read(card)).snapshot).toEqual(ended);
    expect(w.connect).toHaveBeenCalledOnce(); expect(w.sign).not.toHaveBeenCalled(); expect(w.submit).not.toHaveBeenCalled();
  } finally { cleanup.resolve(); db.exec("DROP TRIGGER refuse_result"); db.close(); }
});

it("retains an unstored approval for cleanup and retries bookkeeping without repeating a lost-reply removal", async () => {
  const f = await fixture(), w = f.wallet, card = await w.createConnection(), approval = session(w.account, "retention-failure");
  const started = await w.act(card, { action: "connect" }), operation = connectViewSchema.parse(started.snapshot.data).operation!;
  const db = new Database(join(w.directory, "activity.sqlite")), disconnect = w.transport.disconnect;
  const publication = vi.spyOn(w.records, "completeConnection");
  w.transport.disconnect = vi.fn(async (topic) => { await disconnect(topic); throw new Error("Synthetic removal reply lost"); });
  try {
    db.exec("CREATE TRIGGER refuse_topic BEFORE UPDATE OF topic ON live_wallet_connections WHEN NEW.topic IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic topic write failure'); END");
    w.approval.resolve(approval);
    await vi.waitFor(() => expect(w.logger.error).toHaveBeenCalledWith("Wallet operation failed", { stage: "callback_record" }));
    expect(w.run(() => w.records.currentConnection())).toMatchObject({ sdkPending: true, connection: { status: "awaiting_approval", chainResults: [] } });
    expect(w.run(() => w.records.currentConnection()?.topic)).toBeUndefined();
    expect(w.run(() => w.records.connectionEligibility().pairingAllowed)).toBe(false);
    expect(w.transport.disconnect).not.toHaveBeenCalled(); expect(publication).not.toHaveBeenCalled();
    db.exec("DROP TRIGGER refuse_topic");
    db.exec("CREATE TRIGGER refuse_settlement BEFORE UPDATE OF sdk_pending ON wallet_connection_operations WHEN NEW.sdk_pending=0 BEGIN SELECT RAISE(ABORT,'synthetic settlement failure'); END");
    await w.read(card);
    await vi.waitFor(() => expect(w.runtime.snapshot()?.sessions.find((s) => s.topic === approval.topic)?.status).toBe("absent"));
    expect(w.run(() => w.records.currentConnection())).toMatchObject({ topic: approval.topic, sdkPending: true });
    expect(w.run(() => w.records.operation(operation.operationId))).toMatchObject({ status: "failed", settlementPending: true });
    const result = db.prepare("SELECT result_json FROM wallet_connection_operations WHERE operation_id=?").get(operation.operationId);
    db.exec("DROP TRIGGER refuse_settlement");
    await w.run(() => w.cards.readWalletOperation(card.snapshot.cardId));
    await vi.waitFor(() => expect(w.run(() => w.records.currentConnection()?.sdkPending)).toBe(false));
    await w.read(card);
    expect(w.run(() => w.records.currentConnection()?.connection.status)).toBe("disconnected");
    expect(db.prepare("SELECT result_json FROM wallet_connection_operations WHERE operation_id=?").get(operation.operationId)).toEqual(result);
    expect(w.transport.disconnect).toHaveBeenCalledExactlyOnceWith(approval.topic);
    expect(publication).not.toHaveBeenCalled();
    expect(await w.run(() => w.activity.getKnownAccount(w.account))).toBeUndefined();
    expect(w.sign).not.toHaveBeenCalled(); expect(w.submit).not.toHaveBeenCalled();
  } finally { db.exec("DROP TRIGGER IF EXISTS refuse_topic; DROP TRIGGER IF EXISTS refuse_settlement"); db.close(); }
});

it("reads an already-published exact approval without reapplying it or making it cleanup work", async () => {
  const f = await fixture(), w = f.wallet, approved = session(w.account, "published-response"), card = await w.createConnection();
  const started = await w.act(card, { action: "connect" }), operation = connectViewSchema.parse(started.snapshot.data).operation!;
  w.approval.resolve(approved);
  await vi.waitFor(() => expect(w.run(() => w.records.currentConnection())).toMatchObject({ sdkPending: false, connection: { status: "connected" } }));
  const owner = { id: operation.connectionId, cardId: card.snapshot.cardId, operationId: operation.operationId, runId: w.runtime.runId };
  const before = w.run(() => w.records.currentConnection());
  expect(w.run(() => w.records.captureConnectionSession(owner, approved))).toBe("already_published");
  expect(w.run(() => w.records.completeConnection(owner, approved, w.now()))).toBe("already_published");
  expect(w.run(() => w.records.prepareConnectionCleanup(owner, approved, w.now()))).toBe(false);
  expect(w.run(() => w.records.captureConnectionSession(owner, { ...approved, topic: "different-response" }))).toBe("not_owned");
  expect(w.run(() => w.records.currentConnection())).toEqual(before);
  expect(w.connect).toHaveBeenCalledOnce(); expect(w.transport.disconnect).not.toHaveBeenCalled();
  expect(w.sign).not.toHaveBeenCalled(); expect(w.submit).not.toHaveBeenCalled();
});

it("preserves a response still held by the parent after SDK exit ends its pending I/O", async () => {
  const f = await fixture(), w = f.wallet, card = await w.createConnection(), approved = session(w.account, "response-after-sdk-exit");
  const started = await w.act(card, { action: "connect" }), operation = connectViewSchema.parse(started.snapshot.data).operation!;
  const db = new Database(join(w.directory, "activity.sqlite"));
  try {
    db.exec("CREATE TRIGGER refuse_topic BEFORE UPDATE OF topic ON live_wallet_connections WHEN NEW.topic IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic topic write failure'); END");
    w.approval.resolve(approved);
    await vi.waitFor(() => expect(w.logger.error).toHaveBeenCalledWith("Wallet operation failed", { stage: "callback_record" }));
    w.runtime.fail("initialization_failed");
    expect(w.run(() => w.records.operation(operation.operationId))).toMatchObject({ status: "stopped", settlementPending: false, endReason: "run_ended" });
    const result = db.prepare("SELECT result_json FROM wallet_connection_operations WHERE operation_id=?").get(operation.operationId);
    db.exec("DROP TRIGGER refuse_topic");
    await w.run(() => w.cards.readWalletOperation(card.snapshot.cardId));
    expect(w.run(() => w.records.currentConnection())).toMatchObject({ topic: approved.topic, sdkPending: false,
      connection: { status: "failed", chainResults: [] } });
    expect(db.prepare("SELECT result_json FROM wallet_connection_operations WHERE operation_id=?").get(operation.operationId)).toEqual(result);
    expect(w.transport.disconnect).not.toHaveBeenCalled();
    expect(await w.run(() => w.activity.getKnownAccount(w.account))).toBeUndefined();
    expect(w.sign).not.toHaveBeenCalled(); expect(w.submit).not.toHaveBeenCalled();
  } finally { db.exec("DROP TRIGGER IF EXISTS refuse_topic"); db.close(); }
});

it.each(["stored_topic", "unstored_topic"] as const)("recovers %s after response persistence failure without adopting or publishing a wallet again", async (kind) => {
  const f = await fixture(), w = f.wallet, card = await w.createConnection(), approved = session(w.account, `response-before-exit-${kind}`);
  const started = await w.act(card, { action: "connect" }), operation = connectViewSchema.parse(started.snapshot.data).operation!;
  const oldOwner = { id: operation.connectionId, cardId: card.snapshot.cardId, operationId: operation.operationId, runId: w.runtime.runId };
  const db = new Database(join(w.directory, "activity.sqlite"));
  const connect = vi.fn((chains: readonly WalletChainId[]) => w.transport.connect(chains));
  const disconnect = vi.fn((topic: string) => w.transport.disconnect(topic));
  const runtime = new FixtureWalletRuntime({ ...w.transport, connect, disconnect });
  const records = w.activity.createWalletWorkflowStore("response-recovery-owner", w.now, () => runtime.snapshot());
  const next = new WalletWorkflow({ records, sessions: w.sessions, ownerId: "response-recovery-owner", runtime,
    computation: w.computation, verifyReceipt: w.verifyReceipt, verifyNetwork: w.verifyNetwork, submitTransaction: w.submit,
    assertCurrent: w.access.assertCurrent, bindExternalEvent: (work) => w.access.bind(work), logger: w.logger, now: w.now });
  try {
    db.exec(kind === "stored_topic"
      ? "CREATE TRIGGER refuse_response BEFORE UPDATE OF result_json ON wallet_connection_operations BEGIN SELECT RAISE(ABORT,'synthetic result storage failure'); END"
      : "CREATE TRIGGER refuse_response BEFORE UPDATE OF topic ON live_wallet_connections WHEN NEW.topic IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic topic storage failure'); END");
    w.approval.resolve(approved);
    await vi.waitFor(() => expect(w.logger.error).toHaveBeenCalledWith("Wallet operation failed", { stage: "callback_record" }));
    expect(w.run(() => w.records.currentConnection()?.topic)).toBe(kind === "stored_topic" ? approved.topic : undefined);
    expect(w.run(() => w.records.currentConnection()?.sdkPending)).toBe(true);
    w.workflow.stop(); await w.runtime.close();
    db.exec("DROP TRIGGER refuse_response");
    await w.run(() => next.start());
    await vi.waitFor(() => expect(runtime.availability().status).toBe("available"));
    const facts = w.run(() => next.reconcileConnectionContext());
    expect(w.run(() => records.currentConnection())).toMatchObject({ ownerId: "response-recovery-owner", runId: runtime.runId, sdkPending: false,
      connection: { chainResults: [] } });
    expect(facts.assetReadAccount).toEqual({ status: "address_required" });
    expect(facts.canDisconnect).toBe(kind === "stored_topic");
    expect(!!facts.connectionReconciliationRequired).toBe(kind === "unstored_topic");
    expect(w.run(() => records.connectionEligibility().pairingAllowed)).toBe(false);
    expect(w.run(() => records.captureConnectionSession(oldOwner, approved))).toBe("not_owned");
    expect(await w.run(() => w.activity.getKnownAccount(w.account))).toBeUndefined();
    expect(connect).not.toHaveBeenCalled(); expect(disconnect).not.toHaveBeenCalled();
    expect(w.sign).not.toHaveBeenCalled(); expect(w.submit).not.toHaveBeenCalled();
  } finally { next.stop(); await runtime.close(); db.exec("DROP TRIGGER IF EXISTS refuse_response"); db.close(); }
});

it("holds the pairing reservation after Stop and cleans late approval without assigning any default", async () => {
  const f = await fixture(), w = f.wallet, card = await w.createConnection(), cleanup = deferred<void>();
  w.transport.disconnect = vi.fn(() => cleanup.promise);
  const response = await w.act(card, { action: "connect" }), operation = connectViewSchema.parse(response.snapshot.data).operation!;
  expect((await w.act(await w.read(card), { action: "stop_connection", operationId: operation.operationId })).error).toBeUndefined();
  expect((await w.read(card)).walletDisplay).toBeUndefined();
  expect(() => w.run(() => w.records.assertDataReplacementAllowed(w.now()))).toThrow("unsettled");
  w.approval.resolve(session(w.account, "late-approval"));
  await vi.waitFor(() => expect(w.transport.disconnect).toHaveBeenCalledWith("late-approval"));
  expect(await w.run(() => w.activity.getActiveAccount())).toBeUndefined();
  expect(closedWalletCardSchema.parse((await w.read(card)).snapshot.data).allowedActions).not.toContain("connect");
  cleanup.reject(new Error("Synthetic unconfirmed cleanup"));
  await vi.waitFor(() => expect(w.run(() => w.records.operation(operation.operationId)?.settlementPending)).toBe(false));
  const ended = closedWalletCardSchema.parse((await w.read(card)).snapshot.data);
  expect(w.run(() => w.workflow.currentConnectionContext()).assetReadAccount).toEqual({ status: "address_required" });
  expect(w.run(() => w.workflow.currentConnectionContext()).canDisconnect).toBe(true);
  expect(ended.allowedActions).toEqual([]);
  expect((await w.read(card)).snapshot).toMatchObject({ state: "closed", reason: "cancelled" });
  expect((await w.act(await w.read(card), { action: "connect", operationId: randomUUID() })).error?.code).toBe("card_conflict");
  const next = await w.run(() => w.cards.create("disconnect", {}));
  expect(workflowViewSchema.parse(next.snapshot.data).allowedActions).not.toContain("connect");
  expect(workflowViewSchema.parse(next.snapshot.data).allowedActions).toContain("disconnect");
});

it("keeps the original approval scope separate from a newer grant arriving before its local publication", async () => {
  const f = await fixture(), w = f.wallet, original = session(w.account), newer = { ...original, grants: suiGrants([otherSui]) };
  vi.spyOn(w.transport, "inspectAll").mockReturnValue([{ topic: original.topic, status: "present", session: newer }]);
  const saved = await w.connectSession(original);
  expect(saved.connection.chainResults).toEqual([{ chainId: "sui:mainnet", status: "bound", address: w.account }]);
  expect(saved.connection.chainResults).toEqual([{ chainId: "sui:mainnet", status: "bound", address: w.account }]);
  expect(saved.connection.grants).toEqual(newer.grants);
  expect(await w.run(() => w.activity.getActiveAccount())).toMatchObject({ address: w.account });
  expect(w.run(() => w.workflow.reconcileConnectionContext().assetReadAccount)).toEqual({ status: "address_required" });
  expect(w.run(() => w.workflow.resolveReviewTarget()))
    .toEqual({ status: "unavailable", reason: "connection_required" });
});
