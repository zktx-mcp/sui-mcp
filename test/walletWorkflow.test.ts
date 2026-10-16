import { connectViewSchema } from "../src/core/session/workflowView.js";
import { seedReadAddressCleared } from "./fixtures/readAccount.js";
import { closedReviewCardSchema, workflowViewSchema } from "../src/core/session/workflowView.js";
import { suiGrants } from "./fixtures/walletGrants.js";
import { FixtureWalletRuntime } from "./fixtures/walletRuntime.js";
import { WalletWorkflow } from "../src/core/session/walletWorkflow.js";
import Database from "better-sqlite3";
import { join } from "node:path";
import { DEFAULT_SUI_GRPC_URL, DEFAULT_SUI_GRAPHQL_URL } from "../src/runtime/config.js";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { walletWorkflowFixture, deferred } from "./fixtures/walletWorkflow.js";
import { buildTestTransactionBytes } from "./fixtures/transactionMaterial.js";
import { findForbiddenMcpFields } from "../src/core/action/forbiddenFields.js";
import { waitForWalletConnection } from "../src/core/session/wait.js";
import { WalletUserRejectedError } from "../src/core/session/walletConnection.js";

const fixtures: Awaited<ReturnType<typeof walletWorkflowFixture>>[] = [];
async function fixture() { const value = await walletWorkflowFixture(); fixtures.push(value); return value; }
afterEach(() => { for (const value of fixtures.splice(0)) value.close(); });

describe("stored wallet workflows", () => {
  it("keeps pairing private and creates it only after one admitted selection", async () => {
    const f = await fixture(); let card = await f.createConnection();
    expect(f.connect).not.toHaveBeenCalled();
    expect(findForbiddenMcpFields(card.snapshot)).toEqual([]);
    const first = await f.act(card, { action: "connect" });
    const duplicate = await f.act(card, { action: "connect" });
    expect(duplicate.error).toBeUndefined();
    expect(f.connect).toHaveBeenCalledOnce();
    card = await f.read(card);
    expect(card.walletDisplay?.pairingUri).toContain("wc:fixture");
    expect(JSON.stringify(card.snapshot)).not.toContain("symKey");
    expect(first.snapshot.state).toBe("running");
    expect(first.snapshot.data).toMatchObject({ operation: { status: "running", action: "connect" } });
    expect((await f.run(() => f.cards.readSaved(card.snapshot.cardId))).data).toEqual(card.snapshot.data);
    expect(f.connect).toHaveBeenCalledOnce();
  });

  it.each(["stop_connection", "cancel"] as const)("keeps a card ended by %s closed through late wallet approval and cleanup", async (action) => {
    const f = await fixture(), card = await f.createConnection(), cleanup = deferred<void>();
    vi.mocked(f.transport.disconnect).mockImplementationOnce(async (topic) => { await cleanup.promise; f.removeSession(topic); });
    await f.act(card, { action: "connect" });
    const waiting = await f.read(card), operation = connectViewSchema.parse(waiting.snapshot.data).operation!;
    const input = action === "stop_connection" ? { action, operationId: operation.operationId } : { action };
    const stopped = await f.act(waiting, input);
    expect(stopped.error).toBeUndefined();
    expect(stopped.snapshot).toMatchObject({ state: "closed", reason: "cancelled", data: {
      allowedActions: [], result: { pendingWork: "approval_response" }
    } });
    expect(stopped.walletDisplay).toBeUndefined();
    if (action === "stop_connection") expect((await f.act(waiting, input)).error).toBeUndefined();
    const terminalResult = f.run(() => f.records.operation(operation.operationId))!;
    f.approval.resolve({ topic: "fixture-topic", grants: suiGrants([f.account], ["sui_signTransaction"]),
      expiresAt: new Date(f.now().getTime() + 1_800_000).toISOString(), walletName: "Fixture Wallet" });
    await vi.waitFor(() => expect(f.transport.disconnect).toHaveBeenCalledWith("fixture-topic"));
    expect(f.run(() => f.activity.getActiveAccountSync())).toBeUndefined();
    expect((await f.read(card)).snapshot).toMatchObject({ state: "closed", reason: "cancelled", data: { allowedActions: [] } });
    cleanup.resolve();
    await vi.waitFor(() => expect(f.run(() => f.records.operation(operation.operationId)?.settlementPending)).toBe(false));
    expect(f.run(() => f.records.operation(operation.operationId))).toEqual({ ...terminalResult, settlementPending: false });
    const ended = await f.read(card);
    expect(ended.snapshot).toMatchObject({ state: "closed", reason: "cancelled", data: { allowedActions: [] } });
    expect(ended.snapshot.data).not.toHaveProperty("automaticAction");
    const bind = vi.spyOn(f.runtime, "bind");
    expect((await f.act(ended, { action: "connect" })).snapshot).toEqual(ended.snapshot);
    expect((await f.act(ended, { action: "connect", operationId: randomUUID() })).error).toMatchObject({ code: "card_conflict", message: "This card has ended. Ask in chat for a new request." });
    expect(bind).not.toHaveBeenCalled();
    const fresh = await f.run(() => f.cards.create("connect", {}));
    expect(workflowViewSchema.parse(fresh.snapshot.data).allowedActions).toContain("connect");
    expect(f.connect).toHaveBeenCalledOnce(); expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
  });

  it("binds a signed request to its reviewed bytes and records only verified chain effects as execution", async () => {
    const f = await fixture(); const { connection } = await f.approve(); const ready = await f.prepare(connection.connectionId);
    const input = { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: ready.session.reviewRevision };
    const response = await f.act(ready.card, input);
    expect(response.error).toBeUndefined();
    expect(response.snapshot.data).not.toHaveProperty("nextStateReadAfterMs");
    await f.act(ready.card, input);
    await vi.waitFor(() => expect(f.run(() => f.records.currentRequest(ready.session.id)?.requestStatus)).toBe("completed"));
    expect(f.sign).toHaveBeenCalledOnce(); expect(f.submit).toHaveBeenCalledOnce();
    const request = f.run(() => f.records.currentRequest(ready.session.id))!;
    expect(request.execution?.status).toBe("success");
    expect(request.execution?.txDigest).toBe(request.transactionDigest);
    expect(findForbiddenMcpFields(request)).toEqual([]);
    await f.run(() => f.cards.readSaved(ready.card.snapshot.cardId));
    expect(f.sign).toHaveBeenCalledOnce(); expect(f.submit).toHaveBeenCalledOnce();
  });

  it("keeps a local pairing-publication failure distinct from cancellation or a late approval", async () => {
    const f = await fixture(), card = await f.createConnection(), cleanup = deferred<void>();
    const db = new Database(join(f.directory, "activity.sqlite"));
    const expiryWrite = vi.spyOn(f.records, "pairingExpiry");
    vi.mocked(f.transport.disconnect).mockImplementationOnce(() => cleanup.promise);
    try {
      db.exec("CREATE TRIGGER reject_pairing_expiry BEFORE UPDATE OF expires_at ON wallet_connection_operations BEGIN SELECT RAISE(ABORT,'Synthetic pairing publication failure'); END");
      await f.act(card, { action: "connect" });
      await vi.waitFor(() => expect(expiryWrite).toHaveBeenCalledOnce());
      db.exec("DROP TRIGGER reject_pairing_expiry");
      const operation = f.run(() => f.records.pendingConnectionOperations()[0])!;
      expect(operation.status).toBe("running");
      expect(operation.endReason).toBeUndefined();
      expect(Date.parse(operation.expiresAt)).toBeGreaterThan(f.now().getTime());
      f.approval.resolve({ topic: "fixture-topic", grants: suiGrants([f.account], ["sui_signTransaction"]),
        expiresAt: new Date(f.now().getTime() + 1_800_000).toISOString(), walletName: "Fixture Wallet" });
      await vi.waitFor(() => expect(f.transport.disconnect).toHaveBeenCalledWith("fixture-topic"));
      expect(f.run(() => f.records.connection(operation.connectionId!)?.connection.reason))
        .toBe("This wallet connection was not accepted for account use.");
      cleanup.reject(new Error("Synthetic cleanup failure"));
      await vi.waitFor(() => expect(f.run(() => f.records.operation(operation.operationId)?.settlementPending)).toBe(false));
      expect(f.run(() => f.records.operation(operation.operationId))).toMatchObject({ status: "failed" });
      expect(f.run(() => f.records.operation(operation.operationId)?.endReason)).toBeUndefined();
      expect(f.run(() => f.records.connection(operation.connectionId!)?.connection.reason))
        .toBe("This wallet connection was not accepted for account use, and its removal could not be confirmed. Disconnect it before connecting again.");
      expect((await f.read(card)).snapshot).toMatchObject({ state: "closed", reason: "failed" });
      expect(f.run(() => f.activity.getActiveAccountSync())).toBeUndefined();
      expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
    } finally { cleanup.resolve(); db.exec("DROP TRIGGER IF EXISTS reject_pairing_expiry"); db.close(); }
  });

  it.each(["declined", "unconfirmed"] as const)("reports a %s signing failure without inferring another cause", async (failure) => {
    const f = await fixture(), { connection } = await f.approve(), ready = await f.prepare(connection.connectionId);
    f.sign.mockRejectedValueOnce(failure === "declined" ? new WalletUserRejectedError() : new Error("User rejected"));
    await f.act(ready.card, { action: "request_signature", connectionId: connection.connectionId,
      account: f.account, reviewRevision: ready.session.reviewRevision });
    await vi.waitFor(() => expect(f.run(() => f.records.currentRequest(ready.session.id)?.requestStatus)).toBe("request_failed"));
    expect(f.run(() => f.records.currentRequest(ready.session.id)?.reason)).toBe(failure === "declined"
      ? "The wallet approval request was declined. Nothing was submitted."
      : "The wallet signing request could not be completed. Nothing was submitted.");
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.run(() => f.records.currentRequest(ready.session.id)?.execution)).toBeUndefined();
  });

  it.each(["signer", "transaction"] as const)("refuses an otherwise valid response with a different %s", async (mismatch) => {
    const f = await fixture(); const { connection } = await f.approve(); const ready = await f.prepare(connection.connectionId);
    f.sign.mockImplementationOnce(async (input) => {
      const bytes = mismatch === "transaction" ? await buildTestTransactionBytes(f.account) : Buffer.from(input.transactionBytesBase64, "base64");
      const signed = await (mismatch === "signer" ? Ed25519Keypair.generate() : f.accountKey).signTransaction(bytes);
      return { transactionBytes: signed.bytes, signature: signed.signature };
    });
    await f.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: ready.session.reviewRevision });
    await vi.waitFor(() => expect(f.run(() => f.records.currentRequest(ready.session.id)?.requestStatus)).toBe("request_failed"));
    expect(f.run(() => f.records.currentRequest(ready.session.id)?.reason)).toBe(mismatch === "transaction"
      ? "The returned transaction does not match the reviewed transaction. Nothing was submitted."
      : "Submission checks could not be completed. Nothing was submitted.");
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.run(() => f.records.currentRequest(ready.session.id)?.execution)).toBeUndefined();
  });

  it("does not submit a late valid signature after a stop and retains the unsettled-request guard", async () => {
    const f = await fixture(); const { connection } = await f.approve(); const ready = await f.prepare(connection.connectionId);
    const pending = deferred<{ transactionBytes: string; signature: string }>();
    let signed!: { transactionBytes: string; signature: string };
    f.sign.mockImplementationOnce(async (input) => { const result = await f.accountKey.signTransaction(Buffer.from(input.transactionBytesBase64, "base64"));
      signed = { transactionBytes: result.bytes, signature: result.signature }; return pending.promise; });
    await f.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: ready.session.reviewRevision });
    await vi.waitFor(() => expect(signed).toBeDefined());
    const waiting = await f.read(ready.card);
    const stopped = await f.act(waiting, { action: "stop_waiting" });
    expect(stopped.snapshot).toMatchObject({ state: "closed", reason: "cancelled", data: { allowedActions: [] } });
    expect((await f.act(waiting, { action: "stop_waiting" })).error).toBeUndefined();
    expect(() => f.run(() => f.records.assertDataReplacementAllowed(f.now()))).toThrow("unsettled");
    pending.resolve(signed);
    await vi.waitFor(() => expect(f.run(() => f.records.authority(f.records.currentRequest(ready.session.id)!.attemptId)?.sdk_pending)).toBe(0));
    expect(f.run(() => f.records.currentRequest(ready.session.id)?.requestStatus)).toBe("stopped");
    expect((await f.read(ready.card)).snapshot).toMatchObject({ state: "closed", reason: "cancelled", data: { allowedActions: [] } });
    expect(f.submit).not.toHaveBeenCalled();
  });

  it("does not reinterpret a lost submission response as a chain failure or resubmit", async () => {
    const f = await fixture(); const { connection } = await f.approve(); const ready = await f.prepare(connection.connectionId);
    f.submit.mockRejectedValueOnce(new Error("Lost RPC response"));
    f.chainRead.mockRejectedValue(Object.assign(new Error("Not found in the initial observation"), { name: "TimeoutError" }));
    await f.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: ready.session.reviewRevision });
    await vi.waitFor(() => expect(f.run(() => f.records.currentRequest(ready.session.id)?.requestStatus)).toBe("awaiting_chain_result"));
    f.advance(10 * 60 * 1000);
    await f.read(ready.card);
    const request = f.run(() => f.records.currentRequest(ready.session.id))!;
    expect(request.requestStatus).toBe("outcome_unknown"); expect(request.execution).toBeUndefined();
    expect(f.sign).toHaveBeenCalledOnce(); expect(f.submit).toHaveBeenCalledOnce();
  });
});

