import { TRANSACTION_REQUEST_STATUSES, transactionRequestSchema, transactionRequestStatusSchema } from "../../../core/session/transactionRequest.js";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  actionPlanSchema,
  internalSessionStatusSchema,
  reviewStateOutputSchema
} from "../../../core/action/schemas.js";
import {
  REVIEW_ACTIVITY_LIST_DEFAULT_LIMIT,
  REVIEW_ACTIVITY_LIST_MAX_LIMIT,
  REVIEW_ACTIVITY_LOW_SAMPLE_THRESHOLD
} from "../../../core/activity/activityStore.js";
import { successOutputSchema } from "../../schemas.js";
import { okToolResult } from "../../result.js";
import type { McpServerDeps } from "../../server.js";
import { TOOL_NAMES } from "../../toolNames.js";
import {
  reviewActivityListUserAnswerUse,
  reviewFunnelUserAnswerUse,
  reviewSessionDetailUserAnswerUse
} from "../../responseGuidance.js";
import {
  fetchedAtSchema,
  reviewActivityAccountSourceSchema,
  reviewActivityDataScopeSchema,
  reviewActivityInputSchema,
  userAnswerUseSchema
} from "./commonSchemas.js";
import { activityStoreReadError } from "./readToolHelpers.js";

const reviewActivityCommonOutput = {
  dataScope: reviewActivityDataScopeSchema,
  accountSource: reviewActivityAccountSourceSchema,
  userAnswerUse: userAnswerUseSchema,
  lowSampleWarning: z.boolean(),
  lowSampleThreshold: z.literal(REVIEW_ACTIVITY_LOW_SAMPLE_THRESHOLD),
  truncated: z.object({
    activities: z.boolean(),
    snapshots: z.boolean(),
    transitions: z.boolean(),
    requests: z.boolean().optional()
  })
};

const reviewActivityRowSchema = z.object({
  reviewSessionId: z.string(),
  planId: z.string(),
  actionKind: z.string(),
  adapterId: z.string(),
  protocol: z.string(),
  reviewStatus: internalSessionStatusSchema,
  currentAttemptId: z.string().optional(),
  requestStatus: transactionRequestStatusSchema.optional(),
  reviewRevision: z.number().int().nonnegative().optional(),
  account: z.string(),
  createdAt: fetchedAtSchema,
  updatedAt: fetchedAtSchema,
  executionStatus: z.enum(["success", "failure"]).optional(),
  transactionDigest: z.string().optional(),
  snapshotCount: z.number().int().nonnegative(),
  transitionCount: z.number().int().nonnegative()
});

export function registerReviewActivityListTool(server: McpServer, deps: McpServerDeps): void {
  server.registerTool(
    TOOL_NAMES.readListReviewActivity,
    {
      title: "List review activity",
      description: "List local Sui MCP review-session records for one account. Not wallet transaction history.",
      inputSchema: z.object({
        ...reviewActivityInputSchema,
        reviewStatus: internalSessionStatusSchema.optional(),
        requestStatus: transactionRequestStatusSchema.optional(),
        executionStatus: z.enum(["success", "failure"]).optional(),
        limit: z.number().int().min(1).max(REVIEW_ACTIVITY_LIST_MAX_LIMIT).optional()
      }).strict(),
      outputSchema: successOutputSchema({
        ...reviewActivityCommonOutput,
        activities: z.array(reviewActivityRowSchema)
      }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ account, from, to, reviewStatus, requestStatus, executionStatus, limit }) => {
      try {
        const result = await deps.activityStore.listReviewActivity({
          account,
          from,
          to,
          reviewStatus, requestStatus, executionStatus,
          limit: limit ?? REVIEW_ACTIVITY_LIST_DEFAULT_LIMIT
        });
        return okToolResult({
          ...result,
          userAnswerUse: reviewActivityListUserAnswerUse()
        });
      } catch (error) {
        return activityStoreReadError(error, deps);
      }
    }
  );
}

