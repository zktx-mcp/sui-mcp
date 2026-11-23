import type { SwapQuoteInputFlow } from "../action/swapQuoteAmounts.js";
import type {
  AccountBalances,
  AccountInfo,
  LockedBalances,
} from "@mysten/deepbook-v3";
import { formatRawAmount, normalizeCoinType, parseDisplayAmountToRaw } from "./coinMetadata.js";
import { MAX_RAW_U64, parseRawU64 } from "../numeric/rawU64.js";
import { parseSuiAddress } from "../suiAddress.js";
import {
  DEEPBOOK_CANDLE_CANONICAL_USDC_COIN_TYPE,
  DEEPBOOK_CANDLE_PRICE_CONVENTION,
  type DeepbookCandlePool
} from "./deepbookCandleSource.js";
import {
  DEEPBOOK_CANDLE_CANDLE_USE,
  DEEPBOOK_CANDLE_RESPONSE_TEXT,
  DEEPBOOK_SDK_SIMULATION_SOURCE_BASE
} from "./deepbookSourceOwners.js";
import {
  DEEPBOOK_ACCOUNT_QUANTITY_KIND,
  DEEPBOOK_MID_PRICE_SEMANTICS_KIND,
  DEEPBOOK_QUOTE_QUANTITY_KIND,
  DEEPBOOK_USDC_PRICE_HISTORY_QUANTITY_KIND,
  DEEPBOOK_USDC_PRICE_HISTORY_UNSUPPORTED_CLAIMS,
  ReadServiceInputError,
  type DeepbookAccountInventorySummary,
  type DeepbookAccountSummary,
  type DeepbookDisplayQuantitySemantics,
  type DeepbookUsdcPriceHistoryPair,
  type DeepbookUsdcPriceHistoryQuantitySemantics,
  type DeepbookUsdcPriceHistoryResponseSummary,
  type DeepbookMidPriceSemantics,
  type DeepbookDisplayQuote,
  type DeepbookRawQuoteReturnValues,
  type DeepbookRawQuoteEvidence,
  type DeepbookQuoteQuantitySemantics
} from "./readServiceTypes.js";

export const MAX_DEEPBOOK_QUOTE_RAW_AMOUNT = MAX_RAW_U64;

export function parseDeepbookRawU64(
  value: string,
  field: string,
  options: { positive?: boolean } = {}
): bigint {
  return parseRawU64(value, field, options);
}

export function deepbookDisplayQuantitySemantics(): DeepbookDisplayQuantitySemantics {
  return {
    kind: DEEPBOOK_ACCOUNT_QUANTITY_KIND,
    rawAmountAvailable: false,
    notFor: ["signing", "funding", "route_liquidity", "withdrawal_readiness", "transaction_building"]
  };
}

export function deepbookMidPriceSemantics(): DeepbookMidPriceSemantics {
  return {
    kind: DEEPBOOK_MID_PRICE_SEMANTICS_KIND,
    allowedUse: "deepbook_pool_mid_price_snapshot",
    globalMarketPriceAvailable: false,
    fiatUsdCashOutAvailable: false,
    externalMarketPriceConversionAvailable: false,
    externalMarketLookupAvailable: false,
    usdPegAssumptionAvailable: false,
    bankCashOutEstimateAvailable: false,
    quoteComparisonAvailable: false,
    priceImpactAvailable: false,
    venueComparisonAvailable: false,
    routeRecommendationAvailable: false,
    profitAndLossAvailable: false,
    costBasisAvailable: false,
    notFor: [
      "global_market_price",
      "fiat_usd_cash_out",
      "external_market_price_conversion",
      "external_market_lookup",
      "usd_peg_assumption",
      "bank_cash_out_estimate",
      "price_impact",
      "mid_price_slippage",
      "quote_vs_mid_slippage",
      "effective_quote_price",
      "venue_comparison",
      "best_route",
      "route_recommendation",
      "transaction_building",
      "signing_data",
      "signing_readiness",
      "profit_or_pnl",
      "cost_basis"
    ]
  };
}

