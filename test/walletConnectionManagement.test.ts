import { connectViewSchema } from "../src/core/session/workflowView.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { walletWorkflowFixture, deferred } from "./fixtures/walletWorkflow.js";
import { closedWalletCardSchema, workflowViewSchema } from "../src/core/session/workflowView.js";
import { suiGrants } from "./fixtures/walletGrants.js";
const fixtures: Awaited<ReturnType<typeof walletWorkflowFixture>>[] = [];
afterEach(() => { for (const f of fixtures.splice(0).reverse()) f.close(); });
async function fixture() { const f = await walletWorkflowFixture(); fixtures.push(f); return f; }

it.each(["missing", "stale_run"] as const)("does not qualify an unconfirmed SDK observation (%s)", async (kind) => {
  const f = await fixture(); await f.approve();
  const snapshot = f.runtime.snapshot()!;
  const getter = vi.spyOn(f.runtime, "snapshot").mockReturnValue(kind === "missing" ? undefined : { ...snapshot, runId: randomUUID() });
  try {
    const facts = f.run(() => f.records.readConnectionFacts(f.now()));
    expect(facts.connectionPresence.confirmed).toBe(false);
    expect(f.run(() => f.records.connectionEligibility()).pairingAllowed).toBe(false);
    expect(f.run(() => f.records.connectionEligibility()).assetReadAccount.status).toBe("address_required");
  } finally { getter.mockRestore(); }
  expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});

it("admits the initial connection action only once after UI confirmation", async () => {
  const f = await fixture(), card = await f.run(() => f.cards.create("connect", {}));
  expect(connectViewSchema.parse(card.snapshot.data).automaticAction).toMatchObject({ action: "connect" });
  expect(f.connect).not.toHaveBeenCalled();
  expect((await f.act(card, { action: "restart_wallet_service" })).error).toBeDefined();
  expect((await f.act(card, { action: "connect" })).error).toBeUndefined();
  expect(f.connect).toHaveBeenCalledOnce();
  expect(closedWalletCardSchema.parse((await f.createConnection()).snapshot.data).allowedActions).toEqual([]);
});

it("rejects a stale same-target disconnect and preserves its one admitted request", async () => {
  const f = await fixture(), { connection } = await f.approve(), held = deferred<void>();
  f.transport.disconnect = vi.fn(() => held.promise);
  const a = await f.run(() => f.cards.create("disconnect", {}));
  const b = await f.run(() => f.cards.create("disconnect", {}));
  expect((await f.act(a, { action: "disconnect", operationId: "00000000-0000-4000-8000-000000000099", connectionId: connection.connectionId })).error?.code).toBe("card_conflict");
  expect(f.transport.disconnect).not.toHaveBeenCalled();
  expect((await f.act(a, { action: "disconnect", connectionId: connection.connectionId })).error).toBeUndefined();
  expect((await f.act(b, { action: "disconnect", connectionId: connection.connectionId })).error?.code).toBe("card_conflict");
  expect(f.transport.disconnect).toHaveBeenCalledOnce();
  held.reject(new Error("Remote removal unconfirmed"));
  await vi.waitFor(() => expect(f.run(() => f.records.currentConnection()?.sdkPending)).toBe(false));
  expect(f.run(() => f.records.currentConnection()?.connection.status)).toBe("failed");
  expect(closedWalletCardSchema.parse((await f.read(a)).snapshot.data).result.pendingWork).toBe("session_status");
  expect(f.run(() => f.records.connectionEligibility()).pairingAllowed).toBe(false);
});

