import { isEndpointAccessDenied, withRpcDeadline } from "../suiEndpoint.js";
import { receiptObservationMessages } from "../session/transactionRequest.js";
import { projectPublicChainReceipt, type PublicChainReceiptResult } from "./suiChainReceiptReader.js";
import { TransactionError, type SuiClientTypes } from "@mysten/sui/client";
import { assertNoForbiddenMcpFields } from "./forbiddenFields.js";
import {
  SUI_CHAIN_RECEIPT_REQUIRED_INCLUDE,
  type SuiChainReceiptAccountBalanceChange,
  type SuiChainReceiptEvidence,
  type SuiChainReceiptIncludeField,
  receiptDetailSchemas,
  suiChainReceiptEvidenceSchema
} from "./suiChainReceiptEvidence.js";
import { normalizeCoinType } from "../read/coinMetadata.js";
import { parseSuiAddress, suiTransactionDigestSchema } from "../suiAddress.js";
import {
  receiptEffectsStatus,
  type ReviewedOutputGuard,
  isReceiptNotFoundError,
  objectTypesFromSdk,
  packageCallsFromTransaction,
  receiptErrorMessage,
  requireReceiptAddress
} from "./suiChainReceiptMapping.js";

type ChainReceiptInclude = { [Field in SuiChainReceiptIncludeField]: true };

export const SUI_CHAIN_RECEIPT_GET_TRANSACTION_INCLUDE = includeObjectFromFields(
  SUI_CHAIN_RECEIPT_REQUIRED_INCLUDE
);

// Bounded per-read wait for the known digest to become visible on this node.
// This existing 12-second source-read window is independent of the backend's
// 10-minute initial observation deadline. A missing receipt does not establish
// whether a prior submit (including one with a lost reply) executed.
export const SUI_CHAIN_RECEIPT_WAIT_TIMEOUT_MS = 12_000;

function isWaitTimeoutError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "TimeoutError";
}

export type SuiChainReceiptVerifierClient = {
  core: {
    getChainIdentifier(): Promise<SuiClientTypes.GetChainIdentifierResponse>;
    getTransaction(
      options: SuiClientTypes.GetTransactionOptions<ChainReceiptInclude>
    ): Promise<SuiClientTypes.TransactionResult<ChainReceiptInclude>>;
  };
};

export type VerifySuiChainReceiptInput = {
  guard?: ReviewedOutputGuard | undefined;
  txDigest: string;
  reviewedTransactionDigest: string;
  account: string;
  now: Date;
  signal?: AbortSignal | undefined;
  remainingMs?: number | undefined;
};

export type VerifySuiChainReceiptOptions = {
  client: SuiChainReceiptVerifierClient;
  network: "mainnet";
  expectedChainIdentifier: string;
  readChainIdentifier?: (signal: AbortSignal) => Promise<string>;
  includeDisplay?: boolean;
};

export type SuiChainReceiptVerificationResult =
  | {
      status: "verified_success";
      receipt: SuiChainReceiptEvidence;
      display?: PublicChainReceiptResult;
    }
  | {
      status: "verified_failure";
      failureReason: "chain_execution_failed";
      message: string;
      receipt: SuiChainReceiptEvidence;
      display?: PublicChainReceiptResult;
    }
  | {
      status: "not_found" | "wait_timed_out" | "access_denied" | "source_unavailable" | "wrong_chain";
      failureReason: "chain_receipt_unavailable";
      message: string;
    }
  | {
      status: "verification_failed";
      failureReason: "receipt_verification_failed";
      message: string;
    };

