import { walletAvailabilitySchema, workflowProgressSchema, walletUnavailable, connectionConflictSchema } from "../../../core/session/walletConnection.js";
import { walletObservationSchema } from "../../../core/session/walletRuntime.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { activeAccountResponse, activeAccountResponseSchema } from "../../activeAccountResponse.js";
import type { McpServerDeps } from "../../server.js";
import { errorToolResult, okToolResult } from "../../result.js";
import { noParamsInputSchema, successOutputSchema } from "../../schemas.js";
import { activityStoreToolError, sessionStoreToolError } from "../../toolErrors.js";
import { TOOL_NAMES } from "../../toolNames.js";
import { interactionStatusUserAnswerUse, reviewStatusUserAnswerUse } from "../../responseGuidance.js";
import { userAnswerUseSchema } from "../read/commonSchemas.js";
import { isReviewInteractionPending, reviewStatusResponse } from "../../../core/session/status.js";
import { latest, reviewStatusResponseShape, readCurrentReview } from "./shared.js";
import { pendingConnectionStatusSchema, connectionViewSchema, assetReadAccountSchema } from "../../../core/session/workflowView.js";

export function registerSessionStatusTools(server: McpServer, deps: McpServerDeps): void {
  server.registerTool(TOOL_NAMES.sessionGetInteractionStatus, {
    title: "Get local interaction status", description: "Read wallet connections, the default asset account, and pending interactions.",
    inputSchema: noParamsInputSchema,
    outputSchema: successOutputSchema({ walletAvailability: walletAvailabilitySchema, walletObservation: walletObservationSchema.optional(), activeAccount: activeAccountResponseSchema,
      connections: z.array(connectionViewSchema), assetReadAccount: assetReadAccountSchema,
      connectionConflict: connectionConflictSchema.optional(),
      manageableConnectionIds: z.array(z.string().min(1)), connectionReconciliationRequired: z.literal(true).optional(),
      pendingWalletConnections: z.object({ limit: z.number().int().positive(), truncated: z.boolean(),
        items: z.array(z.object({ cardId: z.string(), connectionId: z.string().optional(),
          status: pendingConnectionStatusSchema, progress: workflowProgressSchema, lastActivityAt: z.string() })) }),
      pendingReviewSessions: z.object({ limit: z.number().int().positive(), truncated: z.boolean(), items: z.array(z.object(reviewStatusResponseShape)) }),
      userAnswerUse: userAnswerUseSchema }),
    annotations: { readOnlyHint: false, openWorldHint: false }
  }, async () => {
    let active;
    try { active = await deps.activityStore.getActiveAccount(); }
    catch (error) { return activityStoreToolError(error, deps.logger); }
    try {
      // Connection reconciliation can invalidate reviews and interrupt requests.
      // Complete that maintenance before projecting its dependent review facts.
      const context = deps.workflow?.reconcileConnectionContext() ?? { connections: [], manageableConnectionIds: [],
        assetReadAccount: { status: "address_required" as const }, walletAvailability: walletUnavailable("initialization_failed") };
      const connections = deps.workflow?.pendingConnections() ?? [];
      const states = await Promise.all(deps.sessions.reviewSessionIds().map((id) => readCurrentReview(deps, id)));
      const reviews = states.flatMap((state) => state && isReviewInteractionPending(state) ? [reviewStatusResponse(state)] : []);
      return okToolResult({ activeAccount: activeAccountResponse(active), pendingWalletConnections: latest(connections),
        pendingReviewSessions: latest(reviews), ...context,
        userAnswerUse: interactionStatusUserAnswerUse("walletObservation" in context && context.walletObservation !== undefined,
          "connectionConflict" in context && !!context.connectionConflict, "connectionReconciliationRequired" in context && !!context.connectionReconciliationRequired) });
    } catch (error) { return sessionStoreToolError(error, deps.logger); }
  });
  server.registerTool(TOOL_NAMES.sessionGetReviewStatus, {
    title: "Get review status", description: "Read one review session, its admitted request and any observed chain result.",
    inputSchema: { reviewSessionId: z.string().min(1) },
    outputSchema: successOutputSchema({ ...reviewStatusResponseShape, userAnswerUse: userAnswerUseSchema }),
    annotations: { readOnlyHint: false, openWorldHint: false }
  }, async ({ reviewSessionId }) => {
    try {
      const state = await readCurrentReview(deps, reviewSessionId);
      if (!state) return errorToolResult({ kind: "session_not_found", details: { reviewSessionId } });
      const session = state.session;
      return okToolResult({ ...reviewStatusResponse(state),
        userAnswerUse: reviewStatusUserAnswerUse(!!session.reviewState, !!session.reviewState?.adapterLifecycle,
          !!session.reviewState?.humanReadableReview, !!session.reviewState?.simulation, !!state.connectionConflict, !!state.connectionReconciliationRequired) });
    } catch (error) { return sessionStoreToolError(error, deps.logger); }
  });
}