it("rolls back disconnect admission when its own card write fails", async () => {
  const f = await fixture(), { connection } = await f.approve();
  const card = await f.run(() => f.cards.create("disconnect", {}));
  const db = new Database(join(f.directory, "activity.sqlite"));
  try {
    db.exec(`CREATE TRIGGER reject_publication BEFORE UPDATE ON live_read_cards WHEN OLD.id='${card.snapshot.cardId}' BEGIN SELECT RAISE(ABORT,'synthetic publication failure'); END`);
    await expect(f.act(card, { action: "disconnect", connectionId: connection.connectionId })).rejects.toThrow("synthetic publication failure");
    expect(f.run(() => f.records.currentConnection()?.sdkPending)).toBe(false);
    expect(f.run(() => f.records.pendingConnectionOperations())).toEqual([]);
    expect(f.transport.disconnect).not.toHaveBeenCalled();
  } finally { db.close(); }
});

it.each([-1, 0, 1])("keeps recorded expiry separate from retained SDK occupancy (offset=%s)", async (offset) => {
  const f = await fixture(), { connection } = await f.approve();
  const expiry = f.now().getTime()+1000;
  f.run(() => f.records.updateConnection(connection.connectionId, { expiresAt: new Date(expiry).toISOString() }, f.now()));
  f.advance(1000+offset);
  const data = workflowViewSchema.parse((await f.run(() => f.cards.create("disconnect", {}))).snapshot.data);
  expect(data.allowedActions).toContain("disconnect"); expect(data.allowedActions).not.toContain("connect");
  expect(f.run(() => f.workflow.currentConnectionContext()).assetReadAccount.status).toBe(offset < 0 ? "available" : "address_required");
  expect(f.connect).toHaveBeenCalledOnce(); expect(f.sign).not.toHaveBeenCalled();
});

it("does not extend the SDK expiry with a later stored connection expiry", async () => {
  const f = await fixture(), { connection } = await f.approve();
  const sdkExpiry = Date.parse(connection.expiresAt), storedExpiry = new Date(sdkExpiry + 60_000).toISOString();
  f.run(() => f.records.updateConnection(connection.connectionId, { expiresAt: storedExpiry }, f.now()));
  f.advance(sdkExpiry - f.now().getTime() - 1);
  expect(f.run(() => f.records.isUsableConnection(connection.connectionId))).toBe(true);
  f.advance(1);
  const facts = f.run(() => f.records.readConnectionFacts(f.now()));
  expect(facts.connection).toMatchObject({ status: "connected", expiresAt: storedExpiry });
  expect(facts.connectionPresence).toMatchObject({ confirmed: true, managed: true, pending: false,
    observation: { status: "present", expiresAt: connection.expiresAt } });
  expect(f.run(() => f.records.isUsableConnection(connection.connectionId))).toBe(false);
  const data = workflowViewSchema.parse((await f.run(() => f.cards.create("disconnect", {}))).snapshot.data);
  expect(data.allowedActions).toContain("disconnect");
  expect(f.run(() => f.workflow.currentConnectionContext()).assetReadAccount.status).toBe("address_required");
  expect(data.allowedActions).not.toContain("connect");
  expect(f.connect).toHaveBeenCalledOnce(); expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});