export async function verifySuiChainReceipt(
  options: VerifySuiChainReceiptOptions,
  input: VerifySuiChainReceiptInput
): Promise<SuiChainReceiptVerificationResult> {
  const parsedInput = parseVerifierInput(input);
  if (!parsedInput.ok) {
    return verificationFailed(parsedInput.message);
  }

  if (options.network !== "mainnet") {
    return verificationFailed("Chain receipt verification requires a verified Sui mainnet endpoint.");
  }

  let chainIdentifier: string;
  let result: SuiClientTypes.TransactionResult<ChainReceiptInclude>;
  let readingDigest = false;
  try {
    const read = await withRpcDeadline(Math.min(input.remainingMs ?? SUI_CHAIN_RECEIPT_WAIT_TIMEOUT_MS, SUI_CHAIN_RECEIPT_WAIT_TIMEOUT_MS), async signal => {
      const chain = options.readChainIdentifier ? await options.readChainIdentifier(signal) : (await options.client.core.getChainIdentifier()).chainIdentifier;
      if (chain !== options.expectedChainIdentifier) return undefined;
      readingDigest = true;
      const transaction = await options.client.core.getTransaction({ digest: parsedInput.txDigest,
        include: { ...SUI_CHAIN_RECEIPT_GET_TRANSACTION_INCLUDE, ...(options.includeDisplay ? { events: true } : {}) }, signal });
      return { chain, transaction };
    }, input.signal);
    if (!read) return { status: "wrong_chain", failureReason: "chain_receipt_unavailable", message: receiptObservationMessages.wrong_chain };
    chainIdentifier = read.chain;
    result = read.transaction;
  } catch (error) {
    input.signal?.throwIfAborted();
    if (error instanceof TransactionError && error.digest !== parsedInput.txDigest) return verificationFailed("The node reported a different transaction digest.");
    const status = isEndpointAccessDenied(error) ? "access_denied"
      : isWaitTimeoutError(error) || (error && typeof error === "object" && "code" in error && error.code === "DEADLINE_EXCEEDED") ? "wait_timed_out"
      : readingDigest && isReceiptNotFoundError(error, parsedInput.txDigest) ? "not_found" : "source_unavailable";
    return { status, failureReason: "chain_receipt_unavailable", message: receiptObservationMessages[status] };
  }

  try {
    const transaction = result.$kind === "Transaction" ? result.Transaction : result.FailedTransaction;
    const receipt = createSuiChainReceiptEvidenceFromTransaction({
      transaction, guard: input.guard,
      txDigest: parsedInput.txDigest,
      reviewedTransactionDigest: parsedInput.reviewedTransactionDigest,
      account: parsedInput.account,
      chainIdentifier,
      fetchedAt: parsedInput.now
    });
    if (result.$kind === "FailedTransaction" && receipt.effectsStatus.success) throw new Error("Transaction status disagrees with its effects.");
    const display = options.includeDisplay
      ? { display: projectPublicChainReceipt(result as SuiClientTypes.TransactionResult<ChainReceiptInclude & { events: true }>, parsedInput.txDigest, chainIdentifier, parsedInput.now, input.guard) }
      : {};
    if (!receipt.effectsStatus.success) {
      return {
        ...display,
        status: "verified_failure",
        failureReason: "chain_execution_failed",
        message: "Sui mainnet verified the transaction receipt and reported failed execution effects.",
        receipt
      };
    }
    return { status: "verified_success", receipt, ...display };
  } catch (error) {
    return verificationFailed(receiptErrorMessage(error, "Sui mainnet transaction receipt could not be verified."));
  }
}

function includeObjectFromFields(fields: readonly SuiChainReceiptIncludeField[]): ChainReceiptInclude {
  return Object.fromEntries(fields.map((field) => [field, true])) as ChainReceiptInclude;
}

function parseVerifierInput(input: VerifySuiChainReceiptInput):
  | { ok: true; txDigest: string; reviewedTransactionDigest: string; account: string; now: Date }
  | { ok: false; message: string } {
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
    return { ok: false, message: "Chain receipt fetchedAt time must be a valid Date." };
  }
  const txDigest = suiTransactionDigestSchema.safeParse(input.txDigest);
  if (!txDigest.success) {
    return { ok: false, message: "Signed transaction digest is not a valid Sui transaction digest." };
  }
  const reviewedTransactionDigest = suiTransactionDigestSchema.safeParse(input.reviewedTransactionDigest);
  if (!reviewedTransactionDigest.success) {
    return { ok: false, message: "Reviewed transaction digest is not a valid Sui transaction digest." };
  }
  const account = parseSuiAddress(input.account);
  if (!account) {
    return { ok: false, message: "Reviewed account is not a valid Sui address." };
  }
  return {
    ok: true,
    txDigest: txDigest.data,
    reviewedTransactionDigest: reviewedTransactionDigest.data,
    account,
    now: input.now
  };
}