describe("wallet startup and review expiry", () => {
  it.each(["restore", "record", "subscription"] as const)("disables wallet operations after a %s startup failure", async (stage) => {
    const f = await fixture(), { connection } = await f.approve();
    f.workflow.stop();
    vi.mocked(f.transport.stop).mockClear(); f.connect.mockClear();
    const records = f.activity.createWalletWorkflowStore("next-owner");
    const subscribe = vi.fn(f.transport.onSessionChanged);
    const restore = vi.fn(async () => {
      if (stage === "restore") throw new Error("PRIVATE-RESTORE-DETAIL");
      return [f.transport.session("fixture-topic")!];
    });
    const db = new Database(join(f.directory, "activity.sqlite"));
    if (stage === "record") db.exec("CREATE TRIGGER refuse_restore BEFORE UPDATE ON live_wallet_connections BEGIN SELECT RAISE(ABORT,'PRIVATE-STORAGE-DETAIL'); END");
    if (stage === "subscription") subscribe.mockImplementation(() => { throw new Error("PRIVATE-SUBSCRIPTION-DETAIL"); });
    const runtime = new FixtureWalletRuntime({ ...f.transport, restore, onSessionChanged: subscribe });
    const next = new WalletWorkflow({ records, sessions: f.sessions,
      ownerId: "next-owner", runtime, computation: f.computation,
      verifyReceipt: f.verifyReceipt, verifyNetwork: f.verifyNetwork, submitTransaction: f.submit,
      assertCurrent: f.access.assertCurrent, bindExternalEvent: (work) => f.access.bind(work), logger: f.logger, now: f.now });
    try {
      await f.run(() => next.start());
      await expect(f.run(() => next.prepare("connect", { intent: "manage" }))).resolves.toEqual({ status: "ready" });
      expect(f.run(() => next.walletAvailability())).toMatchObject(stage === "record"
        ? { status: "initializing", stage: "state_sync" } : { status: "unavailable", reason: "restoration_failed" });
      await expect(f.run(() => next.start())).rejects.toThrow("already started");
      expect(await f.run(() => next.readReview("any-review"))).toBeUndefined();
      expect(f.connect).not.toHaveBeenCalled(); expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
      next.stop(); await runtime.close(); expect(f.transport.stop).toHaveBeenCalledOnce();
      expect(await f.run(() => f.activity.getActiveAccount())).toMatchObject({ address: connection.chainResults.find((item) => item.status === "bound")?.address });
      expect(JSON.stringify(f.logger.error.mock.calls)).not.toContain("PRIVATE-");
    } finally { next.stop(); await runtime.close(); db.exec("DROP TRIGGER IF EXISTS refuse_restore"); db.close(); }
  });

  it("projects material expiry independently of the card deadline and preserves explicit refresh", async () => {
    const f = await fixture(), { connection } = await f.approve(), ready = await f.prepare(connection.connectionId);
    expect(ready.card.snapshot.data).toMatchObject({ actionRemainingMs: 1_800_000, nextStateReadAfterMs: 30_000 });
    f.advance(29_999);
    const before = await f.read(ready.card);
    expect(before.snapshot.data).toMatchObject({ actionRemainingMs: 1_770_001, nextStateReadAfterMs: 1 });
    f.advance(1);
    // Click/expiry race: no preceding read is needed to make the backend refuse.
    const refused = await f.act(before, { action: "request_signature", connectionId: connection.connectionId,
      account: f.account, reviewRevision: ready.session.reviewRevision });
    expect(refused.error?.code).toBe("card_conflict");
    expect(refused.snapshot.data).toMatchObject({ review: { status: "refresh_required", state: { refreshReason: "review_evidence_stale" } } });
    expect(refused.snapshot.data).toMatchObject({ nextStateReadAfterMs: Date.parse(connection.expiresAt) - f.now().getTime() });
    expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
    const expired = await f.read(ready.card);
    expect(expired.snapshot.data).toMatchObject({ allowedActions: ["cancel", "prepare_review"] });
    await f.act(expired, { action: "prepare_review", connectionId: connection.connectionId,
      account: f.account, reviewRevision: ready.session.reviewRevision });
    await vi.waitFor(async () => expect((await f.read(ready.card)).snapshot.data).toMatchObject({
      review: { status: "ready_for_wallet_review", reviewRevision: 2 }, nextStateReadAfterMs: 30_000
    }));
    expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
  });

  it("caps a later-created review card at the original session deadline", async () => {
    const f = await fixture(), { connection } = await f.approve();
    const created = await f.run(() => f.sessions.createReviewSession([f.plan], f.now()));
    const originalExpiry = created.session.expiresAt;
    f.advance(5000);
    const card = await f.run(() => f.cards.create("review", f.reviewInput(created.session.id)));
    expect(Date.parse(card.snapshot.expiresAt)).toBeGreaterThan(Date.parse(originalExpiry));
    expect(card.snapshot.data).toMatchObject({ actionRemainingMs: Date.parse(originalExpiry) - f.now().getTime() });
    await f.act(card, { action: "prepare_review", connectionId: connection.connectionId, account: f.account, reviewRevision: 0 });
    await vi.waitFor(async () => expect((await f.read(card)).snapshot.data).toMatchObject({ review: { status: "ready_for_wallet_review" } }));
    f.advance(Date.parse(originalExpiry) - f.now().getTime());
    const expired = await f.read(card);
    expect(expired.snapshot.data).toMatchObject({ actionRemainingMs: 0, allowedActions: [], review: { status: "expired" } });
    const revision = (expired.snapshot.data as any).review.reviewRevision;
    for (const action of ["prepare_review", "request_signature"]) {
      expect((await f.act(expired, { action, connectionId: connection.connectionId, account: f.account, reviewRevision: revision })).error?.code).toBe("card_conflict");
    }
    expect(f.run(() => f.sessions.readReviewSession(created.session.id))!.expiresAt).toBe(originalExpiry);
    expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
  });
});

