import { reviewViewSchema } from "../src/core/session/workflowView.js";
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { join } from "node:path";
import { walletWorkflowFixture, deferred } from "./fixtures/walletWorkflow.js";
import { settingsWorkflowFixture } from "./fixtures/settingsWorkflow.js";
import { closedReviewCardSchema, closedWalletCardSchema, workflowViewSchema } from "../src/core/session/workflowView.js";
import { suiGrants } from "./fixtures/walletGrants.js";
import type { WalletSession } from "../src/core/session/walletConnection.js";

const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
async function fixture() { const f = await walletWorkflowFixture(); closers.push(f.close); return f; }

it("admits one connection across two cards and keeps the active slot exclusive in SQLite", async () => {
  const f = await fixture(), a = await f.createConnection(), b = await f.createConnection();
  const outcomes = await Promise.all([f.act(a, { action: "connect" }), f.act(b, { action: "connect" })]);
  expect(outcomes.filter((result) => !result.error)).toHaveLength(1);
  expect(f.connect).toHaveBeenCalledOnce();
  const db = new Database(join(f.directory, "activity.sqlite"));
  try {
    expect(db.prepare("SELECT count(*) n FROM live_wallet_connections WHERE current_slot=1").get()).toEqual({ n: 1 });
    expect(() => db.prepare(`INSERT INTO live_wallet_connections(id,owner_id,status,revision,connection_json,current_slot,data_epoch)
      SELECT 'second','fixture-owner',status,revision,connection_json,1,data_epoch FROM live_wallet_connections WHERE current_slot=1`).run()).toThrow(/UNIQUE/);
  } finally { db.close(); }
  expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});

it("requires confirmed disconnection before another connection and never rebinds the old review", async () => {
  const f = await fixture(), a = await f.approve(), review = await f.prepare(a.connection.connectionId);
  const duplicate = await f.createConnection();
  expect(closedWalletCardSchema.parse(duplicate.snapshot.data).allowedActions).toEqual([]);
  expect(closedWalletCardSchema.parse(duplicate.snapshot.data).networks).toEqual([]);
  expect(duplicate.snapshot.data).not.toHaveProperty("walletName");
  expect((await f.act(duplicate, { action: "connect" })).error).toBeDefined();
  expect(f.connect).toHaveBeenCalledOnce();
  const held = deferred<void>(), disconnect = f.transport.disconnect;
  f.transport.disconnect = vi.fn(async (topic) => { await held.promise; await disconnect(topic); });
  const card = await f.createDisconnection();
  expect((await f.act(card, { action: "disconnect", connectionId: a.connection.connectionId })).error).toBeUndefined();
  expect(closedWalletCardSchema.parse((await f.createConnection()).snapshot.data).allowedActions).toEqual([]);
  held.resolve();
  await vi.waitFor(() => expect(f.run(() => f.records.currentConnection()?.sdkPending)).toBe(false));
  const b = await f.connectSession({ topic: "new-session", grants: suiGrants([f.account]), expiresAt: a.connection.expiresAt });
  expect(b.connection.connectionId).not.toBe(a.connection.connectionId);
  expect(closedReviewCardSchema.parse((await f.read(review.card)).snapshot.data).allowedActions).toEqual([]);
  expect(f.run(() => f.sessions.readReviewSession(review.session.id))?.walletConnectionId).toBe(a.connection.connectionId);
  expect(f.run(() => f.records.connections().filter((record) => record.current))).toHaveLength(1);
});

it("uses one address per chain and leaves an ambiguous chain unavailable without a selector", async () => {
  const f = await fixture();
  const session: WalletSession = { topic: "ambiguous", grants: suiGrants([f.account, `0x${"b".repeat(64)}`]), expiresAt: new Date(f.now().getTime() + 60000).toISOString() };
  const result = await f.connectSession(session);
  expect(result.connection.chainResults).toEqual([{ chainId: "sui:mainnet", status: "multiple_accounts" }]);
  expect(f.run(() => f.workflow.currentConnectionContext()).assetReadAccount).toEqual({ status: "address_required" });
  const card = await f.run(() => f.cards.create("disconnect", {}));
  expect(workflowViewSchema.parse(card.snapshot.data).allowedActions).toContain("disconnect");
  expect(workflowViewSchema.parse(card.snapshot.data).allowedActions).not.toContain("connect");
  await expect(f.run(() => f.cards.create("connect", { intent: "use_account", account: f.account }))).rejects.toThrow();
  expect(f.sign).not.toHaveBeenCalled();
});

