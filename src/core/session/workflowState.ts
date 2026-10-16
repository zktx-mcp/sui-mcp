import type { ReviewSession } from "../action/types.js";
import type { z } from "zod";
import type { reviewStateOutputSchema } from "../action/schemas.js";
import type { CardRecord, ReceiptDisplay } from "./cardSession.js";
import { CONNECTION_RECONCILIATION_MESSAGE, walletConnectionEligibility, usableWalletConnection, connectionHasSuiSigningScope, projectWalletConnection, type WalletAvailability, type ConnectionView, type AssetReadAccount, type WalletConnectionPresence } from "./walletConnection.js";
import { isInitialChainObservation, type TransactionRequest } from "./transactionRequest.js";
import type { RequestAuthority } from "./sqliteWalletWorkflowStore.js";
import type { ReviewEvaluationCandidate } from "./reviewValidity.js";
import type { EventLogRecord } from "../eventlog/sink.js";
import type { WalletObservation } from "./walletRuntime.js";
import { SUI_MAINNET_WALLET_CHAIN, type WalletChainId } from "./chainAccounts.js";
import type { WalletConnectionOperation, PendingWalletConnectionOperation } from "./walletConnectionOperations.js";
import { parseSuiAddress } from "../suiAddress.js";

export const workflowActions = ["connect", "disconnect", "stop_connection", "prepare_review",
  "request_signature", "cancel", "stop_waiting", "read_result"] as const;
export type WorkflowAction = (typeof workflowActions)[number];
export const workflowNextSteps = ["none", "wait", "check_status", "open_settings", "request_disconnect", "request_review"] as const;
export type WorkflowNextStep = { kind: (typeof workflowNextSteps)[number]; message?: string; reason?: string };
function walletServiceNextStep(status: WalletAvailability["status"]): WorkflowNextStep | undefined {
  if (status === "available") return undefined;
  return { kind: status === "unavailable" ? "open_settings" : "wait", reason: "wallet_unavailable",
    message: status === "unavailable" ? "Open Settings, then Troubleshooting, to restart the connection service. No wallet request was sent."
      : "Wait for the connection service to finish starting, then check status." };
}
export function walletActionDecision(facts: ConnectionFacts & { walletAvailability: Pick<WalletAvailability, "status"> },
  action: "connect" | "disconnect", targetId?: string): { allowed: boolean; nextStep: WorkflowNextStep } {
  const deny = (kind: WorkflowNextStep["kind"], reason: string, message: string) => ({ allowed: false, nextStep: { kind, reason, message } });
  const service = walletServiceNextStep(facts.walletAvailability.status);
  if (service) return { allowed: false, nextStep: service };
  if (facts.pendingOperation) return deny("check_status", "operation_busy", "Wait for the current wallet operation and its cleanup to finish, then check this request's status.");
  const selection = walletConnectionEligibility(facts.connection, Date.parse(facts.evaluatedAt), facts.connectionPresence, facts.activeAccount, facts.readAddressCleared);
  if (!facts.connectionPresence.confirmed || !facts.connectionPresence.managed || selection.connectionReconciliationRequired) return deny("check_status", "connection_state_unconfirmed",
    selection.connectionReconciliationRequired ? CONNECTION_RECONCILIATION_MESSAGE : "The wallet session has not been confirmed. Check its status before continuing.");
  if (action === "connect") {
    if (!facts.requestedChains.length) return deny("open_settings", "wallet_networks_required", "Choose networks in Settings before requesting a wallet connection.");
    return selection.pairingAllowed ? { allowed: true, nextStep: { kind: "none" } }
      : deny("request_disconnect", "connection_present", "Ask in chat for a Disconnect card before requesting a new wallet connection.");
  }
  if (targetId && facts.connection?.connectionId !== targetId) return deny("check_status", "connection_target_changed", "The wallet session for this card is no longer current. Ask in chat for current connection status.");
  return selection.manageable ? { allowed: true, nextStep: { kind: "none" } }
    : deny("none", "no_session_to_disconnect", "There is no current wallet session to disconnect. No request was sent.");
}

