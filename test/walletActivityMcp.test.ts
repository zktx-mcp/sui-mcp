import { FixtureWalletRuntime } from "./fixtures/walletRuntime.js";
import Database from "better-sqlite3";
import { join } from "node:path";
import { WalletWorkflow } from "../src/core/session/walletWorkflow.js";
import { CardStore } from "../src/core/session/cardSessionStore.js";
import { receiptForCard } from "../src/mcp-ui/view/receiptData.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { registerReadCards } from "../src/mcp-ui/tools.js";
import { registerSessionTools } from "../src/mcp/tools/session/index.js";
import { registerActionTools } from "../src/mcp/tools/action/prepareSuiActionReview.js";
import { registerReviewActivityListTool, registerReviewActivitySummaryTools } from "../src/mcp/tools/read/reviewActivityTools.js";
import type { McpServerDeps } from "../src/mcp/server.js";
import { TOOL_NAMES } from "../src/mcp/toolNames.js";
import { CARD_TOOLS, CARD_METADATA_KEY, CARD_DISPLAY_METADATA_KEY, cardReceiptDisplaySchema, WALLET_DISPLAY_METADATA_KEY, CARD_RESOURCE_PREFIX, cardReferenceSchema, cardSnapshotSchema } from "../src/mcp-ui/contracts.js";
import { walletWorkflowFixture, deferred } from "./fixtures/walletWorkflow.js";
import { findForbiddenMcpFields } from "../src/core/action/forbiddenFields.js";
import { DEFAULT_SUI_GRPC_URL, DEFAULT_SUI_GRAPHQL_URL } from "../src/runtime/config.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function harness(ui = true, receiptDetails = false, accountReader?: NonNullable<Parameters<typeof walletWorkflowFixture>[0]>["accountReader"]) {
  const f = await walletWorkflowFixture({ receiptDetails, ...(accountReader ? { accountReader } : {}) }), server = new McpServer({ name: "wallet-flow-fixture", version: "1" });
  // These registrations consume only the real stores/workflow below; no read
  // service or unrelated protocol dependency is replaced as part of the check.
  const deps = { sessions: f.sessions, activityStore: f.activity, cards: { store: f.cards }, workflow: f.workflow, logger: f.logger } as unknown as McpServerDeps;
  registerReadCards(server, deps); registerSessionTools(server, deps); registerActionTools(server, deps);
  registerReviewActivityListTool(server, deps); registerReviewActivitySummaryTools(server, deps);
  const client = new Client({ name: "wallet-flow-client", version: "1" }, { capabilities: ui ? { extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } } } : {} });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  cleanups.push(async () => { await client.close(); await server.close(); f.close(); });
  const call = (name: string, input: Record<string, unknown> = {}) => f.run(() => client.callTool({ name, arguments: input }));
  return { f, client, call, deps };
}
function data(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, any> {
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  const payload = result.structuredContent as { ok: boolean; data: Record<string, any> }; expect(payload.ok).toBe(true); return payload.data;
}

it("carries the same connection conflict through actual MCP schemas, card resources, waits and review status", async () => {
  const { f, client, call } = await harness();
  const sessions = ["first", "second"].map((topic) => ({ topic, accounts: [f.account], methods: ["sui_signTransaction"],
    chain: "sui:mainnet" as const, expiresAt: new Date(f.now().getTime() + 60000).toISOString() }));
  const connections = sessions.map((session) => f.run(() => f.records.restoreConnection(session, f.now())).connection);
  vi.spyOn(f.transport, "session").mockImplementation((topic) => sessions.find((session) => session.topic === topic));
  vi.spyOn(f.transport, "inspectAll").mockImplementation(() => sessions.map((session) => ({ topic: session.topic, status: "present", session })));
  f.observe();
  const expected = { reason: "multiple_connections", connectionIds: connections.map((item) => item.connectionId).sort() };
  const created = await call(TOOL_NAMES.sessionOpenWalletConnectionCard, { intent: "manage" }), card = data(created);
  const ref = cardReferenceSchema.parse(created._meta?.[CARD_METADATA_KEY]);
  const responses = [created, await call(TOOL_NAMES.sessionGetWalletConnectionCard, { cardId: card.cardId }),
    await call(TOOL_NAMES.sessionWaitWalletConnectionCard, { cardId: card.cardId })];
  for (const response of responses) {
    const payload = data(response), snapshot = payload.card ?? payload;
    expect(snapshot.data.connectionConflict).toEqual(expected);
    expect(snapshot.data.walletAvailability.status).toBe("available");
    expect(snapshot.data.allowedActions).toContain("disconnect");
    expect(snapshot.data.allowedActions).not.toContain("use_account");
    expect(snapshot.data.usableConnectionId).toBeUndefined();
    expect(snapshot.data.assetReadAccount).toEqual({ status: "address_required" });
    expect(JSON.parse((response.content as { text: string }[])[0]!.text)).toEqual(response.structuredContent);
    expect(findForbiddenMcpFields(response.structuredContent)).toEqual([]);
  }
  const saved = await f.run(() => client.readResource({ uri: CARD_RESOURCE_PREFIX + card.cardId }));
  expect(JSON.parse((saved.contents[0] as { text: string }).text).data.connectionConflict).toEqual(expected);
  const overview = data(await call(TOOL_NAMES.sessionGetInteractionStatus));
  expect(overview.connectionConflict).toEqual(expected); expect(overview.assetReadAccount.status).toBe("address_required");
  expect(overview.userAnswerUse.answerFields).toContain("connectionConflict");
  expect(overview.userAnswerUse.cannotAnswer).toContain("sdk_availability_or_recorded_connection_as_account_use_or_signing_authority");
  const { session } = await f.run(() => f.sessions.createReviewSession([f.plan], f.now()));
  expect(data(await call(TOOL_NAMES.sessionGetReviewStatus, { reviewSessionId: session.id })).connectionConflict).toEqual(expected);
  const tools = await client.listTools();
  expect(JSON.stringify(tools.tools.find((tool) => tool.name === TOOL_NAMES.sessionGetInteractionStatus)?.outputSchema)).toContain('"connectionConflict"');
  const refused = await call(CARD_TOOLS.act, { ...ref, revision: card.revision, input: { action: "restart_wallet_service", walletRunId: f.runtime.runId } });
  expect(refused.isError).toBe(true);
  expect(f.connect).not.toHaveBeenCalled(); expect(f.transport.disconnect).not.toHaveBeenCalled(); expect(f.sign).not.toHaveBeenCalled();
});

it("publishes the same source-qualified default in MCP views, waits and saved data", async () => {
  const { f, client, call } = await harness(), { connection } = await f.approve();
  await f.run(() => f.activity.setActiveAccount(f.account, "wallet_connection", f.now(), { id: "different-saved-source" }));
  const created = await call(TOOL_NAMES.sessionOpenWalletConnectionCard, { intent: "manage" }), card = data(created);
  for (const response of [created, await call(TOOL_NAMES.sessionGetWalletConnectionCard, { cardId: card.cardId }),
    await call(TOOL_NAMES.sessionWaitWalletConnectionCard, { cardId: card.cardId })]) {
    const value = data(response), snapshot = value.card ?? value;
    expect(snapshot.data).toMatchObject({ activeAccount: f.account, usableConnectionId: connection.connectionId, assetReadAccount: { status: "address_required" } });
    expect(findForbiddenMcpFields(response.structuredContent)).toEqual([]);
    expect(JSON.parse((response.content as { text: string }[])[0]!.text)).toEqual(response.structuredContent);
  }
  const saved = await f.run(() => client.readResource({ uri: CARD_RESOURCE_PREFIX + card.cardId }));
  expect(JSON.parse((saved.contents[0] as { text: string }).text).data.assetReadAccount).toEqual({ status: "address_required" });
  expect(data(await call(TOOL_NAMES.sessionGetInteractionStatus)).assetReadAccount).toEqual({ status: "address_required" });
  expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});

describe("wallet cards, ordinary MCP and stored review activity", () => {
  it("keeps ordinary preparation reads available with an initialization reason when the workflow is absent", async () => {
    const { f, call, deps } = await harness();
    const { session } = await f.run(() => f.sessions.createReviewSession([f.plan]));
    f.workflow.stop(); delete deps.workflow;
    for (const name of [TOOL_NAMES.sessionGetReviewStatus, TOOL_NAMES.sessionGetExecutionResult, TOOL_NAMES.sessionWaitExecutionResult]) {
      const result = data(await call(name, { reviewSessionId: session.id }));
      expect(result).toMatchObject({ reviewSessionId: session.id, status: "proposed", plans: [f.plan],
        walletAvailability: { status: "unavailable", reason: "initialization_failed" } });
    }
    expect(data(await call(TOOL_NAMES.sessionGetInteractionStatus))).toMatchObject({
      walletAvailability: { status: "unavailable", reason: "initialization_failed" }
    });
    expect(f.connect).not.toHaveBeenCalled(); expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
  });

  it("rejects a removed protocol before creating a review or requesting a signature", async () => {
    const { f, call } = await harness();
    await f.approve();
    const before = f.run(() => f.sessions.reviewSessionIds());
    const result = await call(TOOL_NAMES.actionStartReview, { intent: {
      type: "swap", protocol: "flowx", from: { symbol: "SUI", amount: "1" },
      to: { symbol: "USDC" }, maxSlippageBps: 50
    } });
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toMatchObject({
      ok: false, error: { kind: "input_invalid", details: {
        reason: "unknown_protocol", protocol: "flowx", availableProtocols: ["deep"]
      } }
    });
    expect(f.run(() => f.sessions.reviewSessionIds())).toEqual(before);
    expect(f.sign).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });

  it("reports the same pending disconnect through card, get, wait and interaction tools", async () => {
    const { f, call } = await harness(), { connection } = await f.approve();
    const pending = deferred<void>(); vi.mocked(f.transport.disconnect).mockImplementationOnce(() => pending.promise);
    const created = await call(TOOL_NAMES.sessionOpenWalletConnectionCard), snapshot = cardSnapshotSchema.parse(data(created));
    const ref = cardReferenceSchema.parse(created._meta?.[CARD_METADATA_KEY]);
    const admitted = data(await call(CARD_TOOLS.act, { ...ref, revision: snapshot.revision, input: { action: "disconnect", walletRunId: f.runtime.runId, connectionId: connection.connectionId } }));
    expect(admitted).toMatchObject({ state: "running", data: { observe: true, connection: { pendingAction: "disconnect", status: "connected" } } });
    expect(admitted.data).toMatchObject({ connectionAction: "disconnect" });
    for (const snapshot of [admitted, data(await call(TOOL_NAMES.sessionGetWalletConnectionCard, { cardId: ref.cardId })),
      data(await call(TOOL_NAMES.sessionWaitWalletConnectionCard, { cardId: ref.cardId, timeoutMs: 1 })).card]) {
      expect(snapshot.data).not.toHaveProperty("walletRecoveryGuidance");
    }
    const overview = data(await call(TOOL_NAMES.sessionGetInteractionStatus));
    expect(overview).not.toHaveProperty("walletRecoveryGuidance");
    expect(overview.userAnswerUse.followUp.tool).toBe(TOOL_NAMES.sessionGetReviewStatus);

    expect(data(await call(TOOL_NAMES.sessionGetWalletConnectionCard, { cardId: ref.cardId })).data.observe).toBe(true);
    expect(data(await call(TOOL_NAMES.sessionWaitWalletConnectionCard, { cardId: ref.cardId, timeoutMs: 1 })).waitOutcome).toBe("timed_out");
    expect(data(await call(TOOL_NAMES.sessionGetInteractionStatus)).pendingWalletConnections.items)
      .toContainEqual(expect.objectContaining({ cardId: ref.cardId, connectionId: connection.connectionId, status: "disconnect_pending" }));
    pending.resolve();
    await vi.waitFor(() => expect(f.run(() => f.records.connection(connection.connectionId)?.sdkPending)).toBe(false));
    const final = data(await call(TOOL_NAMES.sessionGetWalletConnectionCard, { cardId: ref.cardId }));
    expect(final).toMatchObject({ state: "closed", data: { observe: false, connection: { status: "disconnected" } } });
    expect(findForbiddenMcpFields(final)).toEqual([]); expect(f.transport.disconnect).toHaveBeenCalledOnce();
  });
  it("keeps UI permission and the same pairing out of ordinary get/wait/saved results", async () => {
    const { f, client, call } = await harness();
    const created = await call(TOOL_NAMES.sessionOpenWalletConnectionCard, { intent: "connect" }), ready = cardSnapshotSchema.parse(data(created));
    const ref = cardReferenceSchema.parse(created._meta?.[CARD_METADATA_KEY]);
    expect(f.connect).not.toHaveBeenCalled();
    expect((ready.data as { boundary: string }).boundary).toContain("not a transaction approval");
    expect((ready.data as { boundary: string }).boundary).toContain("not a transaction approval or proof of address ownership");
    const action = await call(CARD_TOOLS.act, { ...ref, revision: ready.revision, input: { action: "connect", walletRunId: f.runtime.runId } }); data(action);
    const read = await call(CARD_TOOLS.read, ref); const privateDisplay = read._meta?.[WALLET_DISPLAY_METADATA_KEY];
    expect(privateDisplay).toMatchObject({ cardId: ref.cardId, pairingUri: expect.stringContaining("symKey=") });
    expect((await call(CARD_TOOLS.read, ref))._meta?.[WALLET_DISPLAY_METADATA_KEY]).toEqual(privateDisplay);
    const get = await call(TOOL_NAMES.sessionGetWalletConnectionCard, { cardId: ref.cardId });
    const wait = await call(TOOL_NAMES.sessionWaitWalletConnectionCard, { cardId: ref.cardId, timeoutMs: 1 });
    const saved = await f.run(() => client.readResource({ uri: CARD_RESOURCE_PREFIX + ref.cardId }));
    const publicText = JSON.stringify({ get, wait, saved, content: read.content, structuredContent: read.structuredContent });
    for (const forbidden of [ref.permission, "symKey", "wc:fixture"]) expect(publicText).not.toContain(forbidden);
    expect(f.connect).toHaveBeenCalledOnce();
    const wrong = await call(CARD_TOOLS.read, { ...ref, permission: "wrong" });
    expect(wrong.isError).toBe(true); expect(wrong._meta).toBeUndefined();
  });

  it("refuses workflow creation for clients without a card surface without creating an operation", async () => {
    const { f, call } = await harness(false);
    expect((await call(TOOL_NAMES.sessionOpenWalletConnectionCard)).isError).toBe(true);
    expect(f.run(() => f.records.connections())).toEqual([]); expect(f.connect).not.toHaveBeenCalled();
  });

  it("counts six independent reviews by request and chain outcome, and preserves public history through backup", async () => {
    const { f, call } = await harness(); const { connection } = await f.approve();
    const ids: string[] = [];
    for (const outcome of ["request_failed", "stopped", "outcome_unknown", "success", "failure", "unsubmitted"] as const) {
      f.advance(1000); const ready = await f.prepare(connection.connectionId); ids.push(ready.session.id);
      if (outcome === "unsubmitted") continue;
      const originalSign = f.sign.getMockImplementation()!, originalChain = f.chainRead.getMockImplementation()!;
      const held = deferred<{ transactionBytes: string; signature: string }>();
      if (outcome === "request_failed") f.sign.mockRejectedValueOnce(new Error("User rejected"));
      if (outcome === "stopped") f.sign.mockImplementationOnce(() => held.promise);
      if (outcome === "outcome_unknown") f.chainRead.mockRejectedValue(Object.assign(new Error("No receipt yet"), { name: "TimeoutError" }));
      f.setChainOutcome(outcome === "failure" ? "failure" : "success");
      await f.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: ready.session.reviewRevision });
      if (outcome === "stopped") { await f.act(await f.read(ready.card), { action: "stop_waiting" }); held.reject(new Error("Dismissed after stop")); }
      if (outcome === "outcome_unknown") {
        await vi.waitFor(() => expect(f.run(() => f.records.currentRequest(ready.session.id)?.requestStatus)).toBe("awaiting_chain_result"));
        f.advance(10 * 60 * 1000); await f.read(ready.card);
      }
      const status = outcome === "success" || outcome === "failure" ? "completed" : outcome;
      await vi.waitFor(() => {
        const request = f.run(() => f.records.currentRequest(ready.session.id))!;
        expect(request.requestStatus).toBe(status);
        expect(f.run(() => f.records.authority(request.attemptId)?.sdk_pending)).toBe(0);
        expect(f.run(() => f.records.authority(request.attemptId)?.lookup_pending)).toBe(0);
      });
      f.sign.mockImplementation(originalSign); f.chainRead.mockImplementation(originalChain);
    }
    const summary = data(await call(TOOL_NAMES.readSummarizeReviewFunnel, { account: f.account }));
    expect(summary.summary).toMatchObject({ total: 6, withoutRequest: 1, withoutExecutionResult: 4,
      requestStatusCounts: [
        { requestStatus: "awaiting_signature", count: 0 }, { requestStatus: "submitting", count: 0 }, { requestStatus: "awaiting_chain_result", count: 0 },
        { requestStatus: "stopped", count: 1 }, { requestStatus: "request_failed", count: 1 }, { requestStatus: "outcome_unknown", count: 1 }, { requestStatus: "completed", count: 2 } ],
      executionStatusCounts: { success: 1, failure: 1 }, opened: 6, walletConnected: 6, stateComputed: 6, everAwaitedChainResult: 3 });
    expect(summary.summary.avgCreatedToSignatureVerifiedSeconds).toBe(0);
    expect(summary.summary.avgOpenedToSignatureVerifiedSeconds).toBe(0);
    const filtered = data(await call(TOOL_NAMES.readListReviewActivity, { account: f.account, requestStatus: "completed", executionStatus: "failure", limit: 1 }));
    expect(filtered.activities).toHaveLength(1); expect(filtered.activities[0].reviewSessionId).toBe(ids[4]);
    const limited = data(await call(TOOL_NAMES.readListReviewActivity, { account: f.account, limit: 2 }));
    expect(limited.dataScope.recordCount).toBe(6); expect(limited.truncated.activities).toBe(true);
    const rejected = data(await call(TOOL_NAMES.readGetReviewSessionDetail, { reviewSessionId: ids[0]! }));
    expect(rejected.request.requestStatus).toBe("request_failed"); expect(rejected.request.execution).toBeUndefined();
    expect(rejected.userAnswerUse.answerFields).not.toContain("request.execution");
    const failed = data(await call(TOOL_NAMES.sessionGetExecutionResult, { reviewSessionId: ids[4]! }));
    expect(failed.requestStatus).toBe("completed"); expect(failed.executionResult.status).toBe("failure");
    expect(findForbiddenMcpFields(failed)).toEqual([]);
    const options = { suiGrpcUrl: DEFAULT_SUI_GRPC_URL, suiGraphqlUrl: DEFAULT_SUI_GRAPHQL_URL, verifySuiGrpcUrl: async () => {}, verifySuiGraphqlUrl: async () => {},
      now: f.now, advanceRequestDeadlines: (now: Date) => f.records.advanceRequestDeadlines(now) };
    const local = f.activity.createLocalDataService(options);
    const beforeExport = data(await call(TOOL_NAMES.readSummarizeReviewFunnel, { account: f.account }));
    const backup = await f.run(() => local.exportLocalData(f.now()));
    const connectionJournal = f.run(() => f.records.connections());
    expect(backup.data.reviewRequests).toHaveLength(5); expect(backup.data.reviewExecutions).toHaveLength(2);
    const serialized = JSON.stringify(backup);
    for (const secret of ["symKey", "sdk_pending", "can_submit", "token_hash", "transactionBytes", '"signature":']) expect(serialized).not.toContain(secret);
    await f.run(() => local.importLocalDataReplace(backup));
    const restored = data(await call(TOOL_NAMES.readSummarizeReviewFunnel, { account: f.account }));
    expect(restored.summary).toEqual(beforeExport.summary);
    expect(f.run(() => f.records.connections())).toEqual(connectionJournal);
    const request = f.run(() => f.records.currentRequest(ids[4]!))!;
    expect(f.run(() => f.records.authority(request.attemptId))).toBeUndefined();
    const management = await call(TOOL_NAMES.sessionOpenReviewManagement, { reviewSessionId: ids[4]!, attemptId: request.attemptId });
    expect(management.isError).toBe(true);
  });
});