function createSuiChainReceiptEvidenceFromTransaction(input: {
  transaction: SuiClientTypes.Transaction<ChainReceiptInclude>;
  guard?: ReviewedOutputGuard | undefined;
  txDigest: string;
  reviewedTransactionDigest: string;
  account: string;
  chainIdentifier: string;
  fetchedAt: Date;
}): SuiChainReceiptEvidence {
  if (input.txDigest !== input.reviewedTransactionDigest) {
    throw new Error("Signed transaction digest does not match the reviewed transaction digest.");
  }
  if (input.transaction.digest !== input.txDigest) {
    throw new Error("Sui mainnet returned a transaction digest that does not match the signed digest.");
  }
  const transactionData = input.transaction.transaction;
  if (!transactionData) {
    throw new Error("Sui mainnet receipt is missing parsed transaction data.");
  }
  const effects = input.transaction.effects;
  if (!effects || typeof effects.status?.success !== "boolean") {
    throw new Error("Sui mainnet receipt is missing transaction effects.");
  }
  if (effects.transactionDigest !== input.txDigest) {
    throw new Error("Sui mainnet receipt effects digest does not match the signed digest.");
  }
  const sender = requireReceiptAddress(transactionData.sender, "Sui mainnet receipt is missing a valid sender.");
  if (sender !== input.account) {
    throw new Error("Sui mainnet receipt sender does not match the reviewed account.");
  }
  const optional = <T>(read: () => T): T | undefined => {
    try { return read(); } catch { return undefined; }
  };
  const packageCalls = optional(() => receiptDetailSchemas.packageCalls.parse(packageCallsFromTransaction(transactionData)));
  const accountBalanceChanges = input.transaction.balanceChanges && optional(() => receiptDetailSchemas.accountBalanceChanges.parse(accountBalanceChangesFromSdk(input.transaction.balanceChanges, input.account)));
  const objectTypes = input.transaction.objectTypes && optional(() => receiptDetailSchemas.objectTypes.parse(objectTypesFromSdk(input.transaction.objectTypes)));
  const receipt = {
    ...(packageCalls && accountBalanceChanges && objectTypes ? { kind: "sui_chain_receipt_v1" as const } :
      { kind: "sui_chain_receipt_outcome_v2" as const, detailStatus: "incomplete" as const }),
    source: {
      method: "client.core.getTransaction",
      network: "sui:mainnet",
      chainIdentifier: input.chainIdentifier,
      fetchedAt: input.fetchedAt.toISOString(),
      include: [...SUI_CHAIN_RECEIPT_REQUIRED_INCLUDE]
    },
    txDigest: input.txDigest,
    sender,
    effectsStatus: receiptEffectsStatus(effects, input.txDigest, input.guard),
    ...(packageCalls && { packageCalls }), ...(accountBalanceChanges && { accountBalanceChanges }), ...(objectTypes && { objectTypes })
  };
  const parsed = suiChainReceiptEvidenceSchema.parse(receipt);
  assertNoForbiddenMcpFields(parsed);
  return parsed;
}

function accountBalanceChangesFromSdk(
  balanceChanges: SuiClientTypes.BalanceChange[],
  account: string
): SuiChainReceiptAccountBalanceChange[] {
  return balanceChanges.flatMap((change, index) => {
    const address = requireReceiptAddress(
      change.address,
      "Sui mainnet receipt contains a balance change with an invalid address."
    );
    if (address !== account) {
      return [];
    }
    const amount = BigInt(change.amount);
    return [{
      index,
      coinType: normalizeCoinType(change.coinType),
      amountRaw: amount.toString(),
      direction: amount > 0n ? "increase" : amount < 0n ? "decrease" : "zero"
    }];
  });
}

function verificationFailed(message: string): SuiChainReceiptVerificationResult {
  return {
    status: "verification_failed",
    failureReason: "receipt_verification_failed",
    message
  };
}