describe("request authority, lifecycle and actual chain observation", () => {
  it("returns the same admission from another card and rejects a different normalized selection", async () => {
    const f = await fixture(), { connection } = await f.approve(), ready = await f.prepare(connection.connectionId);
    const other = await f.run(() => f.cards.create("review", { reviewSessionId: ready.session.id }));
    const pending = deferred<{ transactionBytes: string; signature: string }>(); f.sign.mockImplementationOnce(() => pending.promise);
    const input = { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: ready.session.reviewRevision };
    await f.act(ready.card, input);
    const duplicate = await f.act(await f.read(other), { ...input, account: "0x" + f.account.slice(2).toUpperCase() });
    expect(duplicate.error).toBeUndefined();
    expect(f.sign).toHaveBeenCalledOnce();
    expect(f.run(() => f.cardRecords.get(other.snapshot.cardId)?.operationId))
      .toBe(f.run(() => f.records.currentRequest(ready.session.id)?.attemptId));
    const conflict = await f.act(await f.read(other), { ...input, account: `0x${"b".repeat(64)}` });
    expect(conflict.error).toBeDefined(); expect(f.sign).toHaveBeenCalledOnce();
    pending.reject(new Error("Wallet dismissed"));
    await vi.waitFor(() => expect(f.run(() => f.records.currentRequest(ready.session.id)?.requestStatus)).toBe("request_failed"));
    expect(f.submit).not.toHaveBeenCalled();
  });

  it.each(["deadline", "account", "network"] as const)("refuses a valid signature after the %s boundary changes", async (boundary) => {
    const f = await fixture(), { connection } = await f.approve(), ready = await f.prepare(connection.connectionId);
    const pending = deferred<{ transactionBytes: string; signature: string }>();
    let signed: { transactionBytes: string; signature: string } | undefined;
    f.sign.mockImplementationOnce(async (input) => { const result = await f.accountKey.signTransaction(Buffer.from(input.transactionBytesBase64, "base64"));
      signed = { transactionBytes: result.bytes, signature: result.signature }; return pending.promise; });
    await f.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: ready.session.reviewRevision });
    await vi.waitFor(() => expect(signed).toBeDefined());
    if (boundary === "deadline") f.advance(90_000);
    if (boundary === "account") f.notify({ topic: "fixture-topic", grants: suiGrants([`0x${"b".repeat(64)}`], ["sui_signTransaction"]), expiresAt: connection.expiresAt });
    if (boundary === "network") f.verifyNetwork.mockRejectedValueOnce(new Error("Different actual chain identifier"));
    pending.resolve(signed!);
    await vi.waitFor(() => expect(f.run(() => f.records.authority(f.records.currentRequest(ready.session.id)!.attemptId)?.sdk_pending)).toBe(0));
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.run(() => f.records.currentRequest(ready.session.id)?.execution)).toBeUndefined();
    expect(f.run(() => f.records.currentRequest(ready.session.id)?.requestStatus)).toBe(boundary === "account" ? "stopped" : "request_failed");
    expect(f.run(() => f.records.currentRequest(ready.session.id)?.reason)).toBe(boundary === "network"
      ? "Submission checks could not be completed. Nothing was submitted."
      : boundary === "account" ? "The wallet connection changed or became unavailable before submission. Nothing was submitted."
        : "Local signing wait expired. The wallet request may still be open.");
  });

  it("records failed chain effects as a completed request with a separate failure result", async () => {
    const f = await fixture(), { connection } = await f.approve(), ready = await f.prepare(connection.connectionId);
    f.setChainOutcome("failure");
    await f.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: ready.session.reviewRevision });
    await vi.waitFor(() => expect(f.run(() => f.records.currentRequest(ready.session.id)?.requestStatus)).toBe("completed"));
    expect(f.run(() => f.records.currentRequest(ready.session.id)?.execution)).toMatchObject({ status: "failure", failureReason: "chain_execution_failed", chainReceipt: { effectsStatus: { success: false } } });
    expect(f.submit).toHaveBeenCalledOnce();
  });

  it("stops local observation after submission without claiming transaction cancellation", async () => {
    const f = await fixture(), { connection } = await f.approve(), ready = await f.prepare(connection.connectionId);
    const submission = deferred<object>(); f.submit.mockImplementationOnce(() => submission.promise);
    await f.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: ready.session.reviewRevision });
    await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce());
    const request = f.run(() => f.records.currentRequest(ready.session.id))!;
    const management = await f.run(() => f.cards.create("review", { mode: "manage", reviewSessionId: ready.session.id, attemptId: request.attemptId }));
    expect((await f.act(management, { action: "stop_waiting" })).error).toBeUndefined();
    expect(f.run(() => f.records.request(request.attemptId)?.requestStatus)).toBe("submitting");
    expect(f.run(() => f.records.authority(request.attemptId)?.observation_stopped)).toBe(1);
    const stopped = await f.read(management), stoppedView = closedReviewCardSchema.parse(stopped.snapshot.data);
    expect(stopped.snapshot).toMatchObject({ state: "closed", reason: "cancelled" });
    expect(stoppedView.allowedActions).toEqual([]);
    expect(stoppedView.result.message).toContain("does not cancel the transaction");
    expect(stoppedView.result.message).not.toContain("request was cancelled");
    expect(stoppedView.request?.transactionDigest).toBe(request.transactionDigest);
    expect((await f.act(management, { action: "stop_waiting" })).error).toBeUndefined();
    expect((await f.act(stopped, { action: "read_result" })).error?.code).toBe("card_conflict");
    submission.resolve({});
    await vi.waitFor(() => expect(f.run(() => f.records.authority(request.attemptId)?.sdk_pending)).toBe(0));
    expect(f.chainRead).not.toHaveBeenCalled();
    const resultCard = await f.run(() => f.cards.create("review", { mode: "manage", reviewSessionId: ready.session.id, attemptId: request.attemptId }));
    expect(workflowViewSchema.parse(resultCard.snapshot.data).allowedActions).toContain("read_result");
    const readReceipt = f.chainRead.getMockImplementation()!, receipt = deferred<Awaited<ReturnType<typeof f.chainRead>>>();
    f.chainRead.mockImplementationOnce(() => receipt.promise);
    expect((await f.act(resultCard, { action: "read_result" })).error).toBeUndefined();
    await vi.waitFor(() => expect(f.chainRead).toHaveBeenCalledOnce());
    expect((await f.act(management, { action: "stop_waiting" })).error).toBeUndefined();
    expect(f.run(() => f.records.authority(request.attemptId))).toMatchObject({ observation_stopped: 0, lookup_pending: 1 });
    receipt.resolve(await readReceipt());
    await vi.waitFor(() => expect(f.run(() => f.records.request(request.attemptId)?.requestStatus)).toBe("completed"));
    expect(f.submit).toHaveBeenCalledOnce();
    expect((await f.read(management)).snapshot).toMatchObject({ state: "closed", reason: "cancelled", data: { allowedActions: [] } });
    expect((await f.act(await f.read(management), { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: ready.session.reviewRevision })).error).toBeDefined();
  });

  it("keeps failed preparation distinct from a consumed signing request and permits explicit retry", async () => {
    const f = await fixture(), { connection } = await f.approve();
    const session = await f.run(() => f.sessions.createReviewSession([f.plan], f.now()));
    let card = await f.run(() => f.cards.create("review", f.reviewInput(session.session.id)));
    const original = vi.mocked(f.sessions.recordWalletConnected).getMockImplementation()!;
    vi.spyOn(f.sessions, "recordWalletConnected").mockRejectedValueOnce(new Error("Private provider detail"));
    await f.act(card, { action: "prepare_review", connectionId: connection.connectionId, account: f.account, reviewRevision: 0 });
    await vi.waitFor(async () => {
      card = await f.read(card);
      expect(card.snapshot.data).toMatchObject({ review: { preparing: false, error: expect.stringContaining("could not be completed") } });
    });
    expect(card.snapshot.state).toBe("ready"); expect(f.sign).not.toHaveBeenCalled();
    expect(JSON.stringify(card.snapshot)).not.toContain("Private provider detail");
    vi.spyOn(f.sessions, "recordWalletConnected").mockImplementation(original);
    await f.act(card, { action: "prepare_review", connectionId: connection.connectionId, account: f.account, reviewRevision: 0 });
    await vi.waitFor(async () => expect((await f.run(() => f.sessions.getReviewSession(session.session.id, f.now)))?.status).toBe("ready_for_wallet_review"));
    expect((await f.read(card)).snapshot.state).toBe("ready");
  });
});


it("rolls back card, attempt, authority and history together when the admission write fails", async () => {
  const f = await fixture(), { connection } = await f.approve(), ready = await f.prepare(connection.connectionId);
  const db = new Database(join(f.directory, "activity.sqlite"));
  try {
    db.exec("CREATE TRIGGER reject_admission BEFORE INSERT ON review_status_transitions WHEN NEW.event='request_admitted' BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END");
    await expect(f.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: ready.session.reviewRevision })).rejects.toThrow("fixture storage failure");
    expect(f.sign).not.toHaveBeenCalled();
    expect(f.run(() => f.records.currentRequest(ready.session.id))).toBeUndefined();
    expect((await f.read(ready.card)).snapshot.state).toBe("ready");
    for (const table of ["review_requests", "live_request_authority", "review_executions"]) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    expect(db.prepare("SELECT current_attempt_id FROM live_review_sessions WHERE id=?").get(ready.session.id)).toEqual({ current_attempt_id: null });
  } finally { db.exec("DROP TRIGGER IF EXISTS reject_admission"); db.close(); }
});

it("checks data replacement again after endpoint verification and preserves unsettled work", async () => {
  const f = await fixture(), { connection } = await f.approve(), ready = await f.prepare(connection.connectionId);
  await f.run(() => f.activity.createPreferencesRepository().ensureDefaultLocalSettings({ suiGrpcUrl: DEFAULT_SUI_GRPC_URL, suiGraphqlUrl: DEFAULT_SUI_GRAPHQL_URL }));
  const verification = deferred<void>(), entered = deferred<void>();
  const service = f.activity.createLocalDataService({ suiGrpcUrl: DEFAULT_SUI_GRPC_URL, suiGraphqlUrl: DEFAULT_SUI_GRAPHQL_URL,
    now: f.now, advanceRequestDeadlines: (now) => f.records.advanceRequestDeadlines(now),
    verifySuiGrpcUrl: async () => { entered.resolve(); await verification.promise; }, verifySuiGraphqlUrl: async () => {} });
  const backup = await f.run(() => service.exportLocalData(f.now()));
  const importing = f.run(() => service.importLocalDataReplace(backup));
  const rejection = expect(importing).rejects.toMatchObject({ details: { reason: "wallet_request_unsettled" } });
  await entered.promise;
  const pending = deferred<{ transactionBytes: string; signature: string }>(); f.sign.mockImplementationOnce(() => pending.promise);
  await f.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: ready.session.reviewRevision });
  const request = f.run(() => f.records.currentRequest(ready.session.id))!;
  await f.act(await f.read(ready.card), { action: "stop_waiting" });
  await expect(f.run(() => service.resetLocalData())).rejects.toMatchObject({ details: { reason: "wallet_request_unsettled" } });
  verification.resolve(); await rejection;
  expect(f.run(() => f.records.request(request.attemptId)?.requestStatus)).toBe("stopped");
  pending.reject(new Error("Wallet dismissed"));
  await vi.waitFor(() => expect(f.run(() => f.records.authority(request.attemptId)?.sdk_pending)).toBe(0));
  await f.run(() => service.resetLocalData());
  expect(f.run(() => f.records.request(request.attemptId))).toBeUndefined(); expect(f.submit).not.toHaveBeenCalled();
});

it("coalesces receipt reads and keeps an unverified response unknown until the exact digest is confirmed", async () => {
  const f = await fixture(), { connection } = await f.approve(), ready = await f.prepare(connection.connectionId);
  const original = f.chainRead.getMockImplementation()!;
  const reading = deferred<Awaited<ReturnType<typeof f.chainRead>>>(); f.chainRead.mockImplementation(() => reading.promise);
  await f.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: ready.session.reviewRevision });
  await vi.waitFor(() => expect(f.chainRead).toHaveBeenCalledOnce());
  await f.read(ready.card); await f.read(ready.card); expect(f.chainRead).toHaveBeenCalledOnce();
  const mismatched = await original();
  if (mismatched.$kind !== "Transaction") throw new Error("Fixture requires successful source data");
  mismatched.Transaction.digest = "1".repeat(32);
  reading.resolve(mismatched);
  await vi.waitFor(() => expect(f.run(() => f.records.currentRequest(ready.session.id)?.requestStatus)).toBe("outcome_unknown"));
  expect(f.run(() => f.records.currentRequest(ready.session.id)?.execution)).toBeUndefined();
  f.chainRead.mockImplementation(original);
  await f.run(() => f.workflow.readReview(ready.session.id, true));
  const completed = f.run(() => f.records.currentRequest(ready.session.id))!;
  expect(completed.requestStatus).toBe("completed");
  await f.run(() => f.workflow.readReview(ready.session.id, true));
  expect(f.run(() => f.records.currentRequest(ready.session.id))).toEqual(completed);
  expect(f.sign).toHaveBeenCalledOnce(); expect(f.submit).toHaveBeenCalledOnce();
});