it("binds private receipt details to the exact completed attempt, including newly opened management cards", async () => {
  const { f, call } = await harness(true, true); const { connection } = await f.approve(), ready = await f.prepare(connection.connectionId);
  await f.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: ready.session.reviewRevision });
  await vi.waitFor(() => expect(f.run(() => f.records.currentRequest(ready.session.id)?.requestStatus)).toBe("completed"));
  const request = f.run(() => f.records.currentRequest(ready.session.id))!;
  const response = await call(TOOL_NAMES.sessionOpenReviewManagement, { reviewSessionId: ready.session.id, attemptId: request.attemptId });
  const snapshot = cardSnapshotSchema.parse(data(response));
  const display = cardReceiptDisplaySchema.parse(response._meta?.[CARD_DISPLAY_METADATA_KEY]);
  expect(display).toMatchObject({ cardId: snapshot.cardId, revision: snapshot.revision, transactionDigest: request.transactionDigest, attemptId: request.attemptId });
  expect(display.ptbGraph?.mermaid.text).toContain("flowchart LR");
  expect((snapshot.data as any).receipt.receipt).not.toHaveProperty("ptbGraph");
  expect(receiptForCard(snapshot, display).ptbGraph).toEqual(display.ptbGraph);
  expect(() => receiptForCard(snapshot, { ...display, attemptId: "another-attempt" })).toThrow("different request");
  expect(f.sign).toHaveBeenCalledOnce(); expect(f.submit).toHaveBeenCalledOnce();
});