it.each(["stop", "expiry"] as const)("blocks a new valid card while the %s pairing still owns unsettled I/O", async (ending) => {
  const f = await fixture(), original = await f.createConnection();
  expect((await f.act(original, { action: "connect" })).error).toBeUndefined();
  await vi.waitFor(() => expect(f.connect).toHaveBeenCalledOnce());
  const pairing = await f.read(original), operation = connectViewSchema.parse(pairing.snapshot.data).operation!;
  if (ending === "stop") expect((await f.act(pairing, { action: "stop_connection" })).error).toBeUndefined();
  else { f.advance(Date.parse(operation.expiresAt) - f.now().getTime()); await f.read(original); }
  expect(f.run(() => f.records.operation(operation.operationId))).toMatchObject({ status: "stopped", settlementPending: true,
    endReason: ending === "stop" ? "user_stopped" : "expired" });
  expect(closedWalletCardSchema.parse((await f.read(original)).snapshot.data).result.pendingWork).toBe("approval_response");
  const fresh = await f.run(() => f.cards.create("connect", {}));
  expect(fresh.snapshot.state).toBe("closed");
  expect(f.run(() => f.workflow.currentConnectionContext()).connection?.sessionPresence).toBe("unconfirmed");
  expect(closedWalletCardSchema.parse(fresh.snapshot.data).allowedActions).toEqual([]);
  const refusedInput = f.connectionInput(fresh, { action: "connect" });
  const refused = await f.run(() => f.cards.act({ cardId: fresh.snapshot.cardId, permission: fresh.permission,
    revision: fresh.snapshot.revision, input: refusedInput }));
  expect(refused.error).toEqual({ code: "card_conflict", message: "This card has ended. Ask in chat for a new request." });
  expect(f.run(() => f.records.operation(String(refusedInput.operationId)))).toBeUndefined();
  expect(f.connect).toHaveBeenCalledOnce();
  f.approval.reject(new Error("Synthetic original approval ended without a session"));
  await vi.waitFor(() => expect(f.run(() => f.records.operation(operation.operationId)?.settlementPending)).toBe(false));
  expect((await f.read(fresh)).snapshot).toEqual(fresh.snapshot);
  const resumed = await f.createConnection(), nextApproval = deferred<Awaited<ReturnType<typeof f.transport.restore>>[number]>();
  f.connect.mockResolvedValueOnce({ uri: "wc:synthetic-new-pairing", expiresAt: new Date(f.now().getTime() + 300_000).toISOString(), approval: nextApproval.promise });
  try {
    expect(f.run(() => f.workflow.currentConnectionContext()).connection?.sessionPresence).toBe("absent");
    expect(workflowViewSchema.parse(resumed.snapshot.data).allowedActions).toContain("connect");
    expect((await f.act(resumed, { action: "connect" })).error).toBeUndefined();
    await vi.waitFor(() => expect(f.connect).toHaveBeenCalledTimes(2));
    expect(f.run(() => f.records.currentConnection()?.connection.connectionId)).not.toBe(operation.connectionId);
    if (ending === "stop") expect((await f.read(original)).snapshot).toMatchObject({ state: "closed", reason: "cancelled" });
  } finally { nextApproval.reject(new Error("Synthetic second approval ended")); }
  expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});

it("keeps new pairing unavailable when an exact retained-topic check fails", async () => {
  const f = await fixture(), { connection } = await f.approve();
  const manage = await f.createDisconnection();
  await f.act(manage, { action: "disconnect", connectionId: connection.connectionId });
  await vi.waitFor(() => expect(f.run(() => f.records.currentConnection()?.sdkPending)).toBe(false));
  const confirmed = f.runtime.snapshot()!, getter = vi.spyOn(f.runtime, "snapshot").mockReturnValue({ ...confirmed, sessions: [] });
  const bind = f.runtime.bind.bind(f.runtime), check = vi.fn().mockRejectedValue(new Error("Synthetic exact session check unavailable"));
  const binding = vi.spyOn(f.runtime, "bind").mockImplementation(() => ({ ...bind(), checkSession: check }));
  let fresh: Awaited<ReturnType<typeof f.createConnection>>;
  try {
    fresh = await f.run(() => f.cards.create("connect", {}));
    expect(check).toHaveBeenCalledExactlyOnceWith("fixture-topic", connection.connectionId);
    expect(f.run(() => f.records.readConnectionFacts(f.now()).connectionPresence.confirmed)).toBe(false);
    expect(fresh.snapshot.state).toBe("ready");
    const input = f.connectionInput(fresh, { action: "connect" });
    expect((await f.run(() => f.cards.act({ cardId: fresh.snapshot.cardId, permission: fresh.permission,
      revision: fresh.snapshot.revision, input }))).error?.code).toBe("card_conflict");
    expect(f.run(() => f.records.operation(String(input.operationId)))).toBeUndefined(); expect(f.connect).toHaveBeenCalledOnce();
  } finally { getter.mockRestore(); binding.mockRestore(); }
  expect(workflowViewSchema.parse((await f.read(fresh!)).snapshot.data).allowedActions).toContain("connect");
  expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});

