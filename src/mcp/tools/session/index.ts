import type { McpServer } from "@modelcontextprotocol/server";
import type { McpServerDeps } from "../../server.js";
import { registerExecutionResultTools } from "./executionResultTools.js";
import { registerSessionStatusTools } from "./statusTools.js";
import { registerWalletConnectionTools } from "./walletConnectionTools.js";

export function registerSessionTools(server: McpServer, deps: McpServerDeps): void {
  registerWalletConnectionTools(server, deps);
  registerSessionStatusTools(server, deps);
  registerExecutionResultTools(server, deps);
}
