import { afterEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { walletWorkflowFixture, deferred } from "./fixtures/walletWorkflow.js";
import { workflowViewSchema, reviewWalletChoices } from "../src/core/session/workflowView.js";
import type { WalletSession } from "../src/core/session/walletConnection.js";

const fixtures: Awaited<ReturnType<typeof walletWorkflowFixture>>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
async function fixture() { const f = await walletWorkflowFixture(); fixtures.push(f); return f; }

it.each(["missing", "stale_run"] as const)("does not confirm an unconfirmed snapshot reader input (%s)", async (kind) => {
  const f = await fixture(); await f.approve();
  const snapshot = f.runtime.snapshot()!;
  expect(f.run(() => f.records.readConnectionFacts(f.now())).connectionPresence.confirmed).toBe(true);
  // This is a private reader contract input, not a claim that an available
  // product runtime publishes a malformed or missing snapshot.
  const getter = vi.spyOn(f.runtime, "snapshot").mockReturnValue(kind === "missing" ? undefined : { ...snapshot, runId: randomUUID() });
  try {
    const facts = f.run(() => f.records.readConnectionFacts(f.now()));
    expect(facts.evaluatedAt).toBe(f.now().toISOString());
    expect(facts.connectionPresence).toEqual({ confirmed: false, connections: [], unrecorded: false, pendingConnectionIds: [] });
    expect(facts.activeAccountConnectionId).toBe(f.run(() => f.records.connections()[0]!.connection.connectionId));
  } finally { getter.mockRestore(); }
  expect(f.run(() => f.records.readConnectionFacts(f.now())).connectionPresence.confirmed).toBe(true);
  expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});
async function storedConnections(count: number, previousOwner = false, selection?: "selected" | "cleared") {
  const f = await fixture();
  // These approved sessions are an external input, not new pairing admissions.
  // Equal names and addresses deliberately require exact connection identity.
  let sessions: WalletSession[] = Array.from({ length: count }, (_, i) => ({ topic: `stored-${i}`, accounts: [f.account],
    methods: ["sui_signTransaction"], chain: "sui:mainnet", expiresAt: new Date(f.now().getTime() + 60_000).toISOString(), walletName: "Same wallet" }));
  const saved = sessions.map((session) => f.run(() => f.records.restoreConnection(session, f.now())));
  if (selection) {
    await f.run(() => f.activity.setActiveAccount(f.account, "wallet_connection", f.now(), { id: saved[0]!.connection.connectionId }));
    if (selection === "cleared") await f.run(() => f.activity.clearActiveAccount(f.now()));
  }
  if (previousOwner) {
    const db = new Database(join(f.directory, "activity.sqlite"));
    try { db.prepare("UPDATE live_wallet_connections SET owner_id=?").run("previous-owner"); } finally { db.close(); }
  }
  vi.spyOn(f.transport, "session").mockImplementation((topic) => sessions.find((item) => item.topic === topic));
  vi.spyOn(f.transport, "inspectAll").mockImplementation(() => sessions.map((session) => ({ topic: session.topic, status: "present", session })));
  vi.mocked(f.transport.disconnect).mockImplementation(async (topic) => { sessions = sessions.filter((item) => item.topic !== topic); });
  f.observe();
  // Owner transfer belongs to the initial complete restoration transaction,
  // never to an ordinary command-time session check.
  if (previousOwner) f.run(() => f.records.applyWalletObservation(f.runtime.snapshot()!, undefined, true));
  const manage = () => f.run(() => f.cards.create("connect", { intent: "manage" }));
  return { f, saved, manage, removeSession(topic: string) { sessions = sessions.filter((item) => item.topic !== topic); f.observe(); } };
}

it.each([false, true])("resolves all stored connections by exact disconnect, including prior owner=%s", async (previousOwner) => {
  const { f, saved, manage } = await storedConnections(3, previousOwner);
  let card = await manage();
  const initial = workflowViewSchema.parse(card.snapshot.data);
  expect(initial.walletAvailability.status).toBe("available");
  expect(initial.connectionConflict).toEqual({ reason: "multiple_connections", connectionIds: saved.map((r) => r.connection.connectionId).sort() });
  expect(initial.allowedActions).toContain("disconnect");
  for (const action of ["connect", "use_account", "restart_wallet_service"]) expect(initial.allowedActions).not.toContain(action);
  expect(f.run(() => f.workflow.reconcileConnectionContext()).assetReadAccount).toEqual({ status: "address_required" });
  expect((await f.act(card, { action: "use_account", connectionId: saved[0]!.connection.connectionId, account: f.account })).error?.code).toBe("card_conflict");
  for (let index = 0; index < saved.length; index++) {
    card = await manage();
    const target = saved[index]!.connection.connectionId;
    expect((await f.act(card, { action: "disconnect", connectionId: target })).error).toBeUndefined();
    await vi.waitFor(() => expect(f.run(() => f.records.connection(target)?.connection.status)).toBe("disconnected"));
    expect(f.transport.disconnect).toHaveBeenLastCalledWith(`stored-${index}`);
    for (const untouched of saved.slice(index + 1)) expect(f.run(() => f.records.connection(untouched.connection.connectionId)?.connection.status)).toBe("connected");
    const next = workflowViewSchema.parse((await manage()).snapshot.data);
    expect(!!next.connectionConflict).toBe(saved.length - index - 1 > 1);
    if (index === 1) expect(next.allowedActions).toContain("use_account");
    if (index === 2) {
      expect(next.allowedActions).toContain("connect");
      expect(next.allowedActions).not.toContain("disconnect");
      expect(next.automaticAction).toBeUndefined();
    }
  }
  expect(f.transport.disconnect).toHaveBeenCalledTimes(3);
  expect(f.connect).not.toHaveBeenCalled(); expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});

it("keeps manual manage pairing distinct from automatic connect and rejects retired restart input", async () => {
  const f = await fixture();
  const card = await f.run(() => f.cards.create("connect", { intent: "manage" }));
  expect(workflowViewSchema.parse(card.snapshot.data).allowedActions).toEqual(["cancel", "connect"]);
  expect(workflowViewSchema.parse(card.snapshot.data).automaticAction).toBeUndefined();
  expect(f.connect).not.toHaveBeenCalled();
  expect((await f.act(card, { action: "restart_wallet_service" })).error).toBeDefined();
  expect((await f.act(card, { action: "connect" })).error).toBeUndefined();
  expect(f.connect).toHaveBeenCalledOnce();
  const other = await f.createConnection();
  expect(workflowViewSchema.parse(other.snapshot.data).allowedActions).not.toContain("connect");
});

it("rejects an old confirmation after another card admits a conflicting-target disconnect", async () => {
  const { f, saved, manage, removeSession } = await storedConnections(2);
  const a = await manage(), b = await manage(), pending = deferred<void>();
  vi.mocked(f.transport.disconnect).mockImplementationOnce(() => pending.promise);
  expect((await f.act(a, { action: "disconnect", connectionId: saved[0]!.connection.connectionId })).error).toBeUndefined();
  expect((await f.act(b, { action: "disconnect", connectionId: saved[1]!.connection.connectionId })).error?.code).toBe("card_conflict");
  expect(f.transport.disconnect).toHaveBeenCalledOnce();
  expect(workflowViewSchema.parse((await manage()).snapshot.data).connectionConflict).toBeDefined();
  pending.reject(new Error("The relay did not confirm removal."));
  await vi.waitFor(() => expect(f.run(() => f.records.connection(saved[0]!.connection.connectionId)?.sdkPending)).toBe(false));
  expect(f.run(() => f.records.connection(saved[0]!.connection.connectionId)?.connection.status)).toBe("failed");
  f.observe();
  expect(workflowViewSchema.parse((await manage()).snapshot.data).connectionConflict?.connectionIds).toEqual(saved.map((r) => r.connection.connectionId).sort());
  expect(f.run(() => f.records.connection(saved[0]!.connection.connectionId)?.connection.status)).toBe("failed");
  removeSession(saved[0]!.topic!);
  expect(workflowViewSchema.parse((await manage()).snapshot.data).connectionConflict).toBeUndefined();
});

it("rolls back conflict-target admission when publishing the new choices fails", async () => {
  const { f, saved, manage } = await storedConnections(2), card = await manage(), other = await manage();
  const db = new Database(join(f.directory, "activity.sqlite"));
  try {
    db.exec(`CREATE TRIGGER reject_choices BEFORE UPDATE ON live_read_cards WHEN OLD.id='${other.snapshot.cardId}' BEGIN SELECT RAISE(ABORT,'fixture choice write failed'); END`);
    await expect(f.act(card, { action: "disconnect", connectionId: saved[0]!.connection.connectionId })).rejects.toThrow("fixture choice write failed");
    expect(f.run(() => f.cardRecords.get(card.snapshot.cardId)?.acceptedInput)).toBeUndefined();
    expect(f.transport.disconnect).not.toHaveBeenCalled();
    expect(f.run(() => f.records.connection(saved[0]!.connection.connectionId)?.sdkPending)).toBe(false);
  } finally { db.exec("DROP TRIGGER reject_choices"); db.close(); }
});

it.each([true, false])("qualifies a saved same-address selection by its original connection (remove selected=%s)", async (removeSelected) => {
  const { f, saved, manage } = await storedConnections(2);
  // Legacy input: the user selected the first session before multiple-session
  // data was opened by this version. The address alone cannot choose a session.
  const selected = saved[0]!.connection, other = saved[1]!.connection;
  await f.run(() => f.activity.setActiveAccount(f.account, "wallet_connection", f.now(), { id: selected.connectionId }));
  expect(f.run(() => f.workflow.reconcileConnectionContext()).assetReadAccount.status).toBe("address_required");
  const removed = removeSelected ? selected : other, remaining = removeSelected ? other : selected;
  expect((await f.act(await manage(), { action: "disconnect", connectionId: removed.connectionId })).error).toBeUndefined();
  await vi.waitFor(() => expect(f.run(() => f.records.connection(removed.connectionId)?.sdkPending)).toBe(false));
  const card = await manage(), view = workflowViewSchema.parse(card.snapshot.data);
  expect(view.usableConnectionId).toBe(remaining.connectionId);
  expect(view.assetReadAccount).toEqual(removeSelected ? { status: "address_required" } : { status: "available", account: f.account });
  expect(f.run(() => f.workflow.reconcileConnectionContext()).assetReadAccount).toEqual(view.assetReadAccount);
  expect(await f.run(() => f.activity.getActiveAccount())).toMatchObject({ address: f.account, walletId: selected.connectionId });
  const { session } = await f.run(() => f.sessions.createReviewSession([f.plan], f.now()));
  const review = await f.run(() => f.cards.create("review", { reviewSessionId: session.id }));
  if (removeSelected) {
    expect(workflowViewSchema.parse(review.snapshot.data).automaticAction).toBeUndefined();
    expect((await f.act(review, { action: "prepare_review", connectionId: remaining.connectionId, account: f.account, reviewRevision: 0 })).error).toBeDefined();
    expect(f.quote).not.toHaveBeenCalled();
    expect((await f.act(card, { action: "use_account", connectionId: remaining.connectionId, account: f.account })).error).toBeUndefined();
    expect(await f.run(() => f.activity.getActiveAccount())).toMatchObject({ walletId: remaining.connectionId });
  }
  expect(workflowViewSchema.parse((await f.read(review)).snapshot.data).automaticAction).toMatchObject({ action: "prepare_review", connectionId: remaining.connectionId, account: f.account });
  expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});

it.each(["cleared", "missing_source", "different_source"] as const)("requires explicit selection for %s without deleting stored history", async (kind) => {
  const f = await fixture(), { connection } = await f.approve();
  if (kind === "cleared") await f.run(() => f.activity.clearActiveAccount(f.now()));
  else await f.run(() => f.activity.setActiveAccount(f.account, "wallet_connection", f.now(), kind === "missing_source" ? undefined : { id: "historical-connection" }));
  const before = await f.run(() => f.activity.getActiveAccount());
  for (let i = 0; i < 2; i++) expect(f.run(() => f.workflow.reconcileConnectionContext()).assetReadAccount).toEqual({ status: "address_required" });
  expect(await f.run(() => f.activity.getActiveAccount())).toEqual(before);
  const card = await f.run(() => f.cards.create("connect", { intent: "manage" }));
  expect(workflowViewSchema.parse(card.snapshot.data)).toMatchObject({ usableConnectionId: connection.connectionId, assetReadAccount: { status: "address_required" } });
  expect((await f.act(card, { action: "use_account", connectionId: connection.connectionId, account: f.account })).error).toBeUndefined();
  expect(f.run(() => f.workflow.reconcileConnectionContext()).assetReadAccount).toEqual({ status: "available", account: f.account });
  expect(f.connect).toHaveBeenCalledOnce(); expect(f.sign).not.toHaveBeenCalled();
});

it.each([-1, 0, 1])("keeps SDK occupancy separate from backend expiry for every published choice (offset=%s)", async (offset) => {
  const { f, saved, manage, removeSession } = await storedConnections(2);
  const selected = saved[0]!.connection, expiring = saved[1]!.connection;
  await f.run(() => f.activity.setActiveAccount(f.account, "wallet_connection", f.now(), { id: selected.connectionId }));
  const expiry = f.now().getTime() + 1000;
  f.run(() => f.records.updateConnection(expiring.connectionId, { expiresAt: new Date(expiry).toISOString() }, f.now()));
  f.advance(1000 + offset); // No new SDK observation: rows remain recorded facts.
  const view = workflowViewSchema.parse((await manage()).snapshot.data);
  expect(f.run(() => f.records.connection(expiring.connectionId)?.connection.status)).toBe("connected");
  const { session } = await f.run(() => f.sessions.createReviewSession([f.plan], f.now()));
  const reviewCard = await f.run(() => f.cards.create("review", { reviewSessionId: session.id }));
  const review = workflowViewSchema.parse(reviewCard.snapshot.data);
  expect(view.connectionConflict?.connectionIds).toHaveLength(2);
  expect(view.usableConnectionId).toBeUndefined(); expect(review.automaticAction).toBeUndefined();
  expect(f.run(() => f.workflow.reconcileConnectionContext()).assetReadAccount).toEqual(view.assetReadAccount);
  // Expiry does not contradict the still-present external SDK session. A
  // separately seeded absence observation releases that occupied slot.
  removeSession(saved[1]!.topic!);
  const single = workflowViewSchema.parse((await manage()).snapshot.data);
  const resumed = workflowViewSchema.parse((await f.read(reviewCard)).snapshot.data);
  expect(single.connectionConflict).toBeUndefined(); expect(single.usableConnectionId).toBe(selected.connectionId);
  expect(single.assetReadAccount).toEqual({ status: "available", account: f.account });
  expect(reviewWalletChoices(resumed, f.account).map((item) => item.connectionId)).toEqual([selected.connectionId]);
  expect(resumed.automaticAction).toMatchObject({ action: "prepare_review", connectionId: selected.connectionId });
  expect(f.transport.disconnect).not.toHaveBeenCalled(); expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});

it("does not extend SDK session expiry using a longer recorded lifetime", async () => {
  const f = await fixture(), { connection } = await f.approve();
  f.run(() => f.records.updateConnection(connection.connectionId, { expiresAt: new Date(Date.parse(connection.expiresAt) + 60_000).toISOString() }, f.now()));
  f.advance(Date.parse(connection.expiresAt) - f.now().getTime());
  const card = await f.run(() => f.cards.create("connect", { intent: "manage" }));
  expect(workflowViewSchema.parse(card.snapshot.data)).toMatchObject({ manageableConnectionIds: [connection.connectionId],
    allowedActions: ["cancel", "disconnect"], assetReadAccount: { status: "address_required" } });
  expect(workflowViewSchema.parse(card.snapshot.data).usableConnectionId).toBeUndefined();
  expect(f.connect).toHaveBeenCalledOnce(); expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});

it("keeps an expired pending disconnect locked until its own outcome is recorded", async () => {
  const f = await fixture(), { connection } = await f.approve(), held = deferred<void>();
  vi.mocked(f.transport.disconnect).mockImplementationOnce(() => held.promise);
  const manage = () => f.run(() => f.cards.create("connect", { intent: "manage" }));
  await f.act(await manage(), { action: "disconnect", connectionId: connection.connectionId });
  f.advance(Date.parse(connection.expiresAt) - f.now().getTime());
  const view = workflowViewSchema.parse((await manage()).snapshot.data);
  expect(view.usableConnectionId).toBeUndefined(); expect(view.assetReadAccount?.status).toBe("address_required");
  expect(view.allowedActions).not.toContain("connect"); expect(view.allowedActions).not.toContain("use_account");
  held.reject(new Error("Fixture remote removal was not confirmed"));
  await vi.waitFor(() => expect(f.run(() => f.records.connection(connection.connectionId)?.sdkPending)).toBe(false));
  expect(f.run(() => f.records.connection(connection.connectionId)?.connection.status)).toBe("failed");
  expect(workflowViewSchema.parse((await manage()).snapshot.data).allowedActions).not.toContain("connect");
  f.notify();
  expect(workflowViewSchema.parse((await manage()).snapshot.data).allowedActions).toContain("connect");
  expect(f.transport.disconnect).toHaveBeenCalledOnce();
});

it("rolls back the selected source, consumption and publication together", async () => {
  const f = await fixture(), { connection } = await f.approve();
  await f.run(() => f.activity.clearActiveAccount(f.now()));
  const card = await f.run(() => f.cards.create("connect", { intent: "manage" }));
  const other = await f.run(() => f.cards.create("connect", { intent: "manage" }));
  const db = new Database(join(f.directory, "activity.sqlite"));
  try {
    db.exec(`CREATE TRIGGER reject_selected_source BEFORE UPDATE ON live_read_cards WHEN OLD.id='${other.snapshot.cardId}' BEGIN SELECT RAISE(ABORT,'fixture selection publication failure'); END`);
    await expect(f.act(card, { action: "use_account", connectionId: connection.connectionId, account: f.account })).rejects.toThrow("fixture selection publication failure");
    expect(await f.run(() => f.activity.getActiveAccount())).toBeUndefined();
    expect(f.run(() => f.cardRecords.get(card.snapshot.cardId)?.acceptedInput)).toBeUndefined();
    db.exec("DROP TRIGGER reject_selected_source");
    expect((await f.act(card, { action: "use_account", connectionId: connection.connectionId, account: f.account })).error).toBeUndefined();
    expect(await f.run(() => f.activity.getActiveAccount())).toMatchObject({ walletId: connection.connectionId, address: f.account });
  } finally { db.exec("DROP TRIGGER IF EXISTS reject_selected_source"); db.close(); }
});

it.each(["selected", "cleared"] as const)("preserves %s source context through complete prior-owner restoration", async (selection) => {
  const { f, saved, manage } = await storedConnections(1, true, selection);
  const view = workflowViewSchema.parse((await manage()).snapshot.data);
  expect(view.usableConnectionId).toBe(saved[0]!.connection.connectionId);
  expect(view.assetReadAccount).toEqual(selection === "selected" ? { status: "available", account: f.account } : { status: "address_required" });
  expect(f.run(() => f.records.connection(saved[0]!.connection.connectionId)?.ownerId)).toBe("fixture-owner");
  expect(f.connect).not.toHaveBeenCalled(); expect(f.sign).not.toHaveBeenCalled();
});

it.each(["clear", "source_change"] as const)("does not change an admitted transaction's authority on read selection %s", async (change) => {
  const f = await fixture(), { connection } = await f.approve(), review = await f.prepare(connection.connectionId);
  const held = deferred<void>(), sign = f.sign.getMockImplementation()!;
  f.sign.mockImplementationOnce(async (input) => { await held.promise; return sign(input); });
  await f.act(review.card, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: review.session.reviewRevision });
  await vi.waitFor(() => expect(f.sign).toHaveBeenCalledOnce());
  const request = f.run(() => f.records.currentRequest(review.session.id))!;
  if (change === "clear") await f.run(() => f.activity.clearActiveAccount(f.now()));
  else await f.run(() => f.activity.setActiveAccount(f.account, "wallet_connection", f.now(), { id: "different-source" }));
  expect(f.run(() => f.workflow.reconcileConnectionContext()).assetReadAccount).toEqual({ status: "address_required" });
  expect(f.run(() => f.records.authority(request.attemptId)?.can_submit)).toBe(1);
  held.resolve();
  await vi.waitFor(() => expect(f.run(() => f.records.request(request.attemptId)?.requestStatus)).toBe("completed"));
  expect(f.submit).toHaveBeenCalledOnce(); expect(f.sign).toHaveBeenCalledOnce();
  const completed = workflowViewSchema.parse((await f.read(review.card)).snapshot.data);
  expect(completed.request?.account).toBe(f.account); expect(completed.usableConnectionId).toBeUndefined();
  expect(completed.assetReadAccount).toBeUndefined();
});
