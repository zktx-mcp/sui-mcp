import { afterEach, expect, it, vi } from "vitest";
import { workflowViewSchema } from "../src/core/session/workflowView.js";
import { readFile, writeFile, rename, mkdir, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { settingsWorkflowFixture } from "./fixtures/settingsWorkflow.js";
import { deferred } from "./fixtures/walletWorkflow.js";
import type { SettingsView } from "../src/core/session/settingsOperation.js";
import type { LocalDataCounts, LocalDataImportPreview } from "../src/core/activity/localDataTypes.js";
import { DEFAULT_SUI_GRPC_URL, DEFAULT_SUI_GRAPHQL_URL } from "../src/runtime/config.js";
import { SuiEndpointError } from "../src/core/suiEndpoint.js";

const resources: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close(); });
async function fixture(options: Parameters<typeof settingsWorkflowFixture>[0] = {}) {
  const value = await settingsWorkflowFixture(options); resources.push(() => value.close()); return value;
}
const view = (card: { snapshot: { data?: unknown } }) => card.snapshot.data as SettingsView;
const downloadPath = (f: Awaited<ReturnType<typeof fixture>>, card: Awaited<ReturnType<typeof f.create>>) => {
  const fileId = f.wallet.run(() => f.records.get(view(card).operationId)!.fileId)!;
  return join(f.wallet.directory, ".settings-staging", `${fileId}.download`);
};
async function downloadReady(f: Awaited<ReturnType<typeof fixture>>, card: Awaited<ReturnType<typeof f.create>>) {
  let current = await f.read(card);
  await vi.waitFor(async () => { current = await f.read(card); expect(view(current).result?.outcome).toBe("completed"); });
  return current;
}
const downloadReport = (card: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["create"]>>) => {
  const data = view(card);
  return { action: "settings_report_download", operationId: data.operationId, fileId: data.file!.fileId,
    attemptId: data.download!.currentAttemptId, status: "acknowledged" };
};


it.each(["selected", "cleared", "different_source", "terminal", -1, 0, 1] as const)(
  "keeps same-time qualification and the next explicit action consistent (%s)", async (kind) => {
    const f = await fixture(), w = f.wallet, { connection } = await w.approve();
    if (kind === "cleared") await w.run(() => w.activity.clearActiveAccount(w.now()));
    if (kind === "different_source") {
      const previous = w.run(() => w.records.restoreConnection({ topic: "previous-same-address-topic", accounts: [w.account],
        methods: ["sui_signTransaction"], chain: "sui:mainnet", expiresAt: connection.expiresAt }, w.now()));
      w.run(() => w.records.updateConnection(previous.connection.connectionId, { status: "disconnected" }, w.now()));
      await w.run(() => w.activity.setActiveAccount(w.account, "wallet_connection", w.now(), { id: previous.connection.connectionId }));
    }
    if (kind === "terminal") w.run(() => w.records.updateConnection(connection.connectionId,
      { status: "failed", reason: "The original disconnect was not confirmed." }, w.now()));
    if (typeof kind === "number") {
      w.run(() => w.records.updateConnection(connection.connectionId, { expiresAt: new Date(w.now().getTime() + 1000).toISOString() }, w.now()));
      w.advance(1000 + kind);
    }
    const at = w.now().toISOString(), stored = await w.run(() => w.activity.getActiveAccount());
    // Literal expectations come from selection provenance/status/expiry, not
    // another consumer or the qualification helper. All reads share this clock.
    const available = kind === "selected" || typeof kind === "number" && kind < 0;
    const expected = available ? { status: "available", account: w.account } : { status: "address_required" };
    const settings = await f.create();
    expect(view(settings).facts!.assetReadAccount).toEqual(expected);
    const connect = await w.run(() => w.cards.create("connect", { intent: "manage" }));
    expect(workflowViewSchema.parse(connect.snapshot.data).assetReadAccount).toEqual(expected);
    const { session } = await w.run(() => w.sessions.createReviewSession([w.plan], w.now()));
    let review = await w.run(() => w.cards.create("review", { reviewSessionId: session.id }));
    const projected = workflowViewSchema.parse(review.snapshot.data);
    expect(projected.assetReadAccount).toEqual(expected);
    if (available) expect(projected.automaticAction).toMatchObject({ action: "prepare_review", account: w.account, connectionId: connection.connectionId });
    else expect(projected.automaticAction).toBeUndefined();
    expect(w.now().toISOString()).toBe(at);
    expect(await w.run(() => w.activity.getActiveAccount())).toEqual(stored);
    if (kind === "different_source" || kind === "cleared") {
      expect((await w.act(connect, { action: "use_account", connectionId: connection.connectionId, account: w.account })).error).toBeUndefined();
      expect(view(await f.read(settings)).facts!.assetReadAccount).toEqual({ status: "available", account: w.account });
      review = await w.read(review);
      expect(workflowViewSchema.parse(review.snapshot.data).automaticAction).toMatchObject({ action: "prepare_review", account: w.account, connectionId: connection.connectionId });
      expect(await w.run(() => w.activity.getActiveAccount())).toMatchObject({ walletId: connection.connectionId });
    } else if (kind === "terminal" || typeof kind === "number" && kind >= 0) {
      expect((await w.act(connect, { action: "disconnect", connectionId: connection.connectionId })).error).toBeUndefined();
      await vi.waitFor(() => expect(w.run(() => w.records.connection(connection.connectionId)!.connection.status)).toBe("disconnected"));
      const fresh = await w.run(() => w.cards.create("connect", { intent: "manage" }));
      expect(workflowViewSchema.parse(fresh.snapshot.data).allowedActions).toContain("connect");
      expect(view(await f.read(settings)).facts!.assetReadAccount).toEqual({ status: "address_required" });
      expect(await w.run(() => w.activity.getActiveAccount())).toEqual(stored);
    }
    expect(w.quote).not.toHaveBeenCalled(); expect(w.sign).not.toHaveBeenCalled(); expect(w.submit).not.toHaveBeenCalled();
    expect(w.connect).toHaveBeenCalledOnce();
  });

it("keeps same-time qualification blocked through pending Disconnect until its actual completion", async () => {
  const f = await fixture(), w = f.wallet, { connection } = await w.approve(), held = deferred<void>();
  const at = w.now().getTime(), stored = w.run(() => w.activity.getActiveAccountSync());
  const sdk = structuredClone(w.runtime.snapshot()!);
  const recorded = w.run(() => w.records.connection(connection.connectionId)!);
  expect(recorded).toMatchObject({ ownerId: "fixture-owner", runId: sdk.runId, sdkPending: false,
    connection: { status: "connected", accounts: [w.account] } });
  expect(Date.parse(connection.expiresAt)).toBeGreaterThan(at);
  expect(sdk.sessions).toMatchObject([{ topic: recorded.topic, status: "present",
    session: { accounts: [w.account], expiresAt: connection.expiresAt } }]);
  expect(w.run(() => w.records.readConnectionFacts(w.now()))).toMatchObject({
    activeAccount: w.account, activeAccountConnectionId: connection.connectionId,
    connectionPresence: { confirmed: true, unrecorded: false, pendingConnectionIds: [],
      connections: [{ connectionId: connection.connectionId, expiresAt: connection.expiresAt }] } });

  // Positive controls use the same public consumers as the pending assertions.
  // The Review remains unprepared; reads do not execute its automatic input.
  const settings = await f.create();
  expect(settings.error).toBeUndefined();
  expect(view(settings).facts).toMatchObject({ walletAvailability: { status: "available", walletRunId: sdk.runId },
    assetReadAccount: { status: "available", account: w.account } });
  const currentConnect = await w.run(() => w.cards.create("connect", { intent: "manage" }));
  expect(currentConnect.error).toBeUndefined();
  const normalConnect = workflowViewSchema.parse(currentConnect.snapshot.data);
  expect(normalConnect.assetReadAccount).toEqual({ status: "available", account: w.account });
  expect(normalConnect.usableConnectionId).toBe(connection.connectionId);
  expect(normalConnect.allowedActions).toContain("use_account");
  const { session } = await w.run(() => w.sessions.createReviewSession([w.plan], w.now()));
  const currentReview = await w.run(() => w.cards.create("review", { reviewSessionId: session.id }));
  expect(currentReview.error).toBeUndefined();
  const normalReview = workflowViewSchema.parse(currentReview.snapshot.data);
  expect(normalReview.assetReadAccount).toEqual({ status: "available", account: w.account });
  expect(normalReview.allowedActions).toContain("prepare_review");
  expect(normalReview.automaticAction).toMatchObject({ action: "prepare_review", account: w.account, connectionId: connection.connectionId });
  expect(w.now().getTime()).toBe(at);

  const disconnect = vi.mocked(w.transport.disconnect).getMockImplementation()!;
  let finished = false;
  vi.mocked(w.transport.disconnect).mockImplementationOnce(async (topic) => {
    await held.promise; await disconnect(topic); finished = true;
  });
  // Admission consumes its own card, not the still-valid observation cards.
  const card = await w.run(() => w.cards.create("connect", { intent: "manage" }));
  try {
    expect((await w.act(card, { action: "disconnect", connectionId: connection.connectionId })).error).toBeUndefined();
    await vi.waitFor(() => expect(w.run(() => w.records.connection(connection.connectionId)!.sdkPending)).toBe(true));
    expect(w.transport.disconnect).toHaveBeenCalledOnce();
    expect(finished).toBe(false);
    // Admission checks the session again, so sequence/observedAt may advance.
    // The run and session facts that determine qualification must not change.
    expect(w.runtime.snapshot()).toMatchObject({ runId: sdk.runId, sessions: sdk.sessions });
    expect(w.run(() => w.records.connection(connection.connectionId))).toMatchObject({ ownerId: recorded.ownerId,
      runId: sdk.runId, sdkPending: true, connection: { status: "connected", expiresAt: connection.expiresAt } });
    expect(w.run(() => w.records.readConnectionFacts(w.now()))).toMatchObject({
      activeAccount: w.account, activeAccountConnectionId: connection.connectionId,
      connections: [{ connectionId: connection.connectionId, status: "connected", pendingAction: "disconnect" }],
      connectionPresence: { confirmed: true, unrecorded: false, pendingConnectionIds: [connection.connectionId],
        connections: [{ connectionId: connection.connectionId, expiresAt: connection.expiresAt }] } });
    expect(w.now().getTime()).toBe(at);
    expect(Date.parse(connection.expiresAt)).toBeGreaterThan(w.now().getTime());

    const pendingSettings = await f.read(settings);
    expect(pendingSettings.error).toBeUndefined();
    expect(view(pendingSettings).facts!.walletAvailability).toMatchObject({ status: "available", walletRunId: sdk.runId });
    // Only Disconnect admission changed. Expiry cannot mask this assertion.
    expect(view(pendingSettings).facts!.assetReadAccount).toEqual({ status: "address_required" });
    const pendingConnectCard = await w.read(currentConnect), pendingReviewCard = await w.read(currentReview);
    expect(pendingConnectCard.error).toBeUndefined(); expect(pendingReviewCard.error).toBeUndefined();
    for (const observed of [pendingConnectCard, pendingReviewCard]) {
      expect(observed.snapshot.state).toBe("ready");
      expect(Date.parse(observed.snapshot.expiresAt)).toBeGreaterThan(at);
      expect(w.run(() => w.cardRecords.get(observed.snapshot.cardId)!.acceptedInput)).toBeUndefined();
      const projected = workflowViewSchema.parse(observed.snapshot.data);
      expect(projected.walletAvailability).toMatchObject({ status: "available", walletRunId: sdk.runId });
      expect(projected.assetReadAccount).toEqual({ status: "address_required" });
      expect(projected.usableConnectionId).toBeUndefined();
      expect(projected.allowedActions).toContain("cancel");
      expect(projected.allowedActions).not.toContain("use_account");
      expect(projected.allowedActions).not.toContain("prepare_review");
      expect(projected.automaticAction).toBeUndefined();
      // These absences also hold for occupied/unprepared normal inputs, so
      // they preserve invariants rather than independently proving pending.
      expect(projected.allowedActions).not.toContain("connect");
      expect(projected.allowedActions).not.toContain("request_signature");
    }
    expect(w.now().getTime()).toBe(at);
    expect(w.run(() => w.activity.getActiveAccountSync())).toEqual(stored);

    // Only after isolating pending do we test that time cannot end SDK work.
    w.advance(Date.parse(connection.expiresAt) - w.now().getTime());
    expect(w.now().getTime()).toBe(Date.parse(connection.expiresAt));
    const afterExpiry = await f.create();
    expect(afterExpiry.error).toBeUndefined();
    expect(view(afterExpiry).facts!.assetReadAccount).toEqual({ status: "address_required" });
    const connect = await w.run(() => w.cards.create("connect", { intent: "manage" }));
    expect(connect.error).toBeUndefined(); expect(connect.snapshot.state).toBe("ready");
    expect(workflowViewSchema.parse(connect.snapshot.data).allowedActions).toContain("cancel");
    expect(workflowViewSchema.parse(connect.snapshot.data).allowedActions).not.toContain("connect");
    const { session: freshSession } = await w.run(() => w.sessions.createReviewSession([w.plan], w.now()));
    const review = await w.run(() => w.cards.create("review", { reviewSessionId: freshSession.id }));
    expect(review.error).toBeUndefined(); expect(review.snapshot.state).toBe("ready");
    expect(workflowViewSchema.parse(review.snapshot.data).allowedActions).toContain("cancel");
    expect(workflowViewSchema.parse(review.snapshot.data).automaticAction).toBeUndefined();
    expect(finished).toBe(false);
    expect(w.runtime.snapshot()).toMatchObject({ runId: sdk.runId, sessions: sdk.sessions });
    expect(w.run(() => w.records.connection(connection.connectionId)!.sdkPending)).toBe(true);
    expect(w.run(() => w.records.connectionView(w.records.connection(connection.connectionId)!.connection).pendingAction)).toBe("disconnect");
  } finally {
    held.resolve();
    if (vi.mocked(w.transport.disconnect).mock.calls.length) await vi.waitFor(() => {
      expect(finished).toBe(true);
      expect(w.run(() => w.records.connection(connection.connectionId))).toMatchObject({ sdkPending: false, connection: { status: "disconnected" } });
      expect(w.runtime.snapshot()!.sessions.find((item) => item.topic === recorded.topic)?.status).toBe("absent");
    });
  }
  expect(w.run(() => w.cardRecords.get(card.snapshot.cardId)!.state)).toMatchObject({ state: "closed", reason: "completed" });
  expect(w.run(() => w.records.pendingDisconnect(connection.connectionId))).toBeUndefined();
  expect(w.run(() => w.activity.getActiveAccountSync())).toEqual(stored);
  expect(view(await f.create()).facts!.assetReadAccount).toEqual({ status: "address_required" });
  const fresh = await w.run(() => w.cards.create("connect", { intent: "manage" }));
  expect(fresh.error).toBeUndefined(); expect(fresh.snapshot.state).toBe("ready");
  expect(workflowViewSchema.parse(fresh.snapshot.data).allowedActions).toContain("connect");
  expect(w.quote).not.toHaveBeenCalled(); expect(w.connect).toHaveBeenCalledOnce();
  expect(w.sign).not.toHaveBeenCalled(); expect(w.submit).not.toHaveBeenCalled();
});