it("keeps observing an explicit unknown-result lookup until its response arrives", async () => {
  const f = await fixture(), { connection } = await f.approve(), ready = await f.prepare(connection.connectionId);
  const original = f.chainRead.getMockImplementation()!;
  f.chainRead.mockRejectedValue(Object.assign(new Error("Not found"), { name: "TimeoutError" }));
  await f.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: ready.session.reviewRevision });
  await vi.waitFor(() => expect(f.run(() => f.records.currentRequest(ready.session.id)?.requestStatus)).toBe("awaiting_chain_result"));
  f.advance(10 * 60 * 1000); let card = await f.read(ready.card);
  expect(card.snapshot.data).toMatchObject({ request: { requestStatus: "outcome_unknown" }, observe: false });
  const reading = deferred<Awaited<ReturnType<typeof f.chainRead>>>(); f.chainRead.mockImplementation(() => reading.promise);
  const frozen = structuredClone(card.snapshot);
  const lookupCard = await f.run(() => f.cards.create("review", { mode: "manage", reviewSessionId: ready.session.id, attemptId: String((card.snapshot.data as any).request.attemptId) }));
  const response = await f.act(lookupCard, { action: "read_result" });
  expect(response.snapshot.data).toMatchObject({ request: { requestStatus: "outcome_unknown" }, observe: true });
  reading.resolve(await original());
  await vi.waitFor(async () => { card = await f.read(lookupCard); expect(card.snapshot.data).toMatchObject({ request: { requestStatus: "completed" }, observe: false }); });
  expect((await f.read(ready.card)).snapshot).toEqual(frozen); expect(f.submit).toHaveBeenCalledOnce();
});

it("preserves the evaluated revision when admission commits after a state read was finalized", async () => {
  const f = await fixture(), card = await f.createConnection();
  const original = f.workflow.describe.bind(f.workflow), entered = deferred<void>(), release = deferred<void>();
  vi.spyOn(f.workflow, "describe").mockImplementationOnce(async (...args) => {
    const view = await original(...args); entered.resolve(); await release.promise; return view;
  });
  const reading = f.read(card); await entered.promise;
  const admitted = await f.act(card, { action: "connect" });
  expect(admitted.error).toBeUndefined(); release.resolve();
  const evaluated = await reading;
  expect(evaluated.snapshot.state).toBe("ready");
  expect(evaluated.snapshot.revision).toBe(card.snapshot.revision);
  expect((evaluated.snapshot.data as { connection?: unknown }).connection).toBeUndefined();
  expect(evaluated.walletDisplay).toBeUndefined();
  const current = await f.read(card);
  expect(current.snapshot.state).toBe("running");
  expect(current.snapshot.data).toMatchObject({ operation: { status: "running" } });
  expect(current.snapshot.data).toMatchObject({ operation: { connectionId: current.walletDisplay!.connectionId, status: "running" } });
  expect(current.snapshot.revision).toBe(f.run(() => f.cardRecords.get(card.snapshot.cardId)!.state.revision));
  expect(f.connect).toHaveBeenCalledOnce();
});

it("invalidates an unadmitted review when a wallet selection changes without changing its approved account set", async () => {
  const f = await fixture(), { connection } = await f.approve(), ready = await f.prepare(connection.connectionId);
  f.notify({ topic: "fixture-topic", grants: suiGrants([f.account], ["sui_signTransaction"]), expiresAt: connection.expiresAt }, ["sui:mainnet"]);
  const changed = await f.read(ready.card);
  expect(changed.snapshot.data).toMatchObject({ review: { status: "refresh_required", state: { refreshReason: "wallet_connection_changed" } } });
  expect((changed.snapshot.data as { allowedActions: string[] }).allowedActions).not.toContain("request_signature");
  expect(f.sign).not.toHaveBeenCalled();
});

it("disables the workflow if a wallet-change transaction cannot be committed and ignores its late signature", async () => {
  const f = await fixture(), { connection } = await f.approve(), ready = await f.prepare(connection.connectionId);
  const pending = deferred<{ transactionBytes: string; signature: string }>(); let signed: { transactionBytes: string; signature: string } | undefined;
  f.sign.mockImplementationOnce(async (input) => { const response = await f.accountKey.signTransaction(Buffer.from(input.transactionBytesBase64, "base64")); signed = { transactionBytes: response.bytes, signature: response.signature }; return pending.promise; });
  await f.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: ready.session.reviewRevision });
  await vi.waitFor(() => expect(signed).toBeDefined());
  const exit = f.holdWalletExit();
  const db = new Database(join(f.directory, "activity.sqlite"));
  try {
    db.exec("CREATE TRIGGER reject_wallet_change BEFORE UPDATE ON live_wallet_connections BEGIN SELECT RAISE(ABORT,'fixture write failure'); END");
    f.notify({ topic: "fixture-topic", grants: suiGrants([f.account], ["sui_signTransaction"]), expiresAt: connection.expiresAt }, ["sui:mainnet"]);
    // A failed business-state write is not a successful current observation.
    await expect(f.read(ready.card)).rejects.toThrow("fixture write failure");
    expect(f.run(() => f.workflow.walletAvailability())).toMatchObject({ status: "unavailable", reason: "wallet_state_unavailable" });
    expect(f.run(() => f.records.currentRequest(ready.session.id)?.requestStatus)).toBe("awaiting_signature");
    const request = f.run(() => f.records.currentRequest(ready.session.id))!;
    expect(f.run(() => f.records.authority(request.attemptId))).toMatchObject({ can_submit: 1, sdk_pending: 1 });
    db.exec("DROP TRIGGER reject_wallet_change");
    expect((await f.read(ready.card)).snapshot.data).toMatchObject({ request: { requestStatus: "request_failed" } });
    expect(f.run(() => f.records.authority(request.attemptId))).toMatchObject({ can_submit: 0, sdk_pending: 1 });
    exit(); pending.resolve(signed!); await new Promise((resolve) => setImmediate(resolve));
    expect(f.submit).not.toHaveBeenCalled(); expect(f.runtime.availability().status).toBe("unavailable");
  } finally { db.exec("DROP TRIGGER IF EXISTS reject_wallet_change"); db.close(); }
});

it("does not reopen expired review state when a late preparation write fails", async () => {
  const f = await fixture(), { connection } = await f.approve(), ready = await f.prepare(connection.connectionId);
  const pending = deferred<void>(), entered = deferred<void>();
  const original = vi.mocked(f.sessions.recordReviewStateWithArtifacts).getMockImplementation()!;
  vi.spyOn(f.sessions, "recordReviewStateWithArtifacts").mockImplementationOnce(async (...args) => {
    entered.resolve(); await pending.promise; return original(...args);
  });
  await f.act(ready.card, { action: "prepare_review", connectionId: connection.connectionId, account: f.account, reviewRevision: ready.session.reviewRevision });
  await entered.promise; f.advance(30 * 60 * 1000);
  expect((await f.run(() => f.sessions.getReviewSession(ready.session.id, f.now)))?.status).toBe("expired");
  pending.resolve();
  await vi.waitFor(async () => expect((await f.run(() => f.sessions.getReviewSession(ready.session.id, f.now)))?.preparationId).toBeUndefined());
  const history = await f.run(() => f.activity.getReviewSessionDetail({ reviewSessionId: ready.session.id, account: f.account }));
  expect(history.session.reviewStatus).toBe("expired"); expect(f.sign).not.toHaveBeenCalled();
});


it("recovers interrupted requests without replay, preserves completed facts, and clears former-owner private material", async () => {
  const f = await fixture(), { connection } = await f.approve(), completed = await f.prepare(connection.connectionId);
  await f.act(completed.card, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: completed.session.reviewRevision });
  await vi.waitFor(() => expect(f.run(() => f.records.currentRequest(completed.session.id)?.requestStatus)).toBe("completed"));
  const saved = f.run(() => f.records.currentRequest(completed.session.id))!;
  const interrupted = await f.prepare(connection.connectionId), pending = deferred<{ transactionBytes: string; signature: string }>();
  let late: { transactionBytes: string; signature: string } | undefined;
  f.sign.mockImplementationOnce(async (input) => { const response = await f.accountKey.signTransaction(Buffer.from(input.transactionBytesBase64, "base64")); late = { transactionBytes: response.bytes, signature: response.signature }; return pending.promise; });
  await f.act(interrupted.card, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: interrupted.session.reviewRevision });
  await vi.waitFor(() => expect(late).toBeDefined());
  const request = f.run(() => f.records.currentRequest(interrupted.session.id))!;
  await f.run(() => seedReadAddressCleared(f.activity)); f.workflow.stop();
  const nextRecords = f.activity.createWalletWorkflowStore("replacement");
  const sign = vi.fn(), connect = vi.fn(), submit = vi.fn();
  const next = new WalletWorkflow({ records: nextRecords, sessions: f.sessions, ownerId: "replacement",
    computation: f.computation, runtime: new FixtureWalletRuntime({ ...f.transport, sign, connect, restore: async () => [f.transport.session("fixture-topic")!] }),
    verifyReceipt: f.verifyReceipt, verifyNetwork: f.verifyNetwork, submitTransaction: submit,
    assertCurrent: f.access.assertCurrent, bindExternalEvent: (work) => f.access.bind(work), logger: f.logger, now: f.now });
  try {
    await f.run(() => next.start());
    expect(f.run(() => nextRecords.request(saved.attemptId))).toEqual(saved);
    expect(f.run(() => nextRecords.request(request.attemptId)?.requestStatus)).toBe("outcome_unknown");
    expect(f.run(() => nextRecords.authority(request.attemptId))).toMatchObject({ owner_id: "replacement", can_submit: 0, sdk_pending: 0, submit_pending: 0, lookup_pending: 0 });
    expect(await f.run(() => f.activity.getActiveAccount())).toBeUndefined();
    const db = new Database(join(f.directory, "activity.sqlite"));
    try { expect(db.prepare("SELECT COUNT(*) AS n FROM live_transaction_materials").get()).toEqual({ n: 0 }); expect(db.prepare("SELECT COUNT(*) AS n FROM live_private_review_artifacts").get()).toEqual({ n: 0 }); }
    finally { db.close(); }
    pending.resolve(late!); await new Promise((resolve) => setImmediate(resolve));
    expect(f.submit).toHaveBeenCalledOnce(); expect(sign).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
    f.chainRead.mockRejectedValue(Object.assign(new Error("Not visible yet"), { name: "TimeoutError" }));
    expect((await f.run(() => next.readReview(interrupted.session.id, true)))?.request?.transactionDigest).toBe(request.transactionDigest);
    expect(submit).not.toHaveBeenCalled();
    const detail = await f.run(() => f.activity.getReviewSessionDetail({ reviewSessionId: interrupted.session.id, account: f.account }));
    expect(detail.transitions.filter((event) => event.event === "expired")).toHaveLength(1);
  } finally { next.stop(); }
});

