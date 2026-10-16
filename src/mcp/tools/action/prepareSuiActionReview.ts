import { cardMetadata, createWorkflowCard, supportsCards } from "../../../mcp-ui/tools.js";
import { cardSnapshotSchema } from "../../../mcp-ui/contracts.js";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  INTENT_PLAN_FACTORIES,
  resolveIntentPlanFactory,
  swapIntentInputSchema
} from "../../../adapters/intentPlanFactories.js";
import { actionPlanSchema, reviewCheckSchema } from "../../../core/action/schemas.js";
import type { McpActionResponse, ReviewCheck } from "../../../core/action/types.js";
import { externalProposalToActionPlan } from "../../../core/proposal/externalProposalReview.js";
import { externalProposalSchema } from "../../../core/proposal/schemas.js";
import {
  prepareActionReviewUserAnswerUse,
  prepareExternalProposalReviewUserAnswerUse
} from "../../responseGuidance.js";
import { registerSuiMcpTool } from "../../registerTool.js";
import type { McpServerDeps } from "../../server.js";
import { successOutputSchema } from "../../schemas.js";
import { errorToolResult } from "../../result.js";
import { sessionStoreToolError } from "../../toolErrors.js";
import { TOOL_NAMES } from "../../toolNames.js";
import { userAnswerUseSchema } from "../read/commonSchemas.js";

export function registerActionTools(server: McpServer, deps: Pick<McpServerDeps, "sessions" | "activityStore" | "cards" | "logger" | "workflow">): void {
  server.registerTool(
    TOOL_NAMES.actionStartReview,
    {
      title: "Start swap review",
      description: "Create a local swap review session on a supported protocol. Returns an internal review card.",
      inputSchema: z.object({
        intent: swapIntentInputSchema
      }).strict(),
      outputSchema: successOutputSchema({
        reviewSessionId: z.string(),
        card: cardSnapshotSchema,
        plans: z.array(actionPlanSchema),
        preliminaryChecks: z.array(reviewCheckSchema),
        userAnswerUse: userAnswerUseSchema
      }),
      _meta: cardMetadata("review"),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
    },
    async ({ intent }) => {
      if (!supportsCards(server)) return errorToolResult({ kind: "ui_unavailable", details: { reason: "An internal review card is required." } });
      const now = new Date();
      const { protocol: protocolSlug, ...swapIntent } = intent;
      const resolution = resolveIntentPlanFactory(INTENT_PLAN_FACTORIES, swapIntent.type, protocolSlug);
      if (resolution.status !== "resolved") {
        return errorToolResult({
          kind: resolution.status === "unsupported_action" ? "unsupported_action" : "input_invalid",
          details:
            resolution.status === "unsupported_action"
              ? { reason: "unsupported_action", actionKind: resolution.actionKind }
              : resolution.status === "unknown_protocol"
                ? {
                    reason: "unknown_protocol",
                    protocol: resolution.protocolSlug,
                    availableProtocols: resolution.available
                  }
                : {
                    reason: "protocol_choice_required",
                    availableProtocols: resolution.available,
                    guidance: "Several protocols support this action; set intent.protocol to one of availableProtocols. Ask the user - do not pick a protocol silently."
                  }
        });
      }
      const plan = resolution.factory.createPlan(swapIntent, now);

      try {
        const target = deps.workflow?.resolveReviewTarget();
        if (!target || target.status !== "available") return errorToolResult({ kind: target?.reason === "wallet_unavailable" || !target ? "wallet_unavailable"
          : target.reason === "connection_required" ? "active_account_not_set" : "input_invalid",
          details: { reason: target?.reason ?? "wallet_unavailable", action: "check_exact_wallet_account",
            message: "A fixed, currently usable Sui account and its exact connection are required for this review." } });
        const { session } = await deps.sessions.createReviewSession([plan], now);
        const preliminaryChecks: ReviewCheck[] = plan.preliminaryChecks ?? [];
        const hasBlockingPreliminaryChecks = preliminaryChecks.some((check) => check.status === "fail");
        const payload: Omit<McpActionResponse, "card"> = {
          reviewSessionId: session.id,
          plans: session.plans,
          preliminaryChecks,
          userAnswerUse: prepareActionReviewUserAnswerUse({ hasBlockingPreliminaryChecks })
        };
        return await createWorkflowCard(server, deps, "review", { reviewSessionId: session.id, connectionId: target.connectionId, account: target.account }, payload);
      } catch (error) {
        return sessionStoreToolError(error, deps.logger);
      }
    }
  );

  registerSuiMcpTool(
    server,
    TOOL_NAMES.actionCreateProposalReview,
    {
      title: "Create external proposal review",
      description: "Create a local non-signable review session from an untrusted external Sui proposal.",
      inputSchema: z.object({
        proposal: externalProposalSchema
      }),
      outputSchema: successOutputSchema({
        reviewSessionId: z.string(),
        card: cardSnapshotSchema,
        plans: z.array(actionPlanSchema),
        preliminaryChecks: z.array(reviewCheckSchema),
        userAnswerUse: userAnswerUseSchema
      }),
      _meta: cardMetadata("review"),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
    },
    async ({ proposal }) => {
      if (!supportsCards(server)) return errorToolResult({ kind: "ui_unavailable", details: { reason: "An internal review card is required." } });
      const now = new Date();
      const plan = externalProposalToActionPlan(proposal, now);

      try {
        const { session } = await deps.sessions.createReviewSession([plan], now);
        const preliminaryChecks: ReviewCheck[] = plan.preliminaryChecks ?? [];
        const payload: Omit<McpActionResponse, "card"> = {
          reviewSessionId: session.id,
          plans: session.plans,
          preliminaryChecks,
          userAnswerUse: prepareExternalProposalReviewUserAnswerUse()
        };
        return await createWorkflowCard(server, deps, "review", { reviewSessionId: session.id }, payload);
      } catch (error) {
        return sessionStoreToolError(error, deps.logger);
      }
    }
  );
}
