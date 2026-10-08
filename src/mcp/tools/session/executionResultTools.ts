import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { waitForExecutionResult, WAIT_OUTCOMES } from "../../../core/session/wait.js";
import { reviewStatusResponse } from "../../../core/session/status.js";
import type { McpServerDeps } from "../../server.js";
import { errorToolResult, okToolResult } from "../../result.js";
import { successOutputSchema } from "../../schemas.js";
import { sessionStoreToolError } from "../../toolErrors.js";
import { TOOL_NAMES } from "../../toolNames.js";
import { executionResultUserAnswerUse } from "../../responseGuidance.js";
import { userAnswerUseSchema } from "../read/commonSchemas.js";
import { reviewStatusResponseShape, waitExecutionInputSchema, readCurrentReview } from "./shared.js";

export function registerExecutionResultTools(server: McpServer, deps: McpServerDeps): void {
  server.registerTool(TOOL_NAMES.sessionGetExecutionResult, {
    title: "Get transaction request result", description: "Read one review session's transaction request and any observed chain result.",
    inputSchema: { reviewSessionId: z.string().min(1) },
    outputSchema: successOutputSchema({ ...reviewStatusResponseShape, userAnswerUse: userAnswerUseSchema }),
    annotations: { readOnlyHint: false, openWorldHint: false }
  }, async ({ reviewSessionId }) => {
    try {
      const state = await readCurrentReview(deps, reviewSessionId, true);
      if (!state) return errorToolResult({ kind: "session_not_found", details: { reviewSessionId } });
      const request = state.request;
      return okToolResult({ ...reviewStatusResponse(state), userAnswerUse: executionResultUserAnswerUse({ hasConnectionConflict: !!state.connectionConflict, reconciliationRequired: !!state.connectionReconciliationRequired, hasRequest: !!request, hasExecutionResult: !!request?.execution }) });
    } catch (error) { return sessionStoreToolError(error, deps.logger); }
  });
  server.registerTool(TOOL_NAMES.sessionWaitExecutionResult, {
    title: "Wait for transaction request result", description: "Wait briefly for one admitted request or required user action.",
    inputSchema: waitExecutionInputSchema(),
    outputSchema: successOutputSchema({ waitOutcome: z.enum(WAIT_OUTCOMES), ...reviewStatusResponseShape, userAnswerUse: userAnswerUseSchema }),
    annotations: { readOnlyHint: false, openWorldHint: false }
  }, async ({ reviewSessionId, timeoutMs }, extra) => {
    try {
      const result = await waitForExecutionResult((id) => readCurrentReview(deps, id), reviewSessionId, { timeoutMs, signal: extra.signal });
      return okToolResult({ waitOutcome: result.waitOutcome, ...reviewStatusResponse(result),
        userAnswerUse: executionResultUserAnswerUse({ hasConnectionConflict: !!result.connectionConflict, reconciliationRequired: !!result.connectionReconciliationRequired, hasRequest: !!result.request, hasExecutionResult: !!result.request?.execution, hasWaitOutcome: true }) });
    } catch (error) { return sessionStoreToolError(error, deps.logger); }
  });
}