it("keeps prior attempts while a newly reviewed revision becomes the current request", async () => {
  const { f, call } = await harness(), { connection } = await f.approve(), ready = await f.prepare(connection.connectionId);
  await f.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: ready.session.reviewRevision });
  await vi.waitFor(() => expect(f.run(() => f.records.currentRequest(ready.session.id)?.requestStatus)).toBe("completed"));
  const first = f.run(() => f.records.currentRequest(ready.session.id))!;
  let replacement = await f.run(() => f.cards.create("review", { reviewSessionId: ready.session.id }));
  expect((await f.act(replacement, { action: "prepare_review", connectionId: connection.connectionId, account: f.account, reviewRevision: ready.session.reviewRevision })).error).toBeUndefined();
  await vi.waitFor(async () => expect((await f.run(() => f.sessions.getReviewSession(ready.session.id, f.now)))?.reviewRevision).toBe(2));
  expect(data(await call(TOOL_NAMES.sessionGetInteractionStatus)).pendingReviewSessions.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ reviewSessionId: ready.session.id, reviewRevision: 2, requestStatus: "completed" })
  ]));
  replacement = await f.read(replacement); f.sign.mockRejectedValueOnce(new Error("User declined this revision"));
  await f.act(replacement, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: 2 });
  await vi.waitFor(() => expect(f.run(() => f.records.currentRequest(ready.session.id)?.requestStatus)).toBe("request_failed"));
  const detail = data(await call(TOOL_NAMES.readGetReviewSessionDetail, { reviewSessionId: ready.session.id }));
  expect(detail.requestCount).toBe(2); expect(detail.request.reviewRevision).toBe(2); expect(detail.request.execution).toBeUndefined();
  expect(detail.requests.find((r: { attemptId: string }) => r.attemptId === first.attemptId)).toEqual(first);
  expect(detail.userAnswerUse.canAnswer).toContain("stored_review_chain_execution_result");
  const summary = data(await call(TOOL_NAMES.readSummarizeReviewFunnel, { account: f.account }));
  expect(summary.summary).toMatchObject({ total: 1, withoutRequest: 0, withoutExecutionResult: 1, executionStatusCounts: { success: 0, failure: 0 } });
  expect(summary.summary.requestStatusCounts.find((r: { requestStatus: string }) => r.requestStatus === "request_failed").count).toBe(1);
  expect(f.submit).toHaveBeenCalledOnce();
});

it.each(["initialization_failed", "restoration_failed"] as const)("returns completed facts across ordinary and card reads after %s", async (reason) => {
  const { f, call, deps } = await harness(true, true), { card: connectCard, connection } = await f.approve(), ready = await f.prepare(connection.connectionId);
  await f.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: ready.session.reviewRevision });
  await vi.waitFor(() => expect(f.run(() => f.records.currentRequest(ready.session.id))?.requestStatus).toBe("completed"));
  const saved = f.run(() => f.records.currentRequest(ready.session.id))!, reads = f.chainRead.mock.calls.length;
  f.workflow.stop();
  const next = new WalletWorkflow({ ownerId: "restoring-owner", records: f.run(() => f.activity.createWalletWorkflowStore("restoring-owner")),
    sessions: f.sessions, runtime: new FixtureWalletRuntime(reason === "restoration_failed" ? { ...f.transport, restore: async () => { throw new Error("PRIVATE-RESTORE"); } } : undefined),
    bindExternalEvent: (work) => f.access.bind(work),
    computation: f.computation, verifyReceipt: f.verifyReceipt, verifyNetwork: f.verifyNetwork, submitTransaction: f.submit,
    assertCurrent: f.access.assertCurrent, logger: f.logger, now: f.now });
  await f.run(() => next.start());
  const nextCards = f.run(() => new CardStore({ records: f.cardRecords, ownerId: "restoring-owner", workflow: next,
    assertCurrent: f.access.assertCurrent, now: f.now, execute: async () => { throw new Error("Unexpected read source"); } }));
  deps.workflow = next; deps.cards = { store: nextCards };
  cleanups.push(async () => { next.stop(); nextCards.stop(); });
  for (const name of [TOOL_NAMES.sessionGetReviewStatus, TOOL_NAMES.sessionGetExecutionResult, TOOL_NAMES.sessionWaitExecutionResult]) {
    const response = data(await call(name, { reviewSessionId: ready.session.id }));
    expect(response).toMatchObject({ request: saved, executionResult: saved.execution, walletAvailability: { status: "unavailable", reason }, progress: { status: "idle" } });
    if (name === TOOL_NAMES.sessionWaitExecutionResult) expect(response.waitOutcome).toBe("status_reached");
  }
  expect(data(await call(TOOL_NAMES.sessionGetInteractionStatus))).toMatchObject({ walletAvailability: { status: "unavailable" } });
  expect(data(await call(TOOL_NAMES.sessionGetWalletConnectionCard, { cardId: connectCard.snapshot.cardId })).data.connection.status).toBe("connected");
  const management = data(await call(TOOL_NAMES.sessionOpenReviewManagement, { reviewSessionId: ready.session.id, attemptId: saved.attemptId }));
  expect(management.data).toMatchObject({ request: saved, walletAvailability: { status: "unavailable" }, observe: false });
  expect(data(await call(TOOL_NAMES.readGetReviewSessionDetail, { reviewSessionId: ready.session.id })).request).toEqual(saved);
  expect(f.chainRead).toHaveBeenCalledTimes(reads); expect(f.sign).toHaveBeenCalledOnce(); expect(f.submit).toHaveBeenCalledOnce();
});

it("reports a lost wallet run as a failed request without authorizing late signatures", async () => {
  const { f, call } = await harness(), { connection } = await f.approve(), ready = await f.prepare(connection.connectionId);
  const pending = deferred<{ transactionBytes: string; signature: string }>(); let signed: { transactionBytes: string; signature: string } | undefined;
  f.sign.mockImplementationOnce(async (input) => { const result = await f.accountKey.signTransaction(Buffer.from(input.transactionBytesBase64, "base64"));
    signed = { transactionBytes: result.bytes, signature: result.signature }; return pending.promise; });
  await f.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: ready.session.reviewRevision });
  await vi.waitFor(() => expect(signed).toBeDefined());
  const source = vi.spyOn(f.transport, "inspectAll").mockImplementation(() => { throw new Error("PRIVATE-EVENT"); });
  f.notify(); source.mockRestore();
  const request = f.run(() => f.records.currentRequest(ready.session.id))!;
  expect(data(await call(TOOL_NAMES.sessionWaitExecutionResult, { reviewSessionId: ready.session.id }))).toMatchObject({ waitOutcome: "status_reached", requestStatus: "request_failed", progress: { status: "idle" } });
  expect(data(await call(TOOL_NAMES.sessionGetInteractionStatus)).pendingReviewSessions.items
    .some((item: { attemptId?: string }) => item.attemptId === request.attemptId)).toBe(false);
  const blocked = await call(CARD_TOOLS.act, { cardId: ready.card.snapshot.cardId, permission: ready.card.permission, revision: 999,
    input: { action: "request_signature", walletRunId: f.runtime.runId, connectionId: connection.connectionId, account: f.account, reviewRevision: 999 } });
  expect(blocked.isError).toBe(true);
  pending.resolve(signed!);
  await vi.waitFor(() => expect(f.run(() => f.records.authority(request.attemptId))?.sdk_pending).toBe(0));
  expect(f.run(() => f.records.request(request.attemptId))?.requestStatus).toBe("request_failed");
  expect(f.submit).not.toHaveBeenCalled(); expect(f.chainRead).not.toHaveBeenCalled();
});

