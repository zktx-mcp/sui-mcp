import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewSession } from "../src/core/action/types.js";
import type { ReviewSnapshot } from "../src/core/session/status.js";
import type { CardStore } from "../src/core/session/cardSessionStore.js";
import { CardError } from "../src/core/session/cardSessionStore.js";
import type { CardSnapshot } from "../src/core/session/cardSession.js";
import type { TransactionRequest } from "../src/core/session/transactionRequest.js";
import { WaitRequestAbortedError, waitForExecutionResult, waitForWalletConnection } from "../src/core/session/wait.js";
import { CONNECT_BOUNDARY } from "../src/core/session/workflowView.js";
import { chainReceiptDigest } from "./fixtures/chainReceipt.js";

const review: ReviewSession = { id: "review", ownerId: "owner", reviewRevision: 1, tokenHash: "private",
  status: "ready_for_wallet_review", plans: [], createdAt: new Date(0).toISOString(), expiresAt: new Date(1000).toISOString(), lastActivityAt: new Date(0).toISOString() };
const request: TransactionRequest = { attemptId: "attempt", reviewSessionId: "review", planId: "plan", reviewRevision: 1,
  account: `0x${"a".repeat(64)}`, transactionDigest: chainReceiptDigest, requestStatus: "awaiting_signature", revision: 0,
  createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
const connection: CardSnapshot = { cardId: "card", kind: "connect", state: "running", revision: 1,
  createdAt: new Date(0).toISOString(), expiresAt: new Date(1000).toISOString(), input: {}, pollAfterMs: 5000, inputRemainingMs: 0,
  data: { kind: "connect", mode: "connect", allowedActions: [], manageableConnectionIds: [], actionRemainingMs: 1000, observe: true,
    walletAvailability: { status: "available", walletRunId: "00000000-0000-4000-8000-000000000001" }, progress: { status: "waiting" }, boundary: CONNECT_BOUNDARY, connections: [] } };
const stateReader = (read: () => Promise<ReviewSession | undefined>, readRequest?: () => TransactionRequest) => async (): Promise<ReviewSnapshot | undefined> => {
  const session = await read();
  return session ? { session, hasReviewInput: false, request: readRequest?.(), walletAvailability: { status: "available", walletRunId: "00000000-0000-4000-8000-000000000001" }, progress: { status: readRequest ? "waiting" : "idle" } } : undefined;
};
const cardStore = (read: () => Promise<CardSnapshot>) => ({ readSaved: read }) as unknown as CardStore;
afterEach(() => vi.useRealTimers());

describe("bounded stored-state waits", () => {
  it("does not wait for user preparation or claim that it is already signing", async () => {
    await expect(waitForExecutionResult(stateReader(async () => review), "review")).resolves.toMatchObject({ waitOutcome: "status_reached", status: "ready_for_wallet_review", request: undefined });
  });
  it("reads the same attempt until its local request ends, without inventing a chain result", async () => {
    vi.useFakeTimers(); let current = request;
    const wait = waitForExecutionResult(stateReader(async () => review, () => current), "review", { timeoutMs: 4000 });
    current = { ...request, requestStatus: "request_failed" };
    await vi.advanceTimersByTimeAsync(3000);
    await expect(wait).resolves.toMatchObject({ waitOutcome: "status_reached", status: "request_failed", request: { attemptId: "attempt" } });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("resolves concurrent observers from the same stored request", async () => {
    vi.useFakeTimers(); let current = request;
    const options = { timeoutMs: 4000 };
    const first = waitForExecutionResult(stateReader(async () => review, () => current), "review", options);
    const second = waitForExecutionResult(stateReader(async () => review, () => current), "review", options);
    current = { ...request, requestStatus: "outcome_unknown" };
    await vi.advanceTimersByTimeAsync(3000);
    for (const wait of [first, second]) await expect(wait).resolves.toMatchObject({ status: "outcome_unknown" });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("times out wallet observation without cancelling or reconnecting", async () => {
    vi.useFakeTimers(); const read = vi.fn(async () => connection);
    const wait = waitForWalletConnection(cardStore(read), "card", { timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    await expect(wait).resolves.toMatchObject({ waitOutcome: "timed_out", snapshot: { state: "running" } });
    expect(read).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
  it("returns immediately for an unsubmitted connection card", async () => {
    await expect(waitForWalletConnection(cardStore(async () => ({ ...connection, state: "ready", data: { ...connection.data as object, observe: false } })), "card"))
      .resolves.toMatchObject({ waitOutcome: "status_reached", snapshot: { state: "ready" } });
  });
  it.each(["connection", "request"] as const)("cleans the %s wait on host abort", async (kind) => {
    vi.useFakeTimers(); const controller = new AbortController();
    const wait = kind === "connection" ? waitForWalletConnection(cardStore(async () => connection), "card", { signal: controller.signal }) :
      waitForExecutionResult(stateReader(async () => review, () => request), "review", { signal: controller.signal });
    const rejection = expect(wait).rejects.toBeInstanceOf(WaitRequestAbortedError);
    await vi.advanceTimersByTimeAsync(0); controller.abort(); await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not read after an already aborted host request", async () => {
    const controller = new AbortController(); controller.abort(); const read = vi.fn(async () => connection);
    await expect(waitForWalletConnection(cardStore(read), "card", { signal: controller.signal })).rejects.toBeInstanceOf(WaitRequestAbortedError);
    expect(read).not.toHaveBeenCalled();
  });
  it("reports a removed review instead of endlessly polling", async () => {
    vi.useFakeTimers(); let current: ReviewSession | undefined = review;
    const wait = waitForExecutionResult(stateReader(async () => current, () => request), "review");
    const rejection = expect(wait).rejects.toMatchObject({ code: "session_not_found", details: { reason: "session_removed_during_wait" } });
    await vi.advanceTimersByTimeAsync(0); current = undefined; await vi.advanceTimersByTimeAsync(3000); await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("stops wallet waits if the card is removed", async () => {
    vi.useFakeTimers(); const read = vi.fn(async () => connection);
    const wait = waitForWalletConnection(cardStore(read), "card"); const rejection = expect(wait).rejects.toBeInstanceOf(CardError);
    await vi.advanceTimersByTimeAsync(0); read.mockRejectedValueOnce(new CardError("Saved card data is unavailable."));
    await vi.advanceTimersByTimeAsync(5000); await rejection; expect(vi.getTimerCount()).toBe(0);
  });
  it("cleans up a request wait if a later store read fails", async () => {
    vi.useFakeTimers(); const read = vi.fn(async () => review);
    const wait = waitForExecutionResult(stateReader(read, () => request), "review"); const rejection = expect(wait).rejects.toThrow("read failed");
    await vi.advanceTimersByTimeAsync(0); read.mockRejectedValueOnce(new Error("read failed")); await vi.advanceTimersByTimeAsync(3000);
    await rejection; expect(vi.getTimerCount()).toBe(0);
  });
});
