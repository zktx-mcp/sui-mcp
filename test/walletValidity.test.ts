import { afterEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";
import { walletWorkflowFixture, deferred } from "./fixtures/walletWorkflow.js";

const fixtures: Awaited<ReturnType<typeof walletWorkflowFixture>>[] = [];
async function ready() {
  const f = await walletWorkflowFixture(); fixtures.push(f);
  const { connection } = await f.approve();
  const review = await f.prepare(connection.connectionId);
  const input = { action: "request_signature", connectionId: connection.connectionId,
    account: f.account, reviewRevision: review.session.reviewRevision };
  return { f, review, input, connection };
}
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });

it.each([0, 1])("evaluates a read at material expiry plus %i ms after real async verification", async (after) => {
  const { f, review, connection } = await ready();
  f.advance(29_999);
  const inspect = f.sessions.inspectReview.bind(f.sessions);
  const calls = vi.spyOn(f.sessions, "inspectReview").mockImplementationOnce(async (...args) => {
    const candidate = await inspect(...args);
    expect(candidate?.material).toBeDefined();
    f.advance(1 + after);
    return candidate;
  });
  const result = await f.read(review.card);
  expect(result.snapshot.data).toMatchObject({ review: { status: "refresh_required", state: { refreshReason: "review_evidence_stale" } },
    allowedActions: ["cancel", "prepare_review"], observe: false });
  expect(result.snapshot.data).toMatchObject({ nextStateReadAfterMs: Date.parse(connection.expiresAt) - f.now().getTime() });
  expect(calls).toHaveBeenCalledOnce();
  expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});

it.each([0, 1])("refuses new admission at material expiry plus %i ms without consuming the card", async (after) => {
  const { f, review, input } = await ready();
  f.advance(29_999);
  const prepare = f.sessions.prepareReviewedTransaction.bind(f.sessions);
  vi.spyOn(f.sessions, "prepareReviewedTransaction").mockImplementationOnce(async (...args) => {
    const material = await prepare(...args);
    f.advance(1 + after);
    return material;
  });
  const result = await f.act(review.card, input);
  expect(result.error?.code).toBe("card_conflict");
  expect(result.snapshot.state).toBe("ready");
  expect(result.snapshot.data).toMatchObject({ review: { status: "refresh_required", state: { refreshReason: "review_evidence_stale" } } });
  const db = new Database(join(f.directory, "activity.sqlite"));
  try {
    expect(db.prepare("SELECT COUNT(*) AS n FROM review_requests").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM live_request_authority").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT accepted_input_json FROM live_read_cards WHERE id=?").get(review.card.snapshot.cardId)).toEqual({ accepted_input_json: null });
  } finally { db.close(); }
  expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled(); expect(f.chainRead).not.toHaveBeenCalled();
});

it("rejects a replaced canonical byte row after verification without reusing its earlier digest", async () => {
  const { f, review, input } = await ready();
  const prepare = f.sessions.prepareReviewedTransaction.bind(f.sessions);
  vi.spyOn(f.sessions, "prepareReviewedTransaction").mockImplementationOnce(async (...args) => {
    const material = await prepare(...args);
    const db = new Database(join(f.directory, "activity.sqlite"));
    try { db.prepare("UPDATE live_transaction_materials SET transaction_bytes=? WHERE material_id=?")
      .run(Buffer.from([0]), material.transactionMaterial.materialId); }
    finally { db.close(); }
    return material;
  });
  const result = await f.act(review.card, input);
  expect(result.error?.code).toBe("card_conflict");
  expect(f.run(() => f.records.currentRequest(review.session.id))).toBeUndefined();
  expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});

