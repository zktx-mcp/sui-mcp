import { TransactionError } from "@mysten/sui/client";
import { bcs } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import { parseSuiAddress } from "../suiAddress.js";
import type { SuiChainReceiptEffectsStatus, SuiChainReceiptPackageCall } from "./suiChainReceiptEvidence.js";

// Shared, pure mappers from the SDK getTransaction result to chain-receipt facts.
// Both the session-bound verifier (suiChainReceiptVerifier.ts) and the public
// receipt reader (suiChainReceiptReader.ts) use these so the effects-status,
// Move-call, and object-type shapes are mapped in one place. Balance changes are
// not here because the verifier filters them to the reviewed account while the
// public reader keeps them all, so each owns its own balance mapper.

export type ReviewedOutputGuard = { commandFailure?: "InsufficientCoinBalance" | undefined; transactionDigest: string; commandIndex: number;
  protocolAbort?: { commandIndex: number; packageId: string; moduleOrigin: string; module: string; code: string } | undefined };
export function matchesMinimumAbort(guard: ReviewedOutputGuard | undefined, digest: string, command: number,
  address: string | undefined, module: string | undefined, code: string | undefined): boolean {
  const abort = guard?.protocolAbort;
  if (!abort || guard?.transactionDigest !== digest || abort.commandIndex !== command || abort.module !== module || abort.code !== code || !address) return false;
  const id = parseSuiAddress(address);
  return id === abort.packageId || id === abort.moduleOrigin;
}
export function receiptEffectsStatus(effects: SuiClientTypes.TransactionEffects, digest: string, guard?: ReviewedOutputGuard) {
  const result = effectsStatusFromSdk(effects.status);
  if (result.success || !effects.bcs) return result;
  // Core may expose an Unknown SDK error for insufficient coin balance. The
  // independently read effects BCS retains the protocol error and command.
  try {
    const parsed = bcs.TransactionEffects.parse(effects.bcs);
    const data = parsed.V2 ?? parsed.V1;
    const failure = data?.status.Failure;
    if (data?.transactionDigest !== digest || !failure || failure.command == null) return result;
    const failedCommand = Number(failure.command);
    if (!Number.isSafeInteger(failedCommand) || failedCommand < 0) return result;
    const abort = failure.error.MoveAbort;
    const minimumMissed = (guard?.transactionDigest === digest && guard.commandIndex === failedCommand && guard.commandFailure !== undefined && failure.error.$kind === guard.commandFailure) ||
      (abort && matchesMinimumAbort(guard, digest, failedCommand, abort[0].module.address, abort[0].module.name, abort[1]));
    return { ...result, failedCommand, ...(minimumMissed ? { minimumReceiveFailure: true as const } : {}) };
  } catch { return result; }
}

export function effectsStatusFromSdk(status: SuiClientTypes.ExecutionStatus): SuiChainReceiptEffectsStatus {
  if (status.success) {
    return { success: true };
  }
  const error = status.error;
  const errorKind =
    typeof error === "object" && error !== null && typeof error.$kind === "string"
      ? error.$kind.slice(0, 200)
      : undefined;
  const errorMessage =
    typeof error === "object" && error !== null && typeof error.message === "string" && error.message.length > 0
      ? error.message.slice(0, 2000)
      : undefined;
  return {
    success: false,
    ...(errorKind === undefined ? {} : { errorKind }),
    ...(errorMessage === undefined ? {} : { errorMessage })
  };
}

export function packageCallsFromTransaction(
  transaction: SuiClientTypes.TransactionData
): SuiChainReceiptPackageCall[] {
  return transaction.commands.flatMap((command, commandIndex) => {
    const moveCall = moveCallFromCommand(command);
    if (!moveCall) {
      return [];
    }
    const packageId = parseSuiAddress(moveCall.package);
    if (!packageId) {
      throw new Error("Sui mainnet receipt contains a Move call with an invalid package id.");
    }
    return [
      {
        commandIndex,
        packageId,
        module: moveCall.module,
        function: moveCall.function,
        target: `${packageId}::${moveCall.module}::${moveCall.function}`
      }
    ];
  });
}

export function objectTypesFromSdk(objectTypes: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(objectTypes).map(([objectId, objectType]) => {
      const normalizedObjectId = parseSuiAddress(objectId);
      if (!normalizedObjectId) {
        throw new Error("Sui mainnet receipt contains an invalid object id in objectTypes.");
      }
      return [normalizedObjectId, objectType];
    })
  );
}

// Fail-closed address parsing for receipt facts. Both the verifier and the
// public reader turn a raw chain address into a receipt address ONLY through
// this helper, so neither path can silently drop or null out a balance-change
// address or sender when the SDK payload is not the expected shape. A malformed
// address throws; callers map the throw to a fail-closed receipt outcome rather
// than returning partial facts.
export function requireReceiptAddress(
  rawAddress: string | null | undefined,
  errorMessage: string
): string {
  const address = rawAddress === null || rawAddress === undefined ? undefined : parseSuiAddress(rawAddress);
  if (!address) {
    throw new Error(errorMessage);
  }
  return address;
}

// Shared error classification for the getTransaction read, used by both the
// verifier and the public reader so a "transaction not found" is recognized one
// way everywhere.
export function isReceiptNotFoundError(error: unknown, digest: string): boolean {
  if (error instanceof TransactionError) return error.reason === "notFound" && error.digest === digest;
  const code =
    typeof error === "object" && error !== null
      ? ((error as { code?: unknown; status?: unknown }).code ?? (error as { status?: unknown }).status)
      : undefined;
  if (code === "NOT_FOUND" || code === "NotFound" || code === "NOT_FOUND_ERROR" || code === 5) {
    return true;
  }
  if (code !== undefined) return false;
  const message = receiptErrorMessage(error, "").trim();
  return /^(?:transaction(?: block)?(?: (?:with |for )?digest [1-9A-HJ-NP-Za-km-z]+)? (?:was |is )?(?:not found|not indexed)|(?:could not|unable to) find transaction(?: block)?(?: (?:with |for )?digest [1-9A-HJ-NP-Za-km-z]+)?)[.!]?$/i.test(message);
}

export function receiptErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    return error.message || fallback;
  }
  if (typeof error === "string") {
    return error || fallback;
  }
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  return fallback;
}

function moveCallFromCommand(
  command: SuiClientTypes.TransactionData["commands"][number]
): { package: string; module: string; function: string } | undefined {
  const maybeCommand = command as {
    $kind?: string;
    MoveCall?: { package: string; module: string; function: string };
  };
  if (!maybeCommand.MoveCall) {
    return undefined;
  }
  if (maybeCommand.$kind !== undefined && maybeCommand.$kind !== "MoveCall") {
    return undefined;
  }
  return maybeCommand.MoveCall;
}