describe("disconnect admission and completion share the stored card operation", () => {
  it.each(["success", "failure"] as const)("observes a delayed %s without treating a session update as completion", async (outcome) => {
    const f = await fixture(), { connection } = await f.approve(), ready = await f.prepare(connection.connectionId);
    const pending = deferred<void>(); vi.mocked(f.transport.disconnect).mockImplementationOnce(() => pending.promise);
    const card = await f.createDisconnection(), other = await f.createDisconnection();
    const input = f.connectionInput(card, { action: "disconnect", connectionId: connection.connectionId });
    const admitted = await f.act(await f.read(card), input);
    expect(admitted.error).toBeUndefined();
    expect(admitted.snapshot).toMatchObject({ state: "running", data: { observe: true,
      connection: { status: "connected" }, operation: { action: "disconnect", status: "running", settlementPending: true } } });
    await f.act(card, input);
    expect(f.transport.disconnect).toHaveBeenCalledOnce();
    expect((await f.run(() => f.workflow.pendingConnections())).find((row) => row.cardId === card.snapshot.cardId))
      .toMatchObject({ status: "disconnect_pending", connectionId: connection.connectionId });
    for (const action of [input, { action: "connect" }]) {
      expect((await f.act(await f.read(other), action)).error).toBeDefined();
    }
    expect((await f.act(await f.read(ready.card), { action: "prepare_review", connectionId: connection.connectionId,
      account: f.account, reviewRevision: ready.session.reviewRevision })).error).toBeDefined();
    f.notify({ topic: "fixture-topic", grants: suiGrants([f.account], ["sui_signTransaction"]), expiresAt: new Date(Date.parse(connection.expiresAt) + 1000).toISOString() });
    expect((await f.read(card)).snapshot).toMatchObject({ state: "running", data: { observe: true } });
    const waiting = await f.run(() => waitForWalletConnection(f.cards, card.snapshot.cardId, { timeoutMs: 0 }));
    expect(waiting.waitOutcome).toBe("timed_out");
    if (outcome === "success") pending.resolve(); else pending.reject(new Error("PRIVATE-SDK-DETAIL"));
    await vi.waitFor(() => expect(f.run(() => f.records.connection(connection.connectionId)?.sdkPending)).toBe(false));
    const final = await f.read(card);
    expect(final.snapshot).toMatchObject({ state: "closed", data: { observe: false,
      result: { message: outcome === "success" ? "Wallet disconnected." : "Wallet disconnection was not confirmed." } } });
    expect(JSON.stringify(final)).not.toContain("PRIVATE-SDK-DETAIL");
    expect((await f.run(() => waitForWalletConnection(f.cards, card.snapshot.cardId, { timeoutMs: 0 }))).waitOutcome).toBe("status_reached");
    expect((await f.run(() => f.workflow.pendingConnections())).some((row) => row.cardId === card.snapshot.cardId)).toBe(false);
    expect(f.transport.disconnect).toHaveBeenCalledOnce(); expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
  });

  it("does not overwrite a confirmed session deletion with a later disconnect error", async () => {
    const f = await fixture(), { connection } = await f.approve(), card = await f.createDisconnection();
    const pending = deferred<void>(); vi.mocked(f.transport.disconnect).mockImplementationOnce(() => pending.promise);
    await f.act(card, { action: "disconnect", connectionId: connection.connectionId });
    f.notify(undefined);
    const final = await f.read(card);
    expect(final.snapshot).toMatchObject({ state: "closed", data: { observe: false, result: { message: "Wallet disconnected." } } });
    pending.reject(new Error("Late acknowledgement failure"));
    await vi.waitFor(() => expect(f.run(() => f.records.connection(connection.connectionId)?.sdkPending)).toBe(false));
    const settled = await f.read(card);
    expect(settled.snapshot).toMatchObject({ state: "closed", data: { result: { message: "Wallet disconnected." } } });
    expect(f.run(() => f.records.operation(String(card.snapshot.input.operationId)))).toMatchObject({ status: "completed", settlementPending: false });
  });

  it("rolls back disconnect admission before calling the wallet", async () => {
    const f = await fixture(), { connection } = await f.approve(), card = await f.createDisconnection();
    const db = new Database(join(f.directory, "activity.sqlite"));
    try {
      db.exec("CREATE TRIGGER reject_disconnect BEFORE INSERT ON wallet_connection_operations BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END");
      await expect(f.act(card, { action: "disconnect", connectionId: connection.connectionId })).rejects.toThrow("fixture storage failure");
      expect(f.run(() => f.cardRecords.get(card.snapshot.cardId))).toMatchObject({ state: { state: "ready", revision: card.snapshot.revision } });
      expect(f.run(() => f.records.pendingDisconnect(connection.connectionId))).toBeUndefined();
      expect(f.transport.disconnect).not.toHaveBeenCalled();
    } finally { db.exec("DROP TRIGGER reject_disconnect"); db.close(); }
  });

  it("recovers an interrupted disconnect without restoring or replaying that connection", async () => {
    const f = await fixture(), { connection } = await f.approve(), card = await f.createDisconnection();
    const pending = deferred<void>(); vi.mocked(f.transport.disconnect).mockImplementationOnce(() => pending.promise);
    await f.act(card, { action: "disconnect", connectionId: connection.connectionId }); f.workflow.stop();
    const disconnect = vi.fn();
    const runtime = new FixtureWalletRuntime({ ...f.transport, disconnect, restore: async () => [f.transport.session("fixture-topic")!] });
    const nextRecords = f.activity.createWalletWorkflowStore("replacement", f.now, () => runtime.snapshot());
    const next = new WalletWorkflow({ records: nextRecords, sessions: f.sessions,
      ownerId: "replacement", runtime,
      computation: f.computation, verifyReceipt: f.verifyReceipt, verifyNetwork: f.verifyNetwork, submitTransaction: f.submit,
      assertCurrent: f.access.assertCurrent, bindExternalEvent: (work) => f.access.bind(work), logger: f.logger, now: f.now });
    try {
      await f.run(() => next.start());
      expect(f.run(() => nextRecords.connection(connection.connectionId))).toMatchObject({ ownerId: "replacement", sdkPending: false,
        connection: { status: "failed", reason: expect.stringContaining("before the wallet operation") } });
      pending.resolve(); await new Promise((resolve) => setImmediate(resolve));
      expect(f.run(() => nextRecords.connection(connection.connectionId)?.connection.status)).toBe("failed");
      expect(disconnect).not.toHaveBeenCalled(); expect(f.transport.disconnect).toHaveBeenCalledOnce();
      expect(f.run(() => next.reconcileConnectionContext())).toMatchObject({ canDisconnect: true,
        connection: expect.objectContaining({ status: "failed" }), assetReadAccount: { status: "address_required" } });
    } finally { next.stop(); }
  });

  it("refuses local reset until a disconnect's SDK callback settles, then retains its journal without old card authority", async () => {
    const f = await fixture(), { connection } = await f.approve(), card = await f.createDisconnection();
    const pending = deferred<void>(); vi.mocked(f.transport.disconnect).mockImplementationOnce(() => pending.promise);
    await f.act(card, { action: "disconnect", connectionId: connection.connectionId });
    await expect(f.run(() => f.localData.resetLocalData())).rejects.toMatchObject({ details: { reason: "wallet_request_unsettled" } });
    pending.resolve(); await new Promise((resolve) => setImmediate(resolve));
    await vi.waitFor(() => expect(f.run(() => f.records.connection(connection.connectionId)?.sdkPending)).toBe(false));
    await f.run(() => f.localData.resetLocalData());
    expect(f.run(() => f.records.connections())).toMatchObject([{ connection: { connectionId: connection.connectionId, status: "disconnected" }, sdkPending: false }]);
    expect(f.run(() => f.cardRecords.get(card.snapshot.cardId))).toBeUndefined();
  });
});

describe("current data decisions settle request deadlines without a View", () => {
  it.each(["counts", "preview"] as const)("advances the deadline at %s while activity and export remain stored reads", async (consumer) => {
    const f = await fixture(), { connection } = await f.approve(), ready = await f.prepare(connection.connectionId);
    f.chainRead.mockRejectedValue(Object.assign(new Error("Not found"), { name: "TimeoutError" }));
    await f.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: ready.session.reviewRevision });
    await vi.waitFor(() => {
      const request = f.run(() => f.records.currentRequest(ready.session.id))!;
      expect(request.requestStatus).toBe("awaiting_chain_result");
      expect(f.run(() => f.records.authority(request.attemptId))).toMatchObject({ sdk_pending: 0, lookup_pending: 0 });
    });
    const before = f.run(() => f.records.currentRequest(ready.session.id))!;
    f.advance(599_999);
    expect((await f.run(() => f.localData.getDataCounts())).outcomeUnknownRequests).toBe(0);
    f.advance(1);
    const history = await f.run(() => f.activity.getReviewSessionDetail({ reviewSessionId: ready.session.id, account: f.account }));
    const backup = await f.run(() => f.localData.exportLocalData(f.now()));
    expect(history.request?.requestStatus).toBe("awaiting_chain_result");
    expect(f.run(() => f.records.request(before.attemptId))).toEqual(before);
    const counts = consumer === "counts" ? await f.run(() => f.localData.getDataCounts())
      : (await f.run(() => f.localData.previewImportLocalData(backup))).currentCounts;
    expect(counts.outcomeUnknownRequests).toBe(1); expect(counts.reviewExecutions).toBe(0);
    const after = f.run(() => f.records.request(before.attemptId))!;
    expect(after).toMatchObject({ requestStatus: "outcome_unknown", revision: before.revision + 1 });
    await f.run(() => f.localData.getDataCounts());
    const updated = await f.run(() => f.activity.getReviewSessionDetail({ reviewSessionId: ready.session.id, account: f.account }));
    expect(updated.request).toEqual(after);
    expect(updated.transitions.filter((row) => row.toStatus === "outcome_unknown")).toHaveLength(1);
    expect((await f.run(() => f.localData.exportLocalData(f.now()))).data.reviewRequests[0]?.request_status).toBe("outcome_unknown");
    expect(f.run(() => f.records.request(before.attemptId))).toEqual(after);
    expect(f.sign).toHaveBeenCalledOnce(); expect(f.submit).toHaveBeenCalledOnce(); expect(f.chainRead).toHaveBeenCalledOnce();
  });

  it("keeps data replacement blocked after signing expires while its callback is unsettled", async () => {
    const f = await fixture(), { connection } = await f.approve(), ready = await f.prepare(connection.connectionId);
    const pending = deferred<{ transactionBytes: string; signature: string }>(); f.sign.mockImplementationOnce(() => pending.promise);
    await f.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: ready.session.reviewRevision });
    const request = f.run(() => f.records.currentRequest(ready.session.id))!;
    f.advance(90_000);
    await f.run(() => f.localData.getDataCounts());
    expect(f.run(() => f.records.request(request.attemptId)?.requestStatus)).toBe("request_failed");
    await expect(f.run(() => f.localData.resetLocalData())).rejects.toMatchObject({ details: { reason: "wallet_request_unsettled" } });
    expect(f.run(() => f.records.authority(request.attemptId))).toMatchObject({ sdk_pending: 1, can_submit: 0 });
    pending.reject(new Error("Wallet dismissed"));
    await vi.waitFor(() => expect(f.run(() => f.records.authority(request.attemptId)?.sdk_pending)).toBe(0));
    expect(f.submit).not.toHaveBeenCalled();
  });

  it("retains an in-flight lookup after its deadline and records a later verified chain result", async () => {
    const f = await fixture(), { connection } = await f.approve(), ready = await f.prepare(connection.connectionId);
    const source = f.chainRead.getMockImplementation()!;
    const pending = deferred<Awaited<ReturnType<typeof f.chainRead>>>(); f.chainRead.mockImplementationOnce(() => pending.promise);
    await f.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: ready.session.reviewRevision });
    await vi.waitFor(() => expect(f.chainRead).toHaveBeenCalledOnce());
    const request = f.run(() => f.records.currentRequest(ready.session.id))!;
    f.advance(600_000);
    expect((await f.run(() => f.localData.getDataCounts())).outcomeUnknownRequests).toBe(1);
    expect(f.run(() => f.records.authority(request.attemptId)?.lookup_pending)).toBe(1);
    await expect(f.run(() => f.localData.resetLocalData())).rejects.toMatchObject({ details: { reason: "wallet_request_unsettled" } });
    pending.resolve(await source());
    await vi.waitFor(() => expect(f.run(() => f.records.request(request.attemptId)?.requestStatus)).toBe("completed"));
    expect((await f.run(() => f.localData.getDataCounts())).outcomeUnknownRequests).toBe(0);
    expect(f.run(() => f.records.request(request.attemptId)?.execution?.status)).toBe("success");
    expect(f.sign).toHaveBeenCalledOnce(); expect(f.submit).toHaveBeenCalledOnce(); expect(f.chainRead).toHaveBeenCalledOnce();
  });

  it.each(["reset", "import"] as const)("settles the deadline inside %s without a preceding counts/read call", async (operation) => {
    const f = await fixture(), { connection } = await f.approve(), ready = await f.prepare(connection.connectionId);
    const backup = await f.run(() => f.localData.exportLocalData(f.now()));
    f.chainRead.mockRejectedValue(Object.assign(new Error("Not found"), { name: "TimeoutError" }));
    await f.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: ready.session.reviewRevision });
    await vi.waitFor(() => {
      const request = f.run(() => f.records.currentRequest(ready.session.id))!;
      expect(request.requestStatus).toBe("awaiting_chain_result");
      expect(f.run(() => f.records.authority(request.attemptId))).toMatchObject({ sdk_pending: 0, lookup_pending: 0 });
    });
    const db = new Database(join(f.directory, "activity.sqlite"));
    // The deletion boundary must see the stored outcome, not just an elapsed timestamp.
    db.exec("CREATE TRIGGER require_expired_outcome BEFORE DELETE ON review_requests WHEN OLD.request_status!='outcome_unknown' BEGIN SELECT RAISE(ABORT,'unsettled stored outcome'); END");
    try {
      if (operation === "reset") { f.advance(600_000); await f.run(() => f.localData.resetLocalData()); }
      else {
        const entered = deferred<void>(), release = deferred<void>();
        const service = f.activity.createLocalDataService({ now: f.now, advanceRequestDeadlines: (now) => f.records.advanceRequestDeadlines(now),
          suiGrpcUrl: DEFAULT_SUI_GRPC_URL, suiGraphqlUrl: DEFAULT_SUI_GRAPHQL_URL,
          verifySuiGrpcUrl: async () => { entered.resolve(); await release.promise; }, verifySuiGraphqlUrl: async () => {} });
        const importing = f.run(() => service.importLocalDataReplace(backup));
        await entered.promise; f.advance(600_000); release.resolve(); await importing;
      }
      expect(f.run(() => f.records.currentRequest(ready.session.id))).toBeUndefined();
      expect(f.submit).toHaveBeenCalledOnce();
    } finally { db.exec("DROP TRIGGER require_expired_outcome"); db.close(); }
  });
});

