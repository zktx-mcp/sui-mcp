import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { SETTINGS_APPLIES_AFTER_RESTART } from "../../../core/preferences/preferencesStore.js";
import { registerSuiMcpTool } from "../../registerTool.js";
import { okToolResult } from "../../result.js";
import { noParamsInputSchema, successOutputSchema } from "../../schemas.js";
import type { McpServerDeps } from "../../server.js";
import { localSettingsToolError, sessionStoreToolError } from "../../toolErrors.js";
import { TOOL_NAMES } from "../../toolNames.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { cardMetadata, createWorkflowCard } from "../../../mcp-ui/tools.js";
import { cardSnapshotSchema } from "../../../mcp-ui/contracts.js";

const endpointSettingSchema = z.object({
  storedValue: z.string(),
  effectiveValue: z.string(),
  source: z.enum(["environment", "local_db", "builtin_default"]),
  pendingStoredValue: z.string().optional(),
  appliesAfter: z.literal(SETTINGS_APPLIES_AFTER_RESTART).optional()
});

export function registerSettingsTools(server: McpServer, deps: Pick<McpServerDeps, "cards" | "localSettings" | "logger">): void {
  registerAppTool(server, TOOL_NAMES.settingsCreateLocalSettingsSession,
    { title: "Settings", description: "Open a local settings card.", inputSchema: noParamsInputSchema,
      outputSchema: successOutputSchema(cardSnapshotSchema.shape), _meta: cardMetadata("settings"),
      annotations: { readOnlyHint: false, openWorldHint: false } },
    async () => {
      try { return await createWorkflowCard(server, deps, "settings", {}); }
      catch (error) { return sessionStoreToolError(error, deps.logger); }
    });

  registerSuiMcpTool(
    server,
    TOOL_NAMES.settingsGetLocalSettings,
    {
      title: "Get local settings",
      description: "Read local Sui MCP settings.",
      inputSchema: noParamsInputSchema,
      outputSchema: successOutputSchema({
        suiGrpcUrl: endpointSettingSchema,
        suiGraphqlUrl: endpointSettingSchema
      }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => {
      try {
        return okToolResult(await deps.localSettings.getLocalSettings());
      } catch (error) {
        return localSettingsToolError(error, deps.logger);
      }
    }
  );
}
