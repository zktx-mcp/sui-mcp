import { MAX_RAW_U64 } from "../../core/numeric/rawU64.js";
import { minimumSwapOutput } from "../../core/action/swapQuoteAmounts.js";
import type { RefreshReason } from "../../core/action/types.js";
import { parseDeepbookRawU64 } from "../../core/read/deepbookReadHelpers.js";
import type { DeepbookRawQuoteEvidence, QuoteDirection } from "../../core/read/readServiceTypes.js";

export const DEEPBOOK_REVIEW_QUOTE_STALE_AFTER_MS = 30_000;
export const DEEPBOOK_MAX_SLIPPAGE_BPS = 1000;
export const DEEPBOOK_MIN_SLIPPAGE_BPS = 1;

export type DeepbookSwapQuotePolicyInput = {
  rawQuote: DeepbookRawQuoteEvidence;
  fetchedAt: string;
  maxSlippageBps: number;
  now: Date;
  staleAfterMs?: number;
  feeMode?: "deep" | "input_coin" | undefined;
};

export type DeepbookSwapQuotePolicyOk = {
  status: "ok";
  direction: QuoteDirection;
  quoteFresh: true;
  expiresAt: string;
  fetchedAt: string;
  quoteAgeMs: number;
  staleAfterMs: number;
  feeMode: "deep" | "input_coin";
  maxSlippageBps: number;
  sourceAmountRaw: string;
  expectedOutRaw: string;
  minOutRaw: string;
  quotedDeepRequiredRaw: string;
};

export type DeepbookSwapQuotePolicyRefreshRequired = {
  status: "refresh_required";
  refreshReason: RefreshReason;
  reason: "quote_stale" | "quote_timestamp_in_future" | "zero_expected_output";
  direction: QuoteDirection;
  fetchedAt: string;
  quoteAgeMs: number;
  staleAfterMs: number;
  clockSkewMs?: number | undefined;
};

export type DeepbookSwapQuotePolicyResult =
  | DeepbookSwapQuotePolicyOk
  | DeepbookSwapQuotePolicyRefreshRequired;

export function deriveDeepbookSwapQuotePolicy(
  input: DeepbookSwapQuotePolicyInput
): DeepbookSwapQuotePolicyResult {
  assertSlippageBps(input.maxSlippageBps);
  const staleAfterMs = input.staleAfterMs ?? DEEPBOOK_REVIEW_QUOTE_STALE_AFTER_MS;
  if (!Number.isInteger(staleAfterMs) || staleAfterMs < 1) {
    throw new Error("staleAfterMs must be a positive integer");
  }

  const fetchedAtMs = parseIsoUtcTimestampMs(input.fetchedAt, "fetchedAt");
  const nowMs = parseValidDateMs(input.now, "now");
  const rawQuoteAgeMs = nowMs - fetchedAtMs;
  const direction = directionFromRawQuote(input.rawQuote);
  if (rawQuoteAgeMs < 0) {
    return {
      status: "refresh_required",
      refreshReason: "quote_stale",
      reason: "quote_timestamp_in_future",
      direction,
      fetchedAt: input.fetchedAt,
      quoteAgeMs: 0,
      staleAfterMs,
      clockSkewMs: -rawQuoteAgeMs
    };
  }
  const quoteAgeMs = rawQuoteAgeMs;
  if (quoteAgeMs >= staleAfterMs) {
    return {
      status: "refresh_required",
      refreshReason: "quote_stale",
      reason: "quote_stale",
      direction,
      fetchedAt: input.fetchedAt,
      quoteAgeMs,
      staleAfterMs
    };
  }

  const expectedOut = parseUnsignedRaw(input.rawQuote.directionalOutput.raw, "directionalOutput.raw");
  if (expectedOut === 0n) {
    return unavailableQuote(input, direction, quoteAgeMs, staleAfterMs, "zero_expected_output");
  }
  const feeMode = input.rawQuote.sourceMoveFunction.endsWith("_input_fee") ? "input_coin" : "deep";
  if (input.feeMode !== undefined && input.feeMode !== feeMode) {
    throw new Error("Requested fee mode and quote source must match");
  }
  const minOut = minimumSwapOutput(expectedOut, input.maxSlippageBps);

  return {
    status: "ok",
    direction,
    quoteFresh: true,
    expiresAt: new Date(fetchedAtMs + staleAfterMs).toISOString(),
    fetchedAt: input.fetchedAt,
    quoteAgeMs,
    staleAfterMs,
    feeMode,
    maxSlippageBps: input.maxSlippageBps,
    sourceAmountRaw: parsePositiveRaw(input.rawQuote.inputAmount.raw, "inputAmount.raw").toString(),
    expectedOutRaw: expectedOut.toString(),
    minOutRaw: minOut.toString(),
    quotedDeepRequiredRaw: parseUnsignedRaw(input.rawQuote.deepRequired.raw, "deepRequired.raw").toString()
  };
}

