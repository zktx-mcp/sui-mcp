import type { z } from "zod";
import type { reviewStateOutputSchema } from "../action/schemas.js";
import type { CardRecord, CardState } from "./cardSession.js";
import type { WalletConnection } from "./walletConnection.js";
import type { TransactionRequest } from "./transactionRequest.js";
import type { ReviewSession } from "../action/types.js";
import { assertNoForbiddenMcpFields } from "../action/forbiddenFields.js";
import { closedWalletCardSchema, closedReviewCardSchema, REVIEW_BOUNDARY } from "./workflowView.js";
import { fixedReviewTarget } from "./workflowState.js";

// Pure projections of facts supplied by the domain committing the outcome.
// No clock, current-wallet lookup, network read or subsequent cleanup is used.
export type WalletPendingWork = "approval_response" | "session_removal" | "session_status";
export function walletCardResult(record: CardRecord, at: Date, input: {
  message: string; connection?: WalletConnection | undefined; pendingWork?: WalletPendingWork | undefined;
}) {
  return closedWalletCardSchema.parse({ kind: record.state.kind, allowedActions: [], observe: false, actionRemainingMs: 0,
    result: { message: input.message, recordedAt: at.toISOString(), ...(input.pendingWork ? { pendingWork: input.pendingWork } : {}) },
    ...(input.connection?.walletName ? { walletName: input.connection.walletName } : {}),
    networks: (input.connection?.chainResults ?? []).map(({ chainId, status }) => ({ chainId, status })) });
}
export function reviewCardResult(record: CardRecord, at: Date, input: {
  session?: ReviewSession | undefined; request?: TransactionRequest | undefined;
  state?: z.infer<typeof reviewStateOutputSchema> | undefined; receipt?: unknown; observationStopped: boolean;
}) {
  const { session, request, state } = input;
  if (request && request.reviewSessionId !== record.state.input.reviewSessionId) throw new Error("The request does not belong to this card.");
  const target = session && !session.plans[0]?.reviewModel ? fixedReviewTarget(session, record.state.input) : undefined;
  const mode = record.scope === "review_manage" ? "review_manage" : "review";
  const message = record.state.error ?? (request?.execution ? request.execution.status === "success" ? "Transaction succeeded on Sui." : "Transaction failed on Sui."
    : mode === "review_manage" && record.state.reason === "expired" ? "This result lookup expired. Ask in chat for a new result card for the same transaction."
    : input.observationStopped && request && request.requestStatus !== "stopped" ? "Result checking was stopped. This does not cancel the transaction. Ask in chat for a new result card for the same transaction."
    : request ? request.reason ?? "No chain execution result has been confirmed."
    : session?.plans[0]?.reviewModel ? "This proposal review has ended. It provided no wallet approval or execution."
    : record.state.reason === "cancelled" ? "This review was cancelled. No approval request was sent."
    : record.state.reason === "expired" ? "This review expired. Ask in chat for a new transaction review."
    : record.state.reason === "server_restarted" ? "This review ended when the server restarted. Ask in chat for a new transaction review."
    : "This review has ended.");
  const gas = state?.simulation?.gasCostSummary;
  const result = closedReviewCardSchema.parse({ kind: "review", mode, allowedActions: [], observe: false, actionRemainingMs: 0,
    result: { message, recordedAt: at.toISOString() }, boundary: REVIEW_BOUNDARY,
    ...(target ? { reviewTarget: target } : {}),
    ...(session?.plans[0] ? { review: { reviewSessionId: session.id, plan: session.plans[0], reviewRevision: request?.reviewRevision ?? session.reviewRevision,
      status: session.status === "expired" ? "expired" : state?.status ?? session.status, account: state?.account ?? session.account, preparing: false,
      ...(state ? { state } : {}), ...(session.preparationError ? { error: session.preparationError } : {}) } } : {}),
    ...(request ? { request } : {}), ...(input.observationStopped ? { observationStopped: true } : {}),
    ...(input.receipt === undefined ? {} : { receipt: input.receipt }),
    ...(gas ? { netGasMist: (BigInt(gas.computationCostRaw) + BigInt(gas.storageCostRaw) - BigInt(gas.storageRebateRaw)).toString() } : {}) });
  assertNoForbiddenMcpFields(result); return result;
}
export function endedCardMessage(reason: CardState["reason"]): string {
  return reason === "cancelled" ? "This card was cancelled." : reason === "expired" ? "The input period ended."
    : reason === "server_restarted" ? "This card ended when the server restarted." : "This card has ended.";
}