it.each(["signature", "lookup"].flatMap((deadline) => ["draft", "selected", "prepared", "executing", "completed"]
  .map((phase) => ({ deadline, phase }))))("keeps $phase Settings reads independent of a refused foreign $deadline deadline write", async ({ deadline, phase }) => {
  const f = await fixture(), w = f.wallet, signature = deferred<Awaited<ReturnType<typeof w.sign>>>(), publishing = deferred<void>(), release = deferred<void>();
  const db = new Database(join(w.directory, "activity.sqlite")); resources.push(() => { db.close(); });
  let heldSignature = false;
  try {
    const { connection } = await w.approve(), ready = await w.prepare(connection.connectionId);
    if (deadline === "signature") { heldSignature = true; w.sign.mockImplementationOnce(() => signature.promise); }
    else w.chainRead.mockRejectedValue(Object.assign(new Error("Synthetic pending chain observation"), { name: "TimeoutError" }));
    expect((await w.act(ready.card, { action: "request_signature", connectionId: connection.connectionId,
      account: w.account, reviewRevision: ready.session.reviewRevision })).error).toBeUndefined();
    await vi.waitFor(() => {
      expect(w.sign).toHaveBeenCalledOnce();
      const request = w.run(() => w.records.currentRequest(ready.session.id))!;
      expect(request.requestStatus).toBe(deadline === "signature" ? "awaiting_signature" : "awaiting_chain_result");
      expect(w.run(() => w.records.authority(request.attemptId))).toMatchObject(deadline === "signature"
        ? { sdk_pending: 1, submit_pending: 0, lookup_pending: 0 } : { sdk_pending: 0, submit_pending: 0, lookup_pending: 0 });
    });
    let card = phase === "draft" ? await f.create() : await f.prepare({ kind: "clear_read_address" });
    if (phase === "selected") card = { ...await f.act(card, { action: "settings_back", operationId: view(card).operationId }), permission: card.permission };
    if (phase === "executing") {
      const publish = f.files.createDownload.bind(f.files);
      vi.spyOn(f.files, "createDownload").mockImplementationOnce(async (...args) => { publishing.resolve(); await release.promise; return publish(...args); });
      card = await f.create(); await f.download(card); await publishing.promise;
      expect(w.run(() => f.records.get(view(card).operationId)?.phase)).toBe("executing");
    } else if (phase === "completed") card = { ...await f.confirm(card), permission: card.permission };
    const request = w.run(() => w.records.currentRequest(ready.session.id))!, authority = w.run(() => w.records.authority(request.attemptId))!;
    const storedDeadline = deadline === "signature" ? authority.signature_deadline : authority.lookup_deadline!;
    w.advance(Date.parse(storedDeadline) - w.now().getTime());
    const snapshot = () => w.run(() => ({ request: w.records.request(request.attemptId), authority: w.records.authority(request.attemptId),
      connections: w.records.connections(), address: w.activity.getActiveAccountSync(), control: f.records.control() }));
    const before = snapshot(), operation = w.run(() => f.records.get(view(card).operationId)), connectCalls = w.connect.mock.calls.length;
    db.exec(`CREATE TRIGGER refuse_foreign_deadline BEFORE UPDATE OF request_status ON review_requests
      WHEN OLD.attempt_id='${request.attemptId.replaceAll("'", "''")}' BEGIN SELECT RAISE(ABORT,'foreign deadline write refused'); END`);
    // Independent control proves that the intended expiry writer is due and
    // refused. No wallet read is allowed to settle it before the Settings read.
    expect(() => w.run(() => w.workflow.reconcileConnectionContext())).toThrow("foreign deadline write refused");
    const existing = await f.read(card), fresh = await f.create();
    expect(existing.error).toBeUndefined(); expect(fresh.error).toBeUndefined();
    expect(view(fresh).facts).toMatchObject({ walletAvailability: { status: "available" },
      assetReadAccount: phase === "completed" ? { status: "address_required" } : { status: "available", account: w.account },
      counts: { outcomeUnknownRequests: 0 } });
    if (phase === "completed") expect(view(existing).result).toEqual(operation!.result);
    else expect(view(existing).facts).toMatchObject({ walletAvailability: { status: "available" }, counts: { outcomeUnknownRequests: 0 } });
    expect(snapshot()).toEqual(before);
    expect(() => w.run(() => w.workflow.reconcileConnectionContext())).toThrow("foreign deadline write refused");
    expect(w.connect).toHaveBeenCalledTimes(connectCalls); expect(w.sign).toHaveBeenCalledOnce();
    expect(w.submit).toHaveBeenCalledTimes(deadline === "signature" ? 0 : 1);
    db.exec("DROP TRIGGER refuse_foreign_deadline");
    w.run(() => w.workflow.reconcileConnectionContext());
    expect(w.run(() => w.records.request(request.attemptId)?.requestStatus)).toBe(deadline === "signature" ? "request_failed" : "outcome_unknown");
    if (heldSignature) { signature.reject(new Error("Synthetic held signature ended")); heldSignature = false;
      await vi.waitFor(() => expect(w.run(() => w.records.authority(request.attemptId)?.sdk_pending)).toBe(0)); }
    release.resolve();
    if (phase === "executing") await vi.waitFor(async () => expect(view(await f.read(card)).result?.outcome).toBe("completed"));
  } finally { db.exec("DROP TRIGGER IF EXISTS refuse_foreign_deadline"); if (heldSignature) signature.reject(new Error("Synthetic signature fixture ended")); release.resolve(); }
});

it("rejects an omitted internal reconciliation purpose instead of defaulting to global maintenance", async () => {
  const f = await fixture(), w = f.wallet;
  const before = w.run(() => ({ cards: f.records.db.prepare("SELECT id,revision,state FROM live_read_cards").all(), control: f.records.control() }));
  expect(() => w.run(() => w.records.reconcileAndEvaluate({ walletAvailability: w.runtime.availability() } as never))).toThrow("An explicit workflow evaluation target is required");
  expect(w.run(() => ({ cards: f.records.db.prepare("SELECT id,revision,state FROM live_read_cards").all(), control: f.records.control() }))).toEqual(before);
  expect(w.connect).not.toHaveBeenCalled(); expect(w.sign).not.toHaveBeenCalled(); expect(w.submit).not.toHaveBeenCalled();
});

it("reads Settings facts while an unrelated pending connection expiry remains unwritable", async () => {
  const f = await fixture(), w = f.wallet, overview = await f.create(), connecting = await w.createConnection();
  await w.act(connecting, { action: "connect" });
  await vi.waitFor(() => expect(w.connect).toHaveBeenCalledOnce());
  const pending = w.run(() => w.records.connections()[0])!;
  expect(pending.connection.status).toBe("awaiting_approval"); expect(pending.sdkPending).toBe(true);
  w.advance(Date.parse(pending.connection.expiresAt) - w.now().getTime());
  const db = new Database(join(w.directory, "activity.sqlite")); resources.push(() => { db.close(); });
  try {
    db.exec(`CREATE TRIGGER refuse_foreign_connection_expiry BEFORE UPDATE ON live_wallet_connections
      WHEN OLD.id='${pending.connection.connectionId.replaceAll("'", "''")}' BEGIN SELECT RAISE(ABORT,'foreign connection expiry refused'); END`);
    expect(() => w.run(() => w.workflow.reconcileConnectionContext())).toThrow("foreign connection expiry refused");
    const before = w.run(() => w.records.connection(pending.connection.connectionId));
    for (const response of [await f.read(overview), await f.create()]) {
      expect(response.error).toBeUndefined(); expect(view(response).facts).toMatchObject({ walletAvailability: { status: "available" }, assetReadAccount: { status: "address_required" } });
    }
    expect(w.run(() => w.records.connection(pending.connection.connectionId))).toEqual(before);
    expect(w.run(() => w.workflow.currentConnectionContext()).manageableConnectionIds).toEqual([]);
    expect(() => w.run(() => w.workflow.reconcileConnectionContext())).toThrow("foreign connection expiry refused");
    db.exec("DROP TRIGGER refuse_foreign_connection_expiry"); w.run(() => w.workflow.reconcileConnectionContext());
    expect(w.run(() => w.records.connection(pending.connection.connectionId)?.connection.status)).toBe("expired");
    // Complete the real held callback; pending is not cleared by a read or clock.
    w.approval.reject(new Error("Synthetic expired pairing ended"));
    await vi.waitFor(() => expect(w.run(() => w.records.connection(pending.connection.connectionId)?.sdkPending)).toBe(false));
    expect(w.connect).toHaveBeenCalledOnce(); expect(w.sign).not.toHaveBeenCalled(); expect(w.submit).not.toHaveBeenCalled();
  } finally { db.exec("DROP TRIGGER IF EXISTS refuse_foreign_connection_expiry"); }
});

async function uploadBackup(f: Awaited<ReturnType<typeof fixture>>, raw: Buffer, initial?: Awaited<ReturnType<typeof f.create>>) {
  let card = initial ?? await f.create(); const permission = card.permission;
  const call = async (input: Record<string, unknown>) => {
    card = { ...await f.act(card, input), permission }; expect(card.error).toBeUndefined();
  };
  await call({ action: "settings_select", draft: { kind: "import_local_data" } });
  const operationId = view(card).operationId;
  await call({ action: "settings_begin_upload", operationId, name: "backup.json", totalSize: raw.length,
    sha256: createHash("sha256").update(raw).digest("hex") });
  const fileId = view(card).file!.fileId;
  for (let offset = 0; offset < raw.length; offset += 20000) {
    await call({ action: "settings_upload_chunk", operationId, fileId, offset,
      chunkBase64: raw.subarray(offset, offset + 20000).toString("base64") });
  }
  await call({ action: "settings_seal_upload", operationId, fileId });
  return card;
}

it.each(["chain_identifier_mismatch", "invalid_url"] as const)("retains a definite %s backup rejection across Back and same-count data changes until explicit selection", async (kind) => {
  let reject = true;
  const verify = vi.fn(async () => { if (reject) throw new SuiEndpointError(kind, "Private provider diagnostic"); });
  const f = await fixture({ verifyEndpoint: verify }), w = f.wallet;
  await w.run(() => w.activity.setActiveAccount(w.account, "wallet_connection", w.now()));
  const raw = Buffer.from(JSON.stringify(await w.run(() => f.localData.exportLocalData())));
  let card = await uploadBackup(f, raw), fileId = view(card).file!.fileId;
  expect(view(card).restoreCheck).toEqual({ status: "can_restore" }); expect(verify).not.toHaveBeenCalled();
  card = { ...await f.confirm(card), permission: card.permission };
  expect(card.error?.code).toBe("invalid_card_input");
  const assertRejected = () => {
    expect(view(card)).toMatchObject({ phase: "sealed", restoreCheck: { status: "cannot_restore", reason: "invalid_backup" }, file: { fileId } });
    expect(view(card).allowedActions).not.toContain("settings_prepare"); expect(view(card).allowedActions).not.toContain("settings_confirm");
    expect(w.run(() => f.records.control())).toMatchObject({ data_epoch: 0, active_operation_id: null });
    expect(w.run(() => w.cardRecords.get(card.snapshot.cardId)?.acceptedInput)).toBeUndefined();
  };
  assertRejected(); const calls = verify.mock.calls.length;
  card = { ...await f.act(card, { action: "settings_back", operationId: view(card).operationId }), permission: card.permission };
  assertRejected();
  const counts = w.run(() => f.localData.getDataCountsSync()), revision = w.run(() => f.records.control().user_data_revision);
  w.advance(1); await w.run(() => w.activity.setActiveAccount(w.account, "wallet_connection", w.now()));
  expect(w.run(() => f.localData.getDataCountsSync())).toEqual(counts);
  expect(w.run(() => f.records.control().user_data_revision)).toBeGreaterThan(revision);
  card = await f.read(card); assertRejected();
  card = { ...await f.act(card, { action: "settings_prepare", operationId: view(card).operationId }), permission: card.permission };
  expect(card.error?.code).toBe("card_conflict"); assertRejected(); expect(verify).toHaveBeenCalledTimes(calls);
  reject = false;
  card = await uploadBackup(f, raw, card);
  expect(view(card).file!.fileId).not.toBe(fileId); expect(view(card).restoreCheck).toEqual({ status: "can_restore" });
  expect(verify).toHaveBeenCalledTimes(calls);
  const result = await f.confirm(card); expect(result.error).toBeUndefined(); expect(view(result).result?.outcome).toBe("completed");
  expect(w.run(() => f.records.control().data_epoch)).toBe(1); expect(verify.mock.calls.length).toBeGreaterThan(calls);
  expect(w.sign).not.toHaveBeenCalled(); expect(w.submit).not.toHaveBeenCalled();
});

it.each(["endpoint_timeout", "endpoint_unreachable"] as const)("permits an explicit retry of a transient %s while preserving final network verification", async (kind) => {
  let reject = true;
  const verify = vi.fn(async () => { if (reject) throw new SuiEndpointError(kind, "Private provider diagnostic"); });
  const f = await fixture({ verifyEndpoint: verify });
  const raw = Buffer.from(JSON.stringify(await f.wallet.run(() => f.localData.exportLocalData())));
  let card = await uploadBackup(f, raw); const fileId = view(card).file!.fileId;
  card = { ...await f.confirm(card), permission: card.permission };
  expect(view(card).restoreCheck).toMatchObject({ status: "cannot_restore", reason: "check_failed" });
  expect(view(card).allowedActions).toContain("settings_prepare"); expect(view(card).allowedActions).not.toContain("settings_confirm");
  expect(f.wallet.run(() => f.records.control().data_epoch)).toBe(0);
  const calls = verify.mock.calls.length; reject = false;
  card = { ...await f.act(card, { action: "settings_prepare", operationId: view(card).operationId }), permission: card.permission };
  expect(view(card)).toMatchObject({ restoreCheck: { status: "can_restore" }, file: { fileId } });
  expect(verify).toHaveBeenCalledTimes(calls); expect(f.wallet.run(() => f.records.control().data_epoch)).toBe(0);
  expect(view(await f.confirm(card)).result?.outcome).toBe("completed");
  expect(verify.mock.calls.length).toBeGreaterThan(calls); expect(f.wallet.sign).not.toHaveBeenCalled();
});

it("does not describe an unfinished download snapshot as a startup supersession conflict", async () => {
  const f = await fixture(), entered = deferred<void>(), release = deferred<void>(), publish = f.files.createDownload.bind(f.files);
  vi.spyOn(f.files, "createDownload").mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return publish(...args); });
  const fresh = await f.create();
  const selected = { ...await f.act(fresh, { action: "settings_select", draft: { kind: "restart_wallet_service" } }), permission: fresh.permission };
  expect(selected.error).toBeUndefined(); expect(view(selected).draft).toEqual({ kind: "restart_wallet_service" });
  const backup = await f.create(); await f.download(backup);
  try {
    await entered.promise;
    expect(f.wallet.run(() => f.records.get(view(backup).operationId)?.phase)).toBe("executing");
    expect(f.wallet.runtime.availability().status).toBe("available");
    const denied = await f.act(selected, { action: "settings_prepare", operationId: view(selected).operationId });
    expect(denied.error).toMatchObject({ code: "card_conflict", message: "A Settings change or service restart has not finished. This restart cannot replace it." });
    expect(denied.error!.message).not.toContain("startup");
    expect(f.wallet.runtime.availability().status).toBe("available");
    expect(f.wallet.run(() => f.records.control().active_operation_id)).toBe(view(backup).operationId);
    release.resolve(); await vi.waitFor(async () => expect(view(await f.read(backup)).result?.outcome).toBe("completed"));
  } finally { release.resolve(); }
});