// A failed wallet event disables that dependency without closing the DB owner.
// The source is restored immediately, so subsequent failures cannot be blamed
// on an injected source exception rather than the disabled wallet boundary.
function failWalletEvents(f: Awaited<ReturnType<typeof walletWorkflowFixture>>) {
  const source = vi.spyOn(f.transport, "inspectAll").mockImplementation(() => { throw new Error("PRIVATE-WALLET-STATE"); });
  try { f.notify(); } finally { source.mockRestore(); }
  expect(f.run(() => f.workflow.walletAvailability())).toMatchObject({ status: "unavailable", reason: "wallet_state_unavailable" });
}

it.each(["submission", "lookup"] as const)("records dispatched chain facts and settles callbacks after wallet failure during %s", async (phase) => {
  const f = await fixture(), { connection } = await f.approve(), ready = await f.prepare(connection.connectionId);
  const submit = deferred<{}>(), lookup = deferred<Awaited<ReturnType<typeof f.chainRead>>>();
  const source = f.chainRead.getMockImplementation()!;
  if (phase === "submission") f.submit.mockImplementationOnce(() => submit.promise);
  else f.chainRead.mockImplementationOnce(() => lookup.promise);
  await f.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: ready.session.reviewRevision });
  await vi.waitFor(() => expect(phase === "submission" ? f.submit : f.chainRead).toHaveBeenCalledOnce());
  const request = f.run(() => f.records.currentRequest(ready.session.id))!;
  failWalletEvents(f);
  const pendingField = phase === "submission" ? "submit_pending" : "lookup_pending";
  expect(f.run(() => f.records.authority(request.attemptId))?.[pendingField]).toBe(1);
  await expect(f.run(() => f.localData.resetLocalData())).rejects.toMatchObject({ details: { reason: "wallet_request_unsettled" } });
  if (phase === "submission") submit.resolve({}); else lookup.resolve(await source());
  await vi.waitFor(() => expect(f.run(() => f.records.request(request.attemptId))?.requestStatus).toBe("completed"));
  expect(f.run(() => f.records.authority(request.attemptId))).toMatchObject({ can_submit: 0, sdk_pending: 0, submit_pending: 0, lookup_pending: 0 });
  expect((await f.read(ready.card)).snapshot.data).toMatchObject({ observe: false,
    request: { attemptId: request.attemptId, transactionDigest: request.transactionDigest, execution: { status: "success" } } });
  await f.run(() => f.workflow.readReview(ready.session.id, true));
  expect(f.submit).toHaveBeenCalledOnce(); expect(f.sign).toHaveBeenCalledOnce(); expect(f.chainRead).toHaveBeenCalledOnce();
});

it("keeps snapshot readers pure while explicit current reads own request and review expiry", async () => {
  const f = await fixture(), { connection } = await f.approve(), ready = await f.prepare(connection.connectionId);
  const pending = deferred<{ transactionBytes: string; signature: string }>(); f.sign.mockImplementationOnce(() => pending.promise);
  await f.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: ready.session.reviewRevision });
  const stored = f.run(() => ({ session: f.sessions.readReviewSession(ready.session.id), request: f.records.currentRequest(ready.session.id) }));
  f.advance(90_000);
  expect(f.run(() => f.sessions.readReviewSession(ready.session.id))).toEqual(stored.session);
  expect(f.run(() => f.records.currentRequest(ready.session.id))).toEqual(stored.request);
  const current = await f.run(() => f.workflow.readReview(ready.session.id));
  expect(current?.request?.requestStatus).toBe("request_failed");
  expect(f.run(() => f.records.authority(stored.request!.attemptId))?.sdk_pending).toBe(1);
  pending.reject(new Error("Wallet dismissed"));
  await vi.waitFor(() => expect(f.run(() => f.records.authority(stored.request!.attemptId))?.sdk_pending).toBe(0));
  expect(f.submit).not.toHaveBeenCalled(); expect(f.chainRead).not.toHaveBeenCalled();
});

it("settles a disabled wallet's disconnect without claiming that the remote connection closed", async () => {
  const f = await fixture(), { connection } = await f.approve(), card = await f.createDisconnection();
  const pending = deferred<void>(); vi.mocked(f.transport.disconnect).mockImplementationOnce(() => pending.promise);
  const exit = f.holdWalletExit();
  await f.act(card, { action: "disconnect", connectionId: connection.connectionId }); failWalletEvents(f);
  const read = await f.read(card);
  expect(read.snapshot.data).toMatchObject({ progress: { status: "unavailable" }, observe: false, connection: { status: "connected" }, operation: { action: "disconnect", status: "running", settlementPending: true } });
  expect((await f.run(() => waitForWalletConnection(f.cards, card.snapshot.cardId))).waitOutcome).toBe("unavailable");
  expect(f.run(() => f.records.connection(connection.connectionId))?.sdkPending).toBe(true);
  exit(); pending.resolve();
  await vi.waitFor(() => expect(f.run(() => f.records.connection(connection.connectionId))?.sdkPending).toBe(false));
  expect((await f.read(card)).snapshot).toMatchObject({ state: "closed", data: { result: { message: "The wallet service ended before this operation was confirmed." }, observe: false } });
  expect(f.transport.disconnect).toHaveBeenCalledOnce(); expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});

it("does not release a pairing's pending guard before the SDK child actually exits", async () => {
  const f = await fixture(), card = await f.createConnection();
  const opening = deferred<Awaited<ReturnType<typeof f.transport.connect>>>(), approval = deferred<Awaited<Awaited<ReturnType<typeof f.transport.connect>>["approval"]>>();
  void approval.promise.catch(() => {}); // The SDK adapter also observes rejection immediately.
  f.connect.mockImplementationOnce(() => opening.promise);
  await f.act(card, { action: "connect" });
  const connectionId = f.run(() => f.records.cardOperation(f.cardRecords.get(card.snapshot.cardId)!)!.connectionId!);
  const exit = f.holdWalletExit();
  failWalletEvents(f);
  opening.resolve({ uri: "wc:fixture", expiresAt: new Date(f.now().getTime() + 300_000).toISOString(), approval: approval.promise });
  await new Promise((resolve) => setImmediate(resolve));
  expect(f.run(() => f.records.connection(connectionId))?.sdkPending).toBe(true);
  expect((await f.read(card)).walletDisplay).toBeUndefined();
  exit(); approval.reject(new Error("Approval closed"));
  await vi.waitFor(() => expect(f.run(() => f.records.connection(connectionId))?.sdkPending).toBe(false));
  expect((await f.read(card)).snapshot.data).toMatchObject({ result: { message: "The wallet service ended before this operation was confirmed." }, observe: false });
  expect(f.connect).toHaveBeenCalledOnce(); expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});

it("refuses submission if wallet state becomes unavailable during mainnet verification", async () => {
  const f = await fixture(), { connection } = await f.approve(), ready = await f.prepare(connection.connectionId);
  const verifying = deferred<void>(); f.verifyNetwork.mockImplementationOnce(() => verifying.promise);
  await f.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: ready.session.reviewRevision });
  await vi.waitFor(() => expect(f.verifyNetwork).toHaveBeenCalledOnce()); failWalletEvents(f);
  const request = f.run(() => f.records.currentRequest(ready.session.id))!;
  verifying.resolve();
  await vi.waitFor(() => expect(f.run(() => f.records.authority(request.attemptId))?.sdk_pending).toBe(0));
  expect(f.run(() => f.records.request(request.attemptId))?.requestStatus).toBe("request_failed");
  expect(f.run(() => f.records.request(request.attemptId))?.reason)
    .toBe("The wallet service stopped before submission. Nothing was submitted.");
  expect(f.submit).not.toHaveBeenCalled(); expect(f.chainRead).not.toHaveBeenCalled();
});



