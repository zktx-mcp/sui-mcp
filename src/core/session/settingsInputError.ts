import type { RestoreCheck, SettingsDraft } from "./settingsOperation.js";
import { SuiEndpointError } from "../suiEndpoint.js";
import { LocalSettingsError } from "../preferences/preferencesStore.js";
import { LocalDataError } from "../activity/localDataTypes.js";

export const SETTINGS_REPLACEMENT_BLOCKED_MESSAGE = "A wallet or transaction response is still pending, or the initial transaction-result waiting period has not ended. Local records cannot be replaced yet.";
export type SettingsInputFailure = {
  message: string;
  restoreReason: Extract<RestoreCheck, { status: "cannot_restore" }>["reason"];
};

// Only authenticated Settings validation reaches this mapping. Return fixed
// explanations and recovery categories, never imported values or exceptions.
export function settingsInputError(error: unknown, kind?: SettingsDraft["kind"]): SettingsInputFailure | undefined {
  if (!(error instanceof SuiEndpointError) &&
      !(error instanceof LocalSettingsError && error.kind === "input_invalid") &&
      !(error instanceof LocalDataError && error.kind === "input_invalid")) return undefined;
  const reason = error instanceof SuiEndpointError ? error.kind : error.details.endpointReason ?? error.details.reason;
  const failure = (restoreReason: SettingsInputFailure["restoreReason"], message: string): SettingsInputFailure => ({ restoreReason, message });
  if (kind === "import_local_data") {
    if (reason === "invalid_url" || reason === "chain_identifier_mismatch") return failure("invalid_backup", "A network address saved in this backup could not be verified for Sui mainnet. Choose another Sui MCP backup with valid mainnet network settings.");
    if (reason === "endpoint_timeout" || reason === "endpoint_unreachable") return failure("check_failed", "Sui MCP could not reach a network address saved in this backup. Check that the service is reachable, then check this backup again.");
  }
  switch (reason) {
    case "invalid_url": return failure("invalid_backup", "The network address is not a valid URL. Correct it and select it again.");
    case "chain_identifier_mismatch": return failure("invalid_backup", "The network check did not confirm Sui mainnet at this address. Select a Sui mainnet network address.");
    case "endpoint_timeout": return failure("check_failed", "The service at this network address did not respond in time. Check that it is reachable, then review the change again.");
    case "endpoint_unreachable": return failure("check_failed", "The service at this network address could not be reached. Check the address and your connection, then review the change again.");
    case "wallet_request_unsettled": return failure("wallet_request_unsettled", SETTINGS_REPLACEMENT_BLOCKED_MESSAGE);
    case "invalid_backup_encoding": return failure("invalid_backup", "This backup contains text that Sui MCP cannot read. Choose another backup.");
    case "invalid_backup_json": return failure("invalid_backup", "This backup's contents are incomplete or incorrectly formatted. Choose another backup.");
  }
  if (error instanceof LocalDataError) return failure("invalid_backup", "This file is not a supported Sui MCP backup. Choose another backup.");
  if (error instanceof LocalSettingsError) return failure("check_failed", "This network address could not be checked. Check the address, then review the change again.");
  return undefined;
}