// Move v8 math::mul floors each product separately at 1e9 fixed-point precision.
const MOVE_SCALE = 1_000_000_000n;

export function deepbookFeeBudget(quote: DeepbookRawQuoteEvidence, available: bigint) {
  const terms = quote.poolTerms;
  if (!terms) throw new Error("The quote is missing raw pool fee and lot parameters.");
  const required = parseUnsignedRaw(quote.deepRequired.raw, "quoted DEEP");
  const rate = parseUnsignedRaw(terms.takerFeeRaw, "taker fee");
  const price = parseUnsignedRaw(terms.deepPerAssetRaw, "DEEP conversion");
  const lot = parsePositiveRaw(terms.lotSizeRaw, "base lot");
  const fee = (asset: bigint) => {
    const converted = asset * price / MOVE_SCALE;
    if (asset > MAX_RAW_U64 || converted > MAX_RAW_U64) throw new Error("DEEP fee conversion exceeds u64.");
    return converted * rate / MOVE_SCALE;
  };
  const margin = (raw: bigint) => (raw * 110n + 99n) / 100n;
  const sell = directionFromRawQuote(quote) === "base_to_quote";
  let target = margin(required);
  let basis = "quoted fee plus 10%";
  if (!sell && !terms.assetIsBase) {
    target = margin(fee(parsePositiveRaw(quote.inputAmount.raw, "quote principal")));
    basis = "full quote principal plus 10%";
  } else if (!sell) {
    const nextLot = fee(parseUnsignedRaw(quote.baseOut.raw, "expected base") + lot);
    if (nextLot > target) target = nextLot;
    basis = "greater of the quoted fee plus 10% and the fee for one more base lot";
  }
  if (available < required || target < required) throw new Error("The DEEP fee budget cannot cover the quoted fee.");
  const bounded = target < available ? target : available;
  return { raw: (bounded < MAX_RAW_U64 ? bounded : MAX_RAW_U64).toString(), targetRaw: (target < MAX_RAW_U64 ? target : MAX_RAW_U64).toString(), basis };
}

function assertSlippageBps(value: number): void {
  if (!Number.isInteger(value) || value < DEEPBOOK_MIN_SLIPPAGE_BPS || value > DEEPBOOK_MAX_SLIPPAGE_BPS) {
    throw new Error(`maxSlippageBps must be an integer from ${DEEPBOOK_MIN_SLIPPAGE_BPS} to ${DEEPBOOK_MAX_SLIPPAGE_BPS}`);
  }
}

function parseIsoUtcTimestampMs(value: string, field: string): number {
  const parsed = new Date(value);
  const timestampMs = parsed.getTime();
  if (!Number.isFinite(timestampMs) || parsed.toISOString() !== value) {
    throw new Error(`${field} must be an ISO 8601 UTC timestamp`);
  }
  return timestampMs;
}

function parseValidDateMs(value: Date, field: string): number {
  if (!(value instanceof Date)) {
    throw new Error(`${field} must be a valid Date`);
  }
  const timestampMs = value.getTime();
  if (!Number.isFinite(timestampMs)) {
    throw new Error(`${field} must be a valid Date`);
  }
  return timestampMs;
}

function directionFromRawQuote(rawQuote: DeepbookRawQuoteEvidence): QuoteDirection {
  return rawQuote.sourceMoveFunction.startsWith("pool::get_quote_quantity_out") ? "base_to_quote" : "quote_to_base";
}

function unavailableQuote(
  input: DeepbookSwapQuotePolicyInput,
  direction: QuoteDirection,
  quoteAgeMs: number,
  staleAfterMs: number,
  reason: "zero_expected_output"
): DeepbookSwapQuotePolicyRefreshRequired {
  return {
    status: "refresh_required",
    refreshReason: "quote_unavailable",
    reason,
    direction,
    fetchedAt: input.fetchedAt,
    quoteAgeMs,
    staleAfterMs
  };
}

function parsePositiveRaw(value: string, field: string): bigint {
  return parseDeepbookRawU64(value, field, { positive: true });
}

function parseUnsignedRaw(value: string, field: string): bigint {
  return parseDeepbookRawU64(value, field);
}
