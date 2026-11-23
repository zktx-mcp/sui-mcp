import { readCoinReservation } from "./transactionFunding.js";
import type { SuiClientTypes } from "@mysten/sui/client";
import { normalizeCoinType, type CoinUnit } from "../read/coinMetadata.js";
import { suiTransactionDigestSchema } from "../suiAddress.js";
import { receiptPtbMermaid } from "./receiptPtbGraph.js";
import {
  receiptEffectsStatus,
  type ReviewedOutputGuard,
  isReceiptNotFoundError,
  objectTypesFromSdk,
  packageCallsFromTransaction,
  receiptErrorMessage,
  requireReceiptAddress
} from "./suiChainReceiptMapping.js";
import {
  SUI_CHAIN_RECEIPT_REQUIRED_INCLUDE,
  type SuiChainReceiptEffectsStatus,
  type SuiChainReceiptIncludeField,
  type SuiChainReceiptPackageCall
} from "./suiChainReceiptEvidence.js";

// Public chain-receipt read: on-chain facts for ANY transaction digest, with no
// session, no reviewed-digest comparison, and no account filter. It keeps every
// balance change (each tagged with its address), unlike the session-bound
// verifier which keeps only the reviewed account's changes. The SDK read and the
// fact mappers are shared with the verifier through suiChainReceiptMapping.ts.
//
// The public reader additionally includes `events` and derives gas, inputs, and a
// left-to-right PTB graph for the receipt page. These are public on-chain facts of
// the transaction read by its digest; no new authority and no interpretation.
type ChainReceiptInclude = { [Field in SuiChainReceiptIncludeField]: true } & { events: true };

const PUBLIC_RECEIPT_INCLUDE = {
  ...Object.fromEntries(SUI_CHAIN_RECEIPT_REQUIRED_INCLUDE.map((field) => [field, true])),
  events: true
} as ChainReceiptInclude;

export type PublicChainReceiptBalanceChange = {
  index: number;
  address: string;
  coinType: string;
  amountRaw: string;
  direction: "increase" | "decrease" | "zero";
  // Best-effort coin-metadata enrichment for a decimal display. Present only when
  // the coin's verified decimals were resolved; absent leaves the page on the raw
  // amount. A metadata failure never fails the receipt.
  decimals?: number;
  symbol?: string;
};

export type PublicChainReceiptGas = {
  totalMist: string;
  computationMist: string;
  storageMist: string;
  storageRebateMist: string;
  nonRefundableStorageMist: string;
  budgetMist: string | undefined;
  priceMist: string | undefined;
  paymentObjectId: string | undefined;
};

export type PublicChainReceiptInput = {
  index: number;
  kind: "object" | "shared_object" | "receiving" | "pure" | "withdrawal" | "unknown";
  objectId: string | undefined;
  // Raw BCS bytes (0x-hex) for a pure input. A pure value's Move type is only
  // determinable from the called function's signature (not resolved in this
  // lightweight public read), so the receipt surfaces the verifiable raw bytes
  // rather than guess a scalar type from byte length.
  bytes?: string;
};

export type PublicChainReceiptEvent = {
  index: number;
  packageId: string;
  module: string;
  eventType: string;
  sender: string;
};

export type PublicChainReceiptPtbGraph = { mermaid: { text: string; namedText: string } };

export type PublicChainReceipt = {
  txDigest: string;
  sender: string | undefined;
  effectsStatus: SuiChainReceiptEffectsStatus;
  packageCalls: SuiChainReceiptPackageCall[];
  balanceChanges: PublicChainReceiptBalanceChange[];
  objectTypes: Record<string, string>;
  gas: PublicChainReceiptGas | undefined;
  unavailableFields?: string[];
  inputs: PublicChainReceiptInput[];
  events: PublicChainReceiptEvent[];
  ptbGraph: PublicChainReceiptPtbGraph | undefined;
  chainIdentifier: string;
  fetchedAt: string;
};