it("reconciles an absent previous-owner connected record instead of keeping a permanent slot lock", async () => {
  const f = await fixture(), a = await f.approve();
  f.removeSession("fixture-topic");
  const db = new Database(join(f.directory, "activity.sqlite"));
  try {
    const recorded = { ...a.connection, status: "connected" };
    db.prepare("UPDATE live_wallet_connections SET owner_id='previous-owner',run_id='previous-run',status='connected',revision=?,connection_json=? WHERE id=?")
      .run(recorded.revision, JSON.stringify(recorded), a.connection.connectionId);
  } finally { db.close(); }
  f.run(() => f.records.applyWalletObservation(f.runtime.snapshot()!, undefined, true));
  expect(f.run(() => f.records.currentConnection())).toMatchObject({ ownerId: "fixture-owner", connection: { status: "disconnected" } });
  expect(f.run(() => f.records.connectionEligibility()).pairingAllowed).toBe(true);
  expect(f.connect).toHaveBeenCalledOnce(); expect(f.sign).not.toHaveBeenCalled();
});

it("transfers cleanup ownership for an old epoch without restoring its account or financial eligibility", async () => {
  const f = await fixture(), a = await f.approve();
  const db = new Database(join(f.directory, "activity.sqlite"));
  try {
    db.prepare("UPDATE settings_control SET data_epoch=data_epoch+1 WHERE id=1").run();
    db.prepare("UPDATE live_wallet_connections SET owner_id='previous-owner',run_id='previous-run' WHERE id=?").run(a.connection.connectionId);
  } finally { db.close(); }
  f.run(() => f.records.applyWalletObservation(f.runtime.snapshot()!, undefined, true));
  expect(f.run(() => f.records.isUsableConnection(a.connection.connectionId))).toBe(false);
  expect(await f.run(() => f.activity.getActiveAccount())).toBeUndefined();
  const card = await f.run(() => f.cards.create("disconnect", {}));
  expect(workflowViewSchema.parse(card.snapshot.data).allowedActions).toContain("disconnect");
  expect((await f.act(card, { action: "disconnect", connectionId: a.connection.connectionId })).error).toBeUndefined();
  await vi.waitFor(() => expect(f.run(() => f.records.currentConnection()?.sdkPending)).toBe(false));
  expect(f.run(() => f.records.connectionEligibility()).pairingAllowed).toBe(true);
  expect(f.run(() => f.records.currentConnection()?.dataEpoch)).toBe(0);
});

