import { SettingsConflict } from "../core/session/settingsOperation.js";
import { WalletUnavailableError } from "../core/session/walletConnection.js";
import { WorkflowConflict } from "../core/session/sqliteWalletWorkflowStore.js";
import { CardError } from "../core/session/cardSessionStore.js";
import { ActivityStoreReadError } from "../core/activity/activityStore.js";
import { TransactionActivityError } from "../core/activity/transactionActivityTypes.js";
import { LocalSettingsError, PreferencesStoreError } from "../core/preferences/preferencesStore.js";
import type { ToolError } from "../core/action/types.js";
import { SessionStoreError } from "../core/session/sessionStore.js";
import { WaitRequestAbortedError } from "../core/session/wait.js";
import { SuiEndpointError } from "../core/suiEndpoint.js";
import { errorToolResult } from "./result.js";

export type ToolErrorLogger = {
  error(message: string, meta?: Record<string, unknown>): void;
};

export function activityStoreToolError(error: unknown, logger: ToolErrorLogger) {
  if (error instanceof ActivityStoreReadError) {
    return errorToolResult({
      kind: error.kind,
      details: error.details
    });
  }

  logger.error("activity store call failed", {
    error: error instanceof Error ? error.message : String(error)
  });

  return errorToolResult({
    kind: "internal_error",
    details: { message: "Activity store call failed" }
  } satisfies ToolError);
}

export function transactionActivityToolError(error: unknown, logger: ToolErrorLogger) {
  if (error instanceof TransactionActivityError) {
    return errorToolResult({
      kind: error.kind,
      details: error.details
    } satisfies ToolError);
  }

  if (error instanceof ActivityStoreReadError) {
    return errorToolResult({
      kind: error.kind,
      details: error.details
    } satisfies ToolError);
  }

  logger.error("transaction activity call failed", {
    error: error instanceof Error ? error.message : String(error)
  });

  return errorToolResult({
    kind: "internal_error",
    details: { message: "Transaction activity call failed" }
  } satisfies ToolError);
}

export function sessionDomainToolError(error: unknown) {
  if (error instanceof WalletUnavailableError) return errorToolResult({ kind: "wallet_unavailable",
    details: { ...(error.availability.status === "unavailable" ? { reason: error.availability.reason } : {}),
      message: error.message, walletAvailability: error.availability } });
  if (error instanceof WorkflowConflict || error instanceof CardError || error instanceof SettingsConflict) {
    return errorToolResult({ kind: "input_invalid", details: { reason: error instanceof WorkflowConflict ? error.reason ?? error.message : error.message, message: error.message } });
  }
  if (error instanceof WaitRequestAbortedError) {
    return errorToolResult({
      kind: "request_aborted",
      details: { reason: error.reason }
    } satisfies ToolError);
  }

  if (error instanceof SessionStoreError) {
    return errorToolResult({
      kind: error.code,
      details: { code: error.code, ...error.details }
    } satisfies ToolError);
  }

  return undefined;
}

export function sessionStoreToolError(error: unknown, logger: ToolErrorLogger) {
  const known = sessionDomainToolError(error);
  if (known) return known;
  logger.error("session store call failed");

  return errorToolResult({
    kind: "internal_error",
    details: { message: "Session store call failed" }
  } satisfies ToolError);
}

export function localSettingsToolError(error: unknown, logger: ToolErrorLogger) {
  if (error instanceof LocalSettingsError) {
    return errorToolResult({
      kind: error.kind,
      details: error.details
    } satisfies ToolError);
  }

  if (error instanceof PreferencesStoreError) {
    logger.error("local settings store error", {
      error: error.message,
      details: error.details
    });
    return errorToolResult({
      kind: "internal_error",
      details: {
        reason: error.kind,
        message: error.message
      }
    } satisfies ToolError);
  }

  if (error instanceof SuiEndpointError) {
    logger.error("local settings endpoint value error", {
      error: error.message,
      kind: error.kind
    });
    return errorToolResult({
      kind: "internal_error",
      details: {
        reason: error.kind,
        message: error.message
      }
    } satisfies ToolError);
  }

  logger.error("local settings call failed", {
    error: error instanceof Error ? error.message : String(error)
  });

  return errorToolResult({
    kind: "internal_error",
    details: { message: "Local settings call failed" }
  } satisfies ToolError);
}