it("explains a stopped transaction check's remaining replacement window without restarting it", async () => {
  const f = await fixture(), w = f.wallet, { connection } = await w.approve(), ready = await w.prepare(connection.connectionId);
  const submission = deferred<object>(); w.submit.mockImplementationOnce(() => submission.promise);
  await w.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: w.account, reviewRevision: ready.session.reviewRevision });
  await vi.waitFor(() => expect(w.submit).toHaveBeenCalledOnce());
  const request = w.run(() => w.records.currentRequest(ready.session.id))!;
  const manage = await w.run(() => w.cards.create("review", { mode: "manage", reviewSessionId: ready.session.id, attemptId: request.attemptId }));
  expect((await w.act(manage, { action: "stop_waiting" })).error).toBeUndefined(); submission.resolve({});
  await vi.waitFor(() => expect(w.run(() => w.records.authority(request.attemptId))).toMatchObject({ sdk_pending: 0, submit_pending: 0, lookup_pending: 0, observation_stopped: 1 }));
  expect(w.run(() => w.records.request(request.attemptId)?.requestStatus)).toBe("awaiting_chain_result"); expect(w.chainRead).not.toHaveBeenCalled();
  const reset = await f.prepare({ kind: "reset_local_data" });
  const rejected = { ...await f.confirm(reset), permission: reset.permission };
  expect(rejected.error).toMatchObject({ code: "invalid_card_input", message: expect.stringContaining("initial transaction-result waiting period") });
  expect(rejected.error!.message).not.toContain("check is still in progress"); expect(w.run(() => f.records.control().data_epoch)).toBe(0);
  const deadline = w.run(() => w.records.authority(request.attemptId)!.lookup_deadline)!;
  w.advance(Date.parse(deadline) - w.now().getTime());
  const stale = { ...await f.confirm(rejected), permission: reset.permission };
  expect(stale.error?.code).toBe("card_conflict"); expect(w.run(() => w.records.request(request.attemptId)?.requestStatus)).toBe("outcome_unknown");
  const updated = { ...await f.act(stale, { action: "settings_prepare", operationId: view(stale).operationId }), permission: reset.permission };
  expect(view(updated).preparation!.counts).toMatchObject({ outcomeUnknownRequests: 1 });
  expect(view(await f.confirm(updated)).result?.outcome).toBe("completed");
  expect(w.chainRead).not.toHaveBeenCalled(); expect(w.submit).toHaveBeenCalledOnce();
});

it("keeps an automatic check pending through a frame read and rejects a data change before publishing its result", async () => {
  const f = await fixture(), entered = deferred<void>(), release = deferred<void>();
  const raw = Buffer.from(JSON.stringify(await f.wallet.run(() => f.localData.exportLocalData())));
  const read = f.files.readUpload.bind(f.files);
  const physical = vi.spyOn(f.files, "readUpload").mockImplementationOnce(async (...args) => {
    entered.resolve(); await release.promise; return read(...args);
  });
  let card = await f.create(); const permission = card.permission;
  const call = async (input: Record<string, unknown>) => { card = { ...await f.act(card, input), permission }; return card; };
  await call({ action: "settings_select", draft: { kind: "import_local_data" } });
  const id = view(card).operationId;
  await call({ action: "settings_begin_upload", operationId: id, name: "backup.json", totalSize: raw.length,
    sha256: createHash("sha256").update(raw).digest("hex") });
  const fileId = view(card).file!.fileId;
  await call({ action: "settings_upload_chunk", operationId: id, fileId, offset: 0, chunkBase64: raw.toString("base64") });
  const pending = f.act(card, { action: "settings_seal_upload", operationId: id, fileId });
  try {
    await entered.promise;
    const during = await f.read(card);
    expect(view(during).restoreCheck).toEqual({ status: "checking" });
    expect(view(during).allowedActions).not.toContain("settings_confirm");
    expect(physical).toHaveBeenCalledOnce();
    await f.wallet.run(() => f.wallet.activity.setActiveAccount(`0x${"b".repeat(64)}`, "wallet_connection", f.wallet.now()));
    release.resolve(); card = { ...await pending, permission };
    expect(view(card)).toMatchObject({ restoreCheck: { status: "check_required" }, file: { fileId, sealed: true } });
    expect(f.wallet.run(() => f.records.control().data_epoch)).toBe(0);
    await call({ action: "settings_prepare", operationId: id });
    expect(view(card).restoreCheck).toEqual({ status: "can_restore" });
    expect(view(card).file!.fileId).toBe(fileId);
    expect((view(card).preparation!.preview as LocalDataImportPreview).activeAccountChange).toBe("cleared");
    expect(f.wallet.run(() => f.wallet.cardRecords.get(card.snapshot.cardId)!.acceptedInput)).toBeUndefined();
    expect(f.wallet.sign).not.toHaveBeenCalled(); expect(f.wallet.submit).not.toHaveBeenCalled();
  } finally { release.resolve(); await pending; }
});

it("retains a usable recheck after automatic preparation storage fails without claiming restoration", async () => {
  const f = await fixture(), raw = Buffer.from(JSON.stringify(await f.wallet.run(() => f.localData.exportLocalData())));
  let card = await f.create(); const permission = card.permission;
  const call = async (input: Record<string, unknown>) => { card = { ...await f.act(card, input), permission }; };
  await call({ action: "settings_select", draft: { kind: "import_local_data" } });
  const id = view(card).operationId;
  await call({ action: "settings_begin_upload", operationId: id, name: "backup.json", totalSize: raw.length,
    sha256: createHash("sha256").update(raw).digest("hex") });
  const fileId = view(card).file!.fileId;
  await call({ action: "settings_upload_chunk", operationId: id, fileId, offset: 0, chunkBase64: raw.toString("base64") });
  const db = new Database(join(f.wallet.directory, "activity.sqlite")); resources.push(() => { db.close(); });
  db.exec("CREATE TRIGGER refuse_import_check BEFORE UPDATE ON settings_operations WHEN NEW.phase='prepared' BEGIN SELECT RAISE(ABORT,'check storage refused'); END");
  await expect(f.act(card, { action: "settings_seal_upload", operationId: id, fileId })).rejects.toThrow("check storage refused");
  card = await f.read(card);
  expect(view(card)).toMatchObject({ restoreCheck: { status: "cannot_restore", reason: "check_failed" } });
  expect(view(card).allowedActions).toContain("settings_prepare");
  expect(view(card).allowedActions).not.toContain("settings_confirm");
  expect(f.wallet.run(() => f.records.control())).toMatchObject({ active_operation_id: null, data_epoch: 0 });
  db.exec("DROP TRIGGER refuse_import_check");
  await call({ action: "settings_prepare", operationId: id });
  expect(view(card)).toMatchObject({ phase: "prepared", restoreCheck: { status: "can_restore" }, file: { fileId, sealed: true } });
  expect(f.wallet.run(() => f.wallet.cardRecords.get(card.snapshot.cardId)!.acceptedInput)).toBeUndefined();
});

it("projects and enforces the shared file reservation without blocking duplicate prefix reads or rewriting other work", async () => {
  const f = await fixture(), w = f.wallet, entered = deferred<void>(), release = deferred<void>();
  const raw = Buffer.from(JSON.stringify(await w.run(() => f.localData.exportLocalData())));
  const prepared = await uploadBackup(f, raw);
  const selectionCases: { action: string; card: Awaited<ReturnType<typeof f.create>> }[] = [];
  for (const action of ["settings_select", "settings_back", "settings_cancel"]) {
    selectionCases.push({ action, card: await f.prepare({ kind: "clear_read_address" }) });
  }
  let partial = await f.create();
  partial = { ...await f.act(partial, { action: "settings_select", draft: { kind: "import_local_data" } }), permission: partial.permission };
  const partialId = view(partial).operationId;
  partial = { ...await f.act(partial, { action: "settings_begin_upload", operationId: partialId, name: "partial.json", totalSize: raw.length,
    sha256: createHash("sha256").update(raw).digest("hex") }), permission: partial.permission };
  const fileId = view(partial).file!.fileId;
  partial = { ...await f.act(partial, { action: "settings_upload_chunk", operationId: partialId, fileId, offset: 0,
    chunkBase64: raw.subarray(0, 1).toString("base64") }), permission: partial.permission };
  let empty = await f.create();
  empty = { ...await f.act(empty, { action: "settings_select", draft: { kind: "import_local_data" } }), permission: empty.permission };
  let complete = await f.create();
  complete = { ...await f.act(complete, { action: "settings_select", draft: { kind: "import_local_data" } }), permission: complete.permission };
  const completeId = view(complete).operationId;
  complete = { ...await f.act(complete, { action: "settings_begin_upload", operationId: completeId, name: "complete.json", totalSize: raw.length,
    sha256: createHash("sha256").update(raw).digest("hex") }), permission: complete.permission };
  const completeFile = view(complete).file!.fileId;
  complete = { ...await f.act(complete, { action: "settings_upload_chunk", operationId: completeId, fileId: completeFile, offset: 0,
    chunkBase64: raw.toString("base64") }), permission: complete.permission };
  expect(view(complete).allowedActions).toContain("settings_seal_upload");
  const pristine = w.run(() => f.records.get(partialId)), beforeFile = w.run(() => f.records.file(fileId));
  expect(view(partial).allowedActions).toContain("settings_upload_chunk");
  expect(view(partial).allowedActions).not.toContain("settings_seal_upload");
  expect(view(empty).allowedActions).toContain("settings_begin_upload");
  for (const item of selectionCases) expect(view(item.card).allowedActions).toContain(item.action);
  const publish = f.files.createDownload.bind(f.files);
  vi.spyOn(f.files, "createDownload").mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return publish(...args); });
  const blocker = await f.create();
  try {
    expect((await f.download(blocker)).error).toBeUndefined(); await entered.promise;
    const heldIO = w.run(() => f.records.control().file_io_id); expect(heldIO).not.toBeNull();
    for (const item of selectionCases) {
      const original = w.run(() => f.records.get(view(item.card).operationId));
      const current = await f.read(item.card);
      expect(view(current).allowedActions).not.toContain(item.action);
      expect(view(current).allowedActions).not.toContain("settings_confirm");
      // Send the valid permission/revision read before the competing I/O.
      // The actual guard must still reject it; the UI projection is not a lock.
      const input = item.action === "settings_select" ? { action: item.action, draft: { kind: "clear_read_address" } }
        : item.action === "settings_cancel" ? { action: item.action } : { action: item.action, operationId: original!.operationId };
      expect((await f.act(item.card, input)).error?.code).toBe("card_conflict");
      expect(w.run(() => f.records.get(original!.operationId))).toEqual(original);
      expect((await f.confirm(item.card)).error?.code).toBe("card_conflict");
    }
    expect(view(await f.read(empty)).allowedActions).not.toContain("settings_begin_upload");
    expect((await f.act(empty, { action: "settings_begin_upload", operationId: view(empty).operationId, name: "new.json", totalSize: raw.length,
      sha256: createHash("sha256").update(raw).digest("hex") })).error?.code).toBe("card_conflict");
    const completeBefore = w.run(() => f.records.get(completeId));
    expect(view(await f.read(complete)).allowedActions).not.toContain("settings_seal_upload");
    expect((await f.act(complete, { action: "settings_seal_upload", operationId: completeId, fileId: completeFile })).error?.code).toBe("card_conflict");
    expect(w.run(() => f.records.get(completeId))).toEqual(completeBefore);
    const restore = await f.read(prepared);
    expect(view(restore)).toMatchObject({ phase: "prepared", restoreCheck: { status: "cannot_restore", reason: "operation_busy" } });
    expect(view(restore).allowedActions).not.toContain("settings_prepare");
    expect((await f.act(restore, { action: "settings_prepare", operationId: view(restore).operationId })).error?.code).toBe("card_conflict");
    expect((await f.act(partial, { action: "settings_upload_chunk", operationId: partialId, fileId, offset: 0,
      chunkBase64: raw.subarray(0, 1).toString("base64") })).error).toBeUndefined();
    expect((await f.act(partial, { action: "settings_upload_chunk", operationId: partialId, fileId, offset: 1,
      chunkBase64: raw.subarray(1).toString("base64") })).error?.code).toBe("card_conflict");
    expect(w.run(() => f.records.get(partialId))).toEqual(pristine);
    expect(w.run(() => f.records.file(fileId))).toEqual(beforeFile);
    expect(await readFile(join(w.directory, ".settings-staging", `${fileId}.upload`))).toEqual(raw.subarray(0, 1));
    expect(w.run(() => f.records.control().file_io_id)).toBe(heldIO);
    release.resolve(); await vi.waitFor(async () => expect(view(await f.read(blocker)).result?.outcome).toBe("completed"));
    expect(view(await f.read(prepared)).restoreCheck).toEqual({ status: "can_restore" });
    expect(view(await f.read(complete)).allowedActions).toContain("settings_seal_upload");
    expect((await f.act(complete, { action: "settings_seal_upload", operationId: completeId, fileId: completeFile })).error).toBeUndefined();

    for (const item of selectionCases) {
      const current = await f.read(item.card); expect(view(current).allowedActions).toContain(item.action);
      const input = item.action === "settings_select" ? { action: item.action, draft: { kind: "clear_read_address" } }
        : item.action === "settings_cancel" ? { action: item.action } : { action: item.action, operationId: view(current).operationId };
      expect((await f.act(current, input)).error).toBeUndefined();
    }
    partial = { ...await f.act(partial, { action: "settings_upload_chunk", operationId: partialId, fileId, offset: 1,
      chunkBase64: raw.subarray(1).toString("base64") }), permission: partial.permission };
    expect(view(partial).allowedActions).toContain("settings_seal_upload");
    expect((await f.act(partial, { action: "settings_seal_upload", operationId: partialId, fileId })).error).toBeUndefined();
    expect(w.run(() => f.records.control())).toMatchObject({ file_io_id: null, active_operation_id: null, data_epoch: 0 });
    expect(w.sign).not.toHaveBeenCalled(); expect(w.submit).not.toHaveBeenCalled();
  } finally { release.resolve(); await vi.waitFor(async () => expect(view(await f.read(blocker)).result?.outcome).toBe("completed")); }
});