it("clears only the saved read address through Settings and preserves the fixed wallet and pending authority", async () => {
  const f = await settingsWorkflowFixture(); closers.push(f.close);
  const w = f.wallet, a = await w.approve(), review = await w.prepare(a.connection.connectionId);
  const held = deferred<{ transactionBytes: string; signature: string }>(), entered = deferred<void>();
  const sign = w.sign.getMockImplementation()!;
  let signed: Awaited<ReturnType<typeof sign>> | undefined;
  w.sign.mockImplementationOnce(async (input) => { signed = await sign(input); entered.resolve(); return held.promise; });
  await w.act(review.card, { action: "request_signature", connectionId: a.connection.connectionId, account: w.account, reviewRevision: review.session.reviewRevision });
  await entered.promise;
  const request = w.run(() => w.records.currentRequest(review.session.id))!;
  const authority = w.run(() => w.records.authority(request.attemptId))!;
  expect(request.requestStatus).toBe("awaiting_signature"); expect(authority.sdk_pending).toBe(1);
  const card = await f.create();
  const operationId = (card.snapshot.data as { operationId: string }).operationId;
  const command = { action: "settings_clear_read_address", operationId, connectionId: a.connection.connectionId, account: w.account };
  expect((await f.act(card, command)).error).toBeUndefined();
  expect(await w.run(() => w.activity.getActiveAccount())).toBeUndefined();
  expect(w.run(() => w.records.currentConnection())).toMatchObject({ readAddressCleared: true, connection: { status: "connected", chainResults: [{ status: "bound", address: w.account }] } });
  expect(w.run(() => w.workflow.currentConnectionContext()).assetReadAccount).toEqual({ status: "address_required", reason: "read_address_cleared" });
  w.run(() => w.records.applyWalletObservation(w.runtime.snapshot()!, undefined, true));
  expect(await w.run(() => w.activity.getActiveAccount())).toBeUndefined();
  expect((await f.act(card, command)).error).toBeUndefined();
  expect(w.run(() => w.workflow.resolveReviewTarget())).toMatchObject({ status: "available", account: w.account });
  expect(w.run(() => w.records.currentRequest(review.session.id))).toEqual(request);
  expect(w.run(() => w.records.authority(request.attemptId))).toEqual(authority);
  expect(w.transport.disconnect).not.toHaveBeenCalled(); expect(w.sign).toHaveBeenCalledOnce(); expect(w.submit).not.toHaveBeenCalled();
  expect((await f.act(card, { ...command, operationId: randomUUID() })).error).toBeDefined();
  held.resolve(signed!);
  await vi.waitFor(() => expect(w.run(() => w.records.currentRequest(review.session.id)?.requestStatus)).toBe("completed"));
  expect(w.sign).toHaveBeenCalledOnce(); expect(w.submit).toHaveBeenCalledOnce();
  const manage = await w.run(() => w.cards.create("disconnect", {}));
  await w.act(manage, { action: "disconnect", connectionId: a.connection.connectionId });
  await vi.waitFor(() => expect(w.run(() => w.records.currentConnection()?.sdkPending)).toBe(false));
  const nextAccount = `0x${"b".repeat(64)}`;
  const next = await w.connectSession({ topic: "after-read-clear", grants: suiGrants([nextAccount]), expiresAt: a.connection.expiresAt });
  expect(w.run(() => w.records.currentConnection()?.readAddressCleared)).toBe(false);
  expect(await w.run(() => w.activity.getActiveAccount())).toMatchObject({ address: nextAccount, connectionId: next.connection.connectionId });
  expect((await f.act(card, command)).error).toBeUndefined();
  expect(await w.run(() => w.activity.getActiveAccount())).toMatchObject({ address: nextAccount });
});

it("keeps every Disconnect card scoped to its original connection", async () => {
  const f = await fixture(), a = await f.approve();
  const scoped = await f.run(() => f.cards.create("disconnect", {}));
  expect(scoped.snapshot.input.connectionId).toBe(a.connection.connectionId);
  const manage = await f.run(() => f.cards.create("disconnect", {}));
  await f.act(manage, { action: "disconnect", connectionId: a.connection.connectionId });
  await vi.waitFor(() => expect(f.run(() => f.records.currentConnection()?.sdkPending)).toBe(false));
  const b = await f.connectSession({ topic: "replacement-topic", grants: suiGrants([f.account]), expiresAt: a.connection.expiresAt });
  const current = await f.read(scoped), view = closedWalletCardSchema.parse(current.snapshot.data);
  expect(current.snapshot.input.connectionId).toBe(a.connection.connectionId);
  expect(current.snapshot.state).toBe("closed"); expect(view.allowedActions).toEqual([]);
  expect(current.snapshot.data).not.toHaveProperty("connection");
  expect(f.run(() => f.workflow.currentConnectionContext()).connection?.connectionId).toBe(b.connection.connectionId);
  const rejected = await f.act(current, { action: "disconnect", connectionId: b.connection.connectionId });
  expect(rejected.error?.code).toBe("card_conflict");
  expect(f.transport.disconnect).toHaveBeenCalledExactlyOnceWith("fixture-topic");
  expect((await f.act(await f.createDisconnection(), { action: "disconnect", connectionId: b.connection.connectionId })).error).toBeUndefined();
  await vi.waitFor(() => expect(f.run(() => f.records.currentConnection()?.sdkPending)).toBe(false));
  expect(f.transport.disconnect).toHaveBeenLastCalledWith("replacement-topic");
  expect((await f.act(await f.read(scoped), { action: "connect" })).error?.code).toBe("card_conflict");
  expect((await f.read(manage)).snapshot.data).toMatchObject({ allowedActions: [] });
  expect(f.connect).toHaveBeenCalledTimes(2); expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});