it("keeps asynchronous card-creation failures inside both review gateways' safe error envelope", async () => {
  const { f, call } = await harness(); await f.approve();
  const create = vi.spyOn(f.cards, "create").mockRejectedValue(new Error("PRIVATE-CARD-STORAGE"));
  const inputs = [
    { name: TOOL_NAMES.actionStartReview, input: { intent: { type: "swap", protocol: "deep", from: { symbol: "SUI", amount: "1" }, to: { symbol: "USDC" }, maxSlippageBps: 50 } } },
    { name: TOOL_NAMES.actionCreateProposalReview, input: { proposal: { type: "payment", id: "untrusted-payment", source: { kind: "user", name: "Fixture" },
      network: "sui:mainnet", createdAt: f.now().toISOString(), purpose: "Review a proposed payment", payment: {
        amount: { symbol: "SUI", amountDisplay: "1", amountKind: "display_proposal" }, recipient: { address: f.account } } } } }
  ];
  for (const { name, input } of inputs) {
    const response = await call(name, input);
    expect(response.isError).toBe(true);
    const text = (response.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text") as { text: string };
    expect(JSON.parse(text.text)).toMatchObject({ ok: false, error: { kind: "internal_error" } });
    expect(JSON.stringify(response)).not.toContain("PRIVATE-CARD-STORAGE");
  }
  expect(create).toHaveBeenCalledTimes(2); expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});

it.each([TOOL_NAMES.sessionGetReviewStatus, TOOL_NAMES.sessionGetExecutionResult,
  TOOL_NAMES.sessionWaitExecutionResult, CARD_TOOLS.read])("returns a typed current-state conflict through %s without repeating verification", async (name) => {
  const { f, call } = await harness(), { connection } = await f.approve(), ready = await f.prepare(connection.connectionId);
  const inspect = f.sessions.inspectReview.bind(f.sessions);
  const reads = vi.spyOn(f.sessions, "inspectReview").mockImplementationOnce(async (...args) => {
    const candidate = await inspect(...args);
    const db = new Database(join(f.directory, "activity.sqlite"));
    try { db.prepare("UPDATE live_review_sessions SET revision=revision+1 WHERE id=?").run(ready.session.id); }
    finally { db.close(); }
    return candidate;
  });
  const result = await call(name, name === CARD_TOOLS.read ? { cardId: ready.card.snapshot.cardId, permission: ready.card.permission } :
    { reviewSessionId: ready.session.id });
  expect(result.isError).toBe(true);
  const content = (result.content as { type: string; text?: string }[]).find(item => item.type === "text")!;
  expect(JSON.parse(content.text!)).toMatchObject({ ok: false, error: { kind: "invalid_session_transition",
    details: { reason: "review_changed_during_verification", message: "The review changed while it was being checked." } } });
  expect(reads).toHaveBeenCalledOnce();
  expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});

// Use public creation for each review: no test-only reopening of a consumed card.
async function openProductReview(h: Awaited<ReturnType<typeof harness>>) {
  const created = await h.call(TOOL_NAMES.actionStartReview, { intent: { type: "swap", protocol: "deep",
    from: { symbol: "SUI", amount: "1" }, to: { symbol: "USDC" }, maxSlippageBps: 50 } });
  // Public creation uses wall time; advance the controlled external-source clock
  // before any reads or transitions so history never predates session creation.
  h.f.advance(Math.max(0, Date.now() - h.f.now().getTime()));
  const id = String(data(created).reviewSessionId), ref = cardReferenceSchema.parse(created._meta?.[CARD_METADATA_KEY]);
  const read = async () => cardSnapshotSchema.parse(data(await h.call(CARD_TOOLS.read, ref)));
  const act = async (input: Record<string, unknown>) => {
    const current = await read();
    const bound = ["prepare_review", "request_signature"].includes(String(input.action))
      ? { walletRunId: (current.data as { walletAvailability: { walletRunId: string } }).walletAvailability.walletRunId, ...input } : input;
    return h.call(CARD_TOOLS.act, { ...ref, revision: current.revision, input: bound });
  };
  return { id, ref, read, act };
}
async function selectProductAccount(h: Awaited<ReturnType<typeof harness>>, connectionId: string, account: string) {
  const created = await h.call(TOOL_NAMES.sessionOpenWalletConnectionCard);
  data(await h.call(CARD_TOOLS.act, { ...cardReferenceSchema.parse(created._meta?.[CARD_METADATA_KEY]),
    revision: cardSnapshotSchema.parse(data(created)).revision, input: { action: "use_account", walletRunId: data(created).data.walletAvailability.walletRunId, connectionId, account } }));
}
async function prepareProductReview(h: Awaited<ReturnType<typeof harness>>, connectionId: string) {
  const review = await openProductReview(h);
  data(await review.act({ action: "prepare_review", connectionId, account: h.f.account, reviewRevision: 0 }));
  await vi.waitFor(() => expect(h.f.run(() => h.f.sessions.readReviewSession(review.id)?.status)).toBe("ready_for_wallet_review"));
  return review;
}

async function approveProductAccounts(h: Awaited<ReturnType<typeof harness>>) {
  const { f } = h, { connection } = await f.approve(), other = `0x${"e".repeat(64)}`;
  f.notify({ topic: "fixture-topic", accounts: [f.account, other], methods: ["sui_signTransaction"], chain: "sui:mainnet", expiresAt: connection.expiresAt });
  return { connection, other };
}

it("rejects changed read-account selections before preparation without changing the bound review or history", async () => {
  const h = await harness(), { f, call } = h, { connection, other } = await approveProductAccounts(h);
  const review = await prepareProductReview(h, connection.connectionId);
  const before = f.run(() => f.sessions.readReviewSession(review.id))!;
  await selectProductAccount(h, connection.connectionId, other);
  const snapshot = await review.read(), view = snapshot.data as any;
  expect(view.review).toMatchObject({ account: f.account, status: "ready_for_wallet_review", preparing: false });
  expect(view.allowedActions).not.toContain("prepare_review");
  expect(view.allowedActions).toContain("request_signature"); // Read context does not revoke reviewed A signing.
  expect(view.review.error).toContain(`Current account selection: This review uses ${f.account}`);
  expect(view.review.error).toContain(`the currently selected account is ${other}`);
  const history = data(await call(TOOL_NAMES.readGetReviewSessionDetail, { reviewSessionId: review.id, account: f.account }));
  const preparations = vi.mocked(f.sessions.recordWalletConnected).mock.calls.length;
  for (let i = 0; i < 2; i++) {
    const rejected = await review.act({ action: "prepare_review", connectionId: connection.connectionId, account: other, reviewRevision: before.reviewRevision });
    expect(rejected.isError).toBe(true); expect(JSON.stringify(rejected.content)).toContain("This review uses");
  }
  expect(f.run(() => f.sessions.readReviewSession(review.id))).toEqual(before);
  expect(data(await call(TOOL_NAMES.readGetReviewSessionDetail, { reviewSessionId: review.id, account: f.account }))).toEqual(history);
  expect(vi.mocked(f.sessions.recordWalletConnected)).toHaveBeenCalledTimes(preparations);
  expect((await review.read()).revision).toBe(snapshot.revision);
  // Keep card permission/revision current while submitting the previously
  // selected A account after read context changes to B. Only account compatibility
  // may reject this command; a stale-card error cannot prove that rule.
  await selectProductAccount(h, connection.connectionId, f.account);
  expect(((await review.read()).data as any).review.error).toBeUndefined();
  await selectProductAccount(h, connection.connectionId, other);
  const changedSelection = await review.act({ action: "prepare_review", connectionId: connection.connectionId,
    account: f.account, reviewRevision: before.reviewRevision });
  expect(changedSelection.isError).toBe(true);
  expect(JSON.stringify(changedSelection.content)).toContain("This review uses");
  expect(vi.mocked(f.sessions.recordWalletConnected)).toHaveBeenCalledTimes(preparations);
  expect(f.run(() => f.sessions.readReviewSession(review.id))).toEqual(before);
  // No active account is also a selection restriction, not a saved preparation failure.
  await f.run(() => f.activity.clearActiveAccount(f.now()));
  expect((await review.read()).data).toMatchObject({ review: { error: expect.stringContaining("No account from a connected wallet is selected") } });
  await selectProductAccount(h, connection.connectionId, f.account);
  expect(((await review.read()).data as any).review.error).toBeUndefined();
  expect(vi.mocked(f.sessions.recordWalletConnected)).toHaveBeenCalledTimes(preparations);
  expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled(); expect(f.connect).toHaveBeenCalledOnce();
});

it("distinguishes current account guidance from a saved preparation error and recovers when A is selected again", async () => {
  const h = await harness(), { f } = h, { connection, other } = await approveProductAccounts(h);
  const review = await prepareProductReview(h, connection.connectionId);
  const before = f.run(() => f.sessions.readReviewSession(review.id))!;
  // Save an actual asynchronous preparation failure, then distinguish it from current selection.
  const original = vi.mocked(f.sessions.recordWalletConnected).getMockImplementation()!;
  vi.mocked(f.sessions.recordWalletConnected).mockRejectedValueOnce(new Error("Synthetic preparation source failure"));
  data(await review.act({ action: "prepare_review", connectionId: connection.connectionId, account: f.account, reviewRevision: before.reviewRevision }));
  await vi.waitFor(() => expect(f.run(() => f.sessions.readReviewSession(review.id)?.preparationError)).toBeDefined());
  vi.mocked(f.sessions.recordWalletConnected).mockImplementation(original);
  await selectProductAccount(h, connection.connectionId, other);
  const both = (await review.read()).data as any;
  expect(both.review.error).toContain("Current account selection:"); expect(both.review.error).toContain("Earlier review message:");
  await selectProductAccount(h, connection.connectionId, f.account);
  data(await review.act({ action: "prepare_review", connectionId: connection.connectionId, account: f.account, reviewRevision: before.reviewRevision }));
  await vi.waitFor(() => expect(f.run(() => f.sessions.readReviewSession(review.id)?.reviewRevision)).toBe(before.reviewRevision + 1));
  expect(((await review.read()).data as any).review.error).toBeUndefined();
  expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled(); expect(f.connect).toHaveBeenCalledOnce();
});

it("prepares a new public review for B independently of an existing review bound to A", async () => {
  const h = await harness(), { f } = h, { connection, other } = await approveProductAccounts(h);
  const review = await prepareProductReview(h, connection.connectionId);
  await selectProductAccount(h, connection.connectionId, other); f.setSourceAccount(other);
  const second = await openProductReview(h); expect(second.id).not.toBe(review.id);
  expect(((await second.read()).data as any).review.error).toBeUndefined();
  data(await second.act({ action: "prepare_review", connectionId: connection.connectionId, account: other, reviewRevision: 0 }));
  await vi.waitFor(() => expect(f.run(() => f.sessions.readReviewSession(second.id))).toMatchObject({ account: other, status: "ready_for_wallet_review" }));
  expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled(); expect(f.connect).toHaveBeenCalledOnce();
});

it.each(["user_stop", "expiry_update", "account_change", "session_delete", "disconnect"] as const)("records the true %s cause before submission and keeps it after later events", async (origin) => {
  const h = await harness(), { f, call } = h, { connection } = await f.approve(), review = await prepareProductReview(h, connection.connectionId);
  const pending = deferred<{ transactionBytes: string; signature: string }>(), signed = deferred<{ transactionBytes: string; signature: string }>();
  const sign = f.sign.getMockImplementation()!;
  f.sign.mockImplementationOnce(async (input) => { signed.resolve(await sign(input)); return pending.promise; });
  data(await review.act({ action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: 1 }));
  const signature = await signed.promise;
  let finishDisconnect: ReturnType<typeof deferred<void>> | undefined;
  if (origin === "user_stop") data(await review.act({ action: "stop_waiting" }));
  else if (origin === "disconnect") {
    finishDisconnect = deferred<void>(); vi.mocked(f.transport.disconnect).mockImplementationOnce(() => finishDisconnect!.promise);
    const created = await call(TOOL_NAMES.sessionOpenWalletConnectionCard);
    data(await call(CARD_TOOLS.act, { ...cardReferenceSchema.parse(created._meta?.[CARD_METADATA_KEY]), revision: cardSnapshotSchema.parse(data(created)).revision,
      input: { action: "disconnect", walletRunId: f.runtime.runId, connectionId: connection.connectionId } }));
  } else if (origin === "session_delete") f.notify();
  else f.notify({ topic: "fixture-topic", accounts: origin === "account_change" ? [`0x${"d".repeat(64)}`] : [f.account],
    methods: ["sui_signTransaction"], chain: "sui:mainnet", expiresAt: new Date(Date.parse(connection.expiresAt) + 1000).toISOString() });
  const expected = origin === "user_stop" ? "User stopped waiting before submission." : origin === "disconnect"
    ? "Wallet disconnection was requested before submission. Nothing was submitted."
    : "The wallet connection changed or became unavailable before submission. Nothing was submitted.";
  const request = f.run(() => f.records.currentRequest(review.id))!;
  expect(request).toMatchObject({ requestStatus: "stopped", reason: expected });
  expect(f.run(() => f.records.authority(request.attemptId))).toMatchObject({ can_submit: 0, sdk_pending: 1 });
  await expect(f.run(() => f.localData.resetLocalData())).rejects.toMatchObject({ details: { reason: "wallet_request_unsettled" } });
  const history = data(await call(TOOL_NAMES.readGetReviewSessionDetail, { reviewSessionId: review.id, account: f.account }));
  expect(history.request.reason).toBe(expected);
  expect(data(await call(TOOL_NAMES.sessionGetExecutionResult, { reviewSessionId: review.id })).request.reason).toBe(expected);
  expect((await review.read()).data).toMatchObject({ request: { reason: expected } });
  f.notify(); f.notify(); // Neither a duplicate nor a later different origin can rewrite the terminal fact.
  expect(f.run(() => f.records.request(request.attemptId))).toEqual(request);
  expect(data(await call(TOOL_NAMES.readGetReviewSessionDetail, { reviewSessionId: review.id, account: f.account }))).toEqual(history);
  finishDisconnect?.resolve(); pending.resolve(signature);
  await vi.waitFor(() => expect(f.run(() => f.records.authority(request.attemptId)?.sdk_pending)).toBe(0));
  const backup = await f.run(() => f.localData.exportLocalData(f.now()));
  expect(backup.data.reviewRequests.find((item) => item.attempt_id === request.attemptId)?.reason).toBe(expected);
  expect(f.sign).toHaveBeenCalledOnce(); expect(f.submit).not.toHaveBeenCalled(); expect(f.chainRead).not.toHaveBeenCalled();
});

it.each(["submitting", "awaiting_chain_result"] as const)("preserves same-digest observation after wallet updates and disconnect during %s", async (stage) => {
  const h = await harness(), { f, call } = h, { connection } = await f.approve(), review = await prepareProductReview(h, connection.connectionId);
  const submit = deferred<object>(), chain = deferred<Awaited<ReturnType<typeof f.chainRead>>>(), originalRead = f.chainRead.getMockImplementation()!;
  if (stage === "submitting") f.submit.mockImplementationOnce(() => submit.promise);
  else f.chainRead.mockRejectedValueOnce(Object.assign(new Error("Not yet found"), { name: "TimeoutError" }));
  data(await review.act({ action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: 1 }));
  await vi.waitFor(() => {
    expect(f.run(() => f.records.currentRequest(review.id)?.requestStatus)).toBe(stage);
    if (stage === "awaiting_chain_result") expect(f.run(() => f.records.authority(f.records.currentRequest(review.id)!.attemptId)?.lookup_pending)).toBe(0);
  });
  const request = f.run(() => f.records.currentRequest(review.id))!, authority = f.run(() => f.records.authority(request.attemptId))!;
  f.chainRead.mockImplementation(() => chain.promise);
  f.notify({ topic: "fixture-topic", accounts: [f.account], methods: ["sui_signTransaction"], chain: "sui:mainnet",
    expiresAt: new Date(Date.parse(connection.expiresAt) + 1000).toISOString() });
  const disconnecting = deferred<void>(); vi.mocked(f.transport.disconnect).mockImplementationOnce(() => disconnecting.promise);
  const connectCard = await call(TOOL_NAMES.sessionOpenWalletConnectionCard);
  data(await call(CARD_TOOLS.act, { ...cardReferenceSchema.parse(connectCard._meta?.[CARD_METADATA_KEY]), revision: cardSnapshotSchema.parse(data(connectCard)).revision,
    input: { action: "disconnect", walletRunId: f.runtime.runId, connectionId: connection.connectionId } }));
  expect(f.run(() => f.records.authority(request.attemptId))).toEqual(authority);
  expect(f.run(() => f.records.busyForAccount(f.account, f.now()))).toBe(true);
  await expect(f.run(() => f.localData.resetLocalData())).rejects.toMatchObject({ details: { reason: "wallet_request_unsettled" } });
  f.notify(); disconnecting.resolve();
  if (stage === "submitting") submit.resolve({});
  else expect((await review.read()).data).toMatchObject({ observe: true, observationStopped: false });
  await vi.waitFor(() => expect(f.chainRead).toHaveBeenCalledTimes(stage === "submitting" ? 1 : 2));
  expect(f.run(() => f.records.authority(request.attemptId))).toMatchObject({ submit_pending: 0, lookup_pending: 1, observation_stopped: 0 });
  const waiting = data(await call(TOOL_NAMES.sessionWaitExecutionResult, { reviewSessionId: review.id, timeoutMs: 1 }));
  expect(waiting.waitOutcome).toBe("timed_out");
  expect(waiting.request.attemptId).toBe(request.attemptId);
  chain.resolve(await originalRead());
  await vi.waitFor(() => expect(f.run(() => f.records.request(request.attemptId)?.requestStatus)).toBe("completed"));
  expect(data(await call(TOOL_NAMES.sessionGetExecutionResult, { reviewSessionId: review.id })).executionResult.status).toBe("success");
  expect((await review.read()).data).toMatchObject({ observe: false, request: { attemptId: request.attemptId, requestStatus: "completed" } });
  expect(f.sign).toHaveBeenCalledOnce(); expect(f.submit).toHaveBeenCalledOnce();
});

it("preserves explicit post-submission stop across SDK events until an explicit same-digest result read", async () => {
  const h = await harness(), { f } = h, { connection } = await f.approve(), review = await prepareProductReview(h, connection.connectionId);
  const submit = deferred<object>(); f.submit.mockImplementationOnce(() => submit.promise);
  const receipt = f.chainRead.getMockImplementation()!;
  f.chainRead.mockRejectedValue(Object.assign(new Error("Not yet found"), { name: "TimeoutError" }));
  data(await review.act({ action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: 1 }));
  await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce());
  data(await review.act({ action: "stop_waiting" }));
  f.notify({ topic: "fixture-topic", accounts: [f.account], methods: ["sui_signTransaction"], chain: "sui:mainnet",
    expiresAt: new Date(Date.parse(connection.expiresAt) + 1000).toISOString() });
  submit.resolve({});
  await vi.waitFor(() => expect(f.run(() => f.records.currentRequest(review.id)?.requestStatus)).toBe("awaiting_chain_result"));
  const readsBeforeStoppedRead = f.chainRead.mock.calls.length;
  expect((await review.read()).data).toMatchObject({ observe: false, observationStopped: true });
  expect(f.chainRead).toHaveBeenCalledTimes(readsBeforeStoppedRead);
  f.chainRead.mockImplementation(receipt);
  data(await review.act({ action: "read_result" }));
  await vi.waitFor(() => expect(f.run(() => f.records.currentRequest(review.id)?.requestStatus)).toBe("completed"));
  expect(f.chainRead).toHaveBeenCalledTimes(readsBeforeStoppedRead + 1); expect(f.submit).toHaveBeenCalledOnce();
});