it("ends a changed verification candidate as a conflict; a new read verifies the current revision", async () => {
  const { f, review } = await ready();
  const inspect = f.sessions.inspectReview.bind(f.sessions);
  const calls = vi.spyOn(f.sessions, "inspectReview").mockImplementationOnce(async (...args) => {
    const candidate = await inspect(...args);
    // A concurrent committed write changes the storage revision independently
    // of the already verified candidate. The next read must inspect anew.
    const db = new Database(join(f.directory, "activity.sqlite"));
    try { db.prepare("UPDATE live_review_sessions SET revision=revision+1 WHERE id=?").run(review.session.id); }
    finally { db.close(); }
    return candidate;
  });
  await expect(f.read(review.card)).rejects.toMatchObject({ code: "invalid_session_transition",
    details: { reason: "review_changed_during_verification" } });
  expect(calls).toHaveBeenCalledOnce();
  expect((await f.read(review.card)).snapshot.data).toMatchObject({ review: { status: "ready_for_wallet_review" } });
  expect(calls).toHaveBeenCalledTimes(2);
  expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});

it("keeps admission material private and recovers the admitted result after original material expiry", async () => {
  const { f, review, input } = await ready();
  const inspected = await f.run(() => f.sessions.inspectReview(review.session.id, f.now()));
  expect(inspected?.material).toMatchObject({ reviewSessionId: review.session.id,
    reviewRevision: review.session.reviewRevision, account: f.account });
  const result = await f.act(review.card, input);
  await vi.waitFor(() => expect(f.run(() => f.records.currentRequest(review.session.id)?.requestStatus)).toBe("completed"));
  f.advance(30_000);
  const recovered = await f.act(review.card, input);
  expect(recovered.snapshot.data).toMatchObject({ request: { requestStatus: "completed" } });
  for (const response of [result.snapshot, recovered.snapshot]) {
    expect(JSON.stringify(response)).not.toContain(inspected!.material!.transactionBytesBase64);
    expect(JSON.stringify(response)).not.toContain(inspected!.material!.transactionMaterial.materialId);
  }
  expect(f.sign).toHaveBeenCalledOnce(); expect(f.submit).toHaveBeenCalledOnce();
});