it("projects a valid backup as unavailable while another final operation owns the slot, without consuming its input", async () => {
  const f = await fixture(), entered = deferred<void>(), release = deferred<void>();
  const raw = Buffer.from(JSON.stringify(await f.wallet.run(() => f.localData.exportLocalData())));
  const imported = await uploadBackup(f, raw), publish = f.files.createDownload.bind(f.files);
  expect(view(imported).restoreCheck).toEqual({ status: "can_restore" });
  vi.spyOn(f.files, "createDownload").mockImplementationOnce(async (...args) => {
    entered.resolve(); await release.promise; return publish(...args);
  });
  const exported = await f.create();
  try {
    await f.download(exported); await entered.promise;
    expect(view(await f.read(imported)).restoreCheck).toMatchObject({ status: "cannot_restore", reason: "operation_busy" });
    expect((await f.confirm(imported)).error?.code).toBe("card_conflict");
    expect(f.wallet.run(() => f.wallet.cardRecords.get(imported.snapshot.cardId)!.acceptedInput)).toBeUndefined();
    expect(f.wallet.run(() => f.records.control().active_operation_id)).toBe(view(exported).operationId);
    release.resolve();
    await vi.waitFor(async () => expect(view(await f.read(exported)).result?.outcome).toBe("completed"));
    expect(view(await f.read(imported)).restoreCheck).toEqual({ status: "can_restore" });
  } finally { release.resolve(); await vi.waitFor(async () => expect(view(await f.read(exported)).result?.outcome).toBe("completed")); }
});

it.each(["file_changed", "endpoint_failed"] as const)("revokes restore availability after rejected final verification (%s) without replacing data", async (cause) => {
  let rejectEndpoint = false;
  const f = await fixture({ verifyEndpoint: async () => { if (rejectEndpoint) throw new Error("Synthetic unavailable endpoint"); } });
  const raw = Buffer.from(JSON.stringify(await f.wallet.run(() => f.localData.exportLocalData())));
  const prepared = await uploadBackup(f, raw), fileId = view(prepared).file!.fileId;
  expect(view(prepared).restoreCheck).toEqual({ status: "can_restore" });
  if (cause === "file_changed") await writeFile(join(f.wallet.directory, ".settings-staging", `${fileId}.upload`), Buffer.alloc(raw.length, 1));
  else rejectEndpoint = true;
  if (cause === "file_changed") expect((await f.confirm(prepared)).error?.code).toBe("card_conflict");
  else await expect(f.confirm(prepared)).rejects.toThrow();
  const current = await f.read(prepared);
  expect(view(current)).toMatchObject({ phase: "sealed", restoreCheck: { status: "cannot_restore",
    reason: cause === "file_changed" ? "file_unavailable" : "check_failed" }, file: { fileId } });
  expect(view(current).allowedActions).not.toContain("settings_confirm");
  expect(f.wallet.run(() => f.records.control())).toMatchObject({ data_epoch: 0, active_operation_id: null });
  expect(f.wallet.run(() => f.wallet.cardRecords.get(prepared.snapshot.cardId)!.acceptedInput)).toBeUndefined();
  expect(view(current).result).toBeUndefined();
});

it.each([false, true])("checks the real parent submission guard after verified signing with Settings restart=%s", async (restart) => {
  const f = await fixture(), w = f.wallet, entered = deferred<void>(), release = deferred<void>();
  const admission = vi.spyOn(w.records, "beginSubmission");
  try {
    const { connection } = await w.approve(), ready = await w.prepare(connection.connectionId);
    w.verifyNetwork.mockImplementationOnce(async () => { entered.resolve(); await release.promise; });
    await w.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: w.account, reviewRevision: ready.session.reviewRevision });
    // This await is after the actual digest and cryptographic signer checks in
    // WalletWorkflow.performSignature. No signature verifier or CAS is mocked.
    await entered.promise;
    const request = w.run(() => w.records.currentRequest(ready.session.id))!;
    expect(w.sign).toHaveBeenCalledOnce(); expect(w.submit).not.toHaveBeenCalled();
    expect(w.run(() => w.records.authority(request.attemptId)?.sdk_pending)).toBe(1);
    if (restart) {
      const recover = await f.prepare({ kind: "restart_wallet_service" }); await f.confirm(recover);
      await vi.waitFor(async () => expect(view(await f.read(recover)).result?.outcome).toBe("completed"));
      expect(w.run(() => w.records.request(request.attemptId)?.requestStatus)).toBe("stopped");
      expect(w.run(() => w.records.beginSubmission(request.attemptId))).toBe(false);
      // The live parent continuation remains protected until its real await ends.
      expect(w.run(() => w.records.authority(request.attemptId)?.sdk_pending)).toBe(1);
      const reset = await f.prepare({ kind: "reset_local_data" });
      expect((await f.confirm(reset)).error).toMatchObject({ code: "invalid_card_input", message: "A wallet or transaction response is still pending, or the initial transaction-result waiting period has not ended. Local records cannot be replaced yet." });
      expect(w.run(() => f.records.control().data_epoch)).toBe(0);
    }
    release.resolve();
    await vi.waitFor(() => expect(w.run(() => w.records.authority(request.attemptId)?.sdk_pending)).toBe(0));
    if (restart) {
      expect(w.submit).not.toHaveBeenCalled(); expect(w.chainRead).not.toHaveBeenCalled();
      expect(w.run(() => w.records.request(request.attemptId))).toMatchObject({ attemptId: request.attemptId,
        transactionDigest: request.transactionDigest, requestStatus: "stopped", reason: "The wallet service was restarted before submission. Nothing was submitted." });
    } else {
      await vi.waitFor(() => expect(w.submit).toHaveBeenCalledOnce());
      expect(admission).toHaveBeenCalledExactlyOnceWith(request.attemptId);
      expect(admission.mock.results[0]).toMatchObject({ type: "return", value: true });
      await vi.waitFor(() => expect(w.run(() => w.records.request(request.attemptId)?.requestStatus)).toBe("completed"));
    }
  } finally { release.resolve(); }
});

it("preserves a request admitted before Settings restart and observes the same digest after its one dispatched submit ends", async () => {
  const f = await fixture(), w = f.wallet, entered = deferred<void>(), release = deferred<void>(), submit = w.submit.getMockImplementation()!;
  try {
    const { connection } = await w.approve(), ready = await w.prepare(connection.connectionId);
    w.submit.mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return submit(...args); });
    await w.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: w.account, reviewRevision: ready.session.reviewRevision });
    await entered.promise;
    const request = w.run(() => w.records.currentRequest(ready.session.id))!;
    expect(request.requestStatus).toBe("submitting"); expect(request.signatureVerifiedAt).toBe(w.now().toISOString());
    expect(w.run(() => w.records.authority(request.attemptId))).toMatchObject({ can_submit: 0, submit_pending: 1 });
    const recover = await f.prepare({ kind: "restart_wallet_service" }); await f.confirm(recover);
    await vi.waitFor(async () => expect(view(await f.read(recover)).result?.outcome).toBe("completed"));
    expect(w.run(() => w.records.request(request.attemptId)?.requestStatus)).toBe("submitting");
    expect(w.run(() => w.records.beginSubmission(request.attemptId))).toBe(false);
    release.resolve(); await vi.waitFor(() => expect(w.run(() => w.records.request(request.attemptId)?.requestStatus)).toBe("completed"));
    const result = w.run(() => w.records.request(request.attemptId))!;
    expect(result.transactionDigest).toBe(request.transactionDigest); expect(result.execution?.txDigest).toBe(request.transactionDigest);
    expect(w.submit).toHaveBeenCalledOnce(); expect(w.chainRead).toHaveBeenCalledOnce();
  } finally { release.resolve(); }
});

it.each(["sdk", "parent", "submit", "lookup", "initial_window"].flatMap((boundary) => ["reset", "import"].map((kind) => ({ boundary, kind }))))("rejects scoped $kind during actual $boundary work and applies only after that work ends", async ({ boundary, kind }) => {
  const f = await fixture(), w = f.wallet, entered = deferred<void>(), release = deferred<void>();
  try {
    const { connection } = await w.approve(), ready = await w.prepare(connection.connectionId);
    const sign = w.sign.getMockImplementation()!, submit = w.submit.getMockImplementation()!, chain = w.chainRead.getMockImplementation()!;
    if (boundary === "sdk") w.sign.mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return sign(...args); });
    if (boundary === "parent") w.verifyNetwork.mockImplementationOnce(async () => { entered.resolve(); await release.promise; });
    if (boundary === "submit") w.submit.mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return submit(...args); });
    if (boundary === "lookup") w.chainRead.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return chain(); });
    if (boundary === "initial_window") w.chainRead.mockImplementationOnce(async () => { entered.resolve(); throw Object.assign(new Error("No chain result yet"), { name: "TimeoutError" }); });
    await w.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: w.account, reviewRevision: ready.session.reviewRevision });
    await entered.promise;
    const request = w.run(() => w.records.currentRequest(ready.session.id))!;
    if (boundary === "initial_window") await vi.waitFor(() => {
      expect(w.run(() => w.records.request(request.attemptId)?.requestStatus)).toBe("awaiting_chain_result");
      expect(w.run(() => w.records.authority(request.attemptId))).toMatchObject({ sdk_pending: 0, submit_pending: 0, lookup_pending: 0 });
    });
    const raw = Buffer.from(JSON.stringify(await w.run(() => f.localData.exportLocalData(w.now()))));
    const reset = kind === "reset" ? await f.prepare({ kind: "reset_local_data" }) : await uploadBackup(f, raw);
    if (kind === "import") {
      expect(view(reset).restoreCheck).toMatchObject({ status: "cannot_restore", reason: "wallet_request_unsettled" });
      expect(view(reset).allowedActions).not.toContain("settings_confirm");
      // The actual replacement sink remains protected, independently of a
      // missing preparation ID or the UI's eligibility decision.
      const validated = await w.run(() => f.localData.parseAndVerifyImportEnvelope(JSON.parse(raw.toString("utf8"))));
      expect(() => w.run(() => f.records.transaction(() => f.localData.applyValidatedReplacement(validated, w.now()))))
        .toThrow("A wallet request is still unsettled");
    } else {
      expect((await f.confirm(reset)).error).toMatchObject({ code: "invalid_card_input", message: "A wallet or transaction response is still pending, or the initial transaction-result waiting period has not ended. Local records cannot be replaced yet." });
    }
    expect(w.run(() => f.records.control())).toMatchObject({ data_epoch: 0, active_operation_id: null });
    expect(w.run(() => w.records.request(request.attemptId)?.requestStatus)).toBe(request.requestStatus);
    expect(w.run(() => w.cardRecords.get(reset.snapshot.cardId)?.acceptedInput)).toBeUndefined();
    const fileId = view(reset).file?.fileId;
    let corrected = reset;
    if (kind === "import") {
      corrected = await f.read(corrected);
      corrected = { ...await f.act(corrected, { action: "settings_back", operationId: view(corrected).operationId }), permission: reset.permission };
      expect(view(corrected)).toMatchObject({ phase: "sealed", file: { fileId, sealed: true } });
      corrected = { ...await f.act(corrected, { action: "settings_prepare", operationId: view(corrected).operationId }), permission: reset.permission };
      expect(corrected.error).toBeUndefined();
      expect(view(corrected).restoreCheck).toMatchObject({ status: "cannot_restore", reason: "wallet_request_unsettled" });
      expect(view(corrected).allowedActions).not.toContain("settings_confirm");
      expect(w.run(() => f.records.control().data_epoch)).toBe(0);
    }
    release.resolve();
    if (boundary === "initial_window") w.run(() => w.workflow.observe(request.attemptId));
    await vi.waitFor(() => expect(w.run(() => w.records.request(request.attemptId)?.requestStatus)).toBe("completed"));
    let fresh = kind === "reset" ? await f.prepare({ kind: "reset_local_data" }) : await f.read(corrected);
    if (kind === "import") {
      expect(view(fresh).file?.fileId).toBe(fileId);
      fresh = { ...await f.act(fresh, { action: "settings_prepare", operationId: view(fresh).operationId }), permission: reset.permission };
      expect(fresh.error).toBeUndefined(); expect(view(fresh).file?.fileId).toBe(fileId);
    }
    expect(view(await f.confirm(fresh)).result?.outcome).toBe("completed");
    expect(w.run(() => f.records.control().data_epoch)).toBe(1);
    expect(w.submit).toHaveBeenCalledOnce();
  } finally { release.resolve(); }
});

it("preserves exact completed Settings and transaction reads while an unrelated download result remains unwritable", async () => {
  const f = await fixture(), w = f.wallet;
  const own = await f.prepare({ kind: "clear_read_address" }), ownResult = view(await f.confirm(own)).result;
  const { connection } = await w.approve(), ready = await w.prepare(connection.connectionId);
  await w.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: w.account, reviewRevision: ready.session.reviewRevision });
  await vi.waitFor(() => expect(w.run(() => w.records.currentRequest(ready.session.id)?.requestStatus)).toBe("completed"));
  const completed = await w.read(ready.card);
  const other = await f.create(), otherId = view(other).operationId;
  const db = new Database(join(w.directory, "activity.sqlite")); resources.push(() => { db.close(); });
  db.exec(`CREATE TRIGGER reject_other_result BEFORE UPDATE ON settings_operations WHEN NEW.operation_id='${otherId}' AND NEW.phase='terminal' BEGIN SELECT RAISE(ABORT,'unrelated download result refused'); END`);
  await f.download(other);
  await vi.waitFor(async () => expect((await readFile(downloadPath(f, other))).length).toBeGreaterThan(0));
  // Visible bytes do not mean verification and result publication have ended.
  await vi.waitFor(async () => { await expect(f.read(other)).rejects.toThrow("unrelated download result refused"); });
  const overview = await f.create();
  expect(overview.error).toBeUndefined();
  expect(view(await f.read(overview)).facts).toMatchObject({ walletAvailability: { status: "available" },
    assetReadAccount: { status: "available", account: w.account } });
  expect(view(await f.read(own)).result).toEqual(ownResult);
  expect((await w.read(ready.card)).snapshot).toEqual(completed.snapshot);
  expect(await w.run(() => w.activity.getActiveAccount())).toMatchObject({ address: w.account });
  await expect(f.read(other)).rejects.toThrow("unrelated download result refused");
  db.exec("DROP TRIGGER reject_other_result"); expect(view(await f.read(other)).result?.outcome).toBe("completed");
  expect(w.submit).toHaveBeenCalledOnce();
});

it.each([-1, 0, 1])("admits a single-step download only before its declared input deadline (%s ms)", async (offset) => {
  const f = await fixture(), prepared = await f.create();
  const publish = vi.spyOn(f.files, "createDownload");
  f.wallet.advance(Date.parse(prepared.snapshot.expiresAt) - f.wallet.now().getTime() + offset);
  const response = await f.download(prepared);
  if (offset < 0) {
    await vi.waitFor(async () => expect(view(await f.read(prepared)).result?.outcome).toBe("completed"));
    expect(publish).toHaveBeenCalledOnce();
  } else {
    expect(response.error?.code).toBe("card_conflict"); expect(view(response).result?.outcome).toBe("interrupted");
    expect(response.snapshot.reason).toBe("expired"); expect(publish).not.toHaveBeenCalled();
    expect(f.wallet.run(() => f.wallet.cardRecords.get(prepared.snapshot.cardId)?.acceptedInput)).toBeUndefined();
  }
});