it("rejects expired connection use, preparation and signing while allowing explicit disconnection", async () => {
  const f = await fixture(), { connection } = await f.approve();
  // Only the connection expires at this fixture deadline; card, review and
  // material lifetimes remain valid to isolate the operation-specific rule.
  const expiresAt = new Date(f.now().getTime() + 1000).toISOString();
  f.notify({ topic: "fixture-topic", grants: suiGrants([f.account], ["sui_signTransaction"]), expiresAt });
  const ready = await f.prepare(connection.connectionId), card = await f.createDisconnection();
  const preparations = vi.mocked(f.sessions.recordWalletConnected).mock.calls.length;
  f.advance(1000);
  expect((await f.read(ready.card)).snapshot.data).toMatchObject({ review: { status: "ready_for_wallet_review" } });
  expect(f.run(() => f.records.connection(connection.connectionId))?.connection.status).toBe("connected");
  for (const action of ["prepare_review", "request_signature"]) {
    expect((await f.act(await f.read(ready.card), { action, connectionId: connection.connectionId,
      account: f.account, reviewRevision: ready.session.reviewRevision })).error)
      .toMatchObject({ code: "card_conflict" });
  }
  expect(vi.mocked(f.sessions.recordWalletConnected)).toHaveBeenCalledTimes(preparations);
  expect(f.run(() => f.records.currentRequest(ready.session.id))).toBeUndefined();
  expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
  expect((await f.act(await f.read(card), { action: "disconnect", connectionId: connection.connectionId })).error).toBeUndefined();
  await vi.waitFor(() => expect(f.run(() => f.records.connection(connection.connectionId))).toMatchObject({
    sdkPending: false, connection: { status: "disconnected" }
  }));
  expect(f.transport.disconnect).toHaveBeenCalledOnce();
  expect((await f.read(card)).snapshot.state).toBe("closed");
  expect((await f.read(card)).snapshot.data).toMatchObject({ result: { message: "Wallet disconnected." } });
});

it.each(["completed", "outcome_unknown"] as const)("does not reopen %s when the submission callback arrives late", async (outcome) => {
  const f = await fixture(), { connection } = await f.approve(), ready = await f.prepare(connection.connectionId);
  const submission = deferred<object>(); f.submit.mockImplementationOnce(() => submission.promise);
  await f.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: 1 });
  await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce());
  const request = f.run(() => f.records.currentRequest(ready.session.id))!;
  if (outcome === "completed") {
    const result = await f.run(() => f.workflow.readReview(ready.session.id, true));
    expect(result?.request).toMatchObject({ requestStatus: "completed", transactionDigest: request.transactionDigest });
  } else {
    f.advance(599_999);
    expect((await f.run(() => f.localData.getDataCounts())).outcomeUnknownRequests).toBe(0);
    expect(f.run(() => f.records.request(request.attemptId)?.requestStatus)).toBe("submitting");
    f.advance(1);
    expect((await f.run(() => f.localData.getDataCounts())).outcomeUnknownRequests).toBe(1);
  }
  expect(f.run(() => f.records.authority(request.attemptId))).toMatchObject({ submit_pending: 1, sdk_pending: 1 });
  await expect(f.run(() => f.localData.resetLocalData())).rejects.toMatchObject({ details: { reason: "wallet_request_unsettled" } });
  const stored = f.run(() => f.records.request(request.attemptId)), deadline = f.run(() => f.records.authority(request.attemptId)?.lookup_deadline);
  submission.resolve({});
  await vi.waitFor(() => expect(f.run(() => f.records.authority(request.attemptId))).toMatchObject({ sdk_pending: 0, submit_pending: 0 }));
  expect(f.run(() => f.records.request(request.attemptId))).toEqual(stored);
  expect(f.run(() => f.records.authority(request.attemptId)?.lookup_deadline)).toBe(deadline);
  expect(f.run(() => f.records.busyForAccount(f.account, f.now()))).toBe(false);
  expect(f.submit).toHaveBeenCalledOnce(); expect(f.sign).toHaveBeenCalledOnce();
});

it("retains known request identity after a chain-result write fails and recovers it by reading", async () => {
  const f = await fixture(), { connection } = await f.approve(), ready = await f.prepare(connection.connectionId);
  const db = new Database(join(f.directory, "activity.sqlite"));
  try {
    db.exec("CREATE TRIGGER reject_result BEFORE INSERT ON review_executions BEGIN SELECT RAISE(ABORT,'PRIVATE-RESULT'); END");
    await f.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: 1 });
    await vi.waitFor(() => expect(f.run(() => f.records.currentRequest(ready.session.id)?.requestStatus)).toBe("outcome_unknown"));
    const request = f.run(() => f.records.currentRequest(ready.session.id))!;
    expect(request.execution).toBeUndefined();
    db.exec("DROP TRIGGER reject_result");
    expect((await f.run(() => f.workflow.readReview(ready.session.id, true)))?.request)
      .toMatchObject({ requestStatus: "completed", execution: { txDigest: request.transactionDigest, status: "success" } });
    expect(f.submit).toHaveBeenCalledOnce(); expect(f.chainRead).toHaveBeenCalledTimes(2);
  } finally { db.exec("DROP TRIGGER IF EXISTS reject_result"); db.close(); }
});

it("keeps a failed callback-settlement write protected until its actual completion is saved, without replay", async () => {
  const f = await fixture(), { connection } = await f.approve(), ready = await f.prepare(connection.connectionId);
  const db = new Database(join(f.directory, "activity.sqlite"));
  try {
    db.exec("CREATE TRIGGER reject_settle BEFORE UPDATE OF submit_pending ON live_request_authority WHEN OLD.submit_pending=1 AND NEW.submit_pending=0 BEGIN SELECT RAISE(ABORT,'PRIVATE-SETTLE'); END");
    await f.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: 1 });
    await vi.waitFor(() => expect(f.logger.error).toHaveBeenCalledWith("Wallet operation failed", { stage: "callback_record" }));
    const request = f.run(() => f.records.currentRequest(ready.session.id))!;
    await expect(f.run(() => f.localData.resetLocalData())).rejects.toMatchObject({ details: { reason: "wallet_request_unsettled" } });
    db.exec("DROP TRIGGER reject_settle");
    expect((await f.run(() => f.workflow.readReview(ready.session.id, true)))?.request?.requestStatus).toBe("completed");
    expect(f.run(() => f.records.authority(request.attemptId))).toMatchObject({ submit_pending: 0, can_submit: 0 });
    expect(() => f.run(() => f.records.assertDataReplacementAllowed(f.now()))).not.toThrow();
    f.workflow.stop(); const next = f.activity.createWalletWorkflowStore("replacement", f.now);
    f.run(() => next.recover(f.now()));
    expect(f.run(() => next.request(request.attemptId)?.requestStatus)).toBe("completed");
    expect(f.run(() => next.authority(request.attemptId))).toMatchObject({ submit_pending: 0, can_submit: 0 });
    expect(f.submit).toHaveBeenCalledOnce();
  } finally { db.exec("DROP TRIGGER IF EXISTS reject_settle"); db.close(); }
});

it("preserves a backend connection-expiry reason after signature verification", async () => {
  const f = await fixture(), { connection } = await f.approve();
  // A short synthetic connection lifetime isolates this guard from the longer
  // signing, review and quote deadlines; it is not a product timeout.
  f.notify({ topic: "fixture-topic", grants: suiGrants([f.account], ["sui_signTransaction"]), expiresAt: new Date(f.now().getTime() + 1000).toISOString() });
  const ready = await f.prepare(connection.connectionId);
  f.verifyNetwork.mockImplementationOnce(async () => { f.advance(1000); });
  await f.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: 1 });
  await vi.waitFor(() => expect(f.run(() => f.records.currentRequest(ready.session.id)?.requestStatus)).toBe("request_failed"));
  expect(f.run(() => f.records.currentRequest(ready.session.id)?.reason)).toBe("The selected Sui wallet connection is unavailable.");
  expect(f.submit).not.toHaveBeenCalled(); expect(f.sign).toHaveBeenCalledOnce();
});


it("carries address-funded material through SQLite admission, real signature verification and one submission", async () => {
  const f = await walletWorkflowFixture({ addressBalance: true }); fixtures.push(f);
  const { connection } = await f.approve(); const ready = await f.prepare(connection.connectionId);
  expect(ready.session.reviewState?.humanReadableReview?.evidenceUsed).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "transaction_funding", summary: expect.stringContaining("SUI address balance") })
  ]));
  const input = { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: ready.session.reviewRevision };
  expect((await f.act(ready.card, input)).error).toBeUndefined();
  await f.act(ready.card, input);
  await vi.waitFor(() => expect(f.run(() => f.records.currentRequest(ready.session.id)?.requestStatus)).toBe("completed"));
  expect(f.sign).toHaveBeenCalledOnce(); expect(f.submit).toHaveBeenCalledOnce();
  expect(f.run(() => f.records.currentRequest(ready.session.id)?.execution?.status)).toBe("success");
});

it("separates connection and disconnection purposes without intent aliases", async () => {
  const f = await fixture();
  await expect(f.run(() => f.cards.create("connect", { intent: "manage" }))).rejects.toThrow();
  await expect(f.createDisconnection()).rejects.toMatchObject({ reason: "no_session_to_disconnect" });
  expect(f.connect).not.toHaveBeenCalled();
  const approved = await f.approve(), disconnect = await f.createDisconnection();
  expect(disconnect.snapshot.data).toMatchObject({ kind: "disconnect", allowedActions: ["cancel", "disconnect"] });
  expect(disconnect.snapshot.data).not.toHaveProperty("automaticAction");
  expect(approved.card.snapshot.state).toBe("closed");
  expect((await f.act(approved.card, f.run(() => f.records.operation(String(approved.card.snapshot.input.operationId))!.input))).error).toBeUndefined();
  expect((await f.act(approved.card, { action: "disconnect", connectionId: approved.connection.connectionId })).error).toBeDefined();
  expect(f.connect).toHaveBeenCalledOnce(); expect(f.transport.disconnect).not.toHaveBeenCalled(); expect(f.sign).not.toHaveBeenCalled();
});

it("admits one preparation across competing cards and never renews a managed attempt", async () => {
  const f = await fixture(), { connection } = await f.approve();
  const session = await f.run(() => f.sessions.createReviewSession([f.plan], f.now()));
  const first = await f.run(() => f.cards.create("review", f.reviewInput(session.session.id)));
  const second = await f.run(() => f.cards.create("review", f.reviewInput(session.session.id)));
  const action = { action: "prepare_review", connectionId: connection.connectionId, account: f.account, reviewRevision: 0 };
  expect(first.snapshot.data).toMatchObject({ automaticAction: action });
  expect(second.snapshot.data).toMatchObject({ automaticAction: action });
  const pending = deferred<void>(), source = f.quote.getMockImplementation()!;
  f.quote.mockImplementationOnce(async () => { await pending.promise; return source(); });
  await Promise.all([f.act(first, action), f.act(second, action)]);
  await vi.waitFor(() => expect(f.quote).toHaveBeenCalledOnce());
  pending.resolve();
  await vi.waitFor(async () => expect((await f.read(first)).snapshot.data).toMatchObject({ review: { status: "ready_for_wallet_review" } }));
  const current = await f.read(first);
  await f.act({ ...first, ...current }, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: 1 });
  await vi.waitFor(() => expect(f.run(() => f.records.currentRequest(session.session.id)?.requestStatus)).toBe("completed"));
  const attempt = f.run(() => f.records.currentRequest(session.session.id))!;
  const managed = await f.run(() => f.cards.create("review", { reviewSessionId: session.session.id, attemptId: attempt.attemptId, mode: "manage" }));
  expect(managed.snapshot.data).not.toHaveProperty("automaticAction");
  f.advance(31_000);
  expect((await f.read(managed)).snapshot.data).not.toHaveProperty("automaticAction");
  expect(f.quote).toHaveBeenCalledOnce(); expect(f.sign).toHaveBeenCalledOnce(); expect(f.submit).toHaveBeenCalledOnce();
});