export type PublicChainReceiptResult =
  | { status: "found"; receipt: PublicChainReceipt }
  | { status: "observed"; txDigest: string; effectsStatus: SuiChainReceiptEffectsStatus; fetchedAt: string; detailStatus: "unavailable" }
  | { status: "invalid_digest" }
  | { status: "not_found" }
  | { status: "unavailable"; message: string };

export type PublicChainReceiptReaderClient = {
  core: {
    getChainIdentifier(): Promise<SuiClientTypes.GetChainIdentifierResponse>;
    getTransaction(
      options: SuiClientTypes.GetTransactionOptions<ChainReceiptInclude>
    ): Promise<SuiClientTypes.TransactionResult<ChainReceiptInclude>>;
  };
};

export type ReadPublicChainReceiptOptions = {
  client: PublicChainReceiptReaderClient;
  network: "mainnet";
  expectedChainIdentifier: string;
  readChainIdentifier?: () => Promise<string>;
  // Optional best-effort resolver for a balance-change coin's verified decimals and
  // symbol (the shared coin-metadata cache + DeepBook fallback). When omitted, the
  // receipt keeps raw amounts. Wired in start.ts from the read service.
  reviewedOutputGuard?: (digest: string, sender: string) => ReviewedOutputGuard | undefined;
  resolveCoinUnit?: (coinType: string) => Promise<CoinUnit>;
};

export async function readPublicChainReceipt(
  options: ReadPublicChainReceiptOptions,
  input: { digest: string; now: Date }
): Promise<PublicChainReceiptResult> {
  const digest = suiTransactionDigestSchema.safeParse(input.digest);
  if (!digest.success) {
    return { status: "invalid_digest" };
  }
  if (options.network !== "mainnet") {
    return { status: "unavailable", message: "Receipt reads require a verified Sui mainnet endpoint." };
  }

  let chainIdentifier: string;
  try {
    chainIdentifier = options.readChainIdentifier ? await options.readChainIdentifier() :
      (await options.client.core.getChainIdentifier()).chainIdentifier;
  } catch (error) {
    return { status: "unavailable", message: receiptErrorMessage(error, "Sui mainnet chain identifier lookup failed.") };
  }
  if (chainIdentifier !== options.expectedChainIdentifier) {
    return { status: "unavailable", message: "Receipt reads require a verified Sui mainnet endpoint." };
  }

  let result: SuiClientTypes.TransactionResult<ChainReceiptInclude>;
  try {
    result = await options.client.core.getTransaction({ digest: digest.data, include: PUBLIC_RECEIPT_INCLUDE });
  } catch (error) {
    if (isReceiptNotFoundError(error, digest.data)) {
      return { status: "not_found" };
    }
    return { status: "unavailable", message: receiptErrorMessage(error, "Sui mainnet transaction lookup failed.") };
  }

  const tx = result.$kind === "Transaction" ? result.Transaction : result.FailedTransaction;
  const sender = tx.transaction?.sender;
  let guard: ReviewedOutputGuard | undefined;
  if (tx.digest === digest.data && sender && tx.effects?.status?.success === false) {
    try { guard = options.reviewedOutputGuard?.(digest.data, sender); }
    catch { /* Local review instructions are optional context for a verified chain failure. */ }
  }
  const projected = projectPublicChainReceipt(result, digest.data, chainIdentifier, input.now, guard);
  if (projected.status !== "found" || !options.resolveCoinUnit) return projected;
  return { status: "found", receipt: { ...projected.receipt,
    balanceChanges: await withCoinDecimals(projected.receipt.balanceChanges, options.resolveCoinUnit) } };
}