it.each(["read", "admission"] as const)("keeps %s expiry committed when the optional event sink fails", async (path) => {
  const append = vi.fn(async () => { throw new Error("Optional sink unavailable"); });
  const f = await walletWorkflowFixture({ eventLog: { append } }); fixtures.push(f);
  const { connection } = await f.approve(), review = await f.prepare(connection.connectionId);
  append.mockClear(); f.advance(29_999);
  if (path === "read") {
    const inspect = f.sessions.inspectReview.bind(f.sessions);
    vi.spyOn(f.sessions, "inspectReview").mockImplementationOnce(async (...args) => {
      const result = await inspect(...args); f.advance(1); return result;
    });
    expect((await f.read(review.card)).snapshot.data).toMatchObject({ review: { status: "refresh_required" } });
  } else {
    const prepare = f.sessions.prepareReviewedTransaction.bind(f.sessions);
    vi.spyOn(f.sessions, "prepareReviewedTransaction").mockImplementationOnce(async (...args) => {
      const result = await prepare(...args); f.advance(1); return result;
    });
    const result = await f.act(review.card, { action: "request_signature", connectionId: connection.connectionId,
      account: f.account, reviewRevision: review.session.reviewRevision });
    expect(result.error?.code).toBe("card_conflict");
    expect(result.snapshot.data).toMatchObject({ review: { status: "refresh_required" } });
  }
  expect(append).toHaveBeenCalledOnce();
  const db = new Database(join(f.directory, "activity.sqlite"));
  try {
    expect(db.prepare("SELECT current_status FROM review_sessions WHERE id=?").get(review.session.id)).toEqual({ current_status: "refresh_required" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM review_status_transitions WHERE review_session_id=? AND to_status='refresh_required'")
      .get(review.session.id)).toEqual({ n: 1 });
  } finally { db.close(); }
  await f.read(review.card);
  expect(append).toHaveBeenCalledOnce();
  expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});

it("rolls back mandatory state, activity and cleanup together without emitting an optional success event", async () => {
  const append = vi.fn(async () => {});
  const f = await walletWorkflowFixture({ eventLog: { append } }); fixtures.push(f);
  const { connection } = await f.approve(), review = await f.prepare(connection.connectionId);
  append.mockClear(); f.advance(30_000);
  const db = new Database(join(f.directory, "activity.sqlite"));
  try {
    db.exec("CREATE TRIGGER refuse_evaluation BEFORE UPDATE ON live_review_sessions BEGIN SELECT RAISE(ABORT, 'fixture evaluation rollback'); END");
    await expect(f.read(review.card)).rejects.toThrow("fixture evaluation rollback");
    expect(db.prepare("SELECT current_status FROM review_sessions WHERE id=?").get(review.session.id)).toEqual({ current_status: "ready_for_wallet_review" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM review_status_transitions WHERE review_session_id=? AND to_status='refresh_required'").get(review.session.id)).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM live_transaction_materials WHERE review_session_id=?").get(review.session.id)).toEqual({ n: 1 });
    expect(append).not.toHaveBeenCalled();
  } finally { db.exec("DROP TRIGGER IF EXISTS refuse_evaluation"); db.close(); }
  expect((await f.read(review.card)).snapshot.data).toMatchObject({ review: { status: "refresh_required" } });
  expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});

it("uses the admitted signature deadline after quote expiry without invalidating the frozen review", async () => {
  const { f, review, input } = await ready();
  const response = deferred<{ transactionBytes: string; signature: string }>();
  let verifiedReply: { transactionBytes: string; signature: string } | undefined;
  f.sign.mockImplementationOnce(async (request) => {
    const signed = await f.accountKey.signTransaction(Buffer.from(request.transactionBytesBase64, "base64"));
    verifiedReply = { transactionBytes: signed.bytes, signature: signed.signature };
    return response.promise;
  });
  await f.act(review.card, input);
  await vi.waitFor(() => expect(verifiedReply).toBeDefined());
  f.advance(30_001);
  const pending = await f.read(review.card);
  expect(pending.snapshot.data).toMatchObject({ request: { requestStatus: "awaiting_signature" }, review: { status: "ready_for_wallet_review" } });
  response.resolve(verifiedReply!);
  await vi.waitFor(() => expect(f.run(() => f.records.currentRequest(review.session.id)?.requestStatus)).toBe("completed"));
  expect(f.sign).toHaveBeenCalledOnce(); expect(f.submit).toHaveBeenCalledOnce();
});

it("does not clean newer private material when an older publication loses its session CAS", async () => {
  const { f, review } = await ready();
  const artifacts = f.run(() => f.activity.createPrivateReviewArtifactStore().get(review.session.id))!;
  const commit = f.activity.recordReviewStateSnapshotWithLiveSession.bind(f.activity);
  vi.spyOn(f.activity, "recordReviewStateSnapshotWithLiveSession").mockImplementationOnce(async (input, live) => {
    const records = f.activity.createSessionRecordStore();
    const current = records.get(review.session.id)!;
    expect(records.commitReviewSessionTransition(current.id, current, { ...current,
      reviewRevision: current.reviewRevision + 1 })).toBe(true);
    return commit(input, live);
  });
  await expect(f.run(() => f.sessions.recordReviewStateWithArtifacts(review.session.id, review.session.reviewState!, artifacts, f.now())))
    .rejects.toMatchObject({ code: "invalid_session_transition" });
  expect(f.run(() => f.activity.createPrivateReviewArtifactStore().get(review.session.id))).toEqual(artifacts);
  const db = new Database(join(f.directory, "activity.sqlite"));
  try {
    expect(db.prepare("SELECT COUNT(*) AS n FROM live_transaction_materials WHERE material_id=?").get(artifacts.transactionMaterial!.materialId)).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM review_state_snapshots WHERE review_session_id=?").get(review.session.id)).toEqual({ n: 1 });
  } finally { db.close(); }
  expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});

it("does not list an unadmitted expired card as work and refuses its late input", async () => {
  const f = await walletWorkflowFixture(); fixtures.push(f);
  const card = await f.createConnection();
  f.advance(Date.parse(card.snapshot.expiresAt) - f.now().getTime());
  expect(f.run(() => f.workflow.pendingConnections())).toEqual([]);
  expect((await f.act(card, { action: "connect" })).error?.code).toBe("card_conflict");
  expect(f.run(() => f.cardRecords.get(card.snapshot.cardId)?.state)).toMatchObject({ state: "closed", reason: "expired" });
  expect(f.connect).not.toHaveBeenCalled(); expect(f.sign).not.toHaveBeenCalled();
});