it("keeps an admitted download's result lifetime beyond input expiration without creating another snapshot", async () => {
  const f = await fixture(), entered = deferred<void>(), release = deferred<void>(), publish = f.files.createDownload.bind(f.files);
  const observed = vi.spyOn(f.files, "createDownload").mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return publish(...args); });
  try {
    const card = await f.create(), attemptId = randomUUID(); await f.download(card, attemptId); await entered.promise;
    f.wallet.advance(Date.parse(card.snapshot.expiresAt) - f.wallet.now().getTime() + 1);
    const current = await f.read(card); expect(view(current)).toMatchObject({ phase: "executing", observe: true });
    expect(view(current).allowedActions).toEqual([]); expect(current.snapshot.state).toBe("running");
    await f.download(card, attemptId); expect(observed).toHaveBeenCalledOnce();
    release.resolve(); await vi.waitFor(async () => expect(view(await f.read(card)).result?.outcome).toBe("completed"));
    await f.download(card, attemptId); expect(observed).toHaveBeenCalledOnce();
  } finally { release.resolve(); }
});

it.each(["select", "begin", "chunk", "seal", "prepare"].flatMap((action) => [-1, 0, 1].map((offset) => ({ action, offset }))))("checks Settings $action input at its original deadline $offset without extending it", async ({ action, offset }) => {
  const f = await fixture(), bytes = Buffer.from(JSON.stringify(await f.wallet.run(() => f.localData.exportLocalData(f.wallet.now()))));
  let card = await f.create(); const permission = card.permission, deadline = card.snapshot.expiresAt;
  const call = async (input: Record<string, unknown>) => { card = { ...await f.act(card, input), permission }; return card; };
  let input: Record<string, unknown> = { action: "settings_select", draft: { kind: "import_local_data" } };
  if (action !== "select") {
    await call(input); const operationId = view(card).operationId;
    input = { action: "settings_begin_upload", operationId, name: "backup.json", totalSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    if (action !== "begin") {
      await call(input); const fileId = view(card).file!.fileId;
      input = { action: "settings_upload_chunk", operationId, fileId, offset: 0, chunkBase64: bytes.toString("base64") };
      if (action !== "chunk") {
        await call(input); input = { action: "settings_seal_upload", operationId, fileId };
        if (action === "prepare") { await call(input); input = { action: "settings_prepare", operationId }; }
      }
    }
  }
  const prior = f.wallet.run(() => f.records.get(view(card).operationId))!;
  f.wallet.advance(Date.parse(deadline) - f.wallet.now().getTime() + offset);
  const response = await call(input);
  expect(response.snapshot.expiresAt).toBe(deadline);
  expect(f.wallet.run(() => f.records.control().active_operation_id)).toBeNull();
  if (offset < 0) expect(response.error).toBeUndefined();
  else {
    expect(response.error?.code).toBe("card_conflict"); expect(response.snapshot.reason).toBe("expired");
    expect(view(response).result?.outcome).toBe("interrupted");
    if (prior.fileId) expect(f.wallet.run(() => f.records.file(prior.fileId!))).toMatchObject({ invalidated: true, cleanup: "complete" });
    expect(f.wallet.run(() => f.wallet.cardRecords.get(response.snapshot.cardId)?.acceptedInput)).toBeUndefined();
  }
  expect(f.wallet.sign).not.toHaveBeenCalled(); expect(f.wallet.submit).not.toHaveBeenCalled();
});

it("preserves late stopped-pairing history across a new ready observation without granting account use", async () => {
  const f = await fixture(), w = f.wallet;
  let card = await w.createConnection(); await w.act(card, { action: "connect" });
  await vi.waitFor(() => expect(w.connect).toHaveBeenCalledOnce());
  card = await w.read(card); await w.act(card, { action: "stop_connection" });
  const connection = w.run(() => w.records.connections()[0]!.connection), restart = await f.prepare({ kind: "restart_wallet_service" });
  await f.confirm(restart); await vi.waitFor(async () => expect(view(await f.read(restart)).result?.outcome).toBe("completed"));
  const late = { topic: "fixture-topic", accounts: [w.account], methods: ["sui_signTransaction"], chain: "sui:mainnet" as const,
    expiresAt: new Date(w.now().getTime() + 60000).toISOString(), walletName: "Late approved wallet" };
  w.approval.resolve(late); w.notify(late);
  expect(w.run(() => w.records.connection(connection.connectionId)?.connection.status)).toBe("stopped");
  expect(w.run(() => w.workflow.reconcileConnectionContext().assetReadAccount)).toEqual({ status: "address_required" });
  const context = w.run(() => w.workflow.reconcileConnectionContext());
  expect(context.connectionReconciliationRequired).toBe(true); expect(context.manageableConnectionIds).toEqual([]);
  expect(w.sign).not.toHaveBeenCalled(); expect(w.submit).not.toHaveBeenCalled();
});

it("cleans up a late approval after Stop in the same available run, without restoring its outcome or account authority", async () => {
  const f = await fixture(), w = f.wallet, entered = deferred<void>(), release = deferred<void>();
  const disconnect = vi.mocked(w.transport.disconnect).getMockImplementation()!;
  vi.mocked(w.transport.disconnect).mockImplementationOnce(async (topic) => { entered.resolve(); await release.promise; await disconnect(topic); });
  try {
    let card = await w.createConnection(); await w.act(card, { action: "connect" });
    await vi.waitFor(() => expect(w.connect).toHaveBeenCalledOnce());
    card = await w.read(card); await w.act(card, { action: "stop_connection" });
    const connection = w.run(() => w.records.connections()[0]!.connection), runId = w.runtime.runId;
    const late = { topic: "fixture-topic", accounts: [w.account], methods: ["sui_signTransaction"], chain: "sui:mainnet" as const,
      expiresAt: new Date(w.now().getTime() + 60000).toISOString(), walletName: "Late approved wallet" };
    w.approval.resolve(late);
    await vi.waitFor(() => expect(w.transport.disconnect).toHaveBeenCalledExactlyOnceWith(late.topic));
    await entered.promise;
    expect(w.runtime.availability()).toMatchObject({ status: "available", walletRunId: runId });
    expect(w.run(() => w.records.connection(connection.connectionId))).toMatchObject({ sdkPending: true, connection: { status: "stopped" } });
    expect(w.run(() => w.workflow.reconcileConnectionContext().assetReadAccount)).toEqual({ status: "address_required" });
    release.resolve();
    await vi.waitFor(() => expect(w.run(() => w.records.connection(connection.connectionId)?.sdkPending)).toBe(false));
    expect(w.run(() => w.records.connection(connection.connectionId)?.connection.status)).toBe("stopped");
    expect(w.runtime.runId).toBe(runId); expect(w.transport.disconnect).toHaveBeenCalledExactlyOnceWith(late.topic);
    expect(w.run(() => w.activity.getActiveAccountSync())).toBeUndefined();
    const current = await w.run(() => w.cards.create("connect", { intent: "manage" }));
    expect(current.snapshot.data).toMatchObject({ allowedActions: ["cancel", "connect"] });
    expect(w.connect).toHaveBeenCalledOnce(); expect(w.sign).not.toHaveBeenCalled(); expect(w.submit).not.toHaveBeenCalled();
  } finally { release.resolve(); }
});

it("rejects missing upload ranges and an incomplete seal without altering bytes, then resumes the same reserved write", async () => {
  const f = await fixture(), bytes = Buffer.from("partial upload input");
  let card = await f.create(); const permission = card.permission;
  const call = async (input: Record<string, unknown>) => { card = { ...await f.act(card, input), permission }; return card; };
  await call({ action: "settings_select", draft: { kind: "import_local_data" } }); const operationId = view(card).operationId;
  await call({ action: "settings_begin_upload", operationId, name: "input.json", totalSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  const fileId = view(card).file!.fileId, path = join(f.wallet.directory, ".settings-staging", `${fileId}.upload`);
  expect((await call({ action: "settings_upload_chunk", operationId, fileId, offset: 1, chunkBase64: bytes.subarray(0, 2).toString("base64") })).error?.code).toBe("card_conflict");
  expect(await readFile(path)).toEqual(Buffer.alloc(0)); expect(f.wallet.run(() => f.records.file(fileId))).toMatchObject({ receivedSize: 0 });
  await call({ action: "settings_upload_chunk", operationId, fileId, offset: 0, chunkBase64: bytes.subarray(0, 2).toString("base64") });
  expect((await call({ action: "settings_seal_upload", operationId, fileId })).error?.code).toBe("card_conflict");
  expect(f.wallet.run(() => f.records.file(fileId))).toMatchObject({ receivedSize: 2, sealed: false });
  expect(await readFile(path)).toEqual(bytes.subarray(0, 2));
  await call({ action: "settings_upload_chunk", operationId, fileId, offset: 2, chunkBase64: bytes.subarray(2).toString("base64") });
  expect((await call({ action: "settings_seal_upload", operationId, fileId })).error).toBeUndefined();
  expect(view(card)).toMatchObject({ phase: "sealed", restoreCheck: { status: "cannot_restore", reason: "invalid_backup" },
    file: { fileId, receivedSize: bytes.length, sealed: true } });
});

it.each([false, true])("preserves the restart cause for a prepared Review or late computation (computing=%s)", async (computing) => {
  const f = await fixture(), w = f.wallet, entered = deferred<void>(), release = deferred<void>(), finished = deferred<void>();
  const failPreparation = w.records.failPreparation.bind(w.records);
  const lastWriter = vi.spyOn(w.records, "failPreparation").mockImplementation((...args) => { failPreparation(...args); finished.resolve(); });
  try {
    const { connection } = await w.approve();
    let card: Awaited<ReturnType<typeof w.createConnection>>, reviewId: string;
    if (computing) {
      const computer = w.computation.adapters["deepbook-swap"]!;
      const spy = vi.fn(computer);
      w.computation.adapters = { ...w.computation.adapters, "deepbook-swap": spy };
      const quote = w.quote.getMockImplementation()!;
      w.quote.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return quote(); });
      const review = await w.run(() => w.sessions.createReviewSession([w.plan], w.now())); reviewId = review.session.id;
      card = await w.run(() => w.cards.create("review", { reviewSessionId: reviewId }));
      await w.act(card, { action: "prepare_review", connectionId: connection.connectionId, account: w.account, reviewRevision: 0 });
      await entered.promise;
      expect(spy).toHaveBeenCalledOnce();
    } else { const ready = await w.prepare(connection.connectionId); card = ready.card; reviewId = ready.session.id; }
    const recover = await f.prepare({ kind: "restart_wallet_service" }); await f.confirm(recover);
    await vi.waitFor(async () => expect(view(await f.read(recover)).result?.outcome).toBe("completed"));
    const before = await w.read(card);
    const expected = "The wallet service was restarted. Update this review before requesting approval.";
    expect(JSON.stringify(before.snapshot.data)).toContain(expected);
    release.resolve();
    // The product's catch/final writer follows adapter completion and wallet
    // verification. Waiting for the adapter alone does not cover that writer.
    if (computing) { await finished.promise; expect(lastWriter).toHaveBeenCalledOnce(); }
    const after = await w.read(card);
    expect(JSON.stringify(after.snapshot.data)).toContain(expected);
    expect(JSON.stringify(after.snapshot.data)).not.toContain('"transactionReviewData"');
    expect((await w.run(() => w.sessions.getReviewSession(reviewId, w.now)))?.preparationId).toBeUndefined();
    expect(w.sign).not.toHaveBeenCalled(); expect(w.submit).not.toHaveBeenCalled();
  } finally { release.resolve(); }
});

it.each(["clear", "grpc", "graphql", "reset", "import"])("keeps one final operation while snapshot I/O is active and accepts the valid %s confirmation after completion", async (kind) => {
  const f = await fixture(), entered = deferred<void>(), release = deferred<void>(), publish = f.files.createDownload.bind(f.files);
  vi.spyOn(f.files, "createDownload").mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return publish(...args); });
  try {
    const other = kind === "import" ? await uploadBackup(f, Buffer.from(JSON.stringify(await f.wallet.run(() => f.localData.exportLocalData(f.wallet.now())))))
      : kind === "reset" ? await f.prepare({ kind: "reset_local_data" })
      : kind === "grpc" || kind === "graphql" ? await f.prepare({ kind: "restore_endpoint", endpoint: kind })
      : await f.prepare({ kind: "clear_read_address" });
    const exporting = await f.create();
    await f.download(exporting); await entered.promise;
    const control = f.wallet.run(() => f.records.control());
    expect(control.active_operation_id).toBe(view(exporting).operationId); expect(control.file_io_id).not.toBeNull();
    expect((await f.confirm(other)).error?.code).toBe("card_conflict");
    expect(f.wallet.run(() => f.records.control())).toEqual(control);
    expect(f.wallet.run(() => f.wallet.cardRecords.get(other.snapshot.cardId)?.acceptedInput)).toBeUndefined();
    release.resolve(); await vi.waitFor(async () => expect(view(await f.read(exporting)).result?.outcome).toBe("completed"));
    expect(view(await f.confirm(other)).result?.outcome).toBe("completed");
    expect(f.wallet.run(() => f.records.control().active_operation_id)).toBeNull();
  } finally { release.resolve(); }
});

it("blocks an otherwise eligible empty-card Connect during admitted Settings recovery and requires a new explicit click afterward", async () => {
  const f = await fixture(), w = f.wallet, entered = deferred<void>(), release = deferred<void>(), replace = w.runtime.replace.bind(w.runtime);
  vi.spyOn(w.runtime, "replace").mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return replace(...args); });
  try {
    const original = await w.createConnection(); expect(original.snapshot.data).toMatchObject({ allowedActions: ["cancel", "connect"] });
    const recover = await f.prepare({ kind: "restart_wallet_service" }); await f.confirm(recover); await entered.promise;
    expect((await w.act(original, { action: "connect" })).error).toBeDefined(); expect(w.connect).not.toHaveBeenCalled();
    expect(f.wallet.run(() => f.records.control())).toMatchObject({ wallet_input_blocked: 1, wallet_block_operation_id: view(recover).operationId });
    release.resolve(); await vi.waitFor(async () => expect(view(await f.read(recover)).result?.outcome).toBe("completed"));
    const fresh = await w.createConnection(); expect(w.connect).not.toHaveBeenCalled();
    expect((await w.act(fresh, { action: "connect" })).error).toBeUndefined(); await vi.waitFor(() => expect(w.connect).toHaveBeenCalledOnce());
  } finally { release.resolve(); }
});