export function projectPublicChainReceipt(result: SuiClientTypes.TransactionResult<ChainReceiptInclude>, digest: string,
  chainIdentifier: string, now: Date, guard?: ReviewedOutputGuard): PublicChainReceiptResult {
  const transaction = result.$kind === "Transaction" ? result.Transaction : result.FailedTransaction;
  const transactionData = transaction.transaction;
  const effects = transaction.effects;
  if (transaction.digest !== digest || effects?.transactionDigest !== digest) {
    return { status: "unavailable", message: "The transaction and effects must match the requested receipt digest." };
  }
  if (!effects?.status || typeof effects.status.success !== "boolean") return { status: "unavailable", message: "Missing execution status." };
  if (result.$kind === "FailedTransaction" && effects.status.success) return { status: "unavailable", message: "Transaction status disagrees with its effects." };
  const effectsStatus = receiptEffectsStatus(effects, digest, guard);
  const unavailableFields: string[] = [];
  function detail<T>(field: string, read: () => T | undefined): T | undefined {
    try {
      const value = read();
      if (value !== undefined) return value;
    } catch { /* Retain independent fields and the verified effects. */ }
    unavailableFields.push(field);
    return undefined;
  }
  const receipt: PublicChainReceipt = {
    txDigest: digest, effectsStatus, chainIdentifier, fetchedAt: now.toISOString(),
    sender: detail("sender", () => transactionData?.sender ? requireReceiptAddress(transactionData.sender, "Invalid sender.") : undefined),
    packageCalls: detail("packageCalls", () => transactionData && packageCallsFromTransaction(transactionData)) ?? [],
    balanceChanges: detail("balanceChanges", () => transaction.balanceChanges?.flatMap((change, index) => {
      const row = detail("balanceChanges", () => balanceChangeFromSdk(change, index));
      return row ? [row] : [];
    })) ?? [],
    objectTypes: detail("objectTypes", () => transaction.objectTypes && objectTypesFromSdk(transaction.objectTypes)) ?? {},
    gas: detail("gas", () => effects.gasUsed && gasFromSdk(effects.gasUsed, transactionData?.gasData)),
    inputs: detail("inputs", () => transactionData?.inputs && inputsFromSdk(transactionData.inputs)) ?? [],
    events: detail("events", () => transaction.events && eventsFromSdk(transaction.events)) ?? [],
    ptbGraph: detail("ptbGraph", () => transactionData && ptbGraphFromTransaction(transactionData))
  };
  if (unavailableFields.length) receipt.unavailableFields = [...new Set(unavailableFields)];
  return { status: "found", receipt };
}

async function withCoinDecimals(
  changes: PublicChainReceiptBalanceChange[],
  resolveCoinUnit: (coinType: string) => Promise<CoinUnit>
): Promise<PublicChainReceiptBalanceChange[]> {
  const units = new Map<string, CoinUnit>();
  await Promise.all(
    [...new Set(changes.map((change) => change.coinType))].map(async (coinType) => {
      try {
        units.set(coinType, await resolveCoinUnit(coinType));
      } catch {
        // Best-effort only: leave the coin without decimals.
      }
    })
  );
  return changes.map((change) => {
    const unit = units.get(change.coinType);
    return unit && unit.status === "available"
      ? { ...change, decimals: unit.decimals, symbol: unit.symbol }
      : change;
  });
}

function balanceChangeFromSdk(change: SuiClientTypes.BalanceChange, index: number): PublicChainReceiptBalanceChange {
    const address = requireReceiptAddress(
      change.address,
      "Sui mainnet receipt contains a balance change with an invalid address."
    );
    const amount = BigInt(change.amount);
    return {
      index,
      address,
      coinType: normalizeCoinType(change.coinType),
      amountRaw: amount.toString(),
      direction: amount > 0n ? "increase" : amount < 0n ? "decrease" : "zero"
    };
}