it("requires an immutable target before creating a signable card and never fills it from a replacement wallet", async () => {
  const f = await fixture(), a = await f.approve();
  const { session } = await f.run(() => f.sessions.createReviewSession([f.plan], f.now()));
  await expect(f.run(() => f.cards.create("review", { reviewSessionId: session.id }))).rejects.toThrow("fixed wallet connection and account");
  const input = f.reviewInput(session.id), card = await f.run(() => f.cards.create("review", input));
  const manage = await f.run(() => f.cards.create("disconnect", {}));
  await f.act(manage, { action: "disconnect", connectionId: a.connection.connectionId });
  await vi.waitFor(() => expect(f.run(() => f.records.currentConnection()?.sdkPending)).toBe(false));
  const b = await f.connectSession({ topic: "immutable-replacement", grants: suiGrants([f.account]), expiresAt: a.connection.expiresAt });
  const current = await f.read(card), view = closedReviewCardSchema.parse(current.snapshot.data);
  expect(view.reviewTarget).toEqual({ connectionId: a.connection.connectionId, account: f.account });
  expect(view.allowedActions).toEqual([]); expect(current.snapshot.data).not.toHaveProperty("automaticAction");
  expect((await f.act(current, { action: "prepare_review", connectionId: b.connection.connectionId, account: f.account, reviewRevision: 0 })).error?.code).toBe("card_conflict");
  expect(f.quote).not.toHaveBeenCalled(); expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
  const bound = await f.prepare(b.connection.connectionId);
  const original = f.run(() => f.sessions.readReviewSession(bound.session.id));
  for (const target of [
    { connectionId: a.connection.connectionId, account: f.account },
    { connectionId: b.connection.connectionId, account: `0x${"c".repeat(64)}` }
  ]) {
    await expect(f.run(() => f.cards.create("review", { reviewSessionId: bound.session.id, ...target })))
      .rejects.toThrow("fixed wallet connection and account");
  }
  expect(f.run(() => f.sessions.readReviewSession(bound.session.id))).toEqual(original);
  expect(f.run(() => f.records.currentRequest(bound.session.id))).toBeUndefined();
  expect(f.quote).toHaveBeenCalledOnce(); expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});

it("blocks new preparation and signing on existing valid cards when an unrecorded SDK session appears", async () => {
  const f = await fixture(), { connection } = await f.approve(), ready = await f.prepare(connection.connectionId);
  const { session } = await f.run(() => f.sessions.createReviewSession([f.plan], f.now()));
  const unprepared = await f.run(() => f.cards.create("review", f.reviewInput(session.id)));
  f.notify({ topic: "unrecorded-after-review", grants: suiGrants([f.account]), expiresAt: connection.expiresAt });
  expect(f.runtime.availability().status).toBe("available");
  expect(f.run(() => f.records.isUsableConnection(connection.connectionId))).toBe(true);
  const material = await f.run(() => f.sessions.prepareReviewedTransaction(ready.session.id, ready.session.plans[0]!.id, f.account, f.now()));
  expect(material.account).toBe(f.account);
  for (const [card, action, reviewRevision] of [[unprepared, "prepare_review", 0], [ready.card, "request_signature", ready.session.reviewRevision]] as const) {
    const current = await f.read(card), view = reviewViewSchema.parse(current.snapshot.data);
    expect(view.nextStep.reason).toBe("connection_state_unconfirmed");
    expect(view.reviewTarget).toEqual({ connectionId: connection.connectionId, account: f.account });
    expect((await f.act(current, { action, connectionId: connection.connectionId, account: f.account, reviewRevision })).error?.message).toBe("That action is not available right now.");
  }
  expect(f.run(() => f.records.currentRequest(ready.session.id))).toBeUndefined();
  expect(f.run(() => f.sessions.readReviewSession(session.id)?.preparationId)).toBeUndefined();
  expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled(); expect(f.quote).toHaveBeenCalledOnce();
  f.removeSession("unrecorded-after-review");
  expect((await f.act(await f.read(unprepared), { action: "prepare_review", connectionId: connection.connectionId, account: f.account, reviewRevision: 0 })).error).toBeUndefined();
  await vi.waitFor(() => expect(f.run(() => f.sessions.readReviewSession(session.id)?.status)).toBe("ready_for_wallet_review"));
});