export function deepbookQuoteQuantitySemantics(
  inputAmountKind: DeepbookQuoteQuantitySemantics["inputAmountKind"]
): DeepbookQuoteQuantitySemantics {
  return {
    kind: DEEPBOOK_QUOTE_QUANTITY_KIND,
    inputAmountKind,
    allowedUse: "indicative_deepbook_pool_quote",
    rawAmountAvailable: true,
    rawEvidenceField: "rawQuote",
    paymentCoverageAvailable: false,
    shortfallContributionAvailable: false,
    routeDependentPaymentSupportAvailable: false,
    requiresIntentEvidenceForCoverage: true,
    canUseForPaymentAnswer: false,
    canUseForShortfallAnswer: false,
    doNotCombineWithPaymentAnswer: true,
    requiredPaymentAnswerTool: "read_preview_intent_evidence",
    paymentAnswerUseBlockedReason: "quote_output_is_price_reference_not_payment_answer",
    requiredPaymentAnswerField: "responseSummary",
    fiatUsdCashOutAvailable: false,
    externalMarketPriceConversionAvailable: false,
    externalMarketLookupAvailable: false,
    usdPegAssumptionAvailable: false,
    bankCashOutEstimateAvailable: false,
    profitAndLossAvailable: false,
    costBasisAvailable: false,
    priceImpactAvailable: false,
    midPriceSlippageAvailable: false,
    venueComparisonAvailable: false,
    routeRecommendationAvailable: false,
    notFor: [
      "signing",
      "funding",
      "payment_coverage",
      "shortfall_contribution",
      "route_dependent_payment_support",
      "route_liquidity",
      "min_out",
      "liquidity_verdict",
      "price_impact",
      "mid_price_slippage",
      "quote_vs_mid_slippage",
      "effective_price",
      "venue_comparison",
      "best_route",
      "route_recommendation",
      "transaction_building",
      "fiat_usd_cash_out",
      "external_market_price_conversion",
      "external_market_lookup",
      "usd_peg_assumption",
      "bank_cash_out_estimate",
      "profit_or_pnl",
      "cost_basis"
    ]
  };
}

export function deepbookUsdcPriceHistoryQuantitySemantics(): DeepbookUsdcPriceHistoryQuantitySemantics {
  return {
    kind: DEEPBOOK_USDC_PRICE_HISTORY_QUANTITY_KIND,
    ...DEEPBOOK_CANDLE_CANDLE_USE,
    liveQuoteAvailable: false,
    historicalMidPriceAvailable: false,
    globalMarketPriceAvailable: false,
    fiatUsdCashOutAvailable: false,
    routeRecommendationAvailable: false,
    transactionBuildingAvailable: false,
    signingReadinessAvailable: false,
    profitAndLossAvailable: false,
    costBasisAvailable: false,
    notFor: [
      "fiat_usd_cash_out",
      "usd_peg_assumption",
      "global_market_price",
      "historical_mid_price",
      "live_quote",
      "route_recommendation",
      "best_route",
      "transaction_building",
      "signing_data",
      "signing_readiness",
      "profit_or_pnl",
      "cost_basis"
    ]
  };
}

export function deepbookUsdcPriceHistoryResponseSummary(): DeepbookUsdcPriceHistoryResponseSummary {
  return {
    questionKind: "deepbook_usdc_price_history",
    evidenceKind: "deepbook_pool_fill_candles",
    sourceStatement: DEEPBOOK_CANDLE_RESPONSE_TEXT.sourceStatement,
    usdcDisclaimer: DEEPBOOK_CANDLE_RESPONSE_TEXT.usdcDisclaimer,
    candleMeaning: "Each candle aggregates finalized DeepBook fills for the identified Sui mainnet pool and UTC interval.",
    excludedFromConclusion: [...DEEPBOOK_USDC_PRICE_HISTORY_UNSUPPORTED_CLAIMS]
  };
}

export function deepbookUsdcPriceHistoryPairFromPool(
  pool: DeepbookCandlePool
): DeepbookUsdcPriceHistoryPair {
  return {
    poolName: pool.pool_name,
    poolId: pool.pool_id,
    baseAsset: {
      symbol: pool.base_asset_symbol,
      coinType: normalizeCoinType(pool.base_asset_id),
      decimals: pool.base_asset_decimals
    },
    quoteAsset: {
      symbol: "USDC",
      coinType: normalizeCoinType(DEEPBOOK_CANDLE_CANONICAL_USDC_COIN_TYPE),
      decimals: pool.quote_asset_decimals
    },
    priceConvention: DEEPBOOK_CANDLE_PRICE_CONVENTION
  };
}

export function deepbookAccountInventorySource(methods: string[]): DeepbookAccountInventorySummary["source"] {
  return {
    ...DEEPBOOK_SDK_SIMULATION_SOURCE_BASE,
    methods
  };
}