it("blocks unexpected SDK sessions without inventing another product connection", async () => {
  const f = await fixture(), { connection } = await f.approve();
  f.notify({ topic: "unexpected-session", grants: suiGrants([f.account]), expiresAt: connection.expiresAt });
  const current = f.run(() => f.workflow.currentConnectionContext());
  expect(current.connectionReconciliationRequired).toBe(true);
  expect(current.assetReadAccount).toEqual({ status: "available", account: f.account });
  expect(f.run(() => f.workflow.resolveReviewTarget())).toEqual({ status: "unavailable", reason: "connection_state_unconfirmed" });
  expect(f.run(() => f.records.connectionEligibility()).pairingAllowed).toBe(false);
  expect(f.run(() => f.records.connections())).toHaveLength(1);
  expect(f.transport.disconnect).not.toHaveBeenCalled(); expect(f.sign).not.toHaveBeenCalled();
});

it("preserves a fixed initial approval when later observation writers run", async () => {
  const f = await fixture(), { connection } = await f.approve();
  expect(() => f.run(() => f.records.updateConnection(connection.connectionId, { chainResults: [] } as never, f.now()))).toThrow(/fixed connection approval/i);
  expect(f.run(() => f.records.currentConnection()?.connection.chainResults)).toEqual(connection.chainResults);
});


it("refuses a new Disconnect for available but pending work before observation uncertainty", async () => {
  const f = await fixture(), { connection } = await f.approve(), held = deferred<void>();
  f.transport.disconnect = vi.fn(() => held.promise);
  const original = await f.createDisconnection();
  await f.act(original, { action: "disconnect", connectionId: connection.connectionId });
  expect(f.runtime.availability().status).toBe("available");
  expect(f.run(() => f.records.readConnectionFacts(f.now()).pendingOperation?.action)).toBe("disconnect");
  const db = new Database(join(f.directory, "activity.sqlite"));
  const count = () => db.prepare("SELECT count(*) AS n FROM live_read_cards").get();
  const before = count();
  try {
    await expect(f.createDisconnection()).rejects.toMatchObject({ reason: "operation_busy" });
    expect(count()).toEqual(before); expect(f.transport.disconnect).toHaveBeenCalledOnce();
  } finally { held.resolve(); db.close(); }
});

it("binds purpose at direct SQLite admission with a valid target and normal positive control", async () => {
  const f = await fixture(), wrong = await f.createConnection();
  const { connection } = await f.approve(), right = await f.createDisconnection();
  const good = f.connectionInput(right, { action: "disconnect", connectionId: connection.connectionId });
  const wrongRecord = f.run(() => f.cardRecords.get(wrong.snapshot.cardId))!;
  const rightRecord = f.run(() => f.cardRecords.get(right.snapshot.cardId))!;
  const { walletConnectionActionSchema } = await import("../src/core/session/walletConnectionOperations.js");
  const input = walletConnectionActionSchema.options[1].parse(good);
  const bad = { ...input, operationId: String(wrong.snapshot.input.operationId) };
  expect(wrongRecord.state.state).toBe("ready"); expect(f.run(() => f.records.isUsableConnection(connection.connectionId))).toBe(true);
  expect(() => f.run(() => f.records.admitDisconnect(wrongRecord, bad))).toThrow("fixed purpose, operation and target");
  expect(f.run(() => f.records.operation(bad.operationId))).toBeUndefined();
  expect(f.run(() => f.cardRecords.get(wrong.snapshot.cardId))).toEqual(wrongRecord);
  const admitted = f.run(() => f.records.admitDisconnect(rightRecord, input));
  expect(admitted.created).toBe(true); expect(f.run(() => f.records.operation(input.operationId)?.cardId)).toBe(right.snapshot.cardId);
  expect(f.transport.disconnect).not.toHaveBeenCalled(); expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});
