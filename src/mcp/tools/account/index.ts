import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { activeAccountResponse, activeAccountResponseSchema } from "../../activeAccountResponse.js";
import { okToolResult } from "../../result.js";
import { noParamsInputSchema } from "../../schemas.js";
import type { McpServerDeps } from "../../server.js";
import { activityStoreToolError } from "../../toolErrors.js";
import { TOOL_NAMES } from "../../toolNames.js";

export function registerAccountTools(server: McpServer, deps: McpServerDeps): void {
  server.registerTool(
    TOOL_NAMES.accountGetActiveAccount,
    {
      title: "Get active account read context",
      description: "Return the active account address for wallet-account reads. Read context only; not signing authorization.",
      inputSchema: noParamsInputSchema,
      outputSchema: z.object({
        ok: z.literal(true),
        data: activeAccountResponseSchema
      }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => {
      try {
        const active = await deps.activityStore.getActiveAccount();
        return okToolResult(activeAccountResponse(active));
      } catch (error) {
        return activityStoreToolError(error, deps.logger);
      }
    }
  );

}