it("blocks otherwise valid disconnect, use, prepare and sign actions after scoped Settings admission, then restores fresh-input access", async () => {
  const f = await fixture(), w = f.wallet, entered = deferred<void>(), release = deferred<void>();
  const replace = w.runtime.replace.bind(w.runtime);
  vi.spyOn(w.runtime, "replace").mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return replace(...args); });
  try {
    const { connection } = await w.approve(), ready = await w.prepare(connection.connectionId);
    const accountCard = await w.run(() => w.cards.create("connect", { intent: "manage" }));
    const disconnectCard = await w.run(() => w.cards.create("connect", { intent: "manage" }));
    const review = await w.run(() => w.sessions.createReviewSession([w.plan], w.now()));
    const prepareCard = await w.run(() => w.cards.create("review", { reviewSessionId: review.session.id }));
    const oldRun = w.runtime.runId;
    const recover = await f.prepare({ kind: "restart_wallet_service" }); await f.confirm(recover); await entered.promise;
    expect(f.wallet.run(() => f.records.control())).toMatchObject({ active_operation_id: view(recover).operationId,
      wallet_input_blocked: 1, wallet_block_operation_id: view(recover).operationId });
    for (const [card, input] of [
      [disconnectCard, { action: "disconnect", connectionId: connection.connectionId }],
      [accountCard, { action: "use_account", connectionId: connection.connectionId, account: w.account }],
      [prepareCard, { action: "prepare_review", connectionId: connection.connectionId, account: w.account, reviewRevision: 0 }],
      [ready.card, { action: "request_signature", connectionId: connection.connectionId, account: w.account, reviewRevision: ready.session.reviewRevision }]
    ] as const) {
      const response = await w.act(card, { ...input, walletRunId: oldRun });
      expect(response.error).toBeDefined();
    }
    expect(w.sign).not.toHaveBeenCalled(); expect(w.submit).not.toHaveBeenCalled(); expect(w.quote).toHaveBeenCalledOnce();
    expect(w.transport.disconnect).not.toHaveBeenCalled();
    release.resolve(); await vi.waitFor(async () => expect(view(await f.read(recover)).result?.outcome).toBe("completed"));
    const fresh = await w.run(() => w.cards.create("connect", { intent: "manage" }));
    expect((await w.act(fresh, { action: "use_account", connectionId: connection.connectionId, account: w.account })).error).toBeUndefined();
    const freshDisconnect = await w.run(() => w.cards.create("connect", { intent: "manage" }));
    expect((await w.act(freshDisconnect, { action: "disconnect", connectionId: connection.connectionId })).error).toBeUndefined();
    await vi.waitFor(() => expect(w.run(() => w.records.connection(connection.connectionId)?.connection.status)).toBe("disconnected"));
    expect(w.transport.disconnect).toHaveBeenCalledExactlyOnceWith("fixture-topic");
  } finally { release.resolve(); }
});

it.each(["connect", "signature"] as const)("invalidates prepared Settings recovery at actual %s admission before the SDK reply", async (kind) => {
  const f = await fixture(), w = f.wallet, held = deferred<void>(), signed = deferred<Awaited<ReturnType<typeof w.sign>>>();
  const originalConnect = w.connect.getMockImplementation()!;
  const target = kind === "signature" ? await w.approve() : undefined;
  const ready = target ? await w.prepare(target.connection.connectionId) : undefined;
  const sourceCard = ready?.card ?? await w.createConnection();
  const restart = await f.prepare({ kind: "restart_wallet_service" });
  const fence = vi.spyOn(w.runtime, "fence"), replace = vi.spyOn(w.runtime, "replace");
  if (kind === "connect") w.connect.mockImplementationOnce(async () => { await held.promise; return originalConnect(); });
  else w.sign.mockImplementationOnce(() => signed.promise);
  try {
    const input = kind === "connect" ? { action: "connect" } : { action: "request_signature", connectionId: target!.connection.connectionId,
      account: w.account, reviewRevision: ready!.session.reviewRevision };
    expect((await w.act(sourceCard, input)).error).toBeUndefined();
    await vi.waitFor(() => expect(kind === "connect" ? w.connect : w.sign).toHaveBeenCalledOnce());
    expect((await f.confirm(restart)).error?.code).toBe("card_conflict");
    expect(fence).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled();
    const fresh = await f.prepare({ kind: "restart_wallet_service" });
    const impact = view(fresh).preparation!.impact as { connections: { connectionId: string; sdkPending: boolean }[]; requests: { attempt_id: string; request_status: string }[] };
    if (kind === "connect") expect(impact.connections).toContainEqual(expect.objectContaining({
      connectionId: w.run(() => w.records.connections()[0]!.connection.connectionId), sdkPending: true }));
    else expect(impact.requests).toContainEqual(expect.objectContaining({
      attempt_id: w.run(() => w.records.currentRequest(ready!.session.id)!.attemptId), request_status: "awaiting_signature" }));
    await f.confirm(fresh); await vi.waitFor(async () => expect(view(await f.read(fresh)).result?.outcome).toBe("completed"));
    expect(fence).toHaveBeenCalledOnce(); expect(replace).toHaveBeenCalledOnce(); expect(w.submit).not.toHaveBeenCalled();
  } finally { held.resolve(); if (kind === "signature") signed.reject(new Error("Synthetic pending wallet response ended")); }
});

it.each(["connect", "signature"] as const)("rolls actual %s admission back when its Settings impact publication fails", async (kind) => {
  const f = await fixture(), w = f.wallet, held = deferred<void>(), signed = deferred<Awaited<ReturnType<typeof w.sign>>>();
  const target = kind === "signature" ? await w.approve() : undefined;
  const ready = target ? await w.prepare(target.connection.connectionId) : undefined;
  const card = ready?.card ?? await w.createConnection(), restart = await f.prepare({ kind: "restart_wallet_service" });
  const db = new Database(join(w.directory, "activity.sqlite")); resources.push(() => { db.close(); });
  const expectedPreparation = view(restart).preparationId, id = restart.snapshot.cardId;
  const input = kind === "connect" ? { action: "connect" } : { action: "request_signature", connectionId: target!.connection.connectionId,
    account: w.account, reviewRevision: ready!.session.reviewRevision };
  const before = w.run(() => w.records.connections().map((item) => item.connection));
  db.exec(`CREATE TRIGGER reject_settings_impact BEFORE UPDATE OF revision ON live_read_cards
    WHEN OLD.id='${id.replaceAll("'", "''")}' AND NEW.revision>OLD.revision BEGIN SELECT RAISE(ABORT,'Settings impact publication refused'); END`);
  try {
    await expect(w.act(card, input)).rejects.toThrow("Settings impact publication refused");
    expect(w.run(() => w.records.connections().map((item) => item.connection))).toEqual(before);
    expect(w.run(() => w.cardRecords.get(card.snapshot.cardId)?.acceptedInput)).toBeUndefined();
    expect(w.run(() => f.records.get(view(restart).operationId)?.preparationId)).toBe(expectedPreparation);
    if (ready) expect(w.run(() => w.records.currentRequest(ready.session.id))).toBeUndefined();
    expect(kind === "connect" ? w.connect : w.sign).not.toHaveBeenCalled();
    db.exec("DROP TRIGGER reject_settings_impact");
    const connect = w.connect.getMockImplementation()!;
    if (kind === "connect") w.connect.mockImplementationOnce(async () => { await held.promise; return connect(); });
    else w.sign.mockImplementationOnce(() => signed.promise);
    expect((await w.act(card, input)).error).toBeUndefined();
    await vi.waitFor(() => expect(kind === "connect" ? w.connect : w.sign).toHaveBeenCalledOnce());
    expect((await f.confirm(restart)).error?.code).toBe("card_conflict");
    expect(w.submit).not.toHaveBeenCalled();
  } finally { db.exec("DROP TRIGGER IF EXISTS reject_settings_impact"); held.resolve(); if (kind === "signature") signed.reject(new Error("Synthetic wallet response ended")); }
});

it("rejects changing an upload during its physical write and refuses late progress after input expiry", async () => {
  const f = await fixture(), bytes = Buffer.from("held physical upload"), entered = deferred<void>(), release = deferred<void>();
  const write = f.files.writeReservedChunk.bind(f.files);
  vi.spyOn(f.files, "writeReservedChunk").mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; await write(...args); });
  try {
    let card = await f.create(); const permission = card.permission;
    card = { ...await f.act(card, { action: "settings_select", draft: { kind: "import_local_data" } }), permission };
    const operationId = view(card).operationId;
    card = { ...await f.act(card, { action: "settings_begin_upload", operationId, name: "backup.json", totalSize: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") }), permission };
    const fileId = view(card).file!.fileId;
    const pending = f.act(card, { action: "settings_upload_chunk", operationId, fileId, offset: 0, chunkBase64: bytes.toString("base64") });
    await entered.promise;
    expect((await f.act(card, { action: "settings_select", draft: { kind: "reset_local_data" } })).error?.code).toBe("card_conflict");
    expect(f.wallet.run(() => f.records.control().file_io_id)).toBe(fileId);
    f.wallet.advance(Date.parse(card.snapshot.expiresAt) - f.wallet.now().getTime());
    const expired = await f.read(card); expect(expired.snapshot.reason).toBe("expired");
    release.resolve(); expect((await pending).error?.code).toBe("card_conflict");
    expect(f.wallet.run(() => f.records.file(fileId))).toMatchObject({ invalidated: true, receivedSize: 0 });
    expect(f.wallet.run(() => f.records.control().file_io_id)).toBeNull();
    const fresh = await f.prepare({ kind: "clear_read_address" }); expect(view(await f.confirm(fresh)).result?.outcome).toBe("completed");
  } finally { release.resolve(); }
});

it.each(["reset", "import"] as const)("rolls back %s replacement and its authority invalidation if its own result cannot be stored", async (kind) => {
  const f = await fixture(); await f.wallet.approve();
  const incoming = Buffer.from(JSON.stringify(await f.wallet.run(() => f.localData.exportLocalData(f.wallet.now()))));
  const prepared = kind === "reset" ? await f.prepare({ kind: "reset_local_data" }) : await uploadBackup(f, incoming);
  const prior = await f.wallet.run(() => f.localData.exportLocalData(f.wallet.now()));
  const other = await f.create(), changed = vi.spyOn(f.localData, "notifyDataReplaced");
  const db = new Database(join(f.wallet.directory, "activity.sqlite")); resources.push(() => { db.close(); });
  db.exec("CREATE TRIGGER reject_replacement_result BEFORE UPDATE ON settings_operations WHEN NEW.phase='terminal' BEGIN SELECT RAISE(ABORT,'replacement result refused'); END");
  await expect(f.confirm(prepared)).rejects.toThrow("replacement result refused");
  expect(f.wallet.run(() => f.records.control())).toMatchObject({ data_epoch: 0, active_operation_id: null });
  expect(f.wallet.run(() => f.wallet.cardRecords.get(prepared.snapshot.cardId)?.acceptedInput)).toBeUndefined();
  expect((await f.wallet.run(() => f.localData.exportLocalData(f.wallet.now()))).data).toEqual(prior.data);
  expect(changed).not.toHaveBeenCalled(); expect((await f.read(other)).snapshot.cardId).toBe(other.snapshot.cardId);
  db.exec("DROP TRIGGER reject_replacement_result");
  expect(view(await f.confirm(prepared)).result?.outcome).toBe("completed");
  expect(changed).toHaveBeenCalledOnce();
});

it("keeps an unconfirmed disconnect failed and management-only across Settings restart", async () => {
  const f = await fixture(), held = deferred<void>();
  try {
    const { connection } = await f.wallet.approve();
    const original = await f.wallet.run(() => f.wallet.cards.create("connect", { intent: "manage" }));
    vi.mocked(f.wallet.transport.disconnect).mockImplementationOnce(() => held.promise);
    await f.wallet.act(original, { action: "disconnect", connectionId: connection.connectionId });
    const restart = await f.prepare({ kind: "restart_wallet_service" }); await f.confirm(restart);
    await vi.waitFor(async () => expect(view(await f.read(restart)).result?.outcome).toBe("completed"));
    const context = f.wallet.run(() => f.wallet.workflow.reconcileConnectionContext());
    expect(context).toMatchObject({ connections: [expect.objectContaining({ connectionId: connection.connectionId, status: "failed" })],
      manageableConnectionIds: [connection.connectionId], assetReadAccount: { status: "address_required" } });
    const old = await f.wallet.read(original);
    expect(old.snapshot.data).toMatchObject({ connection: { status: "failed" } });
    expect(f.wallet.sign).not.toHaveBeenCalled(); expect(f.wallet.submit).not.toHaveBeenCalled();
    const manage = await f.wallet.run(() => f.wallet.cards.create("connect", { intent: "manage" }));
    expect((await f.wallet.act(manage, { action: "use_account", connectionId: connection.connectionId, account: f.wallet.account })).error?.code).toBe("card_conflict");
    held.resolve();
    await f.wallet.act(await f.wallet.read(manage), { action: "disconnect", connectionId: connection.connectionId });
    await vi.waitFor(() => expect(f.wallet.run(() => f.wallet.records.connection(connection.connectionId)?.connection.status)).toBe("disconnected"));
    expect(f.wallet.run(() => f.wallet.workflow.reconcileConnectionContext().manageableConnectionIds)).toEqual([]);
  } finally { held.resolve(); }
});

it.each(["connected", "failed"] as const)("updates current SDK metadata for %s management without changing its original outcome", async (status) => {
  const f = await fixture(), { connection } = await f.wallet.approve();
  if (status === "failed") {
    const original = await f.wallet.run(() => f.wallet.cards.create("connect", { intent: "manage" }));
    vi.mocked(f.wallet.transport.disconnect).mockRejectedValueOnce(new Error("The SDK session remains present"));
    await f.wallet.act(original, { action: "disconnect", connectionId: connection.connectionId });
    await vi.waitFor(() => expect(f.wallet.run(() => f.wallet.records.connection(connection.connectionId))).toMatchObject({ sdkPending: false, connection: { status: "failed" } }));
  }
  const card = await f.wallet.run(() => f.wallet.cards.create("connect", { intent: "manage" }));
  const restart = await f.prepare({ kind: "restart_wallet_service" });
  const account = `0x${"b".repeat(64)}`, prior = f.wallet.transport.session("fixture-topic")!;
  f.wallet.notify({ ...prior, accounts: [account] });
  const current = await f.wallet.read(card);
  expect(current.snapshot.data).toMatchObject({ connections: [expect.objectContaining({ status, accounts: [account] })] });
  expect(current.snapshot.revision).toBeGreaterThan(card.snapshot.revision);
  expect((await f.confirm(restart)).error?.code).toBe("card_conflict");
  f.wallet.observe();
  expect((await f.wallet.read(card)).snapshot.revision).toBe(current.snapshot.revision);
});

it.each(["reset", "import"].flatMap((kind) => [0, 1].map((offset) => ({ kind, offset }))))("settles the lookup deadline for $kind at +$offset ms and preserves the same upload for a new Preview", async ({ kind, offset }) => {
  const f = await fixture(), w = f.wallet;
  const { connection } = await w.approve(), ready = await w.prepare(connection.connectionId);
  w.chainRead.mockRejectedValue(Object.assign(new Error("Not yet independently observed"), { name: "TimeoutError" }));
  await w.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: w.account, reviewRevision: ready.session.reviewRevision });
  await vi.waitFor(() => {
    const request = w.run(() => w.records.currentRequest(ready.session.id))!;
    expect(request.requestStatus).toBe("awaiting_chain_result");
    expect(w.run(() => w.records.authority(request.attemptId))).toMatchObject({ sdk_pending: 0, submit_pending: 0, lookup_pending: 0 });
  });
  const request = w.run(() => w.records.currentRequest(ready.session.id))!;
  const authority = w.run(() => w.records.authority(request.attemptId))!;
  const raw = Buffer.from(JSON.stringify(await w.run(() => w.localData.exportLocalData(w.now()))));
  w.advance(new Date(authority.lookup_deadline!).getTime() - w.now().getTime() - 1);
  const card = kind === "reset" ? await f.prepare({ kind: "reset_local_data" }) : await uploadBackup(f, raw);
  const fileId = view(card).file?.fileId;
  const counts = kind === "reset" ? view(card).preparation!.counts as LocalDataCounts : (view(card).preparation!.preview as LocalDataImportPreview).currentCounts;
  expect(counts!.outcomeUnknownRequests).toBe(0);
  const epoch = w.run(() => f.records.control().data_epoch);
  if (kind === "reset") expect((await f.confirm(card)).error?.code).toBe("invalid_card_input");
  else {
    expect(view(card).restoreCheck).toMatchObject({ status: "cannot_restore", reason: "wallet_request_unsettled" });
    expect(view(card).allowedActions).not.toContain("settings_confirm");
  }
  expect(w.run(() => w.records.request(request.attemptId)?.requestStatus)).toBe("awaiting_chain_result");
  expect(w.run(() => w.cardRecords.get(card.snapshot.cardId)?.acceptedInput)).toBeUndefined();
  w.advance(1 + offset);
  const refusedResponse = kind === "reset" ? await f.confirm(card)
    : await f.act(card, { action: "settings_prepare", operationId: view(card).operationId });
  const refused = { ...refusedResponse, permission: card.permission };
  if (kind === "reset") expect(refused.error?.code).toBe("card_conflict");
  else expect(view(refused)).toMatchObject({ restoreCheck: { status: "can_restore" },
    preparation: { preview: { currentCounts: { outcomeUnknownRequests: 1 } } } });
  expect(w.run(() => w.records.request(request.attemptId)?.requestStatus)).toBe("outcome_unknown");
  expect(w.run(() => f.records.control())).toMatchObject({ data_epoch: epoch, active_operation_id: null });
  expect(w.run(() => w.cardRecords.get(card.snapshot.cardId)?.acceptedInput)).toBeUndefined();
  let fresh = kind === "import" ? refused : await f.read(card);
  if (fileId) expect(view(fresh)).toMatchObject({ phase: "prepared", file: { fileId, sealed: true } });
  if (kind === "reset") fresh = { ...await f.act(fresh, { action: "settings_prepare", operationId: view(fresh).operationId }), permission: card.permission };
  expect(fresh.error).toBeUndefined();
  const refreshedCounts = kind === "reset" ? view(fresh).preparation!.counts as LocalDataCounts : (view(fresh).preparation!.preview as LocalDataImportPreview).currentCounts;
  expect(refreshedCounts!.outcomeUnknownRequests).toBe(1);
  expect(view(await f.confirm(fresh)).result?.outcome).toBe("completed");
  expect(w.run(() => f.records.control().data_epoch)).toBe(epoch + 1);
  expect(w.sign).toHaveBeenCalledOnce(); expect(w.submit).toHaveBeenCalledOnce();
});