function gasFromSdk(
  gasUsed: SuiClientTypes.GasCostSummary,
  gasData: SuiClientTypes.TransactionData["gasData"] | undefined
): PublicChainReceiptGas {
  const computation = BigInt(gasUsed.computationCost);
  const storage = BigInt(gasUsed.storageCost);
  const rebate = BigInt(gasUsed.storageRebate);
  return {
    totalMist: (computation + storage - rebate).toString(),
    computationMist: computation.toString(),
    storageMist: storage.toString(),
    storageRebateMist: rebate.toString(),
    nonRefundableStorageMist: BigInt(gasUsed.nonRefundableStorageFee).toString(),
    budgetMist: gasData?.budget === null || gasData?.budget === undefined ? undefined : BigInt(gasData.budget).toString(),
    priceMist: gasData?.price === null || gasData?.price === undefined ? undefined : BigInt(gasData.price).toString(),
    paymentObjectId: firstPaymentObjectId(gasData)
  };
}

function firstPaymentObjectId(gasData: SuiClientTypes.TransactionData["gasData"] | undefined): string | undefined {
  const payment = gasData?.payment;
  if (!Array.isArray(payment) || payment.length === 0) {
    return undefined;
  }
  for (const item of payment) {
    const ref = asRecord(item);
    if (typeof ref?.objectId !== "string" || typeof ref.digest !== "string") continue;
    try { if (!readCoinReservation(ref.digest)) return ref.objectId; } catch { /* Invalid refs do not establish gas object facts. */ }
  }
  return undefined;
}

// PTB inputs, simplified to a kind and (for object inputs) an object id. The exact
// SDK enum shape is read defensively so a shape change degrades to `unknown`
// rather than throwing.
function inputsFromSdk(inputs: readonly unknown[]): PublicChainReceiptInput[] {
  return inputs.map((raw, index) => {
    const input = asRecord(raw);
    if (input) {
      if ("Object" in input) {
        const object = asRecord(input.Object);
        const variant =
          asRecord(object?.ImmOrOwnedObject) ?? asRecord(object?.SharedObject) ?? asRecord(object?.Receiving) ?? object;
        const objectId = typeof variant?.objectId === "string" ? variant.objectId : undefined;
        const kind: PublicChainReceiptInput["kind"] =
          object && "SharedObject" in object ? "shared_object" : object && "Receiving" in object ? "receiving" : "object";
        return { index, kind, objectId };
      }
      if ("UnresolvedObject" in input) {
        const object = asRecord(input.UnresolvedObject);
        return { index, kind: "object", objectId: typeof object?.objectId === "string" ? object.objectId : undefined };
      }
      if ("Pure" in input || "UnresolvedPure" in input) {
        const pure = asRecord(input.Pure) ?? asRecord(input.UnresolvedPure);
        const bytes = pureBytesToHex(pure?.bytes);
        return bytes === undefined
          ? { index, kind: "pure", objectId: undefined }
          : { index, kind: "pure", objectId: undefined, bytes };
      }
      if ("FundsWithdrawal" in input) {
        return { index, kind: "withdrawal", objectId: undefined };
      }
    }
    return { index, kind: "unknown", objectId: undefined };
  });
}

function eventsFromSdk(events: readonly SuiClientTypes.Event[]): PublicChainReceiptEvent[] {
  return events.map((event, index) => ({
    index,
    packageId: event.packageId,
    module: event.module,
    eventType: event.eventType,
    sender: event.sender
  }));
}

function ptbGraphFromTransaction(transactionData: SuiClientTypes.TransactionData): PublicChainReceiptPtbGraph | undefined {
  const mermaid = receiptPtbMermaid({ inputs: transactionData.inputs, commands: transactionData.commands });
  return mermaid === undefined ? undefined : { mermaid };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

// A pure input's bytes arrive base64-encoded; surface them as 0x-hex (the
// convention used elsewhere in the UI). Returns undefined for an absent or
// non-string value so the input simply carries no bytes.
function pureBytesToHex(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  try {
    return `0x${Buffer.from(value, "base64").toString("hex")}`;
  } catch {
    return undefined;
  }
}
