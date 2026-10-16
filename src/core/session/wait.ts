import type { ExecutionPollingStatus, ReviewSnapshot } from "./status.js";
import {
  EXECUTION_POLLING_INTERVAL_SECONDS,
  getExecutionPollingStatus,
  executionStatusCategory,
  isWaitStoppingExecutionStatus
} from "./status.js";
import { SessionStoreError } from "./sessionStore.js";
import type { CardStore } from "./cardSessionStore.js";
import { WALLET_CONNECTION_POLL_SECONDS } from "./walletConnection.js";

export const DEFAULT_WAIT_TIMEOUT_MS = 45_000;
export const MAX_WAIT_TIMEOUT_MS = 55_000;

export const WAIT_OUTCOMES = ["status_reached", "timed_out", "unavailable"] as const;
export type WaitOutcome = (typeof WAIT_OUTCOMES)[number];
export type WalletStatusCategory = "terminal" | "non_terminal";
export type WaitSessionMissingReason = "missing" | "session_removed_during_wait";
export type WaitAbortReason = "host_abort";

export class WaitRequestAbortedError extends Error {
  constructor(readonly reason: WaitAbortReason = "host_abort") {
    super("Wait request aborted");
  }
}

export type ExecutionWaitResult = ReviewSnapshot & { waitOutcome: WaitOutcome; status: ExecutionPollingStatus };
export type ReviewStateReader = (reviewSessionId: string, now?: Date) => Promise<ReviewSnapshot | undefined>;
type WaitOptions = {
  timeoutMs?: number | undefined;
  signal?: AbortSignal;
  now?: () => Date;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export async function waitForWalletConnection(cards: CardStore, cardId: string, options: WaitOptions = {}) {
  const timeout = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const started = Date.now(), sleep = options.sleep ?? sleepMs;
  while (true) {
    assertNotAborted(options.signal);
    const state = await cards.readWalletOperation(cardId), operation = state.operation;
    if (!operation || operation.status !== "running" && !operation.settlementPending) return { ...state, waitOutcome: "status_reached" as const };
    if (state.walletAvailability.status !== "available") return { ...state, waitOutcome: "unavailable" as const };
    const remaining = timeout - (Date.now() - started);
    if (remaining <= 0) return { ...state, waitOutcome: "timed_out" as const };
    await sleep(Math.min(remaining, WALLET_CONNECTION_POLL_SECONDS * 1000), options.signal);
  }
}

export async function waitForExecutionResult(
  readState: ReviewStateReader,
  reviewSessionId: string,
  options: WaitOptions = {}
): Promise<ExecutionWaitResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const sleep = options.sleep ?? sleepMs, startedAt = Date.now();
  let reason: WaitSessionMissingReason = "missing";
  while (true) {
    assertNotAborted(options.signal);
    const state = await readState(reviewSessionId, options.now?.());
    if (!state) throw new SessionStoreError("session_not_found", `Review session not found: ${reviewSessionId}`, { reason });
    const status = getExecutionPollingStatus(state.session, state.request);
    if (executionStatusCategory(status) === "final") return { ...state, status, waitOutcome: "status_reached" };
    if (state.progress.status === "unavailable") return { ...state, status, waitOutcome: "unavailable" };
    if (isWaitStoppingExecutionStatus(status)) return { ...state, status, waitOutcome: "status_reached" };
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) return { ...state, status, waitOutcome: "timed_out" };
    await sleep(Math.min(remaining, EXECUTION_POLLING_INTERVAL_SECONDS * 1000), options.signal);
    reason = "session_removed_during_wait";
  }
}

function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new WaitRequestAbortedError());
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(new WaitRequestAbortedError());
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new WaitRequestAbortedError();
  }
}