it.each(["request_update", "activity_insert"] as const)("recovers the submitted digest after %s fails without losing replacement protection", async (failure) => {
  const h = await harness(), { f, call } = h, { connection } = await f.approve(), review = await openProductReview(h);
  data(await review.act({ action: "prepare_review", connectionId: connection.connectionId, account: f.account, reviewRevision: 0 }));
  await vi.waitFor(() => expect(f.run(() => f.sessions.readReviewSession(review.id)?.reviewRevision)).toBe(1));
  const db = new Database(join(f.directory, "activity.sqlite")), receipt = f.chainRead.getMockImplementation()!;
  f.chainRead.mockRejectedValue(Object.assign(new Error("Not found"), { name: "TimeoutError" }));
  try {
    db.exec(failure === "request_update"
      ? "CREATE TRIGGER reject_finish BEFORE UPDATE ON review_requests WHEN NEW.request_status='awaiting_chain_result' BEGIN SELECT RAISE(ABORT,'PRIVATE-FINISH'); END"
      : "CREATE TRIGGER reject_finish BEFORE INSERT ON review_status_transitions WHEN NEW.to_status='awaiting_chain_result' BEGIN SELECT RAISE(ABORT,'PRIVATE-FINISH'); END");
    data(await review.act({ action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: 1 }));
    await vi.waitFor(() => expect(f.logger.error).toHaveBeenCalledWith("Wallet operation failed", { stage: "submission_record" }));
    const request = f.run(() => f.records.currentRequest(review.id))!;
    expect(request.requestStatus).toBe("submitting");
    expect(f.run(() => f.records.authority(request.attemptId))).toMatchObject({ sdk_pending: 0, submit_pending: 0, lookup_pending: 0 });
    expect(f.run(() => f.records.busyForAccount(f.account, f.now()))).toBe(true);
    expect(f.run(() => f.activity.createSessionRecordStore().hasUnsettledRequest(review.id, f.now()))).toBe(true);
    const backup = await f.run(() => f.localData.exportLocalData(f.now()));
    await expect(f.run(() => f.localData.resetLocalData())).rejects.toMatchObject({ details: { reason: "wallet_request_unsettled" } });
    await expect(f.run(() => f.localData.importLocalDataReplace(backup))).rejects.toMatchObject({ details: { reason: "wallet_request_unsettled" } });
    db.exec("DROP TRIGGER reject_finish"); f.chainRead.mockImplementation(receipt);
    const result = data(await call(TOOL_NAMES.sessionGetExecutionResult, { reviewSessionId: review.id }));
    expect(result).toMatchObject({ requestStatus: "completed", attemptId: request.attemptId,
      executionResult: { txDigest: request.transactionDigest, status: "success" } });
    expect(result).not.toHaveProperty("hasReviewInput");
    const summary = data(await call(TOOL_NAMES.readSummarizeReviewFunnel, { account: f.account })).summary;
    expect(summary).toMatchObject({ total: 1, everAwaitedChainResult: 0, executionStatusCounts: { success: 1, failure: 0 } });
    expect(summary.requestStatusCounts).toContainEqual({ requestStatus: "completed", count: 1 });
    const detail = data(await call(TOOL_NAMES.readGetReviewSessionDetail, { reviewSessionId: review.id, account: f.account }));
    expect(detail.transitions.filter((t: { toStatus?: string }) => t.toStatus === "awaiting_chain_result")).toHaveLength(0);
    expect(detail.request?.execution?.txDigest).toBe(request.transactionDigest);
    const listed = data(await call(TOOL_NAMES.readListReviewActivity, { account: f.account, requestStatus: "completed" }));
    expect(listed.activities).toHaveLength(1);
    expect(f.submit).toHaveBeenCalledOnce(); expect(f.sign).toHaveBeenCalledOnce();
  } finally { db.exec("DROP TRIGGER IF EXISTS reject_finish"); db.close(); }
});