it.each([0, 1])("rechecks import deletion impact after endpoint verification crosses the lookup deadline by %s ms", async (offset) => {
  const entered = deferred<void>(), release = deferred<void>(); let hold = false;
  const f = await fixture({ verifyEndpoint: async () => { if (hold) { entered.resolve(); await release.promise; } } }), w = f.wallet;
  try {
    const { connection } = await w.approve(), ready = await w.prepare(connection.connectionId);
    w.chainRead.mockRejectedValue(Object.assign(new Error("No independently observed result"), { name: "TimeoutError" }));
    const raw = Buffer.from(JSON.stringify(await w.run(() => f.localData.exportLocalData(w.now()))));
    const card = await uploadBackup(f, raw), fileId = view(card).file!.fileId, epoch = w.run(() => f.records.control().data_epoch);
    expect(view(card).restoreCheck).toEqual({ status: "can_restore" });
    expect((view(card).preparation!.preview as LocalDataImportPreview).currentCounts.outcomeUnknownRequests).toBe(0);
    hold = true; const applying = f.confirm(card); await entered.promise;
    await w.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: w.account, reviewRevision: ready.session.reviewRevision });
    await vi.waitFor(() => {
      const request = w.run(() => w.records.currentRequest(ready.session.id))!;
      expect(request.requestStatus).toBe("awaiting_chain_result");
      expect(w.run(() => w.records.authority(request.attemptId))).toMatchObject({ sdk_pending: 0, submit_pending: 0, lookup_pending: 0 });
    });
    const request = w.run(() => w.records.currentRequest(ready.session.id))!;
    const deadline = w.run(() => w.records.authority(request.attemptId)!.lookup_deadline)!;
    w.advance(Date.parse(deadline) - w.now().getTime() - 1);
    w.advance(1 + offset); release.resolve();
    expect((await applying).error?.code).toBe("card_conflict");
    expect(w.run(() => w.records.request(request.attemptId)?.requestStatus)).toBe("outcome_unknown");
    expect(view(card).preparationId).toBeDefined();
    expect(w.run(() => f.records.control())).toMatchObject({ data_epoch: epoch, active_operation_id: null });
    expect(w.run(() => w.cardRecords.get(card.snapshot.cardId)?.acceptedInput)).toBeUndefined();
    let current = await f.read(card); expect(view(current)).toMatchObject({ phase: "sealed", file: { fileId, sealed: true } });
    hold = false;
    current = { ...await f.act(current, { action: "settings_prepare", operationId: view(current).operationId }), permission: card.permission };
    expect((view(current).preparation!.preview as LocalDataImportPreview).currentCounts.outcomeUnknownRequests).toBe(1);
    expect(view(await f.confirm(current)).result?.outcome).toBe("completed");
    expect(w.submit).toHaveBeenCalledOnce();
  } finally { release.resolve(); }
});

it.each(["grpc", "graphql"] as const)("binds %s set/restore preparation to its actual target and captures an environment override", async (endpoint) => {
  const override = endpoint === "grpc" ? "https://override.example:9443" : "https://override.example:9443/graphql";
  const requested = endpoint === "grpc" ? "https://requested.example:8443" : "https://requested.example:8443/graphql";
  const verify = vi.fn(async () => {});
  const f = await fixture({ verifyEndpoint: verify, env: endpoint === "grpc" ? { SUI_MCP_GRPC_URL: override } : { SUI_MCP_GRAPHQL_URL: override } });
  const key = endpoint === "grpc" ? "suiGrpcUrl" : "suiGraphqlUrl";
  const defaultValue = endpoint === "grpc" ? DEFAULT_SUI_GRPC_URL : DEFAULT_SUI_GRAPHQL_URL;
  const otherBefore = await f.wallet.run(() => endpoint === "grpc" ? f.preferences.getSuiGraphqlUrl() : f.preferences.getSuiGrpcUrl());
  const set = await f.prepare({ kind: "set_endpoint", endpoint, value: requested });
  expect(verify).not.toHaveBeenCalled();
  expect(view(set).preparation?.endpoint).toMatchObject({ endpoint, key, value: requested, storedValue: defaultValue, effectiveValue: override, source: "environment" });
  const result = view(await f.confirm(set)).result!;
  expect(verify).toHaveBeenCalledExactlyOnceWith(requested);
  expect(result.details).toMatchObject({ endpoint, storedValue: requested, previousStoredValue: defaultValue,
    effectiveValueAtSave: override, effectiveSourceAtSave: "environment", appliesAfter: "mcp_server_restart" });
  expect(view(await f.read(set)).result).toEqual(result);
  const restore = await f.prepare({ kind: "restore_endpoint", endpoint });
  expect(view(restore).preparation?.endpoint).toMatchObject({ endpoint, key, value: defaultValue, storedValue: requested, source: "environment" });
  expect(verify).toHaveBeenCalledTimes(1);
  const restored = view(await f.confirm(restore)).result!;
  expect(restored.details).toMatchObject({ status: "reset", endpoint, storedValue: defaultValue, previousStoredValue: requested, effectiveValueAtSave: override });
  expect(verify).toHaveBeenLastCalledWith(defaultValue);
  expect(await f.wallet.run(() => endpoint === "grpc" ? f.preferences.getSuiGraphqlUrl() : f.preferences.getSuiGrpcUrl())).toEqual(otherBefore);
  const current = await f.wallet.run(() => f.localSettings.getLocalSettings());
  expect(endpoint === "grpc" ? current.suiGrpcUrl.effectiveValue : current.suiGraphqlUrl.effectiveValue).toBe(override);
});

it("retries only its own known-ended I/O on completed reads, without replaying download or blocking the saved result", async () => {
  const f = await fixture(), unrelated = await f.prepare({ kind: "clear_read_address" }); await f.confirm(unrelated);
  const prepared = await f.create(); await f.download(prepared);
  const ready = await downloadReady(f, prepared), path = downloadPath(f, prepared);
  const bytes = await readFile(path);
  const db = new Database(join(f.wallet.directory, "activity.sqlite")); resources.push(() => { db.close(); });
  db.exec(`CREATE TRIGGER reject_finished_release BEFORE UPDATE ON settings_control
    WHEN OLD.file_io_id IS NOT NULL AND NEW.file_io_id IS NULL AND EXISTS (
      SELECT 1 FROM settings_files f JOIN settings_operations o ON o.operation_id=f.cleanup_operation_id
      WHERE f.file_id=OLD.file_io_id AND o.phase='terminal') BEGIN SELECT RAISE(ABORT,'I/O release refused'); END`);
  const publish = vi.spyOn(f.files, "createDownload");
  await expect(f.act(ready, downloadReport(ready))).rejects.toThrow("I/O release refused");
  await vi.waitFor(() => expect(f.wallet.run(() => f.records.file(f.records.get(view(prepared).operationId)!.fileId!)?.cleanup)).toBe("complete"));
  const completed = await f.read(prepared), result = view(completed).result!;
  expect(view(completed).temporaryFileCleanup).toBe("pending");
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(result.details!.sha256);
  const fileId = f.wallet.run(() => f.records.control().file_io_id);
  expect(view(await f.read(unrelated)).result?.outcome).toBe("completed");
  expect(f.wallet.run(() => f.records.control().file_io_id)).toBe(fileId);
  const blocked = await f.create();
  expect((await f.act(blocked, { action: "settings_select", draft: { kind: "clear_read_address" } })).error?.code).toBe("card_conflict");
  expect(view(await f.read(prepared)).result).toEqual(result);
  db.exec("DROP TRIGGER reject_finished_release");
  expect(view(await f.read(unrelated)).result?.outcome).toBe("completed");
  expect(f.wallet.run(() => f.records.control().file_io_id)).toBe(fileId);
  const settled = await f.read(prepared);
  expect(view(settled)).toMatchObject({ result, temporaryFileCleanup: "complete" });
  expect(f.wallet.run(() => f.records.control().file_io_id)).toBeNull();
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" }); expect(publish).not.toHaveBeenCalled();
  const next = await f.prepare({ kind: "clear_read_address" }); expect(view(await f.confirm(next)).result?.outcome).toBe("completed");
  expect(f.wallet.connect).not.toHaveBeenCalled(); expect(f.wallet.sign).not.toHaveBeenCalled(); expect(f.wallet.submit).not.toHaveBeenCalled();
});

it("preserves the private live connection journal across Reset and blocks pairing until the SDK confirms absence", async () => {
  const f = await fixture(), { connection, card: original } = await f.wallet.approve();
  const reset = await f.prepare({ kind: "reset_local_data" }); await f.confirm(reset);
  const context = f.wallet.run(() => f.wallet.workflow.reconcileConnectionContext());
  expect(context).toMatchObject({ connections: [expect.objectContaining({ connectionId: connection.connectionId, status: "connected" })],
    assetReadAccount: { status: "address_required" }, manageableConnectionIds: [connection.connectionId] });
  expect(f.wallet.transport.session("fixture-topic")).toBeDefined();
  await expect(f.wallet.read(original)).rejects.toThrow("access is unavailable");
  const manage = await f.wallet.run(() => f.wallet.cards.create("connect", { intent: "manage" }));
  expect(manage.snapshot.data).toMatchObject({ allowedActions: ["cancel", "disconnect", "use_account"] });
  expect((await f.wallet.act(manage, { action: "connect" })).error?.code).toBe("card_conflict");
  expect(f.wallet.connect).toHaveBeenCalledOnce();
  const backup = await f.wallet.run(() => f.localData.exportLocalData(f.wallet.now()));
  expect(JSON.stringify(backup)).not.toContain("fixture-topic"); expect(backup.data).not.toHaveProperty("live_wallet_connections");
  await f.wallet.act(await f.wallet.read(manage), { action: "disconnect", connectionId: connection.connectionId });
  await vi.waitFor(() => expect(f.wallet.run(() => f.wallet.records.connection(connection.connectionId)?.connection.status)).toBe("disconnected"));
  const empty = await f.wallet.run(() => f.wallet.cards.create("connect", { intent: "manage" }));
  expect(empty.snapshot.data).toMatchObject({ allowedActions: ["cancel", "connect"] });
  expect(f.wallet.connect).toHaveBeenCalledOnce();
});

it("does not release a terminal operation's I/O while physical cleanup is still running", async () => {
  const f = await fixture(), entered = deferred<void>(), release = deferred<void>();
  const cleanup = f.files.cleanup.bind(f.files);
  vi.spyOn(f.files, "cleanup").mockImplementationOnce(async (file) => { entered.resolve(); await release.promise; await cleanup(file); });
  const prepared = await f.create(); await f.download(prepared);
  const ready = await downloadReady(f, prepared), reported = f.act(ready, downloadReport(ready));
  try {
  await entered.promise;
  const fileId = f.wallet.run(() => f.records.control().file_io_id);
  expect(fileId).not.toBeNull();
  const running = await f.read(prepared);
  expect(view(running).result?.outcome).toBe("completed"); expect(view(running).temporaryFileCleanup).toBe("pending");
  expect(f.wallet.run(() => f.records.control().file_io_id)).toBe(fileId);
  release.resolve();
  await vi.waitFor(async () => expect(view(await f.read(prepared)).temporaryFileCleanup).toBe("complete"));
  expect(f.wallet.run(() => f.records.control().file_io_id)).toBeNull();
  } finally { release.resolve(); await reported; }
});

it("stores a verified endpoint and its result together; duplicate confirmation does not repeat validation", async () => {
  const verify = vi.fn(async () => {}), f = await fixture({ verifyEndpoint: verify });
  const prepared = await f.prepare({ kind: "set_endpoint", endpoint: "grpc", value: "https://mainnet.example:9443" });
  const applied = await f.confirm(prepared);
  expect(view(applied).result).toMatchObject({ outcome: "completed", details: { storedValue: "https://mainnet.example:9443", appliesAfter: "mcp_server_restart" } });
  const settings = await f.wallet.run(() => f.localSettings.getLocalSettings());
  expect(settings.suiGrpcUrl).toMatchObject({ storedValue: "https://mainnet.example:9443", effectiveValue: "https://fullnode.mainnet.sui.io:443", pendingStoredValue: "https://mainnet.example:9443" });
  expect((await f.confirm(prepared)).snapshot).toEqual(applied.snapshot);
  expect(verify).toHaveBeenCalledOnce();
});

