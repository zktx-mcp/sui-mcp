import { walletAvailabilitySchema } from "../../../core/session/walletConnection.js";
import { walletConnectionOperationSchema } from "../../../core/session/walletConnectionOperations.js";
import { walletConnectionCardInputSchema } from "../../../core/session/walletConnectionOperations.js";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { cardMetadata, createWorkflowCard } from "../../../mcp-ui/tools.js";
import { cardSnapshotSchema } from "../../../mcp-ui/contracts.js";
import { waitForWalletConnection, WAIT_OUTCOMES } from "../../../core/session/wait.js";
import type { McpServerDeps } from "../../server.js";
import { okToolResult } from "../../result.js";
import { successOutputSchema } from "../../schemas.js";
import { TOOL_NAMES } from "../../toolNames.js";
import { timeoutInputSchema } from "./shared.js";
import { CardError } from "../../../core/session/cardSessionStore.js";
import { sessionStoreToolError } from "../../toolErrors.js";

export function registerWalletConnectionTools(server: McpServer, deps: McpServerDeps): void {
  const failure = (error: unknown) => sessionStoreToolError(error, deps.logger);
  server.registerTool(TOOL_NAMES.sessionOpenWalletConnectionCard, {
    title: "Connect wallet", description: "Open a card for one wallet connection request.",
    inputSchema: walletConnectionCardInputSchema, outputSchema: successOutputSchema(cardSnapshotSchema.shape),
    _meta: cardMetadata("connect"), annotations: { readOnlyHint: false, openWorldHint: false }
  }, async (input) => { try { return await createWorkflowCard(server, deps, "connect", input); } catch (error) { return failure(error); } });
  server.registerTool(TOOL_NAMES.sessionOpenWalletDisconnectionCard, {
    title: "Disconnect wallet", description: "Open a confirmation card for the current wallet disconnection.",
    inputSchema: walletConnectionCardInputSchema, outputSchema: successOutputSchema(cardSnapshotSchema.shape),
    _meta: cardMetadata("disconnect"), annotations: { readOnlyHint: false, openWorldHint: false }
  }, async (input) => { try { return await createWorkflowCard(server, deps, "disconnect", input); } catch (error) { return failure(error); } });
  const operationState = { card: cardSnapshotSchema, operation: walletConnectionOperationSchema.nullable(),
    walletAvailability: walletAvailabilitySchema, evaluatedAt: z.string().datetime() };
  server.registerTool(TOOL_NAMES.sessionGetWalletConnectionCard, {
    title: "Get wallet connection card", description: "Read a wallet card and its exact operation’s current settlement.",
    inputSchema: z.object({ cardId: z.string().min(1) }).strict(), outputSchema: successOutputSchema(operationState),
    annotations: { readOnlyHint: false, openWorldHint: false }
  }, async ({ cardId }) => {
    try {
      if (!deps.cards) return failure(new CardError("Wallet card is unavailable."));
      return okToolResult(await deps.cards.store.readWalletOperation(cardId));
    } catch (error) { return failure(error); }
  });
  server.registerTool(TOOL_NAMES.sessionWaitWalletConnectionCard, {
    title: "Wait for wallet connection card", description: "Wait briefly for one wallet card's exact operation and cleanup.",
    inputSchema: z.object({ cardId: z.string().min(1), timeoutMs: timeoutInputSchema }).strict(),
    outputSchema: successOutputSchema({ ...operationState, waitOutcome: z.enum(WAIT_OUTCOMES) }),
    annotations: { readOnlyHint: false, openWorldHint: false }
  }, async ({ cardId, timeoutMs }, extra) => {
    try {
      if (!deps.cards) return failure(new CardError("Wallet card is unavailable."));
      const result = await waitForWalletConnection(deps.cards.store, cardId, { timeoutMs, signal: extra.mcpReq.signal });
      return okToolResult(result);
    } catch (error) { return failure(error); }
  });
  server.registerTool(TOOL_NAMES.sessionOpenReviewManagement, {
    title: "Open transaction request management", description: "Open management for one existing review session and transaction attempt.",
    inputSchema: z.object({ reviewSessionId: z.string().min(1), attemptId: z.string().min(1) }),
    outputSchema: successOutputSchema(cardSnapshotSchema.shape), _meta: cardMetadata("review"),
    annotations: { readOnlyHint: false, openWorldHint: false }
  }, async (input) => {
    try { return await createWorkflowCard(server, deps, "review", { ...input, mode: "manage" }); }
    catch (error) { return failure(error); }
  });
}