it("admits only one pairing across different cards with current revisions", async () => {
  const f = await fixture(), pending = deferred<Awaited<ReturnType<typeof f.transport.connect>>>();
  f.connect.mockImplementation(() => pending.promise);
  const first = await f.createConnection(), second = await f.createConnection();
  for (const card of [first, second]) expect(card.snapshot.data).toMatchObject({ automaticAction: { action: "connect" } });
  const responses = await Promise.all([f.act(first, { action: "connect" }), f.act(second, { action: "connect" })]);
  expect(responses.filter((response) => !response.error)).toHaveLength(1);
  const refused = responses.find((response) => response.error)!;
  const loser = [first, second].find((card) => card.snapshot.cardId === refused.snapshot.cardId)!;
  const winner = [first, second].find((card) => card !== loser)!;
  expect(refused.error?.code).toBe("card_conflict");
  expect(refused.snapshot.state).toBe("closed");
  // Admission publishes the changed owner-wide choices before a QR response.
  expect(refused.snapshot.revision).toBeGreaterThan(loser.snapshot.revision);
  expect(refused.snapshot.data).not.toHaveProperty("automaticAction");
  expect((refused.snapshot.data as { allowedActions: string[] }).allowedActions).not.toContain("connect");
  expect(f.run(() => f.cardRecords.get(refused.snapshot.cardId))?.acceptedInput).toBeUndefined();
  expect(f.run(() => f.records.connections()).map((row) => row.connection.status)).toEqual(["awaiting_approval"]);
  expect(f.connect).toHaveBeenCalledOnce();
  // A refreshed revision still cannot bypass the owner-wide connection rule.
  expect((await f.act(await f.read(loser), { action: "connect" })).error?.code).toBe("card_conflict");
  await f.act(winner, { action: "connect" });
  expect(f.connect).toHaveBeenCalledOnce(); expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});

it.each(["connected", "disconnect_pending"] as const)("refuses another pairing while %s", async (status) => {
  const f = await fixture(), { connection } = await f.approve();
  if (status === "disconnect_pending") {
    vi.mocked(f.transport.disconnect).mockImplementation(() => new Promise(() => {}));
    const disconnect = await f.createDisconnection();
    expect((await f.act(disconnect, { action: "disconnect", connectionId: connection.connectionId })).error).toBeUndefined();
  }
  const card = await f.createConnection(), before = f.run(() => f.records.currentConnection());
  expect((card.snapshot.data as { allowedActions: string[] }).allowedActions).not.toContain("connect");
  expect(card.snapshot.data).not.toHaveProperty("automaticAction");
  expect((await f.act(card, { action: "connect" })).error?.code).toBe("card_conflict");
  expect(f.run(() => f.records.currentConnection())).toEqual(before);
  expect(f.connect).toHaveBeenCalledOnce(); expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});

it("rolls back both the connection and card before an unsuccessful pairing admission", async () => {
  const f = await fixture(), card = await f.createConnection(), db = new Database(join(f.directory, "activity.sqlite"));
  try {
    db.exec("CREATE TRIGGER reject_pairing_card BEFORE UPDATE ON live_read_cards BEGIN SELECT RAISE(ABORT,'fixture card write failed'); END");
    await expect(f.act(card, { action: "connect" })).rejects.toThrow("fixture card write failed");
    expect(f.run(() => f.records.connections())).toEqual([]);
    expect(f.run(() => f.cardRecords.get(card.snapshot.cardId))).toMatchObject({ state: { state: "ready", revision: card.snapshot.revision } });
    expect(f.run(() => f.cardRecords.get(card.snapshot.cardId))?.acceptedInput).toBeUndefined();
    expect(f.connect).not.toHaveBeenCalled();
  } finally { db.exec("DROP TRIGGER reject_pairing_card"); db.close(); }
});

it.each(["disconnected", "failed", "rejected", "stopped", "expired", "previous_owner"] as const)("does not turn %s history into a permanent pairing lock", async (status) => {
  const f = await fixture();
  // An independently stored historical session is not a new pairing admission.
  const saved = f.run(() => f.seedConnection({ topic: "historical-fixture", grants: suiGrants([f.account], ["sui_signTransaction"]), expiresAt: new Date(f.now().getTime() + 60_000).toISOString() }));
  if (status === "previous_owner") {
    const db = new Database(join(f.directory, "activity.sqlite"));
    try { db.prepare("UPDATE live_wallet_connections SET owner_id=? WHERE id=?").run("previous-owner", saved.connection.connectionId); } finally { db.close(); }
  } else f.run(() => f.records.updateConnection(saved.connection.connectionId, { status }, f.now()));
  if (status === "previous_owner") f.run(() => f.records.applyWalletObservation(f.runtime.snapshot()!, undefined, true));
  const card = await f.createConnection();
  expect(workflowViewSchema.parse(card.snapshot.data).allowedActions).toContain("connect");
  expect((await f.act(card, { action: "connect" })).error).toBeUndefined();
  expect(f.connect).toHaveBeenCalledOnce(); expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});



it("retains a failed disconnect result while requiring a new scoped disconnect for its SDK session", async () => {
  const f = await fixture(), { connection } = await f.approve();
  const failed = await f.run(() => f.cards.create("disconnect", {}));
  vi.mocked(f.transport.disconnect).mockRejectedValueOnce(new Error("Synthetic relay response failure"));
  const command = f.connectionInput(failed, { action: "disconnect", connectionId: connection.connectionId });
  await f.act(failed, command);
  await vi.waitFor(() => expect(f.run(() => f.records.connection(connection.connectionId))).toMatchObject({ sdkPending: false, connection: { status: "failed" } }));
  expect(f.transport.session("fixture-topic")).toBeDefined();
  const saved = (await f.read(failed)).snapshot.data;
  const manage = await f.createDisconnection();
  expect(manage.snapshot.data).toMatchObject({ allowedActions: ["cancel", "disconnect"] });
  expect(f.run(() => f.workflow.currentConnectionContext())).toMatchObject({ canDisconnect: true, assetReadAccount: { status: "address_required" } });
  expect((await f.act(manage, { action: "connect", chains: ["sui:mainnet"] })).error?.code).toBe("card_conflict");
  // An identical consumed input returns its saved result; it cannot retry I/O.
  expect((await f.act(failed, command)).snapshot.data).toEqual(saved);
  expect(f.transport.disconnect).toHaveBeenCalledOnce();
  await f.act(await f.read(manage), { action: "disconnect", connectionId: connection.connectionId });
  await vi.waitFor(() => expect(f.run(() => f.records.connection(connection.connectionId)?.connection.status)).toBe("disconnected"));
  expect((await f.read(failed)).snapshot.data).toEqual(saved);
  const empty = await f.run(() => f.cards.create("connect", {}));
  expect(empty.snapshot.data).toMatchObject({ allowedActions: ["cancel", "connect"] });
  expect(f.connect).toHaveBeenCalledOnce(); expect(f.transport.disconnect).toHaveBeenCalledTimes(2); expect(f.submit).not.toHaveBeenCalled();
});

it("does not turn an unrecorded SDK session into authority or invalidate an independent admission", async () => {
  const f = await fixture(), { connection } = await f.approve(), ready = await f.prepare(connection.connectionId);
  const original = f.transport.session("fixture-topic")!;
  const unknown = { ...original, topic: "unrecorded-sdk-session" };
  f.verifyNetwork.mockImplementationOnce(async () => {
    vi.spyOn(f.transport, "inspectAll").mockImplementation(() => [original, unknown].map((session) => ({ topic: session.topic, status: "present" as const, session })));
    f.observe();
  });
  await f.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: ready.session.reviewRevision });
  await vi.waitFor(() => expect(f.run(() => f.records.currentRequest(ready.session.id)?.requestStatus)).toBe("completed"));
  const request = f.run(() => f.records.currentRequest(ready.session.id))!;
  expect(f.run(() => f.records.authority(request.attemptId)?.can_submit)).toBe(0);
  const context = f.run(() => f.workflow.reconcileConnectionContext());
  expect(context).toMatchObject({ walletAvailability: { status: "available" }, connectionReconciliationRequired: true,
    canDisconnect: true, assetReadAccount: { status: "available", account: f.account } });

  expect(JSON.stringify(context)).not.toContain("unrecorded-sdk-session");
  const card = await f.run(() => f.cards.create("connect", {}));
  expect(card.snapshot.data).toMatchObject({ allowedActions: [], observe: false });
  expect(f.run(() => f.workflow.currentConnectionContext()).connectionReconciliationRequired).toBe(true);
  await expect(f.createDisconnection()).rejects.toMatchObject({ reason: "connection_state_unconfirmed" });
  expect((await f.act(card, { action: "connect" })).error?.code).toBe("card_conflict");
  expect(f.sign).toHaveBeenCalledOnce(); expect(f.submit).toHaveBeenCalledOnce(); expect(f.connect).toHaveBeenCalledOnce();
});

it("keeps ordinary approval registration pending without declaring an unrecorded SDK session a recovery failure", async () => {
  const f = await fixture(), card = await f.createConnection();
  await f.act(card, { action: "connect" });
  await vi.waitFor(() => expect(f.connect).toHaveBeenCalledOnce());
  const session = { topic: "not-yet-registered", grants: suiGrants([f.account], ["sui_signTransaction"]), expiresAt: new Date(f.now().getTime() + 60_000).toISOString() };
  vi.spyOn(f.transport, "inspectAll").mockReturnValue([{ topic: session.topic, status: "present", session }]);
  f.observe();
  const context = f.run(() => f.workflow.reconcileConnectionContext());
  expect(context.connectionReconciliationRequired).toBeUndefined();
  const management = await f.run(() => f.cards.create("connect", {}));
  expect(management.snapshot.data).toMatchObject({ allowedActions: [], observe: false });
  expect(f.run(() => f.workflow.currentConnectionContext()).assetReadAccount).toEqual({ status: "address_required" });
  expect((await f.act(management, { action: "connect" })).error?.code).toBe("card_conflict");
  f.approval.resolve(session);
  await vi.waitFor(() => expect(f.run(() => f.records.readConnectionFacts(f.now()).connection?.status)).toBe("connected"));
  expect(f.run(() => f.workflow.reconcileConnectionContext()).connectionReconciliationRequired).toBeUndefined();
  expect(f.connect).toHaveBeenCalledOnce();
});