it("lists live input and work, excluding cancelled and independently expired input before the limit", async () => {
  const h = await harness(), { f, call } = h, { connection } = await f.approve();
  const live = await openProductReview(h), cancelled: string[] = [];
  for (let i = 0; i < 6; i++) {
    const review = await openProductReview(h); cancelled.push(review.id);
    if (i === 0) {
      data(await review.act({ action: "prepare_review", connectionId: connection.connectionId, account: f.account, reviewRevision: 0 }));
      await vi.waitFor(() => expect(f.run(() => f.sessions.readReviewSession(review.id)?.reviewRevision)).toBe(1));
    }
    data(await review.act({ action: "cancel" }));
    expect(await review.read()).toMatchObject({ state: "closed", reason: "cancelled", data: { allowedActions: [] } });
  }
  const expiring = await openProductReview(h), db = new Database(join(f.directory, "activity.sqlite"));
  try {
    // Only the input expires; the review evidence remains a valid stored fact.
    db.prepare("UPDATE live_read_cards SET expires_at=?,revision=revision+1 WHERE id=?").run(f.now().toISOString(), expiring.ref.cardId);
    const overview = data(await call(TOOL_NAMES.sessionGetInteractionStatus)).pendingReviewSessions;
    expect(overview.truncated).toBe(false); expect(overview.items.map((r: any) => r.reviewSessionId)).toEqual([live.id]);
    expect(f.run(() => f.sessions.readReviewSession(expiring.id)?.status)).toBe("proposed");
    for (const id of cancelled) expect(f.run(() => f.sessions.readReviewSession(id))).toBeDefined();
    data(await live.act({ action: "prepare_review", connectionId: connection.connectionId, account: f.account, reviewRevision: 0 }));
    await vi.waitFor(() => expect(f.run(() => f.sessions.readReviewSession(live.id)?.reviewRevision)).toBe(1));
    const pending = deferred<{ transactionBytes: string; signature: string }>(); f.sign.mockImplementationOnce(() => pending.promise);
    data(await live.act({ action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: 1 }));
    expect(data(await call(TOOL_NAMES.sessionGetInteractionStatus)).pendingReviewSessions.items)
      .toContainEqual(expect.objectContaining({ reviewSessionId: live.id, requestStatus: "awaiting_signature" }));
    pending.reject(new Error("Dismissed"));
    await vi.waitFor(() => expect(f.run(() => f.records.currentRequest(live.id)?.requestStatus)).toBe("request_failed"));
    expect(data(await call(TOOL_NAMES.sessionGetInteractionStatus)).pendingReviewSessions.items).toEqual([]);
    expect(f.submit).not.toHaveBeenCalled();
  } finally { db.close(); }
});

it("settles an ended preparation after storage recovers, without restarting its sources", async () => {
  const h = await harness(), { f, call } = h, { connection } = await f.approve(), review = await openProductReview(h);
  const gate = deferred<void>(), quote = f.quote.getMockImplementation()!;
  f.quote.mockImplementationOnce(async () => { await gate.promise; return quote(); });
  data(await review.act({ action: "prepare_review", connectionId: connection.connectionId, account: f.account, reviewRevision: 0 }));
  expect((await review.read()).data).toMatchObject({ review: { preparing: true }, progress: { status: "waiting" } });
  expect(data(await call(TOOL_NAMES.sessionGetInteractionStatus)).pendingReviewSessions.items)
    .toContainEqual(expect.objectContaining({ reviewSessionId: review.id }));
  const db = new Database(join(f.directory, "activity.sqlite"));
  try {
    db.exec("CREATE TRIGGER reject_prepared BEFORE UPDATE OF preparation_id ON live_review_sessions WHEN OLD.preparation_id IS NOT NULL AND NEW.preparation_id IS NULL BEGIN SELECT RAISE(ABORT,'PRIVATE-PREPARED'); END");
    gate.resolve();
    await vi.waitFor(() => expect(f.logger.error).toHaveBeenCalledWith("Wallet operation failed", { stage: "review_computation" }));
    expect(f.run(() => f.sessions.readReviewSession(review.id)?.preparationId)).toBeDefined();
    expect((await call(CARD_TOOLS.read, review.ref)).isError).toBe(true);
    db.exec("DROP TRIGGER reject_prepared");
    const recovered = await review.read();
    expect(recovered.data).toMatchObject({ review: { preparing: false, error: expect.stringContaining("could not be completed") },
      allowedActions: ["cancel", "prepare_review"] });
    const before = await f.run(() => f.activity.getReviewSessionDetail({ reviewSessionId: review.id, account: f.account }));
    await review.read(); await call(TOOL_NAMES.sessionGetReviewStatus, { reviewSessionId: review.id });
    const after = await f.run(() => f.activity.getReviewSessionDetail({ reviewSessionId: review.id, account: f.account }));
    expect(after.transitions).toEqual(before.transitions); expect(f.quote).toHaveBeenCalledOnce();
    data(await review.act({ action: "prepare_review", connectionId: connection.connectionId, account: f.account, reviewRevision: 0 }));
    await vi.waitFor(() => expect(f.run(() => f.sessions.readReviewSession(review.id)?.reviewRevision)).toBe(1));
    expect(f.quote).toHaveBeenCalledTimes(2); expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
  } finally { gate.resolve(); db.exec("DROP TRIGGER IF EXISTS reject_prepared"); db.close(); }
});

it.each(["absent", "retained", "unavailable"] as const)("recovers a stored disconnect with %s SDK state through ordinary reads", async (sdkState) => {
  const { f, call } = await harness(), { connection } = await f.approve();
  const created = await call(TOOL_NAMES.sessionOpenWalletConnectionCard), ref = cardReferenceSchema.parse(created._meta?.[CARD_METADATA_KEY]);
  const gate = deferred<void>(), disconnect = f.transport.disconnect, performDisconnect = vi.mocked(f.transport.disconnect).getMockImplementation()!;
  vi.mocked(disconnect).mockImplementationOnce(async () => {
    await gate.promise;
    if (sdkState === "absent") await performDisconnect("fixture-topic");
    if (sdkState === "retained") throw new Error("Remote disconnect failed");
  });
  const action = await call(CARD_TOOLS.act, { ...ref, revision: data(created).revision, input: { action: "disconnect", walletRunId: f.runtime.runId, connectionId: connection.connectionId } }); data(action);
  const db = new Database(join(f.directory, "activity.sqlite"));
  try {
    db.exec("CREATE TRIGGER reject_disconnected BEFORE UPDATE OF status ON live_wallet_connections BEGIN SELECT RAISE(ABORT,'PRIVATE-DISCONNECT'); END");
    // A failed session event disables the SDK path; undefined then is not evidence of absence.
    if (sdkState === "unavailable") f.notify();
    gate.resolve();
    await vi.waitFor(() => expect(f.logger.error).toHaveBeenCalledWith("Wallet operation failed", { stage: "disconnection" }));
    expect(f.run(() => f.records.connection(connection.connectionId)?.sdkPending)).toBe(false);
    db.exec("DROP TRIGGER reject_disconnected");
    const result = data(await call(TOOL_NAMES.sessionGetWalletConnectionCard, { cardId: ref.cardId }));
    expect(result.state).toBe("closed");
    const expected = sdkState === "absent" ? "disconnected" : "failed";
    expect(result.data.connection.status).toBe(expected);
    if (expected === "failed") expect(result.data.connection.reason).toContain("may remain in your wallet app");
    expect(data(await call(TOOL_NAMES.sessionWaitWalletConnectionCard, { cardId: ref.cardId, timeoutMs: 1 })).waitOutcome).toBe("status_reached");
    expect(data(await call(TOOL_NAMES.sessionGetInteractionStatus)).pendingWalletConnections.items).toEqual([]);
    expect(f.run(() => f.records.pendingDisconnect(connection.connectionId))).toBeUndefined();
    expect(disconnect).toHaveBeenCalledOnce();
  } finally { gate.resolve(); db.exec("DROP TRIGGER IF EXISTS reject_disconnected"); db.close(); }
});