export function normalizeOptionalManagerAddress(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = parseSuiAddress(value);
  if (normalized === undefined) {
    throw new ReadServiceInputError("input_invalid", "managerAddress must be a valid Sui address", {
      field: "managerAddress",
      value
    });
  }
  return normalized;
}

export function normalizeManagerAddresses(values: string[]): string[] {
  return values.map((value) => {
    const normalized = parseSuiAddress(value);
    if (normalized === undefined) {
      throw new Error("DeepBook BalanceManager ID was not a valid Sui address");
    }
    return normalized;
  });
}

// Account inventory v1 exposes only ledger and rebate balances; governance,
// stake, volume, and AccountInfo.open_orders need separate review before export.
export function toDeepbookAccountSummary(accountInfo: AccountInfo): DeepbookAccountSummary {
  return {
    epoch: accountInfo.epoch,
    settledBalances: assertDeepbookDisplayBalances(accountInfo.settled_balances, "accountSummary.settledBalances"),
    owedBalances: assertDeepbookDisplayBalances(accountInfo.owed_balances, "accountSummary.owedBalances"),
    unclaimedRebates: assertDeepbookDisplayBalances(accountInfo.unclaimed_rebates, "accountSummary.unclaimedRebates")
  };
}

export function assertDeepbookDisplayBalances<T extends AccountBalances | LockedBalances>(balances: T, field: string): T {
  assertDeepbookDisplayNumber(balances.base, `${field}.base`);
  assertDeepbookDisplayNumber(balances.quote, `${field}.quote`);
  assertDeepbookDisplayNumber(balances.deep, `${field}.deep`);
  return balances;
}

export function parseQuoteDisplayAmount(displayAmount: string, decimals: number): string {
  let rawAmount: string;
  try {
    rawAmount = parseDisplayAmountToRaw(displayAmount, decimals);
  } catch (error) {
    throw new ReadServiceInputError(
      "input_invalid",
      "amountDisplay must be a positive unsigned decimal string within verified decimals",
      {
        field: "amountDisplay",
        value: displayAmount,
        decimals,
        reason: error instanceof Error ? error.message : "unknown"
      }
    );
  }
  if (!/^[1-9]\d*$/.test(rawAmount)) {
    throw new ReadServiceInputError(
      "input_invalid",
      "amountDisplay must convert to a positive raw integer amount",
      {
        field: "amountDisplay",
        value: displayAmount,
        decimals,
        rawAmount
      }
    );
  }
  if (BigInt(rawAmount) > MAX_DEEPBOOK_QUOTE_RAW_AMOUNT) {
    throw new ReadServiceInputError(
      "input_invalid",
      "amountDisplay must convert to a raw integer amount that fits the DeepBook u64 quote input",
      {
        field: "amountDisplay",
        value: displayAmount,
        decimals,
        rawAmount,
        maxRawAmount: MAX_DEEPBOOK_QUOTE_RAW_AMOUNT.toString()
      }
    );
  }
  return rawAmount;
}

