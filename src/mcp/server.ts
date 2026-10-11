import { registerReadCards } from "../mcp-ui/tools.js";
import type { CardStore } from "../core/session/cardSessionStore.js";
import type { WalletWorkflow } from "../core/session/walletWorkflow.js";
import { McpServer } from "@modelcontextprotocol/server";
import type { Transport } from "@modelcontextprotocol/server";
import type { SuiReadService } from "../core/read/readService.js";
import type { TransactionActivityService } from "../core/activity/transactionActivityService.js";
import type { ActivityStore } from "../core/activity/activityStore.js";
import type { LocalSettingsService } from "../core/preferences/preferencesStore.js";
import type { SessionStore } from "../core/session/sessionStore.js";
import { registerMcpPrompts } from "./prompts.js";
import type { AdapterPromptSurface } from "../adapters/adapterPromptSurfaces.js";
import { registerMcpResources } from "./resources.js";
import { SERVER_INSTRUCTIONS, SERVER_NAME, SERVER_VERSION } from "./serverInfo.js";
import { assertAllToolNamesValid } from "./toolNames.js";
import { registerActionTools } from "./tools/action/prepareSuiActionReview.js";
import { registerAccountTools } from "./tools/account/index.js";
import { registerReadTools } from "./tools/read/index.js";
import { registerSettingsTools } from "./tools/settings/index.js";
import { registerSessionTools } from "./tools/session/index.js";

export type McpServerDeps = {
  cards?: { store: CardStore } | undefined;
  workflow?: WalletWorkflow | undefined;
  promptSurfaces?: readonly AdapterPromptSurface[];
  sessions: SessionStore;
  activityStore: ActivityStore;
  localSettings: LocalSettingsService;
  readService: SuiReadService;
  transactionActivityService: TransactionActivityService;
  logger: {
    error(message: string, meta?: Record<string, unknown>): void;
  };
};

export function createMcpServer(deps: McpServerDeps): McpServer {
  assertAllToolNamesValid();

  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION
  }, {
    instructions: SERVER_INSTRUCTIONS
  });

  registerMcpResources(server);
  registerReadCards(server, deps);
  registerMcpPrompts(server, deps.promptSurfaces ?? []);
  registerAccountTools(server, deps);
  registerReadTools(server, deps);
  registerSettingsTools(server, deps);
  registerActionTools(server, deps);
  registerSessionTools(server, deps);

  return server;
}

export async function startMcp(server: McpServer, transport: Transport): Promise<void> {
  await server.connect(transport);
}
