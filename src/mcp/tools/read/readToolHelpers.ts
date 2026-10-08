import { CONNECTION_CONFLICT_MESSAGE, CONNECTION_RECONCILIATION_MESSAGE } from "../../../core/session/walletConnection.js";
import {
  ReadServiceCacheError,
  ReadServiceInputError
} from "../../../core/read/readService.js";
import { parseSuiAddress } from "../../../core/suiAddress.js";
import { errorToolResult } from "../../result.js";
import { activityStoreToolError } from "../../toolErrors.js";
import type { McpServerDeps } from "../../server.js";
import { walletUnavailable } from "../../../core/session/walletConnection.js";
import { TOOL_NAMES } from "../../toolNames.js";

type AssetAccountInput =
  | { mode: "explicit_or_connected"; account?: string | undefined }
  | { mode: "connected_only" };

export async function resolveExplicitOrActiveAccount(
  input: AssetAccountInput,
  deps: Pick<McpServerDeps, "activityStore" | "workflow" | "logger">
): Promise<
  | { status: "ok"; account: string }
  | { status: "error"; result: ReturnType<typeof errorToolResult> }
  | { status: "address_required"; message: string; result: ReturnType<typeof errorToolResult> }
> {
  if (input.mode === "explicit_or_connected" && input.account !== undefined) {
    const explicitAccount = parseSuiAddress(input.account);
    if (explicitAccount === undefined) {
      return {
        status: "error",
        result: errorToolResult({
          kind: "input_invalid",
          details: {
            field: "account"
          }
        })
      };
    }
    return { status: "ok", account: explicitAccount };
  }

  let active;
  try {
    active = await deps.activityStore.getActiveAccount();
  } catch (error) {
    return { status: "error", result: activityStoreToolError(error, deps.logger) };
  }
  if (!active && input.mode === "explicit_or_connected") {
    const message = "Please provide a Sui address in chat.";
    return {
      status: "address_required", message,
      result: errorToolResult({
        kind: "active_account_not_set",
        details: {
          action: "provide_account", message
        }
      })
    };
  }
  try {
    const context = deps.workflow?.reconcileConnectionContext();
    if (context?.assetReadAccount.status === "available") return { status: "ok", account: context.assetReadAccount.account };
    const availability = context?.walletAvailability ?? walletUnavailable("initialization_failed");
    if (input.mode === "connected_only") {
      if (availability.status !== "available") return { status: "error", result: errorToolResult({ kind: "wallet_unavailable",
        details: { ...(availability.status === "unavailable" ? { reason: availability.reason } : {}), message: availability.message, walletAvailability: availability } }) };
      return { status: "error", result: errorToolResult({ kind: active ? "input_invalid" : "active_account_not_set",
        details: { reason: "connected_account_required",
          message: context?.connectionReconciliationRequired ? CONNECTION_RECONCILIATION_MESSAGE : context?.connectionConflict ? CONNECTION_CONFLICT_MESSAGE : "This tool requires a selected account with a usable wallet connection. An address alone cannot be used.",
          ...(context?.connectionConflict ? { connectionConflict: context.connectionConflict } : {}),
          ...(context?.connectionReconciliationRequired ? { connectionReconciliationRequired: true } : {}),
          followUp: { tool: TOOL_NAMES.sessionGetInteractionStatus,
            answerFields: ["walletAvailability", "connections", "pendingWalletConnections", "assetReadAccount"],
            reason: `Check current connections and pending operations. Use pendingWalletConnections.items[].cardId with ${TOOL_NAMES.sessionGetWalletConnection} or ${TOOL_NAMES.sessionWaitWalletConnection}. If no operation is pending and the user requests connection or account selection, open ${TOOL_NAMES.sessionCreateWalletConnection}. Only the user may act in that card.` } } }) };
    }
    const message = context?.connectionReconciliationRequired ? CONNECTION_RECONCILIATION_MESSAGE + " Provide a Sui address in chat for this public read." : context?.connectionConflict ? CONNECTION_CONFLICT_MESSAGE + " Provide a Sui address in chat for this public read." : availability.status !== "available"
      ? "The wallet connection cannot be checked. Please provide a Sui address in chat to view its assets."
      : "No connected wallet is available for the selected account. Please provide a Sui address in chat.";
    return { status: "address_required", message, result: errorToolResult({ kind: "input_invalid",
      details: { field: "account", reason: "address_required", message, walletAvailability: availability } }) };
  } catch (error) {
    return { status: "error", result: activityStoreToolError(error, deps.logger) };
  }
}

export function readServiceError(error: unknown, deps: McpServerDeps) {
  if (error instanceof ReadServiceCacheError) {
    deps.logger.error("read service metadata cache failed", {
      operation: error.details.operation,
      error: error.cause instanceof Error ? error.cause.message : String(error.cause)
    });
    return errorToolResult({
      kind: error.kind,
      details: error.details
    });
  }

  if (error instanceof ReadServiceInputError) {
    return errorToolResult({
      kind: error.kind,
      details: error.details
    });
  }

  deps.logger.error("read service call failed", {
    error: error instanceof Error ? error.message : String(error)
  });

  return errorToolResult({
    kind: "internal_error",
    details: { message: "Read service call failed" }
  });
}

export function activityStoreReadError(error: unknown, deps: McpServerDeps) {
  return activityStoreToolError(error, deps.logger);
}