export type { ConnectionView } from "./walletConnection.js";
export type ReviewWalletTarget = { connectionId: string; account: string };
// A target comes from the original card or that same review's stored binding,
// never from the current wallet or the optional address used for public reads.
export function fixedReviewTarget(session: Pick<ReviewSession, "account" | "walletConnectionId">,
  input?: Record<string, unknown>): ReviewWalletTarget | undefined {
  const hasInputTarget = input?.connectionId !== undefined || input?.account !== undefined;
  const inputId = typeof input?.connectionId === "string" && input.connectionId.length ? input.connectionId : undefined;
  const inputAccount = typeof input?.account === "string" ? parseSuiAddress(input.account) : undefined;
  if (hasInputTarget && (!inputId || !inputAccount)) return undefined;
  if (inputId && session.walletConnectionId && inputId !== session.walletConnectionId ||
      inputAccount && session.account && inputAccount !== session.account) return undefined;
  const connectionId = inputId ?? session.walletConnectionId, account = inputAccount ?? session.account;
  return connectionId && account ? { connectionId, account } : undefined;
}
// Collected from one SQLite read snapshot. This is not a maintenance request
// or authority to apply an operation; only public projections leave the core.
export type ConnectionFacts = {
  evaluatedAt: string; activeAccount?: string | undefined;
  readAddressCleared: boolean; requestedChains: WalletChainId[];
  connection?: ConnectionView | undefined;
  pendingOperation?: PendingWalletConnectionOperation | undefined;
  connectionPresence: WalletConnectionPresence;
  walletObservation?: WalletObservation | undefined;
};
export type ConnectionContext = {
  connection?: ConnectionView | undefined; walletAvailability: WalletAvailability;
  pendingOperation?: PendingWalletConnectionOperation | undefined;
  walletObservation?: WalletObservation | undefined;
  requestedChains: WalletChainId[];
  assetReadAccount: AssetReadAccount; canDisconnect: boolean;
  connectionReconciliationRequired?: true | undefined;
};
export type WorkflowEligibilityFacts = ConnectionFacts & {
  ownerId: string; record?: CardRecord | undefined;
  walletAvailability: Pick<WalletAvailability, "status">;
  walletDependent?: boolean | undefined;
  connection?: ConnectionView | undefined;
  session?: ReviewSession | undefined; request?: TransactionRequest | undefined;
  authority?: RequestAuthority | undefined; busyForAccount: boolean;
  operation?: WalletConnectionOperation | undefined;
};
export type WorkflowFacts = WorkflowEligibilityFacts & {
  walletAvailability: WalletAvailability;
  walletObservation?: WalletObservation | undefined;
  hasReviewInput: boolean;
  boundReview?: z.infer<typeof reviewStateOutputSchema> | undefined;
  receipt?: unknown; receiptDisplay?: ReceiptDisplay | undefined;
};
export type EvaluatedWorkflowState = WorkflowFacts & {
  allowedActions: WorkflowAction[]; actionRemainingMs: number; inputRemainingMs: number;
  usableConnectionId?: string | undefined; assetReadAccount?: AssetReadAccount | undefined;
  canDisconnect: boolean; connectionReconciliationRequired?: true | undefined;
  nextStep: WorkflowNextStep;
  nextStateReadAfterMs?: number | undefined; events: EventLogRecord[];
  preparationIssue?: string | undefined;
  reviewTarget?: { connectionId: string; account: string } | undefined;
};
export type WorkflowEvaluationInput = {
  expectedCard?: CardRecord | undefined; walletAvailability: WalletAvailability;
  walletObservation?: WalletObservation | undefined;
  uiObservation?: boolean | undefined;
} & ({ purpose: "current_wallet" } | { purpose: "review"; reviewSessionId: string;
  readTarget: ReviewReadTarget; candidate: ReviewEvaluationCandidate });
// Bound before asynchronous inspection and checked again in the DB transaction.
// A live input needs current wallet eligibility even when an older attempt exists.
export type ReviewReadTarget = {
  reviewSessionId: string; attemptId?: string | undefined; walletDependent: boolean;
};

