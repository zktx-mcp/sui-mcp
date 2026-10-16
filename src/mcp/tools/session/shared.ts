import type { McpServerDeps } from "../../server.js";
import type { ReviewSnapshot } from "../../../core/session/status.js";
import { walletObservationSchema } from "../../../core/session/walletRuntime.js";
import { walletAvailabilitySchema, workflowProgressSchema, walletUnavailable } from "../../../core/session/walletConnection.js";
import { z } from "zod";
import { actionPlanSchema, executionPollingStatusSchema, internalSessionStatusSchema, reviewStateOutputSchema } from "../../../core/action/schemas.js";
import { EXECUTION_STATUS_CATEGORIES } from "../../../core/session/status.js";
import { transactionExecutionSummarySchema, transactionRequestSchema, transactionRequestStatusSchema } from "../../../core/session/transactionRequest.js";
import { DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS } from "../../../core/session/wait.js";

export const INTERACTION_STATUS_LIMIT = 5;
export function executionPollingHintSchema() {
  return z.object({ nonTerminalStatuses: z.array(executionPollingStatusSchema), waitStoppingStatuses: z.array(executionPollingStatusSchema),
    finalStatuses: z.array(executionPollingStatusSchema), userActionRequiredStatuses: z.array(executionPollingStatusSchema),
    recommendedIntervalSeconds: z.number().int().positive() });
}
export function executionStatusCategorySchema() { return z.enum(EXECUTION_STATUS_CATEGORIES); }
export const timeoutInputSchema = z.number().int().min(1).max(MAX_WAIT_TIMEOUT_MS).default(DEFAULT_WAIT_TIMEOUT_MS).optional();
export function waitExecutionInputSchema() { return { reviewSessionId: z.string().min(1), timeoutMs: timeoutInputSchema }; }
export const reviewStatusResponseShape = {
  connectionReconciliationRequired: z.literal(true).optional(),
  walletAvailability: walletAvailabilitySchema, walletObservation: walletObservationSchema.optional(), progress: workflowProgressSchema,
  reviewSessionId: z.string(), status: internalSessionStatusSchema, reviewRevision: z.number().int().nonnegative(),
  account: z.string().optional(), plans: z.array(actionPlanSchema), reviewState: reviewStateOutputSchema.optional(),
  pollingStatus: executionPollingStatusSchema, statusCategory: executionStatusCategorySchema(), pollingHint: executionPollingHintSchema(),
  expiresAt: z.string(), lastActivityAt: z.string(), attemptId: z.string().optional(), requestStatus: transactionRequestStatusSchema.optional(),
  request: transactionRequestSchema.optional(), executionResult: transactionExecutionSummarySchema.optional()
};
export function latest<T extends { lastActivityAt: string }>(items: T[]) {
  const sorted = [...items].sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt));
  return { limit: INTERACTION_STATUS_LIMIT, items: sorted.slice(0, INTERACTION_STATUS_LIMIT), truncated: sorted.length > INTERACTION_STATUS_LIMIT };
}

// Runtime workflows own reconciliation/observation. A server without a wallet
// workflow can still expose ordinary preparation facts, with explicit absence.
export async function readCurrentReview(deps: Pick<McpServerDeps, "workflow" | "sessions">, id: string,
  explicitResult = false): Promise<ReviewSnapshot | undefined> {
  if (deps.workflow) return deps.workflow.readReview(id, explicitResult);
  const session = await deps.sessions.getReviewSession(id);
  return session ? { session, hasReviewInput: false, walletAvailability: walletUnavailable("initialization_failed"), progress: { status: "idle" } } : undefined;
}