export function registerReviewActivitySummaryTools(server: McpServer, deps: McpServerDeps): void {
  server.registerTool(
    TOOL_NAMES.readSummarizeReviewFunnel,
    {
      title: "Summarize review funnel",
      description: "Lifecycle counts for local Sui MCP review sessions in one account scope.",
      inputSchema: reviewActivityInputSchema,
      outputSchema: successOutputSchema({
        ...reviewActivityCommonOutput,
        summary: z.object({
          total: z.number().int().nonnegative(),
          opened: z.number().int().nonnegative(),
          walletConnected: z.number().int().nonnegative(),
          stateComputed: z.number().int().nonnegative(),
          reviewStatusCounts: z.record(internalSessionStatusSchema, z.number().int().nonnegative()),
          requestStatusCounts: z.array(z.object({ requestStatus: z.enum(TRANSACTION_REQUEST_STATUSES), count: z.number().int().nonnegative() }).strict()),
          executionStatusCounts: z.object({ success: z.number().int().nonnegative(), failure: z.number().int().nonnegative() }),
          withoutRequest: z.number().int().nonnegative(),
          withoutExecutionResult: z.number().int().nonnegative(),
          everReachedReviewStateCounts: z.object({
            ready_for_wallet_review: z.number().int().nonnegative(),
            blocked: z.number().int().nonnegative(),
            refresh_required: z.number().int().nonnegative()
          }),
          everAwaitedChainResult: z.number().int().nonnegative(),
          expiredWithoutExecutionResult: z.number().int().nonnegative(),
          avgCreatedToSignatureVerifiedSeconds: z.number().nullable(),
          avgOpenedToSignatureVerifiedSeconds: z.number().nullable()
        })
      }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ account, from, to }) => {
      try {
        const result = await deps.activityStore.summarizeReviewFunnel({ account, from, to });
        return okToolResult({
          ...result,
          userAnswerUse: reviewFunnelUserAnswerUse()
        });
      } catch (error) {
        return activityStoreReadError(error, deps);
      }
    }
  );

  server.registerTool(
    TOOL_NAMES.readGetReviewSessionDetail,
    {
      title: "Get review session detail",
      description: "Return one stored Sui MCP review session with plan, snapshots, transitions, and result.",
      inputSchema: z.object({
        reviewSessionId: z.string().min(1),
        account: z.string().min(1).optional()
      }),
      outputSchema: successOutputSchema({
        ...reviewActivityCommonOutput,
        session: reviewActivityRowSchema.omit({
          executionStatus: true,
          transactionDigest: true,
          requestStatus: true,
          reviewRevision: true,
          snapshotCount: true,
          transitionCount: true
        }),
        planJson: actionPlanSchema,
        intentJson: z.unknown().optional(),
        stateSnapshots: z.array(
          z.object({
            id: z.number().int().positive(),
            reviewRevision: z.number().int().nonnegative(),
            planId: z.string(),
            account: z.string(),
            status: z.string(),
            blockedReason: z.string().optional(),
            refreshReason: z.string().optional(),
            stateJson: reviewStateOutputSchema,
            updatedAt: fetchedAtSchema,
            recordedAt: fetchedAtSchema
          })
        ),
        transitions: z.array(
          z.object({
            id: z.number().int().positive(),
            event: z.string(),
            domain: z.enum(["review", "request"]),
            attemptId: z.string().optional(),
            fromStatus: z.string().optional(),
            toStatus: z.string(),
            isNoOp: z.boolean(),
            account: z.string().optional(),
            reason: z.string().optional(),
            transitionedAt: fetchedAtSchema
          })
        ),
        request: transactionRequestSchema.optional(),
        requestCount: z.number().int().nonnegative(),
        requests: z.array(transactionRequestSchema)
      }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ reviewSessionId, account }) => {
      try {
        const result = await deps.activityStore.getReviewSessionDetail({ reviewSessionId, account });
        return okToolResult({
          ...result,
          userAnswerUse: reviewSessionDetailUserAnswerUse({ hasCurrentRequest: !!result.request, hasCurrentExecution: !!result.request?.execution,
            hasHistoricalExecution: result.requests.some((request) => !!request.execution) })
        });
      } catch (error) {
        return activityStoreReadError(error, deps);
      }
    }
  );
}