it.each(["network", "signature_record", "submission_admission"] as const)("reports %s failure without inventing a wallet mismatch or discarding committed facts", async (stage) => {
  const h = await harness(), { f, call } = h, { connection } = await f.approve();
  const review = await prepareProductReview(h, connection.connectionId);
  const db = new Database(join(f.directory, "activity.sqlite"));
  try {
    if (stage === "network") f.verifyNetwork.mockRejectedValueOnce(new Error("PRIVATE-RPC-DETAIL"));
    else db.exec(stage === "signature_record"
      ? "CREATE TRIGGER reject_verification BEFORE INSERT ON review_status_transitions WHEN NEW.event='signature_verified' BEGIN SELECT RAISE(ABORT,'PRIVATE-SQLITE-DETAIL'); END"
      : "CREATE TRIGGER reject_verification BEFORE UPDATE ON review_requests WHEN NEW.request_status='submitting' BEGIN SELECT RAISE(ABORT,'PRIVATE-SQLITE-DETAIL'); END");
    data(await review.act({ action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: 1 }));
    await vi.waitFor(() => {
      const request = f.run(() => f.records.currentRequest(review.id))!;
      expect(request.requestStatus).toBe("request_failed");
      expect(f.run(() => f.records.authority(request.attemptId))).toMatchObject({ can_submit: 0, sdk_pending: 0, submit_pending: 0 });
    });
    const reason = "Submission checks could not be completed. Nothing was submitted.";
    const expectedVerificationTime = stage === "submission_admission" ? f.now().toISOString() : undefined;
    const request = f.run(() => f.records.currentRequest(review.id))!;
    expect(request.reason).toBe(reason);
    expect(request.signatureVerifiedAt).toBe(expectedVerificationTime);
    expect(request.submittedAt).toBeUndefined(); expect(request.execution).toBeUndefined();
    expect(f.verifyNetwork).toHaveBeenCalledOnce(); expect(f.sign).toHaveBeenCalledOnce();
    expect(f.submit).not.toHaveBeenCalled(); expect(f.chainRead).not.toHaveBeenCalled();

    const result = data(await call(TOOL_NAMES.sessionGetExecutionResult, { reviewSessionId: review.id }));
    const detail = data(await call(TOOL_NAMES.readGetReviewSessionDetail, { reviewSessionId: review.id, account: f.account }));
    const card = await review.read(), backup = await f.run(() => f.localData.exportLocalData(f.now()));
    expect(result.request.reason).toBe(reason); expect(detail.request.reason).toBe(reason);
    expect(card.data).toMatchObject({ request: { attemptId: request.attemptId, reason } });
    expect(detail.transitions.filter((t: { event: string }) => t.event === "signature_verified"))
      .toHaveLength(stage === "submission_admission" ? 1 : 0);
    expect(backup.data.reviewRequests.find((r) => r.attempt_id === request.attemptId))
      .toMatchObject({ reason, request_status: "request_failed", signature_verified_at: expectedVerificationTime ?? null, submitted_at: null });
    expect(backup.data.reviewStatusTransitions.find((t) => t.attempt_id === request.attemptId && t.to_status === "request_failed")?.reason).toBe(reason);
    for (const privateText of ["PRIVATE-RPC-DETAIL", "PRIVATE-SQLITE-DETAIL"]) {
      expect(JSON.stringify({ result, detail, card, backup, logs: f.logger.error.mock.calls })).not.toContain(privateText);
    }
  } finally { db.exec("DROP TRIGGER IF EXISTS reject_verification"); db.close(); }
});


it.each(["disconnected", "expired", "unavailable", "cleared", "pending_disconnect", "sdk_missing", "different_account"] as const)("requires an explicit asset address after %s without losing stored context or results", async (condition) => {
  const accountReader = vi.fn(async ({ account }: { account: string }) => ({ status: "ok" as const, account,
    fetchedAt: "2026-09-27T00:00:00.000Z", name: null, balances: [], nfts: [], objectGroups: [], scannedObjects: 0, objectsTruncated: false }));
  const { f, call } = await harness(true, false, accountReader);
  const { connection } = await f.approve();
  const status = data(await call(TOOL_NAMES.sessionGetInteractionStatus));
  expect(status.assetReadAccount).toEqual({ status: "available", account: f.account });
  expect(status.connections).toContainEqual(expect.objectContaining({ connectionId: connection.connectionId, status: "connected" }));
  const saved = data(await call(CARD_TOOLS.account));
  expect(saved).toMatchObject({ state: "closed", reason: "completed", input: { account: f.account } });
  const gate = deferred<void>();
  if (condition === "disconnected") f.notify();
  if (condition === "sdk_missing") { vi.spyOn(f.transport, "session").mockReturnValue(undefined); f.observe(); }
  if (condition === "different_account") f.notify({ ...f.transport.session("fixture-topic")!, accounts: [`0x${"c".repeat(64)}`] });
  if (condition === "expired") f.notify({ ...f.transport.session("fixture-topic")!, expiresAt: new Date(f.now().getTime() - 1).toISOString() });
  if (condition === "unavailable") { vi.spyOn(f.transport, "inspectAll").mockImplementation(() => { throw new Error("PRIVATE SDK ERROR"); }); f.observe(); }
  if (condition === "cleared") await f.run(() => f.activity.clearActiveAccount(f.now()));
  if (condition === "pending_disconnect") {
    vi.mocked(f.transport.disconnect).mockImplementationOnce(async () => { await gate.promise; });
    const card = await f.createConnection(); await f.act(card, { action: "disconnect", connectionId: connection.connectionId });
  }
  try {
    const unavailable = data(await call(TOOL_NAMES.sessionGetInteractionStatus));
    expect(unavailable.assetReadAccount).toEqual({ status: "address_required" });
    expect(unavailable.activeAccount.status).toBe(condition === "cleared" ? "none" : "set");
    expect(data(await call(CARD_TOOLS.account))).toMatchObject({ status: "input_required", field: "account" });
    expect(accountReader).toHaveBeenCalledTimes(1);
    const explicit = `0x${"b".repeat(64)}`;
    expect(data(await call(CARD_TOOLS.account, { account: explicit }))).toMatchObject({ state: "closed", data: { account: explicit } });
    expect(accountReader.mock.calls.map(([input]) => input.account)).toEqual([f.account, explicit]);
    expect((await f.run(() => f.cards.readSaved(saved.cardId))).data).toMatchObject({ account: f.account });
    expect(f.connect).toHaveBeenCalledOnce(); expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
  } finally { gate.resolve(); }
});

it.each(["missing_session", "changed_accounts", "unavailable"] as const)("projects reviews from the same confirmed %s wallet observation", async (condition) => {
  const { f, call } = await harness();
  const { connection } = await f.approve(), ready = await f.prepare(connection.connectionId);
  const approved = f.transport.session("fixture-topic")!;
  // Public reads return the last confirmed snapshot without awaiting SDK I/O.
  // A subsequent SDK observation must invalidate every dependent projection.
  vi.spyOn(f.transport, "session").mockImplementation(() => {
    if (condition === "unavailable") throw new Error("PRIVATE SDK FAILURE");
    return condition === "missing_session" ? undefined : { ...approved, accounts: [`0x${"d".repeat(64)}`] };
  });
  const previous = data(await call(TOOL_NAMES.sessionGetInteractionStatus));
  expect(previous.assetReadAccount).toEqual({ status: "available", account: f.account });
  f.observe();
  const status = data(await call(TOOL_NAMES.sessionGetInteractionStatus));
  const review = status.pendingReviewSessions.items.find((item: { reviewSessionId: string }) => item.reviewSessionId === ready.session.id);
  const stored = f.run(() => f.sessions.readReviewSession(ready.session.id))!;
  expect(review.status).toBe("refresh_required");
  expect(review.status).toBe(stored.status); expect(review.reviewRevision).toBe(stored.reviewRevision);
  expect(review.walletAvailability).toEqual(status.walletAvailability);
  if (condition !== "unavailable") {
    expect(review.reviewState.refreshReason).toBe("wallet_connection_changed");
    expect(review.reviewState.transactionReviewData).toBeUndefined();
  } else {
    expect(status.walletAvailability).toMatchObject({ status: "unavailable", reason: "wallet_state_unavailable" });
    expect(status.connections[0].status).toBe("connected"); // Last recorded, not confirmed absent.
  }
  expect(status.assetReadAccount).toEqual({ status: "address_required" });
  expect(JSON.stringify(status)).not.toContain("PRIVATE SDK FAILURE");
  expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});

