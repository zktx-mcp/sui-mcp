import { MarketReadRequests } from "./marketReadRequests.js";
import type { McpServer } from "@modelcontextprotocol/server";
import type { McpServerDeps } from "../../server.js";
import { registerDeepbookReadTools } from "./deepbookReadTools.js";
import {
  registerReviewActivityListTool,
  registerReviewActivitySummaryTools
} from "./reviewActivityTools.js";
import {
  registerServerStatusTools,
  SUPPORTED_PROTOCOLS
} from "./serverStatusTools.js";
import { registerTransactionActivityTools } from "./transactionActivityTools.js";
import { registerWalletReadTools } from "./walletReadTools.js";

export { SUPPORTED_PROTOCOLS };

export function registerReadTools(server: McpServer, deps: McpServerDeps, registeredPromptNames: readonly string[], registeredTools: ReadonlySet<string>,
  fixedResources: Parameters<typeof registerServerStatusTools>[3]): void {
  registerServerStatusTools(server, registeredPromptNames, registeredTools, fixedResources);
  const marketReads = new MarketReadRequests(server, deps.marketReadLifetime);
  registerDeepbookReadTools(server, deps, marketReads);
  registerWalletReadTools(server, deps, registeredTools);
  registerReviewActivityListTool(server, deps);
  registerTransactionActivityTools(server, deps, marketReads);
  registerReviewActivitySummaryTools(server, deps);
}
