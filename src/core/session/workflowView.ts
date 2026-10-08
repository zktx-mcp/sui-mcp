import { workflowActions, type EvaluatedWorkflowState } from "./workflowState.js";
export type { ConnectionView, WorkflowAction } from "./workflowState.js";
import { z } from "zod";
import { suiAddressStringSchema, parseSuiAddress } from "../suiAddress.js";
import { actionPlanSchema, internalSessionStatusSchema, reviewStateOutputSchema } from "../action/schemas.js";
import { walletConnectionSchema, walletAvailabilitySchema, workflowProgressSchema, WALLET_CONNECTION_POLL_SECONDS, connectionConflictSchema, assetReadAccountSchema } from "./walletConnection.js";
import { transactionRequestSchema } from "./transactionRequest.js";
import { workflowProgress } from "./walletConnection.js";
import { reviewProgress, EXECUTION_POLLING_INTERVAL_SECONDS } from "./status.js";
import { walletRunIdSchema, walletRecoverySchema, walletObservationSchema } from "./walletRuntime.js";

export const CONNECT_BOUNDARY = "A wallet connection provides account context; it is not a transaction approval or proof of address ownership.";
export const REVIEW_BOUNDARY = "Review evidence is not a safety guarantee. Only an explicit card action and wallet approval may authorize this exact transaction.";
// A projection of an admitted card operation, not a new wallet connection state.
export const connectionViewSchema = walletConnectionSchema.extend({ pendingAction: z.literal("disconnect").optional() });
export { assetReadAccountSchema, type AssetReadAccount } from "./walletConnection.js";
export const pendingConnectionStatusSchema = z.enum(["input_required", "awaiting_approval", "disconnect_pending"]);
export type PendingConnectionStatus = z.infer<typeof pendingConnectionStatusSchema>;
const connectAction = z.object({ action: z.literal("connect"), walletRunId: walletRunIdSchema }).strict();
const disconnectAction = z.object({ action: z.literal("disconnect"), walletRunId: walletRunIdSchema, connectionId: z.string().min(1) }).strict();
const accountAction = z.object({ action: z.literal("use_account"), walletRunId: walletRunIdSchema, connectionId: z.string().min(1), account: suiAddressStringSchema }).strict();
const reviewAction = z.object({ action: z.enum(["prepare_review", "request_signature"]), connectionId: z.string().min(1),
  walletRunId: walletRunIdSchema, account: suiAddressStringSchema, reviewRevision: z.number().int().nonnegative() }).strict();
const simpleAction = z.object({ action: z.enum(["cancel", "stop_connection", "stop_waiting", "read_result"]) }).strict();
export const workflowActionSchema = z.union([connectAction, disconnectAction, accountAction, reviewAction, simpleAction]);
export const automaticWorkflowActionSchema = z.union([connectAction, reviewAction.extend({ action: z.literal("prepare_review") })]);
export function parseWorkflowAction(input: unknown) {
  const action = workflowActionSchema.parse(input);
  return "account" in action ? { ...action, account: parseSuiAddress(action.account)! } : action;
}