it("removes a signature wait invalidated by a confirmed session observation without resubmission", async () => {
  const { f, call } = await harness(), { connection } = await f.approve(), ready = await f.prepare(connection.connectionId);
  const pending = deferred<{ transactionBytes: string; signature: string }>();
  f.sign.mockImplementationOnce(() => pending.promise);
  await f.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: 1 });
  await vi.waitFor(() => expect(f.sign).toHaveBeenCalledOnce());
  const request = f.run(() => f.records.currentRequest(ready.session.id))!;
  vi.spyOn(f.transport, "session").mockReturnValue(undefined); f.observe();
  try {
    const status = data(await call(TOOL_NAMES.sessionGetInteractionStatus));
    expect(f.run(() => f.records.request(request.attemptId))).toMatchObject({ requestStatus: "stopped",
      reason: "The wallet connection changed or became unavailable before submission. Nothing was submitted." });
    expect(status.pendingReviewSessions.items.some((item: { reviewSessionId: string }) => item.reviewSessionId === ready.session.id)).toBe(false);
    expect(f.run(() => f.records.authority(request.attemptId)?.can_submit)).toBe(0);
    expect(f.sign).toHaveBeenCalledOnce(); expect(f.submit).not.toHaveBeenCalled();
  } finally {
    pending.reject(new Error("Fixture wallet ended"));
    await vi.waitFor(() => expect(f.run(() => f.records.authority(request.attemptId)?.sdk_pending)).toBe(0));
  }
});

it("keeps a completed chain result after a confirmed session-loss observation", async () => {
  const { f, call } = await harness(), { connection } = await f.approve(), ready = await f.prepare(connection.connectionId);
  await f.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: 1 });
  await vi.waitFor(() => expect(f.run(() => f.records.currentRequest(ready.session.id)?.requestStatus)).toBe("completed"));
  const before = f.run(() => f.records.currentRequest(ready.session.id))!;
  vi.spyOn(f.transport, "session").mockReturnValue(undefined); f.observe();
  const status = data(await call(TOOL_NAMES.sessionGetInteractionStatus));
  expect(status.connections[0].status).toBe("disconnected");
  const result = data(await call(TOOL_NAMES.sessionGetExecutionResult, { reviewSessionId: ready.session.id }));
  expect(result.executionResult).toEqual(before.execution); expect(result.requestStatus).toBe("completed");
  expect(f.sign).toHaveBeenCalledOnce(); expect(f.submit).toHaveBeenCalledOnce();
});

it("advertises and opens disconnect controls without clearing context or disconnecting the wallet", async () => {
  const { f, client, call } = await harness(), { connection } = await f.approve();
  const before = await f.run(() => f.activity.getActiveAccount());
  const tools = (await client.listTools()).tools;
  const gateway = tools.find((tool) => tool.name === TOOL_NAMES.sessionOpenWalletConnectionCard)!;
  expect(gateway.description).toContain("disconnection");
  expect(gateway.description).not.toMatch(/must|should|always/i);
  expect(gateway.inputSchema.properties).not.toHaveProperty("action");
  const opened = data(await call(gateway.name));
  expect(opened.data.allowedActions).toContain("disconnect");
  expect(opened.data.connections).toContainEqual(expect.objectContaining({ connectionId: connection.connectionId, status: "connected" }));
  expect(await f.run(() => f.activity.getActiveAccount())).toEqual(before);
  expect(f.transport.disconnect).not.toHaveBeenCalled();
  expect(f.connect).toHaveBeenCalledOnce(); expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});

it.each(["sdk_pending", "submit_pending", "lookup_pending", "request_deadline", "connection_expiry"] as const)(
  "reads the exact completed result through every consumer while unrelated %s writes keep failing", async (failure) => {
    const { f, call, client } = await harness(), { connection } = await f.approve(), target = await f.prepare(connection.connectionId);
    await f.act(target.card, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: target.session.reviewRevision });
    await vi.waitFor(() => expect(f.run(() => f.records.currentRequest(target.session.id)?.requestStatus)).toBe("completed"));
    const original = f.run(() => f.records.currentRequest(target.session.id))!;
    const db = new Database(join(f.directory, "activity.sqlite"));
    let otherId: string | undefined;
    try {
      if (failure === "connection_expiry") {
        const pending = { ...connection, connectionId: "other-pairing", status: "awaiting_approval", accounts: [], methods: [], revision: 0,
          expiresAt: new Date(f.now().getTime() - 1).toISOString() };
        db.prepare("INSERT INTO live_wallet_connections (id,owner_id,status,revision,topic,sdk_pending,run_id,connection_json) VALUES (?,?,?,?,?,?,?,?)")
          .run(pending.connectionId, "fixture-owner", pending.status, 0, null, 1, f.runtime.runId, JSON.stringify(pending));
        db.exec("CREATE TRIGGER refuse_other BEFORE UPDATE ON live_wallet_connections WHEN OLD.id='other-pairing' BEGIN SELECT RAISE(ABORT,'unrelated write refused'); END");
      } else {
        const other = await f.prepare(connection.connectionId);
        if (failure === "request_deadline") f.sign.mockImplementationOnce(() => deferred<{ transactionBytes: string; signature: string }>().promise);
        else db.exec(`CREATE TRIGGER refuse_other BEFORE UPDATE OF ${failure} ON live_request_authority
          WHEN OLD.${failure}=1 AND NEW.${failure}=0 BEGIN SELECT RAISE(ABORT,'unrelated write refused'); END`);
        await f.act(other.card, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: other.session.reviewRevision });
        await vi.waitFor(() => expect(f.run(() => f.records.currentRequest(other.session.id)?.requestStatus)).toBe(failure === "request_deadline" ? "awaiting_signature" : "completed"));
        otherId = f.run(() => f.records.currentRequest(other.session.id))!.attemptId;
        if (failure === "request_deadline") {
          db.prepare("UPDATE live_request_authority SET signature_deadline=? WHERE attempt_id=?").run(new Date(f.now().getTime() - 1).toISOString(), otherId);
          db.exec(`CREATE TRIGGER refuse_other BEFORE UPDATE OF request_status ON review_requests WHEN OLD.attempt_id='${otherId}' BEGIN SELECT RAISE(ABORT,'unrelated write refused'); END`);
        } else await vi.waitFor(() => expect(f.logger.error).toHaveBeenCalled());
      }
      const dispatches = f.submit.mock.calls.length;
      const management = data(await call(TOOL_NAMES.sessionOpenReviewManagement, { reviewSessionId: target.session.id, attemptId: original.attemptId }));
      expect(management.data.request).toEqual(original);
      for (const tool of [TOOL_NAMES.sessionGetReviewStatus, TOOL_NAMES.sessionGetExecutionResult, TOOL_NAMES.sessionWaitExecutionResult]) {
        const result = data(await call(tool, { reviewSessionId: target.session.id }));
        expect(result.request).toEqual(original);
      }
      for (const id of [target.card.snapshot.cardId, management.cardId]) {
        const saved = await f.run(() => client.readResource({ uri: `${CARD_RESOURCE_PREFIX}${id}` }));
        expect(JSON.parse(String("text" in saved.contents[0]! ? saved.contents[0].text : "")).data.request).toEqual(original);
      }
      expect((await f.read(target.card)).snapshot.data).toMatchObject({ request: original });
      expect(() => f.run(() => f.workflow.reconcileConnectionContext())).toThrow("unrelated write refused");
      if (otherId && failure !== "request_deadline" && failure !== "connection_expiry") {
        expect(f.run(() => f.records.authority(otherId!))?.[failure]).toBe(1);
        await expect(f.run(() => f.localData.resetLocalData())).rejects.toThrow();
      }
      expect(f.submit).toHaveBeenCalledTimes(dispatches);
      db.exec("DROP TRIGGER refuse_other");
      f.run(() => f.workflow.reconcileConnectionContext());
      expect(f.run(() => f.records.request(original.attemptId))).toEqual(original);
      if (otherId && failure !== "request_deadline" && failure !== "connection_expiry") expect(f.run(() => f.records.authority(otherId!))?.[failure]).toBe(0);
      if (failure === "connection_expiry") expect(f.run(() => f.records.connection("other-pairing")?.connection.status)).toBe("expired");
      if (failure === "request_deadline") expect(f.run(() => f.records.request(otherId!)?.requestStatus)).toBe("request_failed");
    } finally { db.exec("DROP TRIGGER IF EXISTS refuse_other"); db.close(); }
  });

it("keeps own completed facts readable during callback repair, but reports an own-session expiry write error", async () => {
  const { f, call } = await harness(), { connection } = await f.approve(), ready = await f.prepare(connection.connectionId);
  const db = new Database(join(f.directory, "activity.sqlite"));
  try {
    db.exec("CREATE TRIGGER refuse_callback BEFORE UPDATE OF lookup_pending ON live_request_authority WHEN OLD.lookup_pending=1 AND NEW.lookup_pending=0 BEGIN SELECT RAISE(ABORT,'callback refused'); END");
    await f.act(ready.card, { action: "request_signature", connectionId: connection.connectionId, account: f.account, reviewRevision: ready.session.reviewRevision });
    await vi.waitFor(() => expect(f.run(() => f.records.currentRequest(ready.session.id)?.requestStatus)).toBe("completed"));
    const original = f.run(() => f.records.currentRequest(ready.session.id))!, lookups = f.chainRead.mock.calls.length;
    expect(data(await call(TOOL_NAMES.sessionGetExecutionResult, { reviewSessionId: ready.session.id })).request).toEqual(original);
    expect(f.run(() => f.records.authority(original.attemptId)?.lookup_pending)).toBe(1);
    expect(f.chainRead).toHaveBeenCalledTimes(lookups);
    db.exec("DROP TRIGGER refuse_callback");
    f.advance(Date.parse(ready.session.expiresAt) - f.now().getTime() + 1);
    db.exec("CREATE TRIGGER refuse_expiry BEFORE UPDATE OF status ON live_review_sessions WHEN NEW.status='expired' BEGIN SELECT RAISE(ABORT,'own expiry refused'); END");
    expect((await call(TOOL_NAMES.sessionGetExecutionResult, { reviewSessionId: ready.session.id })).isError).toBe(true);
    expect(f.run(() => f.records.request(original.attemptId))).toEqual(original);
    db.exec("DROP TRIGGER refuse_expiry");
    expect(data(await call(TOOL_NAMES.sessionGetReviewStatus, { reviewSessionId: ready.session.id }))).toMatchObject({ status: "expired", request: original });
    expect(f.submit).toHaveBeenCalledOnce(); expect(f.chainRead).toHaveBeenCalledTimes(lookups);
  } finally { db.close(); }
});
