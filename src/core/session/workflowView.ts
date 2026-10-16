import { workflowActions, workflowNextSteps, type EvaluatedWorkflowState } from "./workflowState.js";
export type { ConnectionView, WorkflowAction } from "./workflowState.js";
import { z } from "zod";
import { suiAddressStringSchema } from "../suiAddress.js";
import { actionPlanSchema, internalSessionStatusSchema, reviewStateOutputSchema } from "../action/schemas.js";
import { walletConnectionSchema, walletAvailabilitySchema, workflowProgressSchema, WALLET_CONNECTION_POLL_SECONDS, connectionChainStateSchema } from "./walletConnection.js";
import { transactionRequestSchema } from "./transactionRequest.js";
import { workflowProgress } from "./walletConnection.js";
import { reviewProgress, EXECUTION_POLLING_INTERVAL_SECONDS } from "./status.js";
import { walletRunIdSchema, walletObservationSchema } from "./walletRuntime.js";
import { walletConnectionActionSchema, walletConnectionOperationSchema } from "./walletConnectionOperations.js";
import { walletChainSchema, walletChainsSchema, SUI_MAINNET_WALLET_CHAIN, normalizeChainAddress } from "./chainAccounts.js";

export const CONNECT_BOUNDARY = "A wallet connection provides account context; it is not a transaction approval or proof of address ownership.";
export const REVIEW_BOUNDARY = "Review evidence is not a safety guarantee. Only an explicit card action and wallet approval may authorize this exact transaction.";
// A projection of an admitted card operation, not a new wallet connection state.
export const connectionViewSchema = walletConnectionSchema.extend({
  sessionPresence: z.enum(["present", "absent", "unusable", "unconfirmed"]),
  chainStates: z.array(connectionChainStateSchema).optional(),
  disconnectImpact: z.object({ impactId: z.string(), requestCount: z.number().int().nonnegative(), chains: walletChainsSchema }).strict().optional() });
export { assetReadAccountSchema, type AssetReadAccount } from "./walletConnection.js";
export const pendingConnectionStatusSchema = z.enum(["awaiting_approval", "disconnect_pending", "cleanup_pending"]);
export type PendingConnectionStatus = z.infer<typeof pendingConnectionStatusSchema>;
const reviewAction = z.object({ action: z.enum(["prepare_review", "request_signature"]), connectionId: z.string().min(1),
  walletRunId: walletRunIdSchema, account: suiAddressStringSchema, reviewRevision: z.number().int().nonnegative() }).strict();
const simpleAction = z.object({ action: z.enum(["cancel", "stop_waiting", "read_result"]) }).strict();
const stopConnectionAction = z.object({ action: z.literal("stop_connection"), operationId: z.string().uuid() }).strict();
export const workflowActionSchema = z.union([walletConnectionActionSchema, stopConnectionAction, reviewAction, simpleAction]);
export const automaticWorkflowActionSchema = z.union([walletConnectionActionSchema.options[0], reviewAction.extend({ action: z.literal("prepare_review") })]);
export function parseWorkflowAction(input: unknown) {
  const action = workflowActionSchema.parse(input);
  if ("account" in action) {
    const account = normalizeChainAddress(SUI_MAINNET_WALLET_CHAIN, action.account);
    if (!account) throw new Error("A valid chain account is required.");
    return { ...action, account };
  }
  return action;
}


function checkReviewAccount(view: { reviewTarget?: { account: string } | undefined; review?: { account?: string | undefined } | undefined;
  request?: { account: string } | undefined }, context: z.RefinementCtx): void {
  if (view.reviewTarget && (view.review?.account && view.review.account !== view.reviewTarget.account ||
      view.request && view.request.account !== view.reviewTarget.account)) {
    context.addIssue({ code: "custom", path: ["reviewTarget"], message: "The fixed review target must match its recorded account and request." });
  }
}
const nextStepSchema = z.object({ kind: z.enum(workflowNextSteps), message: z.string().optional(), reason: z.string().optional() }).strict();
const liveFields = {
  allowedActions: z.array(z.enum(workflowActions)), actionRemainingMs: z.number().int().nonnegative(),
  nextStateReadAfterMs: z.number().int().nonnegative().optional(), observe: z.boolean(),
  walletAvailability: walletAvailabilitySchema, walletObservation: walletObservationSchema.optional(),
  progress: workflowProgressSchema, nextStep: nextStepSchema
};
export const connectViewSchema = z.object({ ...liveFields, kind: z.literal("connect"), mode: z.literal("connect"),
  allowedActions: z.array(z.enum(["connect", "cancel", "stop_connection"])),
  boundary: z.literal(CONNECT_BOUNDARY), requestedChains: walletChainsSchema,
  operation: walletConnectionOperationSchema.optional(), automaticAction: walletConnectionActionSchema.options[0].optional() }).strict();