export function parseRawAmount(value: string): bigint {
  try {
    return parseDeepbookRawU64(value, "amountRaw", { positive: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "amountRaw is invalid";
    if (reason === "amountRaw must fit u64") {
      throw new ReadServiceInputError("input_invalid", "amountRaw must fit the DeepBook u64 quote input", {
        field: "amountRaw",
        value,
        maxRawAmount: MAX_DEEPBOOK_QUOTE_RAW_AMOUNT.toString()
      });
    }
    throw new ReadServiceInputError("input_invalid", "amountRaw must be a positive integer string", {
      field: "amountRaw",
      value
    });
  }
}

export function assertValidDeepbookMidPrice(poolKey: string, midPrice: number): number {
  if (!Number.isFinite(midPrice) || midPrice <= 0) {
    throw new ReadServiceInputError("quote_unavailable", "DeepBook mid price is unavailable for this pool", {
      poolKey,
      source: "midPrice"
    });
  }
  return midPrice;
}

export const deepbookQuoteGetters = {
  base_to_quote: {
    deep: { method: "getQuoteQuantityOut", move: "pool::get_quote_quantity_out" },
    input_coin: { method: "getQuoteQuantityOutInputFee", move: "pool::get_quote_quantity_out_input_fee" }
  },
  quote_to_base: {
    deep: { method: "getBaseQuantityOut", move: "pool::get_base_quantity_out" },
    input_coin: { method: "getBaseQuantityOutInputFee", move: "pool::get_base_quantity_out_input_fee" }
  }
} as const;

export function deepbookQuoteInputFlow(quote: DeepbookRawQuoteEvidence): SwapQuoteInputFlow {
  const sellBase = quote.sourceMoveFunction.startsWith("pool::get_quote_quantity_out");
  const returned = sellBase ? quote.baseOut : quote.quoteOut;
  const principal = parseDeepbookRawU64(quote.inputAmount.raw, "inputAmount", { positive: true });
  const remainder = parseDeepbookRawU64(returned.raw, "expected input return");
  const { raw, ...asset } = quote.deepRequired;
  const included = quote.sourceMoveFunction.endsWith("_input_fee");
  if (remainder > principal || (included && raw !== "0")) {
    throw new ReadServiceInputError("quote_unavailable", "DeepBook quote returned inconsistent input or fee amounts", { sourceMoveFunction: quote.sourceMoveFunction });
  }
  return {
    expectedSpendRaw: (principal - remainder).toString(),
    expectedReturnRaw: returned.raw,
    fee: quote.poolTerms?.whitelisted && quote.poolTerms.takerFeeRaw === "0" && raw === "0"
      ? { kind: "base_fee_waived", quotedRaw: "0", source: "pool_whitelist_and_zero_taker_rate" }
      : included
      ? { kind: "included_in_input", amountUnavailableReason: "not_itemized_by_quote" }
      : { kind: "separate_coin", amount: { raw, asset } }
  };
}

export function toDeepbookDisplayQuoteFromRaw(
  quote: DeepbookRawQuoteReturnValues,
  units: {
    baseDecimals: number;
    quoteDecimals: number;
    deepDecimals: number;
  }
): DeepbookDisplayQuote {
  return {
    baseOut: rawToDeepbookDisplayAmount(quote.baseOutRaw, units.baseDecimals),
    quoteOut: rawToDeepbookDisplayAmount(quote.quoteOutRaw, units.quoteDecimals),
    deepRequired: rawToDeepbookDisplayAmount(quote.deepRequiredRaw, units.deepDecimals)
  };
}

export function assertPositiveInteger(value: number, field: string, max?: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new ReadServiceInputError("input_invalid", `${field} must be a positive integer`, {
      field,
      value
    });
  }

  if (max !== undefined && value > max) {
    throw new ReadServiceInputError("input_invalid", `${field} must be less than or equal to ${max}`, {
      field,
      value,
      max
    });
  }
}

function assertDeepbookDisplayNumber(value: number, field: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`DeepBook account inventory display number is unavailable for ${field}`);
  }
}

function rawToDeepbookDisplayAmount(raw: string, decimals: number): string {
  try {
    parseRawU64(raw, "quote return value");
    return formatRawAmount(raw, decimals);
  } catch (error) {
    throw new ReadServiceInputError("quote_unavailable", "DeepBook raw quote return value cannot be displayed", {
      raw,
      decimals,
      reason: error instanceof Error ? error.message : "unknown"
    });
  }
}

export function deepbookMinimumBaseRaw(terms: NonNullable<DeepbookRawQuoteEvidence["poolTerms"]>): bigint {
  const lot = parseRawU64(terms.lotSizeRaw, "lot size", { positive: true });
  const min = parseRawU64(terms.minBaseRaw, "minimum base", { positive: true });
  return (min + lot - 1n) / lot * lot;
}

// DeepBook book::get_quantity_out applies the input-fee divisor before lot rounding.
export function deepbookMinimumInputRaw(quote: DeepbookRawQuoteEvidence): bigint | undefined {
  const terms = quote.poolTerms;
  if (!terms) return undefined;
  if (!quote.sourceMoveFunction.startsWith("pool::get_quote_quantity_out")) {
    return terms.minimumBuyQuoteRaw == null ? undefined : parseRawU64(terms.minimumBuyQuoteRaw, "quote needed for minimum base");
  }
  const base = deepbookMinimumBaseRaw(terms);
  if (!quote.sourceMoveFunction.endsWith("_input_fee")) return base;
  const scale = 1_000_000_000n;
  const rate = parseRawU64(terms.takerFeeRaw, "taker fee") * 1_250_000_000n / scale;
  return (base * (scale + rate) + scale - 1n) / scale;
}
