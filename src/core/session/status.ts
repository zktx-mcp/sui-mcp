import type { InternalSessionStatus, ReviewSession } from "../action/types.js";
import { isRequestWaiting, type TransactionRequest, type TransactionRequestStatus } from "./transactionRequest.js";
import { workflowProgress, type WalletAvailability, type WorkflowProgress } from "./walletConnection.js";
import type { WalletObservation } from "./walletRuntime.js";

export type ReviewSnapshot = {
  session: ReviewSession;
  request?: TransactionRequest | undefined;
  walletAvailability: WalletAvailability;
  walletObservation?: WalletObservation | undefined;
  progress: WorkflowProgress;
  hasReviewInput: boolean;
  connectionReconciliationRequired?: true | undefined;
};
export function reviewProgress(preparing: boolean, request: TransactionRequest | undefined,
  availability: WalletAvailability, observation: { stopped: boolean; pending: boolean }): WorkflowProgress {
  if (preparing) return workflowProgress(true, true, availability);
  if (request?.requestStatus === "completed") return { status: "idle" };
  const waiting = !!request && !observation.stopped &&
    (observation.pending || ["awaiting_signature", "submitting", "awaiting_chain_result"].includes(request.requestStatus));
  return workflowProgress(waiting, request?.requestStatus === "awaiting_signature", availability);
}

export const EXECUTION_POLLING_INTERVAL_SECONDS = 3;
export type ExecutionPollingStatus = InternalSessionStatus | TransactionRequestStatus;
export const EXECUTION_STATUS_CATEGORIES = ["final", "user_action_required", "awaiting_chain_result", "non_terminal"] as const;
export type ExecutionStatusCategory = (typeof EXECUTION_STATUS_CATEGORIES)[number];

export function isFinalSessionStatus(status: InternalSessionStatus): boolean { return status === "expired"; }
export function getExecutionPollingStatus(session: ReviewSession, request?: TransactionRequest): ExecutionPollingStatus {
  return request?.requestStatus ?? session.status;
}
export function executionStatusCategory(status: ExecutionPollingStatus): ExecutionStatusCategory {
  if (["completed", "request_failed", "stopped", "outcome_unknown", "expired"].includes(status)) return "final";
  if (status === "awaiting_chain_result") return "awaiting_chain_result";
  if (status === "awaiting_signature" || status === "submitting") return "non_terminal";
  return "user_action_required";
}
export function isWaitStoppingExecutionStatus(status: ExecutionPollingStatus): boolean {
  const category = executionStatusCategory(status);
  return category === "final" || category === "user_action_required";
}
export function isInteractionPendingReviewStatus(status: ExecutionPollingStatus): boolean {
  return executionStatusCategory(status) !== "final";
}
export function isReviewInteractionPending({ hasReviewInput, request, progress }: ReviewSnapshot): boolean {
  // Historical preparation state is not proof that a live input remains.
  // Consumed input, in turn, does not end its admitted request or observation.
  return hasReviewInput || progress.status !== "idle" || !!request && isRequestWaiting(request.requestStatus);
}
export function executionPollingHint() {
  return {
    nonTerminalStatuses: ["awaiting_signature", "submitting", "awaiting_chain_result"] as ExecutionPollingStatus[],
    waitStoppingStatuses: ["proposed", "awaiting_wallet", "wallet_connected", "ready_for_wallet_review", "refresh_required", "blocked", "expired",
      "stopped", "request_failed", "outcome_unknown", "completed"] as ExecutionPollingStatus[],
    finalStatuses: ["stopped", "request_failed", "outcome_unknown", "completed", "expired"] as ExecutionPollingStatus[],
    userActionRequiredStatuses: ["proposed", "awaiting_wallet", "wallet_connected", "ready_for_wallet_review", "refresh_required", "blocked"] as ExecutionPollingStatus[],
    recommendedIntervalSeconds: EXECUTION_POLLING_INTERVAL_SECONDS
  };
}
export function reviewStatusResponse({ session, request, walletAvailability, walletObservation, progress, connectionReconciliationRequired }: ReviewSnapshot) {
  const pollingStatus = getExecutionPollingStatus(session, request);
  return {
    walletAvailability, walletObservation, progress, connectionReconciliationRequired,
    reviewSessionId: session.id, status: session.status, reviewRevision: session.reviewRevision,
    account: session.account, plans: session.plans, reviewState: session.reviewState,
    pollingStatus, statusCategory: executionStatusCategory(pollingStatus), pollingHint: executionPollingHint(),
    expiresAt: session.expiresAt, lastActivityAt: session.lastActivityAt,
    ...(request ? { attemptId: request.attemptId, requestStatus: request.requestStatus, request,
      ...(request.execution ? { executionResult: request.execution } : {}) } : {})
  };
}
