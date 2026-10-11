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
import { activityStoreToolError, sessionStoreToolError } from "../../toolErrors.js";
import { TOOL_NAMES } from "../../toolNames.js";
import { userAnswerUseSchema } from "../read/commonSchemas.js";

export function registerActionTools(server: McpServer, deps: Pick<McpServerDeps, "sessions" | "activityStore" | "cards" | "logger">): void {
  server.registerTool(
    TOOL_NAMES.actionPrepareSuiActionReview,
    {
      title: "Prepare swap review",
      description: "Create a local swap review session on a supported protocol. Returns an internal review card.",
      inputSchema: z.object({
        intent: swapIntentInputSchema
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
    async ({ intent }) => {
      if (!supportsCards(server)) return errorToolResult({ kind: "ui_unavailable", details: { reason: "An internal review card is required." } });
      const now = new Date();
      // A swap review is account-bound: its evidence (balances, transaction
      // material, digest, simulation) is computed for a specific sender, and
      // no transaction can be built without that account. Refuse here when no
      // wallet account is connected instead of creating a hollow proposal that
      // can never be computed or signed. Connect first via
      // session.create_wallet_connection.
      let activeAccount;
      try {
        activeAccount = await deps.activityStore.getActiveAccount();
      } catch (error) {
        return activityStoreToolError(error, deps.logger);
      }
      if (!activeAccount) {
        return errorToolResult({
          kind: "active_account_not_set",
          details: { action: "connect_wallet_connection" }
        });
      }
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
        const { session } = await deps.sessions.createReviewSession([plan], now);
        const preliminaryChecks: ReviewCheck[] = plan.preliminaryChecks ?? [];
        const hasBlockingPreliminaryChecks = preliminaryChecks.some((check) => check.status === "fail");
        const payload: Omit<McpActionResponse, "card"> = {
          reviewSessionId: session.id,
          plans: session.plans,
          preliminaryChecks,
          userAnswerUse: prepareActionReviewUserAnswerUse({ hasBlockingPreliminaryChecks })
        };
        return await createWorkflowCard(server, deps, "review", { reviewSessionId: session.id }, payload);
      } catch (error) {
        return sessionStoreToolError(error, deps.logger);
      }
    }
  );

  registerSuiMcpTool(
    server,
    TOOL_NAMES.actionPrepareExternalProposalReview,
    {
      title: "Prepare external proposal review",
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