export const workflowViewSchema = z.object({
  kind: z.enum(["connect", "review"]),
  mode: z.enum(["connect", "review", "review_manage"]),
  allowedActions: z.array(z.enum(workflowActions)),
  actionRemainingMs: z.number().int().nonnegative(),
  nextStateReadAfterMs: z.number().int().nonnegative().optional(),
  automaticAction: automaticWorkflowActionSchema.optional(),
  observe: z.boolean(),
  walletAvailability: walletAvailabilitySchema,
  walletObservation: walletObservationSchema.optional(),
  runtimeRecovery: walletRecoverySchema.optional(),
  connectionConflict: connectionConflictSchema.optional(),
  manageableConnectionIds: z.array(z.string().min(1)),
  connectionReconciliationRequired: z.literal(true).optional(),
  usableConnectionId: z.string().min(1).optional(),
  assetReadAccount: assetReadAccountSchema.optional(),
  acceptedWalletRunId: walletRunIdSchema.optional(),
  progress: workflowProgressSchema,
  boundary: z.enum([CONNECT_BOUNDARY, REVIEW_BOUNDARY]),
  connections: z.array(connectionViewSchema),
  activeAccount: z.string().optional(),
  connection: connectionViewSchema.optional(),
  connectionAction: z.enum(["connect", "disconnect"]).optional(),
  review: z.object({
    reviewSessionId: z.string(), plan: actionPlanSchema, reviewRevision: z.number().int().nonnegative(),
    status: internalSessionStatusSchema, account: z.string().optional(), preparing: z.boolean(),
    accountRequestPending: z.literal(true).optional(),
    error: z.string().optional(),
    state: reviewStateOutputSchema.optional()
  }).strict().optional(),
  request: transactionRequestSchema.optional(),
  receipt: z.unknown().optional(),
  netGasMist: z.string().regex(/^-?[0-9]+$/).optional(),
  observationStopped: z.boolean().optional()
}).strict().superRefine((view, context) => {
  const connection = view.connections.find((item) => item.connectionId === view.usableConnectionId);
  if (view.usableConnectionId && (!connection || connection.status !== "connected" ||
      view.walletAvailability.status !== "available" || view.connectionConflict || view.connectionReconciliationRequired ||
      view.connections.some((item) => item.pendingAction || item.status === "awaiting_approval"))) {
    context.addIssue({ code: "custom", path: ["usableConnectionId"], message: "The usable connection must match current connection facts." });
  }
  if (new Set(view.manageableConnectionIds).size !== view.manageableConnectionIds.length ||
      view.manageableConnectionIds.some((id) => !view.connections.some((item) => item.connectionId === id &&
        !item.pendingAction && item.status !== "awaiting_approval"))) {
    context.addIssue({ code: "custom", path: ["manageableConnectionIds"], message: "Management must name distinct recorded targets without pending operations." });
  }
  if (view.connectionReconciliationRequired && (view.usableConnectionId || view.assetReadAccount?.status === "available" ||
      view.allowedActions.some((action) => ["connect", "use_account", "prepare_review", "request_signature"].includes(action)))) {
    context.addIssue({ code: "custom", path: ["connectionReconciliationRequired"], message: "Unrecorded SDK connections cannot authorize connection or account use." });
  }
  if (view.assetReadAccount?.status === "available" && (!connection ||
      !connection.accounts.includes(view.assetReadAccount.account) || view.activeAccount !== view.assetReadAccount.account)) {
    context.addIssue({ code: "custom", path: ["assetReadAccount"], message: "The default address must belong to the usable connection and stored selection." });
  }
});
export type WorkflowView = z.infer<typeof workflowViewSchema>;

// Automatic preparation uses the same current selection and typed admission as
// a deliberate retry. A failed computation is not a reason to compute in a loop.
function automaticReviewAction(input: EvaluatedWorkflowState) {
  const { record, session, request } = input;
  if (!session || record?.scope !== "review" || request || session.preparationError ||
      !input.allowedActions.includes("prepare_review")) return undefined;
  const needsPreparation = !session.reviewState && session.reviewRevision === 0 ||
    session.reviewState?.status === "refresh_required" && session.reviewState.refreshReason === "review_evidence_stale";
  if (!needsPreparation || input.assetReadAccount?.status !== "available") return undefined;
  const account = input.assetReadAccount.account;
  const candidates = reviewWalletChoices(input, account);
  if (candidates.length !== 1) return undefined;
  return { action: "prepare_review" as const, walletRunId: input.walletAvailability.walletRunId, connectionId: candidates[0]!.connectionId,
    account, reviewRevision: session.reviewRevision };
}

