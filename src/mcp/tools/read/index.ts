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

export function registerReadTools(server: McpServer, deps: McpServerDeps, registeredPromptNames: readonly string[]): void {
  registerServerStatusTools(server, registeredPromptNames);
  registerDeepbookReadTools(server, deps);
  registerWalletReadTools(server, deps);
  registerReviewActivityListTool(server, deps);
  registerTransactionActivityTools(server, deps);
  registerReviewActivitySummaryTools(server, deps);
}