it("keeps same-address transaction exclusion across disconnect and reconnect until the original result settles", async () => {
  const f = await fixture(), first = await f.approve(), a = await f.prepare(first.connection.connectionId);
  const lookup = deferred<Awaited<ReturnType<typeof f.chainRead>>>(), chainRead = f.chainRead.getMockImplementation()!;
  f.chainRead.mockImplementationOnce(() => lookup.promise);
  await f.act(a.card, { action: "request_signature", connectionId: first.connection.connectionId, account: f.account, reviewRevision: a.session.reviewRevision });
  await vi.waitFor(() => expect(f.run(() => f.records.authority(f.records.currentRequest(a.session.id)!.attemptId)?.lookup_pending)).toBe(1));
  const request = f.run(() => f.records.currentRequest(a.session.id))!;
  const disconnect = await f.run(() => f.cards.create("disconnect", {}));
  await f.act(disconnect, { action: "disconnect", connectionId: first.connection.connectionId });
  await vi.waitFor(() => expect(f.run(() => f.records.currentConnection()?.connection.status)).toBe("disconnected"));
  const next = await f.connectSession({ topic: "same-address-reconnection", grants: suiGrants([f.account]), expiresAt: first.connection.expiresAt });
  expect(f.run(() => f.workflow.resolveReviewTarget())).toEqual({ status: "available", connectionId: next.connection.connectionId, account: f.account });
  const { session } = await f.run(() => f.sessions.createReviewSession([f.plan], f.now()));
  const card = await f.run(() => f.cards.create("review", { reviewSessionId: session.id, account: f.account, connectionId: next.connection.connectionId }));
  const refused = await f.act(card, { action: "prepare_review", connectionId: next.connection.connectionId, account: f.account, reviewRevision: 0 });
  expect(refused.error).toEqual({ code: "card_conflict", message: "Another wallet request or transaction result for this account is still pending." });
  expect(f.run(() => f.records.currentRequest(session.id))).toBeUndefined();
  expect(f.sign).toHaveBeenCalledOnce(); expect(f.submit).toHaveBeenCalledOnce();
  expect(f.run(() => f.records.currentRequest(a.session.id))).toMatchObject({ attemptId: request.attemptId, transactionDigest: request.transactionDigest, requestStatus: "awaiting_chain_result" });
  lookup.resolve(await chainRead());
  await vi.waitFor(() => expect(f.run(() => f.records.currentRequest(a.session.id)?.requestStatus)).toBe("completed"));
  const refreshed = await f.read(card);
  expect((await f.act(refreshed, { action: "prepare_review", connectionId: next.connection.connectionId, account: f.account, reviewRevision: 0 })).error).toBeUndefined();
  await vi.waitFor(() => expect(f.run(() => f.sessions.readReviewSession(session.id)?.status)).toBe("ready_for_wallet_review"));
  expect(f.sign).toHaveBeenCalledOnce(); expect(f.submit).toHaveBeenCalledOnce();
});

it("rejects a second signature admission for the same account with a valid ready review and proceeds once the first ends", async () => {
  const f = await fixture(), { connection } = await f.approve(), a = await f.prepare(connection.connectionId), b = await f.prepare(connection.connectionId);
  const pending = deferred<{ transactionBytes: string; signature: string }>(), signed = f.sign.getMockImplementation()!;
  let response: Awaited<ReturnType<typeof signed>> | undefined;
  f.sign.mockImplementationOnce(async (input) => { response = await signed(input); return pending.promise; });
  await f.act(a.card, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: a.session.reviewRevision });
  await vi.waitFor(() => expect(response).toBeDefined());
  const second = await f.read(b.card), input = { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: b.session.reviewRevision };
  expect((await f.act(second, input)).error).toEqual({ code: "card_conflict", message: "Another wallet request or transaction result for this account is still pending." });
  expect(f.run(() => f.records.currentRequest(b.session.id))).toBeUndefined(); expect(f.sign).toHaveBeenCalledOnce();
  pending.resolve(response!);
  await vi.waitFor(() => expect(f.run(() => f.records.currentRequest(a.session.id)?.requestStatus)).toBe("completed"));
  expect((await f.act(await f.read(b.card), input)).error).toBeUndefined();
  await vi.waitFor(() => expect(f.run(() => f.records.currentRequest(b.session.id)?.requestStatus)).toBe("completed"));
  expect(f.sign).toHaveBeenCalledTimes(2); expect(f.submit).toHaveBeenCalledTimes(2);
});

