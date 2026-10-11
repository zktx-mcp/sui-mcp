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
  server.registerTool(TOOL_NAMES.sessionCreateWalletConnection, {
    title: "Open wallet connection controls", description: "Open a card for Sui wallet connection, disconnection and account selection.",
    inputSchema: z.object({ intent: z.enum(["manage", "connect", "disconnect"]).default("manage") }), outputSchema: successOutputSchema(cardSnapshotSchema.shape),
    _meta: cardMetadata("connect"), annotations: { readOnlyHint: false, openWorldHint: false }
  }, async ({ intent }) => { try { return await createWorkflowCard(server, deps, "connect", { intent }); } catch (error) { return failure(error); } });
  server.registerTool(TOOL_NAMES.sessionGetWalletConnection, {
    title: "Get wallet connection", description: "Read the saved state of one wallet connection card.",
    inputSchema: z.object({ cardId: z.string().min(1) }), outputSchema: successOutputSchema(cardSnapshotSchema.shape),
    annotations: { readOnlyHint: false, openWorldHint: false }
  }, async ({ cardId }) => {
    try {
      if (!deps.cards) return failure(new CardError("Wallet card is unavailable."));
      const snapshot = await deps.cards.store.readSaved(cardId);
      if (snapshot.kind !== "connect") return failure(new CardError("Wallet card is unavailable."));
      return okToolResult(snapshot);
    } catch (error) { return failure(error); }
  });
  server.registerTool(TOOL_NAMES.sessionWaitWalletConnection, {
    title: "Wait for wallet connection", description: "Wait briefly for a wallet connection card's approval or required user input.",
    inputSchema: z.object({ cardId: z.string().min(1), timeoutMs: timeoutInputSchema }),
    outputSchema: successOutputSchema({ waitOutcome: z.enum(WAIT_OUTCOMES), card: cardSnapshotSchema }),
    annotations: { readOnlyHint: false, openWorldHint: false }
  }, async ({ cardId, timeoutMs }, extra) => {
    try {
      if (!deps.cards) return failure(new CardError("Wallet card is unavailable."));
      const result = await waitForWalletConnection(deps.cards.store, cardId, { timeoutMs, signal: extra.mcpReq.signal });
      return okToolResult({ waitOutcome: result.waitOutcome, card: result.snapshot });
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