export const disconnectViewSchema = z.object({ ...liveFields, kind: z.literal("disconnect"), mode: z.literal("disconnect"),
  allowedActions: z.array(z.enum(["disconnect", "cancel"])),
  boundary: z.literal(CONNECT_BOUNDARY), connection: connectionViewSchema.optional(),
  operation: walletConnectionOperationSchema.optional() }).strict();
const reviewPayloadSchema = z.object({
  reviewSessionId: z.string(), plan: actionPlanSchema, reviewRevision: z.number().int().nonnegative(),
  status: internalSessionStatusSchema, account: z.string().optional(), preparing: z.boolean(),
  accountRequestPending: z.literal(true).optional(), error: z.string().optional(), state: reviewStateOutputSchema.optional()
}).strict();
const reviewTargetSchema = z.object({ connectionId: z.string(), account: suiAddressStringSchema }).strict();
const netGasSchema = z.string().regex(/^-?[0-9]+$/).optional();
export const reviewViewSchema = z.object({ ...liveFields, kind: z.literal("review"), mode: z.enum(["review", "review_manage"]),
  allowedActions: z.array(z.enum(["prepare_review", "request_signature", "read_result", "stop_waiting", "cancel"])),
  boundary: z.literal(REVIEW_BOUNDARY), reviewTarget: reviewTargetSchema.optional(), review: reviewPayloadSchema,
  walletName: z.string().optional(), acceptedWalletRunId: walletRunIdSchema.optional(),
  automaticAction: reviewAction.extend({ action: z.literal("prepare_review") }).optional(),
  request: transactionRequestSchema.optional(), receipt: z.unknown().optional(), netGasMist: netGasSchema,
  observationStopped: z.boolean().optional()
}).strict().superRefine(checkReviewAccount);
export const workflowViewSchema = z.discriminatedUnion("kind", [connectViewSchema, disconnectViewSchema, reviewViewSchema]);
export type WorkflowView = z.infer<typeof workflowViewSchema>;
export type ReviewView = z.infer<typeof reviewViewSchema>;
export type WalletView = z.infer<typeof connectViewSchema> | z.infer<typeof disconnectViewSchema>;

const closedResult = z.object({ message: z.string(), recordedAt: z.string().datetime() }).strict();
const closedFields = { allowedActions: z.array(z.never()), observe: z.literal(false), actionRemainingMs: z.literal(0), result: closedResult };
export const closedWalletCardSchema = z.object({ ...closedFields, kind: z.enum(["connect", "disconnect"]),
  result: closedResult.extend({ pendingWork: z.enum(["approval_response", "session_removal", "session_status"]).optional() }), walletName: z.string().optional(),
  networks: z.array(z.object({ chainId: walletChainSchema, status: z.enum(["bound", "not_approved", "multiple_accounts", "invalid_response"]) }).strict()) }).strict();
export const closedReviewCardSchema = z.object({ ...closedFields, kind: z.literal("review"),
  mode: z.enum(["review", "review_manage"]), review: reviewPayloadSchema.optional(),
  reviewTarget: reviewTargetSchema.optional(), request: transactionRequestSchema.optional(),
  receipt: z.unknown().optional(), netGasMist: netGasSchema,
  observationStopped: z.boolean().optional(), boundary: z.literal(REVIEW_BOUNDARY) }).strict().superRefine(checkReviewAccount);
export type ClosedReviewCard = z.infer<typeof closedReviewCardSchema>;

// Automatic preparation uses the same fixed target and typed admission as
// a deliberate retry. A failed computation is not a reason to compute in a loop.
function automaticReviewAction(input: EvaluatedWorkflowState) {
  const { record, session, request } = input;
  if (!session || record?.scope !== "review" || request || session.preparationError ||
      !input.allowedActions.includes("prepare_review")) return undefined;
  const needsPreparation = !session.reviewState && session.reviewRevision === 0 ||
    session.reviewState?.status === "refresh_required" && session.reviewState.refreshReason === "review_evidence_stale";
  if (!needsPreparation || !input.reviewTarget) return undefined;
  const account = input.reviewTarget.account;
  return { action: "prepare_review" as const, walletRunId: input.walletAvailability.walletRunId,
    connectionId: input.reviewTarget.connectionId, account, reviewRevision: session.reviewRevision };
}