// Method support filters wallet choices; it does not authorize a signature.
export function reviewWalletChoices(selection: { connections: WorkflowView["connections"]; usableConnectionId?: string | undefined }, account: string, requireSigningMethod = false) {
  return selection.connections.filter((item) => item.connectionId === selection.usableConnectionId && item.accounts.includes(account) &&
    (!requireSigningMethod || item.methods.includes("sui_signTransaction")));
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
export function projectConnectionView(input: EvaluatedWorkflowState): WorkflowView {
  const { walletAvailability } = input;
  const stored = input.record?.state.data as { disconnectOutcome?: unknown } | undefined;
  const connection = input.record?.acceptedInput?.action === "disconnect" && stored?.disconnectOutcome
    ? connectionViewSchema.parse(stored.disconnectOutcome) : input.connection;
  const readAfter = nextStateRead(input);
  const progress = input.runtimeRecovery ? { status: "phase" in input.runtimeRecovery ? "waiting" as const : "idle" as const } :
    workflowProgress(connection?.status === "awaiting_approval" || connection?.pendingAction === "disconnect", true, walletAvailability);
  return workflowViewSchema.parse({ kind: "connect", mode: "connect", allowedActions: input.allowedActions,
    actionRemainingMs: input.actionRemainingMs, observe: progress.status === "waiting", progress, walletAvailability,
    ...(input.record?.state.input.intent === "connect" && input.allowedActions.includes("connect")
      ? { automaticAction: { action: "connect", walletRunId: walletAvailability.walletRunId } } : {}),
    runtimeRecovery: input.runtimeRecovery, walletObservation: input.walletObservation,
    connectionConflict: input.connectionConflict, usableConnectionId: input.usableConnectionId, assetReadAccount: input.assetReadAccount,
    manageableConnectionIds: input.manageableConnectionIds, connectionReconciliationRequired: input.connectionReconciliationRequired,
    connectionAction: ["connect", "disconnect"].includes(String(input.record?.acceptedInput?.action)) ? input.record?.acceptedInput?.action : undefined,
    acceptedWalletRunId: input.record?.acceptedInput?.walletRunId,
    ...(readAfter === undefined ? {} : { nextStateReadAfterMs: readAfter }),
    connections: input.connections, activeAccount: input.activeAccount, connection, boundary: CONNECT_BOUNDARY });
}

export function projectReviewView(input: EvaluatedWorkflowState): WorkflowView {
  const { record, session, request, authority, walletAvailability, boundReview } = input;
  if (!record || !session) throw new Error("Review projection requires an evaluated card and session.");
  const progress = reviewProgress(!boundReview && !!session.preparationId, request, walletAvailability, {
    stopped: authority?.observation_stopped === 1, pending: authority?.lookup_pending === 1
  });
  const displayedReview = boundReview ?? session.reviewState;
  const gas = displayedReview?.simulation?.gasCostSummary;
  const automaticAction = automaticReviewAction(input);
  const readAfter = nextStateRead(input);
  return workflowViewSchema.parse({ kind: "review", mode: record.scope === "review_manage" ? "review_manage" : "review",
    allowedActions: input.allowedActions, actionRemainingMs: input.actionRemainingMs, observe: progress.status === "waiting", progress, walletAvailability,
    connections: input.connections, connectionConflict: input.connectionConflict, usableConnectionId: input.usableConnectionId,
    manageableConnectionIds: input.manageableConnectionIds, connectionReconciliationRequired: input.connectionReconciliationRequired,
    assetReadAccount: input.assetReadAccount, activeAccount: input.activeAccount, boundary: REVIEW_BOUNDARY, receipt: input.receipt,
    walletObservation: input.walletObservation,
    acceptedWalletRunId: record.acceptedInput?.walletRunId,
    ...(readAfter === undefined ? {} : { nextStateReadAfterMs: readAfter }),
    ...(automaticAction ? { automaticAction } : {}),
    netGasMist: gas ? (BigInt(gas.computationCostRaw) + BigInt(gas.storageCostRaw) - BigInt(gas.storageRebateRaw)).toString() : undefined,
    review: { reviewSessionId: session.id, plan: session.plans[0], reviewRevision: boundReview && request ? request.reviewRevision : session.reviewRevision,
      status: boundReview?.status ?? session.status, account: boundReview?.account ?? session.account,
      ...(!request && !session.plans[0]?.reviewModel && input.busyForAccount ? { accountRequestPending: true } : {}),
      preparing: !boundReview && !!session.preparationId,
      error: !boundReview ? [input.preparationIssue && `Current account selection: ${input.preparationIssue}`,
        session.preparationError && `Earlier review message: “${session.preparationError}”`].filter(Boolean).join("\n\n") || undefined : undefined,
      state: displayedReview },
    request, observationStopped: authority ? authority.observation_stopped === 1 : undefined });
}