it("rejects a changed stored endpoint after asynchronous verification without overwriting it", async () => {
  const entered = deferred<void>(), release = deferred<void>();
  const f = await fixture({ verifyEndpoint: async () => { entered.resolve(); await release.promise; } });
  const prepared = await f.prepare({ kind: "set_endpoint", endpoint: "grpc", value: "https://requested.example:443" });
  const applying = f.confirm(prepared); await entered.promise;
  await f.wallet.run(() => f.preferences.setSuiGrpcUrl("https://other.example:443"));
  release.resolve(); const response = await applying;
  expect(response.error?.code).toBe("card_conflict");
  expect(await f.wallet.run(() => f.preferences.getSuiGrpcUrl())).toMatchObject({ value: "https://other.example:443" });
  expect(view(response).phase).toBe("draft"); expect(view(response).result).toBeUndefined();
});

it("clears read context without disconnecting the wallet or restoring it on a read", async () => {
  const f = await fixture(); const { connection } = await f.wallet.approve();
  const prepared = await f.prepare({ kind: "clear_read_address" }); await f.confirm(prepared);
  expect(await f.wallet.run(() => f.wallet.activity.getActiveAccount())).toBeUndefined();
  expect(f.wallet.run(() => f.wallet.records.connection(connection.connectionId)?.connection.status)).toBe("connected");
  expect(f.wallet.transport.disconnect).not.toHaveBeenCalled();
  expect(f.wallet.run(() => f.wallet.workflow.reconcileConnectionContext().assetReadAccount)).toEqual({ status: "address_required" });
});

it("retains reset's own result and credential as read-only after replacing other cards", async () => {
  const f = await fixture(); const other = await f.create();
  const prepared = await f.prepare({ kind: "reset_local_data" }), applied = await f.confirm(prepared);
  expect(view(applied).result).toMatchObject({ outcome: "completed", details: { status: "reset", sessionsInvalidated: true } });
  expect(f.wallet.run(() => f.records.control().data_epoch)).toBe(1);
  expect((await f.read(prepared)).snapshot).toEqual(applied.snapshot);
  expect((await f.confirm(prepared)).snapshot).toEqual(applied.snapshot);
  await expect(f.read(other)).rejects.toThrow("access is unavailable");
  expect((await f.act({ ...applied, permission: prepared.permission }, { action: "settings_select", draft: { kind: "reset_local_data" } })).error?.code).toBe("card_conflict");
});

it("rolls back endpoint and admission if saving its result fails", async () => {
  const f = await fixture(), prepared = await f.prepare({ kind: "set_endpoint", endpoint: "grpc", value: "https://requested.example:443" });
  const db = new Database(join(f.wallet.directory, "activity.sqlite")); resources.push(() => { db.close(); });
  db.exec("CREATE TRIGGER reject_settings_result BEFORE UPDATE ON settings_operations WHEN NEW.phase='terminal' BEGIN SELECT RAISE(ABORT,'result storage refused'); END");
  await expect(f.confirm(prepared)).rejects.toThrow("result storage refused");
  expect(await f.wallet.run(() => f.preferences.getSuiGrpcUrl())).toMatchObject({ value: "https://fullnode.mainnet.sui.io:443" });
  expect(f.wallet.run(() => f.records.control().active_operation_id)).toBeNull();
  expect(f.wallet.run(() => f.wallet.cardRecords.get(prepared.snapshot.cardId)?.acceptedInput)).toBeUndefined();
});

it("prepares one full download snapshot; repeated admission and file reads do not create another", async () => {
  const f = await fixture(); const prepared = await f.create(), attemptId = randomUUID();
  await f.download(prepared, attemptId);
  let completed = await f.read(prepared);
  await vi.waitFor(async () => { completed = await f.read(prepared); expect(view(completed).result?.outcome).toBe("completed"); });
  const details = view(completed).result!.details!;
  const data = await readFile(downloadPath(f, prepared));
  const parsed = JSON.parse(data.toString("utf8"));
  expect(parsed).toMatchObject({ format: "sui-mcp.local-data", network: "mainnet" });
  expect(parsed).not.toHaveProperty("schemaVersion");
  expect(parsed.data).toHaveProperty("localSettings"); expect(JSON.stringify(parsed)).not.toContain(prepared.permission);
  const ownRecord = f.wallet.run(() => f.wallet.cardRecords.get(prepared.snapshot.cardId))!;
  const range = await f.wallet.run(() => f.settings.readFile(ownRecord, String(details.fileId), 0, data.length, attemptId));
  expect(Buffer.from(range.chunkBase64, "base64")).toEqual(data);
  expect(createHash("sha256").update(data).digest("hex")).toBe(details.sha256);
  expect((await f.download(prepared, attemptId)).snapshot).toEqual(completed.snapshot);
});

it("automatically checks the same resumed upload without endpoint contact or extending input lifetime, then applies once", async () => {
  const verify = vi.fn(async () => {}), f = await fixture({ verifyEndpoint: verify });
  const { connection, card: priorConnectionCard } = await f.wallet.approve();
  const envelope = await f.wallet.run(() => f.wallet.localData.exportLocalData(f.wallet.now()));
  const raw = Buffer.from(JSON.stringify(envelope));
  let card = await f.create();
  const permission = card.permission, deadline = card.snapshot.expiresAt;
  const call = async (input: Record<string, unknown>) => { card = { ...await f.act(card, input), permission }; expect(card.error).toBeUndefined(); };
  await call({ action: "settings_select", draft: { kind: "import_local_data" } });
  const operationId = view(card).operationId, sha256 = createHash("sha256").update(raw).digest("hex");
  await call({ action: "settings_begin_upload", operationId, name: "backup.json", totalSize: raw.length, sha256 });
  const fileId = view(card).file!.fileId, split = Math.floor(raw.length / 2);
  await call({ action: "settings_upload_chunk", operationId, fileId, offset: 0, chunkBase64: raw.subarray(0, split).toString("base64") });
  card = await f.read(card);
  await call({ action: "settings_begin_upload", operationId, name: "renamed.json", totalSize: raw.length, sha256 });
  expect(view(card).file).toMatchObject({ fileId, receivedSize: split, sha256 });
  await call({ action: "settings_upload_chunk", operationId, fileId, offset: 0, chunkBase64: raw.subarray(0, split).toString("base64") });
  await call({ action: "settings_upload_chunk", operationId, fileId, offset: split, chunkBase64: raw.subarray(split).toString("base64") });
  await call({ action: "settings_seal_upload", operationId, fileId });
  expect(view(card)).toMatchObject({ phase: "prepared", restoreCheck: { status: "can_restore" }, file: { fileId, sealed: true } });
  expect(verify).not.toHaveBeenCalled(); expect(card.snapshot.expiresAt).toBe(deadline);
  const confirmed = card;
  await call({ action: "settings_confirm", operationId, preparationId: view(card).preparationId });
  expect(view(card).result).toMatchObject({ outcome: "completed", details: { status: "imported" } });
  expect(f.wallet.run(() => f.wallet.workflow.reconcileConnectionContext())).toMatchObject({ manageableConnectionIds: [connection.connectionId],
    connections: [expect.objectContaining({ connectionId: connection.connectionId })], assetReadAccount: { status: "available", account: f.wallet.account } });
  await expect(f.wallet.read(priorConnectionCard)).rejects.toThrow("access is unavailable");
  expect(f.wallet.connect).toHaveBeenCalledOnce(); expect(f.wallet.sign).not.toHaveBeenCalled(); expect(f.wallet.submit).not.toHaveBeenCalled();
  const epoch = f.wallet.run(() => f.records.control().data_epoch);
  expect((await f.confirm(confirmed)).snapshot).toEqual(card.snapshot);
  expect(f.wallet.run(() => f.records.control().data_epoch)).toBe(epoch);
  expect(f.wallet.run(() => f.records.file(fileId))).toMatchObject({ invalidated: true, cleanup: "complete" });
});

it("rejects a changed duplicate upload chunk without overwriting the original bytes", async () => {
  const f = await fixture(), bytes = Buffer.from("immutable file"), sha256 = createHash("sha256").update(bytes).digest("hex");
  let card = await f.create(); const permission = card.permission;
  const call = async (input: Record<string, unknown>) => { card = { ...await f.act(card, input), permission }; return card; };
  await call({ action: "settings_select", draft: { kind: "import_local_data" } });
  const operationId = view(card).operationId;
  await call({ action: "settings_begin_upload", operationId, name: "file.json", totalSize: bytes.length, sha256 });
  const fileId = view(card).file!.fileId;
  await call({ action: "settings_upload_chunk", operationId, fileId, offset: 0, chunkBase64: bytes.toString("base64") });
  const error = await call({ action: "settings_upload_chunk", operationId, fileId, offset: 0, chunkBase64: Buffer.alloc(bytes.length).toString("base64") });
  expect(error.error?.code).toBe("card_conflict");
  expect(await readFile(join(f.wallet.directory, ".settings-staging", `${fileId}.upload`))).toEqual(bytes);
});

it("preserves a physically prepared snapshot across result storage failure without repeating file creation", async () => {
  const f = await fixture(), prepared = await f.create();
  const publish = vi.spyOn(f.files, "createDownload");
  const db = new Database(join(f.wallet.directory, "activity.sqlite")); resources.push(() => { db.close(); });
  db.exec("CREATE TRIGGER reject_export_result BEFORE UPDATE ON settings_operations WHEN NEW.phase='terminal' BEGIN SELECT RAISE(ABORT,'export result refused'); END");
  await f.download(prepared);
  await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
  const path = downloadPath(f, prepared);
  await vi.waitFor(async () => expect((await readFile(path)).length).toBeGreaterThan(0));
  // Wait for the actual result-storage failure, not just the physical write.
  await vi.waitFor(async () => { await expect(f.read(prepared)).rejects.toThrow("export result refused"); });
  db.exec("DROP TRIGGER reject_export_result");
  const completed = await f.read(prepared);
  expect(view(completed).result?.outcome).toBe("completed");
  expect(publish).toHaveBeenCalledOnce();
});

it.each(["upload", "download"] as const)("keeps replacement cleanup of an old %s with its own result and preserves the file identity", async (role) => {
  const f = await fixture(), bytes = Buffer.from("{}");
  await f.wallet.run(() => f.wallet.activity.setActiveAccount(`0x${"a".repeat(64)}`, "wallet_connection", f.wallet.now()));
  let previous = await f.create(), fileId: string, operationId: string, publicPath = join(f.wallet.directory, "backups", "previous-user-backup.json"), publicBytes = Buffer.from("existing user backup");
  await mkdir(join(f.wallet.directory, "backups"), { recursive: true }); await writeFile(publicPath, publicBytes);
  if (role === "upload") {
    const permission = previous.permission;
    const call = async (input: Record<string, unknown>) => { previous = { ...await f.act(previous, input), permission }; expect(previous.error).toBeUndefined(); };
    await call({ action: "settings_select", draft: { kind: "import_local_data" } });
    operationId = view(previous).operationId;
    await call({ action: "settings_begin_upload", operationId, name: "backup.json", totalSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    fileId = view(previous).file!.fileId;
    await call({ action: "settings_upload_chunk", operationId, fileId, offset: 0, chunkBase64: bytes.toString("base64") });
    await call({ action: "settings_seal_upload", operationId, fileId });
  } else {
    previous = await f.create(); await f.download(previous);
    let complete = await f.read(previous);
    await vi.waitFor(async () => { complete = await f.read(previous); expect(view(complete).result?.outcome).toBe("completed"); });
    operationId = view(previous).operationId; fileId = view(complete).file!.fileId;

  }
  const path = join(f.wallet.directory, ".settings-staging", `${fileId}.${role === "upload" ? "upload" : "download"}`);
  const retained = join(f.wallet.directory, "retained-test-upload");
  await rename(path, retained);
  // A directory at the recorded temporary-file path makes the real unlink fail.
  // The filesystem and cleanup implementation are not replaced by a test double.
  await mkdir(path);
  const reset = await f.prepare({ kind: "reset_local_data" });
  await expect(f.confirm(reset)).rejects.toThrow();
  const applied = await f.read(reset);
  expect(view(applied)).toMatchObject({ result: { outcome: "completed", details: { status: "reset" } }, temporaryFileCleanup: "failed" });
  expect(await f.wallet.run(() => f.wallet.activity.getActiveAccount())).toBeUndefined();
  await expect(f.read(previous)).rejects.toThrow("access is unavailable");
  expect(f.wallet.run(() => f.records.file(fileId))).toMatchObject({ operationId, cleanupOperationId: view(reset).operationId });
  const epoch = f.wallet.run(() => f.records.control().data_epoch);
  await rmdir(path); await rename(retained, path);
  expect(view(await f.read(reset))).toMatchObject({ result: { outcome: "completed" }, temporaryFileCleanup: "complete" });
  expect(f.wallet.run(() => f.records.file(fileId)?.cleanup)).toBe("complete");
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  if (publicPath) expect(await readFile(publicPath)).toEqual(publicBytes);
  expect(f.wallet.run(() => f.records.control().data_epoch)).toBe(epoch);
});

it("releases only a departed owner's terminal I/O reservation without changing its completed result", async () => {
  const f = await fixture(), prepared = await f.create();
  await f.download(prepared); const ready = await downloadReady(f, prepared);
  const db = new Database(join(f.wallet.directory, "activity.sqlite")); resources.push(() => { db.close(); });
  const operationId = view(prepared).operationId;
  db.exec(`CREATE TRIGGER reject_finished_release BEFORE UPDATE ON settings_control
    WHEN OLD.file_io_id IS NOT NULL AND NEW.file_io_id IS NULL AND EXISTS (
      SELECT 1 FROM settings_files f JOIN settings_operations o ON o.operation_id=f.cleanup_operation_id
      WHERE f.file_id=OLD.file_io_id AND o.phase='terminal')
    BEGIN SELECT RAISE(ABORT,'I/O release refused'); END`);
  await expect(f.act(ready, downloadReport(ready))).rejects.toThrow("I/O release refused");
  await vi.waitFor(() => {
    const operation = f.wallet.run(() => f.records.get(operationId)!);
    expect(operation.phase).toBe("terminal");
    expect(f.wallet.run(() => f.records.file(operation.fileId!)!.cleanup)).toBe("complete");
    expect(f.wallet.run(() => f.records.control().file_io_id)).toBe(operation.fileId);
  });
  const result = f.wallet.run(() => f.records.get(operationId)!.result), fileId = f.wallet.run(() => f.records.get(operationId)!.fileId)!;
  db.exec("DROP TRIGGER reject_finished_release");
  // Same-owner recovery is not evidence that an active reservation ended.
  f.wallet.run(() => f.settings.recoverOwner());
  expect(f.wallet.run(() => f.records.control().file_io_id)).toBe(fileId);
  // Persisted old-owner rows model the next parent after that owner's exit;
  // the real file cleanup above already ended, and no old I/O is left running.
  db.prepare("UPDATE settings_operations SET owner_id=? WHERE operation_id=?").run("departed-owner", operationId);
  db.prepare("UPDATE live_read_cards SET owner_id=?,revision=revision+1 WHERE id=?").run("departed-owner", prepared.snapshot.cardId);
  f.wallet.run(() => f.settings.recoverOwner());
  expect(f.wallet.run(() => f.records.control().file_io_id)).toBeNull();
  expect(f.wallet.run(() => f.records.get(operationId)!.result)).toEqual(result);
  const next = await f.prepare({ kind: "clear_read_address" });
  expect(view(await f.confirm(next)).result?.outcome).toBe("completed");
});