function nextStateRead(input: EvaluatedWorkflowState): number | undefined {
  const walletInput = input.record?.state.state === "ready" && input.record.scope !== "review_manage" && !input.request &&
    !input.session?.plans[0]?.reviewModel && input.inputRemainingMs > 0;
  const startup = walletInput && ["initializing", "recovering"].includes(input.walletAvailability.status);
  const delays = [input.nextStateReadAfterMs, startup ? WALLET_CONNECTION_POLL_SECONDS * 1000 : undefined,
    walletInput && input.record?.scope === "review" && input.busyForAccount ? EXECUTION_POLLING_INTERVAL_SECONDS * 1000 : undefined]
    .filter((value): value is number => value !== undefined && value > 0);
  return delays.length ? Math.min(...delays) : undefined;
}

// These projections do not read clocks, storage, or admission rules. The
// evaluated facts and choices were collected together by the database owner.
export function projectConnectionView(input: EvaluatedWorkflowState): WalletView {
  const { walletAvailability, operation } = input, readAfter = nextStateRead(input);
  const progress = workflowProgress(!!operation && operation.status === "running", true, walletAvailability);
  const common = { allowedActions: input.allowedActions, actionRemainingMs: input.actionRemainingMs,
    observe: progress.status === "waiting", progress, walletAvailability, walletObservation: input.walletObservation,
    operation, nextStep: input.nextStep, boundary: CONNECT_BOUNDARY,
    ...(readAfter === undefined ? {} : { nextStateReadAfterMs: readAfter }) };
  if (input.record?.scope === "disconnect") return disconnectViewSchema.parse({ ...common, kind: "disconnect", mode: "disconnect",
    connection: input.connection?.connectionId === input.record.state.input.connectionId ? input.connection : undefined });
  return connectViewSchema.parse({ ...common, kind: "connect", mode: "connect",
    requestedChains: walletChainsSchema.parse(input.record?.state.input.requestedChains ?? input.requestedChains),
    ...(!operation && input.record?.operationId && input.allowedActions.includes("connect")
      ? { automaticAction: { action: "connect", operationId: input.record.operationId, walletRunId: walletAvailability.walletRunId,
          chains: input.record.state.input.requestedChains } } : {}) });
}

export function projectReviewView(input: EvaluatedWorkflowState): ReviewView {
  const { record, session, request, authority, walletAvailability, boundReview } = input;
  if (!record || !session) throw new Error("Review projection requires an evaluated card and session.");
  const progress = reviewProgress(!boundReview && !!session.preparationId, request, walletAvailability, {
    stopped: authority?.observation_stopped === 1, pending: authority?.lookup_pending === 1
  });
  const displayedReview = boundReview ?? session.reviewState;
  const gas = displayedReview?.simulation?.gasCostSummary;
  const automaticAction = automaticReviewAction(input);
  const readAfter = nextStateRead(input);
  return reviewViewSchema.parse({ kind: "review", mode: record.scope === "review_manage" ? "review_manage" : "review",
    allowedActions: input.allowedActions, actionRemainingMs: input.actionRemainingMs, observe: progress.status === "waiting", progress, walletAvailability,
    reviewTarget: input.reviewTarget, nextStep: input.nextStep,
    walletName: input.connection?.connectionId === input.reviewTarget?.connectionId ? input.connection?.walletName : undefined,
    boundary: REVIEW_BOUNDARY, receipt: input.receipt,
    walletObservation: input.walletObservation,
    acceptedWalletRunId: record.acceptedInput?.walletRunId,
    ...(readAfter === undefined ? {} : { nextStateReadAfterMs: readAfter }),
    ...(automaticAction ? { automaticAction } : {}),
    netGasMist: gas ? (BigInt(gas.computationCostRaw) + BigInt(gas.storageCostRaw) - BigInt(gas.storageRebateRaw)).toString() : undefined,
    review: { reviewSessionId: session.id, plan: session.plans[0], reviewRevision: boundReview && request ? request.reviewRevision : session.reviewRevision,
      status: boundReview?.status ?? session.status, account: boundReview?.account ?? session.account,
      ...(!request && !session.plans[0]?.reviewModel && input.busyForAccount ? { accountRequestPending: true } : {}),
      preparing: !boundReview && !!session.preparationId,
      error: !boundReview ? [input.preparationIssue && `Review target: ${input.preparationIssue}`,
        session.preparationError && `Earlier review message: “${session.preparationError}”`].filter(Boolean).join("\n\n") || undefined : undefined,
      state: displayedReview },
    request, observationStopped: authority ? authority.observation_stopped === 1 : undefined });
}
