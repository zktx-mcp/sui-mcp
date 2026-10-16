import { suiGrants } from "./fixtures/walletGrants.js";
import { FixtureWalletRuntime } from "./fixtures/walletRuntime.js";
import { afterEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";
import { walletWorkflowFixture, deferred } from "./fixtures/walletWorkflow.js";
import { workflowViewSchema } from "../src/core/session/workflowView.js";
import { randomUUID } from "node:crypto";
import { createLocalSessionBase } from "../src/core/session/localSession.js";
import { SqliteCardRecordStore } from "../src/core/session/sqliteCardStore.js";
import { seedApprovedConnection } from "./fixtures/walletJournal.js";
import type { WalletSession, WalletTransport } from "../src/core/session/walletConnection.js";
import type { WalletSessionInspection } from "../src/core/session/walletRuntime.js";
import type { CardRecord } from "../src/core/session/cardSession.js";

const fixtures: Awaited<ReturnType<typeof walletWorkflowFixture>>[] = [];
async function fixture() { const f = await walletWorkflowFixture(); fixtures.push(f); return f; }
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
async function disconnectCard(f: Awaited<ReturnType<typeof fixture>>) { return f.run(() => f.cards.create("disconnect", {})); }

it.each(["topicless", "cancelled_retained", "cleanup_failed", "unusable"] as const)("recovers a persisted %s connection under a fresh owner and run without reopening its old card", async (kind) => {
  const oldOwner = "departed-owner", oldRun = randomUUID(), operationId = randomUUID();
  let priorCard!: CardRecord, permission!: string, connectionId!: string, storedResult!: string;
  let source!: WalletTransport, observation: WalletSessionInspection | undefined;
  const approval = deferred<WalletSession>();
  const f = await walletWorkflowFixture({ createRuntime: (directory, { account }) => {
    const at = new Date(Date.now() - 1_000), session: WalletSession = { topic: "retained-before-start",
      grants: suiGrants([account]), expiresAt: new Date(at.getTime() + 3_600_000).toISOString(), walletName: "Synthetic retained wallet" };
    const old = seedApprovedConnection(join(directory, "activity.sqlite"), session, { ownerId: oldOwner, runId: oldRun, at });
    connectionId = old.connection.connectionId;
    const base = createLocalSessionBase(at, 1_800_000); permission = base.token;
    priorCard = { ownerId: oldOwner, scope: "connect", tokenHash: base.base.tokenHash, operationId,
      acceptedInput: { action: "connect", operationId, walletRunId: oldRun, chains: ["sui:mainnet"] },
      state: { cardId: base.base.id, kind: "connect", state: "closed", reason: kind === "unusable" ? "completed" : "cancelled", revision: 1,
        createdAt: base.base.createdAt, expiresAt: base.base.expiresAt, input: { requestedChains: ["sui:mainnet"], connectionId: null, operationId } } };
    const db = new Database(join(directory, "activity.sqlite"));
    try {
      // These are prior persisted outcomes, prepared before Workflow.start and
      // before the new runtime publishes any observation. Only the external
      // SDK inspection is a double; recovery/admission/projection remain real.
      if (kind !== "unusable") {
        const { approvedAt: _approval, ...pending } = old.connection;
        const connection = { ...pending, status: kind === "cleanup_failed" ? "failed" : "stopped", chainResults: [], grants: kind === "topicless" ? [] : session.grants,
          reason: kind === "cleanup_failed" ? "The unaccepted session could not be removed." : "The connection request was stopped here." };
        db.prepare("UPDATE live_wallet_connections SET status=?,connection_json=?,topic=? WHERE id=?")
          .run(connection.status, JSON.stringify(connection), kind === "topicless" ? null : session.topic, connectionId);
        db.prepare("DELETE FROM accounts").run();
      }
      const cards = new SqliteCardRecordStore(db), initial: CardRecord = { ...priorCard,
        state: { ...priorCard.state, state: "running", reason: undefined, revision: 0 } };
      cards.create(initial);
      storedResult = JSON.stringify(kind === "unusable" ? { message: "Wallet connection approved." }
        : { message: "Connecting was stopped here. A pending wallet approval will not be used.", endReason: "user_stopped" });
      db.prepare(`INSERT INTO wallet_connection_operations
        (operation_id,card_id,owner_id,run_id,data_epoch,action,connection_id,status,input_json,result_json,sdk_pending,created_at,updated_at,expires_at)
        VALUES (?,?,?,?,0,'connect',?,?,?,?,1,?,?,?)`).run(operationId, priorCard.state.cardId, oldOwner, oldRun, connectionId,
        kind === "unusable" ? "completed" : "stopped", JSON.stringify({ action: "connect", operationId, walletRunId: oldRun, chains: ["sui:mainnet"] }),
        storedResult, at.toISOString(), at.toISOString(), priorCard.state.expiresAt);
      priorCard.state.data = { kind: "connect", allowedActions: [], observe: false, actionRemainingMs: 0,
        result: { message: kind === "unusable" ? "Wallet connection approved." : "Connecting was stopped here. A pending wallet approval will not be used.", recordedAt: at.toISOString() },
        networks: kind === "unusable" ? [{ chainId: "sui:mainnet", status: "bound" }] : [] };
      expect(cards.replace(initial, priorCard, at)).toBe(true);
    } finally { db.close(); }
    observation = kind === "topicless" ? undefined : kind === "unusable"
      ? { topic: session.topic, status: "unusable" } : { topic: session.topic, status: "present", session };
    source = { restore: vi.fn(async () => []), inspectAll: vi.fn(() => observation ? [observation] : []),
      inspect: vi.fn((topic: string): WalletSessionInspection => observation && observation.topic === topic ? observation : { topic, status: "absent" }),
      session: (topic) => observation?.topic === topic && observation.status === "present" ? observation.session : undefined,
      connect: vi.fn(async () => ({ uri: "wc:synthetic-new-pairing", expiresAt: session.expiresAt, approval: approval.promise })),
      disconnect: vi.fn(async (topic) => { if (observation?.topic === topic) observation = { topic, status: "absent" }; }),
      sign: vi.fn(async () => { throw new Error("No signature is permitted by this recovery scenario"); }),
      onSessionChanged: () => () => {}, stop: vi.fn() };
    return new FixtureWalletRuntime(source);
  } });
  fixtures.push(f);
  const db = new Database(join(f.directory, "activity.sqlite"));
  try {
    expect(f.runtime.runId).not.toBe(oldRun);
    expect(f.run(() => f.records.currentConnection())).toMatchObject({ ownerId: "fixture-owner", runId: f.runtime.runId, sdkPending: false,
      connection: { connectionId, status: kind === "unusable" || kind === "cleanup_failed" ? "failed" : "stopped" } });
    const oldResult = db.prepare("SELECT result_json FROM wallet_connection_operations WHERE operation_id=?").get(operationId);
    expect(oldResult).toEqual({ result_json: storedResult });
    expect(f.run(() => f.cardRecords.get(priorCard.state.cardId)?.state)).toMatchObject({ state: "closed", reason: kind === "unusable" ? "completed" : "cancelled" });
    expect(f.run(() => f.records.isUsableConnection(connectionId))).toBe(false);
    expect(f.run(() => f.workflow.resolveReviewTarget())).toMatchObject({ status: "unavailable", reason: "connection_required" });
    const card = kind === "topicless" ? await f.createConnection() : await disconnectCard(f), data = workflowViewSchema.parse(card.snapshot.data);
    expect(f.run(() => f.workflow.currentConnectionContext()).assetReadAccount).toEqual({ status: "address_required" });
    expect(data.allowedActions.some((action) => action === "disconnect")).toBe(kind !== "topicless");
    expect(data.allowedActions).toEqual(kind === "topicless" ? ["cancel", "connect"] : ["cancel", "disconnect"]);
    expect(source.connect).not.toHaveBeenCalled(); expect(source.disconnect).not.toHaveBeenCalled(); expect(source.sign).not.toHaveBeenCalled();
    const closed = await f.run(() => f.cards.act({ cardId: priorCard.state.cardId, permission, revision: priorCard.state.revision,
      input: { action: "connect", operationId: randomUUID(), walletRunId: f.runtime.runId, chains: ["sui:mainnet"] } }));
    expect(closed.error?.code).toBe("card_conflict");
    if (kind === "topicless") {
      expect((await f.act(card, { action: "connect" })).error).toBeUndefined();
      await vi.waitFor(() => expect(source.connect).toHaveBeenCalledOnce());
      expect(f.run(() => f.records.currentConnection()?.connection.connectionId)).not.toBe(connectionId);
    } else {
      expect((await f.act(card, { action: "connect", chains: ["sui:mainnet"] })).error?.code).toBe("card_conflict");
      const current = await f.read(card);
      expect((await f.act(current, { action: "disconnect", connectionId })).error).toBeUndefined();
      await vi.waitFor(() => expect(f.run(() => f.records.currentConnection()?.sdkPending)).toBe(false));
      expect(source.disconnect).toHaveBeenCalledExactlyOnceWith("retained-before-start");
      expect((await f.read(card)).snapshot.data).toMatchObject({ allowedActions: [] });
      expect(source.connect).not.toHaveBeenCalled();
    }
    expect(f.run(() => f.cardRecords.get(priorCard.state.cardId)?.state)).toMatchObject({ state: "closed", reason: kind === "unusable" ? "completed" : "cancelled" });
    expect(source.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
  } finally { db.close(); if (kind === "topicless") approval.reject(new Error("Synthetic recovery test finished")); }
});

it("rolls connection admission back if its own card publication fails", async () => {
  const f = await fixture(), controls = await f.createConnection(), connecting = await f.createConnection();
  const db = new Database(join(f.directory, "activity.sqlite"));
  const controlId = connecting.snapshot.cardId.replaceAll("'", "''");
  db.exec(`CREATE TRIGGER reject_impact_publication BEFORE UPDATE OF revision ON live_read_cards
    WHEN OLD.id='${controlId}' AND NEW.revision>OLD.revision BEGIN SELECT RAISE(ABORT,'fixture impact publication failure'); END`);
  try {
    await expect(f.act(connecting, { action: "connect" })).rejects.toThrow("fixture impact publication failure");
    expect(f.run(() => f.records.connections())).toEqual([]);
    expect(f.run(() => f.cardRecords.get(connecting.snapshot.cardId))).toMatchObject({ state: { state: "ready", revision: connecting.snapshot.revision } });
    expect(f.run(() => f.cardRecords.get(connecting.snapshot.cardId)?.acceptedInput)).toBeUndefined();
    expect(f.run(() => f.cardRecords.get(controls.snapshot.cardId)!.state.revision)).toBe(controls.snapshot.revision);
    expect(f.connect).not.toHaveBeenCalled();
    db.exec("DROP TRIGGER reject_impact_publication");
    const opening = deferred<Awaited<ReturnType<typeof f.connect>>>(); f.connect.mockImplementationOnce(() => opening.promise);
    expect((await f.act(connecting, { action: "connect" })).error).toBeUndefined(); expect(f.connect).toHaveBeenCalledOnce();
    expect((await f.act(controls, { action: "connect" })).error?.code).toBe("card_conflict");
    expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
  } finally { db.exec("DROP TRIGGER IF EXISTS reject_impact_publication"); db.close(); }
});

it("revokes a pending approval before service loss and rejects its late signature", async () => {
  const f = await fixture(), { connection } = await f.approve(), review = await f.prepare(connection.connectionId);
  const pending = deferred<Awaited<ReturnType<typeof f.sign>>>();
  f.sign.mockImplementationOnce(() => pending.promise);
  await f.act(review.card, { action: "request_signature", account: f.account, connectionId: connection.connectionId, reviewRevision: review.session.reviewRevision });
  await vi.waitFor(() => expect(f.sign).toHaveBeenCalledOnce());
  const request = f.run(() => f.records.currentRequest(review.session.id))!;
  f.runtime.fail("wallet_state_unavailable");
  expect(f.run(() => f.records.request(request.attemptId)?.requestStatus)).toBe("request_failed");
  expect(f.run(() => f.records.authority(request.attemptId)?.can_submit)).toBe(0);
  const signed = await f.accountKey.signTransaction(Buffer.from(f.sign.mock.calls[0]![0].transactionBytesBase64, "base64"));
  pending.resolve({ transactionBytes: signed.bytes, signature: signed.signature });
  await vi.waitFor(() => expect(f.run(() => f.records.authority(request.attemptId)?.sdk_pending)).toBe(0));
  expect(f.submit).not.toHaveBeenCalled(); expect(f.sign).toHaveBeenCalledOnce();
});

it("keeps the real parent verification pending after child loss until it actually returns", async () => {
  const f = await fixture(), { connection } = await f.approve(), review = await f.prepare(connection.connectionId);
  const gate = deferred<void>(); f.verifyNetwork.mockImplementationOnce(() => gate.promise);
  await f.act(review.card, { action: "request_signature", account: f.account, connectionId: connection.connectionId, reviewRevision: review.session.reviewRevision });
  await vi.waitFor(() => expect(f.verifyNetwork).toHaveBeenCalledOnce());
  const request = f.run(() => f.records.currentRequest(review.session.id))!;
  f.runtime.fail("wallet_state_unavailable");
  expect(f.runtime.availability().status).toBe("unavailable");
  expect(f.run(() => f.records.authority(request.attemptId))).toMatchObject({ can_submit: 0, sdk_pending: 1 });
  await expect(f.run(() => f.localData.resetLocalData())).rejects.toThrow("unsettled");
  const nextReview = await f.run(() => f.sessions.createReviewSession([f.plan], f.now()));
  const nextCard = await f.run(() => f.cards.create("review", { reviewSessionId: nextReview.session.id, connectionId: connection.connectionId, account: f.account }));
  expect(nextCard.snapshot.data).toMatchObject({ allowedActions: ["cancel"], review: { accountRequestPending: true } });
  gate.resolve();
  await vi.waitFor(() => expect(f.run(() => f.records.authority(request.attemptId)?.sdk_pending)).toBe(0));
  expect((await f.read(nextCard)).snapshot.data).not.toHaveProperty("automaticAction");
  expect(f.submit).not.toHaveBeenCalled();
});

it("continues the already dispatched transaction once, with its original chain observation", async () => {
  const f = await fixture(), { connection } = await f.approve(), review = await f.prepare(connection.connectionId);
  const submission = deferred<{}>(); f.submit.mockImplementationOnce(() => submission.promise);
  await f.act(review.card, { action: "request_signature", account: f.account, connectionId: connection.connectionId, reviewRevision: review.session.reviewRevision });
  await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce());
  const request = f.run(() => f.records.currentRequest(review.session.id))!;
  const before = f.run(() => f.records.authority(request.attemptId))!;
  f.runtime.fail("wallet_state_unavailable");
  expect(f.run(() => f.records.request(request.attemptId)?.requestStatus)).toBe("submitting");
  expect(f.run(() => f.records.authority(request.attemptId))).toMatchObject({ submit_pending: 1, lookup_deadline: before.lookup_deadline, observation_stopped: 0 });
  submission.resolve({});
  await vi.waitFor(() => expect(f.run(() => f.records.request(request.attemptId)?.requestStatus)).toBe("completed"));
  expect(f.run(() => f.records.request(request.attemptId)?.transactionDigest)).toBe(request.transactionDigest);
  expect(f.submit).toHaveBeenCalledOnce(); expect(f.sign).toHaveBeenCalledOnce();
});

it("checks the SDK again after signature and mainnet verification, without relying on an earlier observation", async () => {
  const f = await fixture(), { connection } = await f.approve(), review = await f.prepare(connection.connectionId);
  const approved = f.transport.session("fixture-topic")!;
  f.verifyNetwork.mockImplementationOnce(async () => {
    // No event is sent. Only the required final check can see this change.
    vi.spyOn(f.transport, "session").mockReturnValue({ ...approved, grants: suiGrants([`0x${"b".repeat(64)}`]) });
  });
  await f.act(review.card, { action: "request_signature", account: f.account, connectionId: connection.connectionId, reviewRevision: review.session.reviewRevision });
  await vi.waitFor(() => expect(f.run(() => f.records.currentRequest(review.session.id)?.requestStatus)).toBe("stopped"));
  expect(f.sign).toHaveBeenCalledOnce(); expect(f.submit).not.toHaveBeenCalled();
});

it("repairs finished wallet callback flags without repeating a signature or chain lookup", async () => {
  const f = await fixture(), { connection } = await f.approve(), review = await f.prepare(connection.connectionId);
  const db = new Database(join(f.directory, "activity.sqlite"));
  db.exec("CREATE TRIGGER reject_sdk_settle BEFORE UPDATE OF sdk_pending ON live_request_authority WHEN OLD.sdk_pending=1 AND NEW.sdk_pending=0 BEGIN SELECT RAISE(ABORT,'fixture callback write failure'); END");
  try {
    await f.act(review.card, { action: "request_signature", account: f.account, connectionId: connection.connectionId, reviewRevision: review.session.reviewRevision });
    await vi.waitFor(() => expect(f.run(() => f.records.currentRequest(review.session.id)?.requestStatus)).toBe("completed"));
    const request = f.run(() => f.records.currentRequest(review.session.id))!, reads = f.chainRead.mock.calls.length;
    expect(f.run(() => f.records.authority(request.attemptId)?.sdk_pending)).toBe(1);
    db.exec("DROP TRIGGER reject_sdk_settle");
    expect((await f.run(() => f.workflow.readReview(review.session.id)))?.request).toEqual(request);
    expect(f.run(() => f.records.authority(request.attemptId)?.sdk_pending)).toBe(0);
    expect(f.sign).toHaveBeenCalledOnce(); expect(f.submit).toHaveBeenCalledOnce(); expect(f.chainRead).toHaveBeenCalledTimes(reads);
  } finally { db.exec("DROP TRIGGER IF EXISTS reject_sdk_settle"); db.close(); }
});

it("never lets a pairing cleanup clear the pending flag owned by a later disconnect", async () => {
  const f = await fixture(), { card: connected, connection } = await f.approve(), pending = deferred<void>();
  vi.mocked(f.transport.disconnect).mockImplementationOnce(() => pending.promise);
  const card = await disconnectCard(f); await f.act(card, { action: "disconnect", connectionId: connection.connectionId });
  f.run(() => f.records.settleConnection(connection.connectionId, { cardId: connected.snapshot.cardId, runId: f.runtime.runId, operationId: f.run(() => f.cardRecords.get(connected.snapshot.cardId)!.operationId!), action: "connect" }));
  expect(f.run(() => f.records.connection(connection.connectionId)?.sdkPending)).toBe(true);
  pending.resolve();
  await vi.waitFor(() => expect(f.run(() => f.records.connection(connection.connectionId)?.sdkPending)).toBe(false));
  expect(f.transport.disconnect).toHaveBeenCalledOnce();
});

it.each(["completed", "submitting"] as const)("keeps %s transaction facts independent of an unsaved wallet authority revocation", async (status) => {
  const f = await fixture(), { connection } = await f.approve(), review = await f.prepare(connection.connectionId);
  const submission = deferred<{}>();
  if (status === "submitting") f.submit.mockImplementationOnce(() => submission.promise);
  await f.act(review.card, { action: "request_signature", account: f.account, connectionId: connection.connectionId, reviewRevision: review.session.reviewRevision });
  await vi.waitFor(() => expect(f.run(() => f.records.currentRequest(review.session.id)?.requestStatus)).toBe(status));
  const request = f.run(() => f.records.currentRequest(review.session.id))!;
  const card = await disconnectCard(f);
  const db = new Database(join(f.directory, "activity.sqlite"));
  db.exec("CREATE TRIGGER reject_failure BEFORE UPDATE ON live_wallet_connections BEGIN SELECT RAISE(ABORT,'fixture outcome failure'); END");
  try {
    f.runtime.fail("initialization_failed");
    await expect(f.read(card)).rejects.toThrow("fixture outcome failure");
    const saved = await f.run(() => f.workflow.readReview(review.session.id, true));
    expect(saved?.request).toMatchObject({ attemptId: request.attemptId, transactionDigest: request.transactionDigest,
      requestStatus: "completed", execution: { status: "success" } });
    expect(f.sign).toHaveBeenCalledOnce(); expect(f.submit).toHaveBeenCalledOnce();
    if (status === "submitting") {
      expect(f.run(() => f.records.authority(request.attemptId))).toMatchObject({ sdk_pending: 1, submit_pending: 1 });
      await expect(f.run(() => f.localData.resetLocalData())).rejects.toThrow("unsettled");
    }
    db.exec("DROP TRIGGER reject_failure");
    expect((await f.read(card)).snapshot.data).toMatchObject({ walletAvailability: { status: "unavailable" } });
  } finally { submission.resolve({}); db.exec("DROP TRIGGER IF EXISTS reject_failure"); db.close(); }
});

it("requires only its own lookup repair before admitting a new same-digest observation", async () => {
  const f = await fixture(), { connection } = await f.approve(), review = await f.prepare(connection.connectionId);
  const db = new Database(join(f.directory, "activity.sqlite")), chain = f.chainRead.getMockImplementation()!;
  f.chainRead.mockRejectedValue(new Error("Fixture chain response unavailable"));
  db.exec("CREATE TRIGGER refuse_lookup BEFORE UPDATE OF lookup_pending ON live_request_authority WHEN OLD.lookup_pending=1 AND NEW.lookup_pending=0 BEGIN SELECT RAISE(ABORT,'own lookup refused'); END");
  try {
    await f.act(review.card, { action: "request_signature", account: f.account, connectionId: connection.connectionId, reviewRevision: review.session.reviewRevision });
    await vi.waitFor(() => expect(f.logger.error).toHaveBeenCalled());
    const request = f.run(() => f.records.currentRequest(review.session.id))!;
    f.run(() => f.records.transitionRequest(request.attemptId, "outcome_unknown", f.now(), { reason: "Fixture observation window ended." }));
    const calls = f.chainRead.mock.calls.length;
    expect((await f.run(() => f.workflow.readReview(review.session.id)))?.request?.requestStatus).toBe("outcome_unknown");
    await expect(f.run(() => f.workflow.readReview(review.session.id, true))).rejects.toThrow("own lookup refused");
    expect(f.chainRead).toHaveBeenCalledTimes(calls);
    expect(f.run(() => f.records.authority(request.attemptId)?.lookup_pending)).toBe(1);
    await expect(f.run(() => f.localData.resetLocalData())).rejects.toThrow();
    db.exec("DROP TRIGGER refuse_lookup"); f.chainRead.mockImplementation(chain);
    expect((await f.run(() => f.workflow.readReview(review.session.id, true)))?.request?.requestStatus).toBe("completed");
    expect(f.submit).toHaveBeenCalledOnce();
  } finally { db.close(); }
});

it.each(["lost", "disconnect", "account"] as const)("preserves the concrete %s cause when invalidating a prepared review", async (cause) => {
  const f = await fixture(), { connection } = await f.approve(), review = await f.prepare(connection.connectionId);
  if (cause === "lost") (f.runtime as FixtureWalletRuntime).fail("initialization_failed");
  else if (cause === "account") f.notify({ ...f.transport.session("fixture-topic")!, grants: suiGrants([f.account, `0x${"b".repeat(64)}`]) }, ["sui:mainnet"]);
  else await f.act(await disconnectCard(f), { action: "disconnect", connectionId: connection.connectionId });
  const snapshot = await f.read(review.card);
  const data = (snapshot.snapshot.data as { review?: { state?: { refreshReason?: string }; error?: string } });
  expect(data.review?.state?.refreshReason).toBe("wallet_connection_changed");
  const message = cause === "lost" ? "The wallet service stopped." :
    cause === "disconnect" ? "Wallet disconnection was requested for the original connection. This review cannot use a replacement connection." : "The original wallet connection's Sui authorization changed.";
  expect(data.review?.error).toContain(message);
  const db = new Database(join(f.directory, "activity.sqlite"));
  try { expect(db.prepare("SELECT reason FROM review_status_transitions WHERE review_session_id=? AND event='review_invalidated' ORDER BY id DESC LIMIT 1").get(review.session.id)).toMatchObject({ reason: expect.stringContaining(message) }); }
  finally { db.close(); }
  expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});

it("retains the service-loss reason when an interrupted computation returns late", async () => {
  const f = await fixture(), { connection } = await f.approve(), originalQuote = f.quote.getMockImplementation()!, held = deferred<void>();
  f.quote.mockImplementationOnce(async () => { await held.promise; return originalQuote(); });
  const { session } = await f.run(() => f.sessions.createReviewSession([f.plan], f.now()));
  const card = await f.run(() => f.cards.create("review", { reviewSessionId: session.id, connectionId: connection.connectionId, account: f.account }));
  await f.act(card, { action: "prepare_review", account: f.account, connectionId: connection.connectionId, reviewRevision: 0 });
  await vi.waitFor(() => expect(f.quote).toHaveBeenCalledOnce());
  (f.runtime as FixtureWalletRuntime).fail("initialization_failed");
  const before = f.run(() => f.sessions.readReviewSession(session.id))!;
  expect(before.preparationId).toBeUndefined();
  expect(before.preparationError).toContain("stopped");
  held.resolve(); await vi.waitFor(() => expect(f.simulate).toHaveBeenCalled());
  expect(f.run(() => f.sessions.readReviewSession(session.id))?.preparationError).toBe(before.preparationError);
  expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});