export function workflowConnectionEligibility(facts: ConnectionFacts & {
  walletAvailability: Pick<WalletAvailability, "status">; walletDependent?: boolean | undefined;
}) {
  const selection = walletConnectionEligibility(facts.connection, Date.parse(facts.evaluatedAt), facts.connectionPresence,
    facts.activeAccount, facts.readAddressCleared);
  const available = facts.walletAvailability.status === "available", dependent = facts.walletDependent !== false;
  return { selection, usableConnectionId: available && dependent ? selection.connection?.connectionId : undefined,
    assetReadAccount: !dependent ? undefined : available ? selection.assetReadAccount : { status: "address_required" as const },
    connection: projectWalletConnection(facts.connection, Date.parse(facts.evaluatedAt), facts.connectionPresence, available),
    pendingOperation: facts.pendingOperation,
    canDisconnect: available && selection.manageable,
    connectionReconciliationRequired: available && dependent ? selection.connectionReconciliationRequired : undefined };
}

// Shared domain eligibility. The DB supplies current facts at its decision
// boundary. Returned choices are advisory; admission still binds concrete input.
export function workflowEligibility(facts: WorkflowEligibilityFacts) {
  const { record, session, request, authority, walletAvailability } = facts;
  const at = Date.parse(facts.evaluatedAt);
  const cardRemaining = record?.ownerId === facts.ownerId && record.state.reason !== "cancelled"
    ? Math.max(0, Date.parse(record.state.expiresAt) - at) : 0;
  // A later-created input card cannot extend its review session. Admitted
  // requests and management cards retain their separate observation authority.
  const remaining = record?.scope === "review" && session && !request
    ? Math.min(cardRemaining, Math.max(0, Date.parse(session.expiresAt) - at)) : cardRemaining;
  const inputAvailable = remaining > 0 && record?.state.state === "ready" && record.acceptedInput === undefined;
  const allowedActions: WorkflowAction[] = [];
  const { selection, ...connectionEligibility } = workflowConnectionEligibility(facts);
  const reviewTarget = session && !session.plans[0]?.reviewModel ? fixedReviewTarget(session, record?.state.input) : undefined;
  const targetId = reviewTarget?.connectionId, targetAccount = reviewTarget?.account;
  const reviewConnection = walletAvailability.status === "available" && !facts.connectionPresence.unrecorded && facts.walletDependent !== false && targetId && targetAccount
    ? usableWalletConnection(facts.connection, at, facts.connectionPresence, targetId, SUI_MAINNET_WALLET_CHAIN, targetAccount) : undefined;
  const preparationIssue = session && record?.scope === "review" && !session.plans[0]?.reviewModel && !reviewTarget
    ? "This review has no matching fixed wallet target. Start a new review." : undefined;
  const scopedDisconnect = record?.scope === "disconnect";
  const walletDecision = walletActionDecision(facts, scopedDisconnect ? "disconnect" : "connect", scopedDisconnect ? String(record?.state.input.connectionId) : undefined);
  let nextStep: WorkflowNextStep = facts.operation?.status === "running" && facts.operation.cardId === record?.state.cardId
    ? { kind: "wait" } : walletDecision.nextStep;
  const disconnectTargetMatches = !scopedDisconnect || record.state.input.connectionId === facts.connection?.connectionId;
  if (record?.scope === "connect" || scopedDisconnect) {
    if (inputAvailable) {
      allowedActions.push("cancel");
      if (walletAvailability.status === "available") {
        if (record.scope === "connect" && walletDecision.allowed) allowedActions.push("connect");
        if (scopedDisconnect && walletDecision.allowed) allowedActions.push("disconnect");
      }
    }
    if (record.state.state !== "closed" && remaining > 0 && facts.operation?.action === "connect" && facts.operation.status === "running") allowedActions.push("stop_connection");
  }
  if (session && inputAvailable && record?.scope === "review" && session.status !== "expired" && Date.parse(session.expiresAt) > at && !session.preparationId) {
    allowedActions.push("cancel");
    if (walletAvailability.status === "available" && reviewConnection && !session.plans[0]?.reviewModel) {
      if (!facts.busyForAccount) allowedActions.push("prepare_review");
      if (!facts.busyForAccount && connectionHasSuiSigningScope(reviewConnection, targetAccount!) && session.status === "ready_for_wallet_review" && session.reviewState?.transactionReviewData &&
          (!request || request.reviewRevision !== session.reviewRevision)) allowedActions.push("request_signature");
    }
  }
  if (record && record.state.state !== "closed" && session && remaining > 0 && request && request.reviewSessionId === session.id &&
      authority?.owner_id === facts.ownerId &&
      (record.operationId === request.attemptId || record.scope === "review_manage" && record.state.input.attemptId === request.attemptId)) {
    if (request.requestStatus === "awaiting_signature" || !authority.observation_stopped && isInitialChainObservation(request.requestStatus)) allowedActions.push("stop_waiting");
    if (record.scope === "review_manage" && record.state.state === "ready" && record.acceptedInput === undefined && (isInitialChainObservation(request.requestStatus) || request.requestStatus === "outcome_unknown")) allowedActions.push("read_result");
  }
  const expiry = session && inputAvailable && record?.scope === "review" && !session.preparationId &&
    session.status === "ready_for_wallet_review" && (!request || request.reviewRevision !== session.reviewRevision)
      ? session.reviewState?.humanReadableReview?.freshness.expiresAt : undefined;
  const reviewRead = expiry && session ? Math.min(remaining, Date.parse(session.expiresAt) - at, Date.parse(expiry) - at) : undefined;
  const connectionDeadlines = inputAvailable && facts.walletDependent !== false && facts.connection?.status === "connected" &&
    (["connect", "disconnect"].includes(record?.scope ?? "") || facts.connection.connectionId === reviewTarget?.connectionId)
    ? [Date.parse(facts.connection.expiresAt) - at].filter((delay) => delay > 0) : [];
  const readDelays = [reviewRead, ...connectionDeadlines].filter((delay): delay is number => delay !== undefined && delay > 0);
  const nextRead = readDelays.length ? Math.min(...readDelays) : undefined;
  if (session) {
    nextStep = { kind: "none" };
    if (!session.plans[0]?.reviewModel && !request) {
      const service = walletServiceNextStep(walletAvailability.status);
      if (service) nextStep = service;
      else if (facts.connectionPresence.unrecorded) nextStep = { kind: "check_status", reason: "connection_state_unconfirmed", message: CONNECTION_RECONCILIATION_MESSAGE };
      else if (facts.pendingOperation) nextStep = { kind: "check_status", reason: "operation_busy", message: "Wait for the current wallet operation and its cleanup to finish, then check this review's status." };
      else if (reviewTarget && connectionEligibility.connection?.connectionId === targetId && connectionEligibility.connection?.sessionPresence === "absent") nextStep = { kind: "request_review", message: "The original wallet session is no longer present. Reconnect a wallet and ask in chat for a new transaction review." };
      else if (reviewTarget && facts.connection && facts.connection.connectionId !== targetId) nextStep = { kind: "request_review", message: "This review belongs to the earlier wallet connection. Ask in chat for a new transaction review." };
      else if (!reviewConnection && connectionEligibility.canDisconnect && facts.connection?.connectionId === targetId) nextStep = { kind: "request_disconnect", message: "The original wallet connection is unavailable. Ask in chat for a Disconnect card, then start a new review after reconnecting." };
      else if (!reviewConnection) nextStep = { kind: "check_status", message: "This review keeps its original account and connection. Ask in chat to check that wallet connection's status before continuing." };
      else if (facts.busyForAccount) nextStep = { kind: "wait", message: "A previous transaction request for this Sui account is still pending. Wait for it to finish, then check this review's status." };
    }
  }
  return { allowedActions, preparationIssue, nextStep, ...connectionEligibility, reviewTarget,
    canDisconnect: connectionEligibility.canDisconnect && disconnectTargetMatches,
    ...(session ? { usableConnectionId: reviewConnection?.connectionId } : {}),
    actionRemainingMs: remaining, inputRemainingMs: inputAvailable ? remaining : 0,
    ...(nextRead !== undefined && nextRead > 0 ? { nextStateReadAfterMs: nextRead } : {}) };
}