it("checks a retained topic missing from the ready snapshot before releasing old-owner occupancy", async () => {
  const f = await fixture(), { connection } = await f.approve();
  const db = new Database(join(f.directory, "activity.sqlite"));
  try { db.prepare("UPDATE live_wallet_connections SET owner_id='old-owner',run_id='old-run' WHERE id=?").run(connection.connectionId); }
  finally { db.close(); }
  const originalSnapshot = f.runtime.snapshot.bind(f.runtime), before = originalSnapshot()!;
  const snapshot = vi.spyOn(f.runtime, "snapshot").mockReturnValue({ ...before, sessions: [] });
  f.run(() => f.records.applyWalletObservation(f.runtime.snapshot()!, undefined, true));
  expect(f.run(() => f.records.connectionEligibility()).pairingAllowed).toBe(false);
  vi.spyOn(f.transport, "session").mockReturnValue(undefined);
  const bind = f.runtime.bind.bind(f.runtime), check = vi.fn();
  vi.spyOn(f.runtime, "bind").mockImplementation(() => {
    const run = bind(); return { ...run, checkSession: async (...args) => { check(...args); snapshot.mockRestore(); return run.checkSession(...args); } };
  });
  const card = await f.createConnection();
  expect(check).toHaveBeenCalledExactlyOnceWith("fixture-topic", connection.connectionId);
  expect(workflowViewSchema.parse(card.snapshot.data).allowedActions).toContain("connect");
  expect(f.run(() => f.records.currentConnection())).toMatchObject({ ownerId: "fixture-owner", connection: { status: "disconnected" } });
  expect(f.connect).toHaveBeenCalledOnce(); expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});

it.each(["stale_connection", "result_write_failure"] as const)("keeps read-address clearing atomic across %s", async (failure) => {
  const f = await settingsWorkflowFixture(); closers.push(f.close);
  const w = f.wallet, a = await w.approve();
  let card = await f.create(); const operationId = (card.snapshot.data as { operationId: string }).operationId;
  const input = { action: "settings_clear_read_address", operationId, connectionId: a.connection.connectionId, account: w.account };
  const db = new Database(join(w.directory, "activity.sqlite"));
  try {
    if (failure === "stale_connection") {
      const disconnect = await w.run(() => w.cards.create("disconnect", {}));
      await w.act(disconnect, { action: "disconnect", connectionId: a.connection.connectionId });
      await vi.waitFor(() => expect(w.run(() => w.records.currentConnection()?.sdkPending)).toBe(false));
      await w.connectSession({ topic: "new-same-address-source", grants: suiGrants([w.account]), expiresAt: a.connection.expiresAt });
      card = await f.read(card);
      expect((await f.act(card, input)).error?.code).toBe("card_conflict");
    } else {
      db.exec("CREATE TRIGGER reject_clear_result BEFORE UPDATE OF result_json ON settings_operations WHEN NEW.phase='terminal' BEGIN SELECT RAISE(ABORT,'synthetic clear result failure'); END");
      await expect(f.act(card, input)).rejects.toThrow("synthetic clear result failure");
      db.exec("DROP TRIGGER reject_clear_result");
    }
    expect(w.run(() => w.records.currentConnection()?.readAddressCleared)).toBe(false);
    expect(await w.run(() => w.activity.getActiveAccount())).toMatchObject({ address: w.account });
    expect(w.run(() => f.records.get(operationId)?.result)).toBeUndefined();
    expect(w.run(() => f.records.control().active_operation_id)).toBeNull();
    const current = w.run(() => w.records.currentConnection())!;
    card = await f.read(card);
    expect((await f.act(card, { ...input, connectionId: current.connection.connectionId })).error).toBeUndefined();
    expect(await w.run(() => w.activity.getActiveAccount())).toBeUndefined();
    expect(w.sign).not.toHaveBeenCalled(); expect(w.submit).not.toHaveBeenCalled();
  } finally { db.exec("DROP TRIGGER IF EXISTS reject_clear_result"); db.close(); }
});
