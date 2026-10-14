import type { McpServer } from "@modelcontextprotocol/server";
import { mainnetPools } from "@mysten/deepbook-v3";
import { z } from "zod";
import { unknownRecordSchema } from "../../../core/action/schemas.js";
import {
  DEEPBOOK_SCALAR_UNIT_SOURCE
} from "../../../core/read/coinMetadata.js";
import {
  DEEPBOOK_OFFICIAL_INDEXER_CANONICAL_USDC_COIN_TYPE,
  deepbookOfficialIndexerCandleSchema,
  deepbookOfficialIndexerIntervalSchema
} from "../../../core/read/deepbookOfficialIndexerSource.js";
import {
  DEEPBOOK_OFFICIAL_INDEXER_CANDLE_USE,
  DEEPBOOK_OFFICIAL_INDEXER_RESPONSE_TEXT,
  DEEPBOOK_OFFICIAL_INDEXER_SOURCE_BASE,
  DEEPBOOK_OFFICIAL_INDEXER_USDC_REFERENCE
} from "../../../core/read/deepbookSourceOwners.js";
import {
  DEEPBOOK_MID_PRICE_DIRECTION,
  DEEPBOOK_MID_PRICE_PRECISION,
  DEEPBOOK_MID_PRICE_SEMANTICS_KIND,
  DEEPBOOK_MID_PRICE_TYPE,
  DEEPBOOK_ACCOUNT_QUANTITY_KIND,
  DEEPBOOK_USDC_CANDLE_AVAILABILITY,
  DEEPBOOK_USDC_PRICE_HISTORY_QUANTITY_KIND,
  DEEPBOOK_USDC_PRICE_HISTORY_SOURCE_UNAVAILABLE_REASONS,
  DEEPBOOK_USDC_PRICE_HISTORY_UNSUPPORTED_CLAIMS,
  DEEPBOOK_USDC_PRICE_HISTORY_UNSUPPORTED_PAIR_REASONS,
  DEEPBOOK_QUOTE_QUANTITY_KIND,
  DEFAULT_DEEPBOOK_SIMULATION_SENDER,
  MAX_DEEPBOOK_ACCOUNT_OPEN_ORDER_IDS,
  MAX_DEEPBOOK_USDC_PRICE_HISTORY_BARS,
  MAX_DEEPBOOK_ORDERBOOK_TICKS
} from "../../../core/read/readService.js";
import { noParamsInputSchema, successOutputSchema } from "../../schemas.js";
import { okToolResult } from "../../result.js";
import type { McpServerDeps } from "../../server.js";
import { TOOL_NAMES } from "../../toolNames.js";
import { fetchedAtSchema, readSourceSchema, userAnswerUseSchema } from "./commonSchemas.js";
import { readServiceError, resolveExplicitOrActiveAccount } from "./readToolHelpers.js";

const deepbookMidPriceSourceSchema = z.object({
  sdk: z.string(),
  transport: z.literal("grpc"),
  simulation: z.literal("client.core.simulateTransaction"),
  method: z.literal("midPrice"),
  precision: z.literal(DEEPBOOK_MID_PRICE_PRECISION)
});

const deepbookDisplayQuoteSourceSchema = z.object({
  sdk: z.literal("@mysten/deepbook-v3"),
  transport: z.literal("grpc"),
  simulation: z.literal("client.core.simulateTransaction"),
  method: z.enum(["getQuoteQuantityOut", "getBaseQuantityOut"]),
  returnValueEncoding: z.literal("bcs.u64")
});

const deepbookAccountInventorySourceSchema = z.object({
  sdk: z.literal("@mysten/deepbook-v3"),
  transport: z.literal("grpc"),
  simulation: z.literal("client.core.simulateTransaction"),
  methods: z.array(
    z.enum(["getBalanceManagerIds", "accountExists", "account", "lockedBalance", "accountOpenOrders"])
  )
});

const deepbookDisplayAccountBalancesSchema = z.object({
  base: z.number().refine(Number.isFinite),
  quote: z.number().refine(Number.isFinite),
  deep: z.number().refine(Number.isFinite)
});

const deepbookAccountQuantitySemanticsSchema = z.object({
  kind: z.literal(DEEPBOOK_ACCOUNT_QUANTITY_KIND),
  rawAmountAvailable: z.literal(false),
  notFor: z.tuple([
    z.literal("signing"),
    z.literal("funding"),
    z.literal("route_liquidity"),
    z.literal("withdrawal_readiness"),
    z.literal("transaction_building")
  ])
});

const deepbookMidPriceSemanticsSchema = z.object({
  kind: z.literal(DEEPBOOK_MID_PRICE_SEMANTICS_KIND),
  allowedUse: z.literal("deepbook_pool_mid_price_snapshot"),
  globalMarketPriceAvailable: z.literal(false),
  fiatUsdCashOutAvailable: z.literal(false),
  externalMarketPriceConversionAvailable: z.literal(false),
  externalMarketLookupAvailable: z.literal(false),
  usdPegAssumptionAvailable: z.literal(false),
  bankCashOutEstimateAvailable: z.literal(false),
  quoteComparisonAvailable: z.literal(false),
  priceImpactAvailable: z.literal(false),
  venueComparisonAvailable: z.literal(false),
  routeRecommendationAvailable: z.literal(false),
  profitAndLossAvailable: z.literal(false),
  costBasisAvailable: z.literal(false),
  notFor: z.tuple([
    z.literal("global_market_price"),
    z.literal("fiat_usd_cash_out"),
    z.literal("external_market_price_conversion"),
    z.literal("external_market_lookup"),
    z.literal("usd_peg_assumption"),
    z.literal("bank_cash_out_estimate"),
    z.literal("price_impact"),
    z.literal("mid_price_slippage"),
    z.literal("quote_vs_mid_slippage"),
    z.literal("effective_quote_price"),
    z.literal("venue_comparison"),
    z.literal("best_route"),
    z.literal("route_recommendation"),
    z.literal("transaction_building"),
    z.literal("signing_data"),
    z.literal("signing_readiness"),
    z.literal("profit_or_pnl"),
    z.literal("cost_basis")
  ])
});

const deepbookUsdcPriceHistorySelectorSchema = z.union([
  z.object({ kind: z.literal("pool_name"), value: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("asset_symbol"), value: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("coin_type"), value: z.string().min(1) }).strict()
]);

const deepbookUsdcPriceHistoryRangeSchema = z.object({
  start: fetchedAtSchema,
  end: fetchedAtSchema,
  timeZone: z.literal("UTC"),
  interval: deepbookOfficialIndexerIntervalSchema,
  intervalDurationMs: z.number().int().positive(),
  maxBars: z.literal(MAX_DEEPBOOK_USDC_PRICE_HISTORY_BARS),
  requestedCandleSlots: z.number().int().positive()
}).strict();

const deepbookUsdcPriceHistoryRequestedSchema = z.object({
  selector: deepbookUsdcPriceHistorySelectorSchema,
  range: deepbookUsdcPriceHistoryRangeSchema
}).strict();

const deepbookUsdcPriceHistoryPairSchema = z.object({
  poolName: z.string().min(1),
  poolId: z.string().min(1),
  baseAsset: z.object({
    symbol: z.string().min(1),
    coinType: z.string().min(1),
    decimals: z.number().int().nonnegative()
  }).strict(),
  quoteAsset: z.object({
    symbol: z.literal("USDC"),
    coinType: z.literal(DEEPBOOK_OFFICIAL_INDEXER_CANONICAL_USDC_COIN_TYPE),
    decimals: z.number().int().nonnegative()
  }).strict(),
  priceConvention: z.literal(DEEPBOOK_OFFICIAL_INDEXER_USDC_REFERENCE.priceConvention)
}).strict();

const deepbookUsdcPriceHistorySourceSchema = z.object({
  kind: z.literal(DEEPBOOK_OFFICIAL_INDEXER_SOURCE_BASE.kind),
  baseUrl: z.url(),
  sourceStatement: z.string().min(1),
  poolList: z.object({
    url: z.url(),
    fetchedAt: fetchedAtSchema
  }).strict(),
  candles: z.object({
    url: z.url(),
    fetchedAt: fetchedAtSchema,
    poolName: z.string().min(1),
    interval: deepbookOfficialIndexerIntervalSchema,
    startTimeMs: z.number().int().nonnegative(),
    endTimeMs: z.number().int().nonnegative(),
    limit: z.number().int().positive()
  }).strict(),
  chainRecomputedBySuiMcp: z.literal(DEEPBOOK_OFFICIAL_INDEXER_SOURCE_BASE.chainRecomputedBySuiMcp)
}).strict();

const deepbookUsdcPriceHistoryUnsupportedClaimSchema = z.enum(DEEPBOOK_USDC_PRICE_HISTORY_UNSUPPORTED_CLAIMS);

const deepbookUsdcPriceHistoryQuantitySemanticsSchema = z.object({
  kind: z.literal(DEEPBOOK_USDC_PRICE_HISTORY_QUANTITY_KIND),
  allowedUse: z.literal(DEEPBOOK_OFFICIAL_INDEXER_CANDLE_USE.allowedUse),
  source: z.literal(DEEPBOOK_OFFICIAL_INDEXER_CANDLE_USE.source),
  quoteAsset: z.literal(DEEPBOOK_OFFICIAL_INDEXER_CANDLE_USE.quoteAsset),
  priceConvention: z.literal(DEEPBOOK_OFFICIAL_INDEXER_CANDLE_USE.priceConvention),
  usdcIsFiatUsd: z.literal(DEEPBOOK_OFFICIAL_INDEXER_CANDLE_USE.usdcIsFiatUsd),
  usdPegGuaranteeAvailable: z.literal(DEEPBOOK_OFFICIAL_INDEXER_CANDLE_USE.usdPegGuaranteeAvailable),
  chainRecomputedBySuiMcp: z.literal(DEEPBOOK_OFFICIAL_INDEXER_CANDLE_USE.chainRecomputedBySuiMcp),
  liveQuoteAvailable: z.literal(false),
  historicalMidPriceAvailable: z.literal(false),
  globalMarketPriceAvailable: z.literal(false),
  fiatUsdCashOutAvailable: z.literal(false),
  routeRecommendationAvailable: z.literal(false),
  transactionBuildingAvailable: z.literal(false),
  signingReadinessAvailable: z.literal(false),
  profitAndLossAvailable: z.literal(false),
  costBasisAvailable: z.literal(false),
  notFor: z.tuple([
    z.literal("fiat_usd_cash_out"),
    z.literal("usd_peg_assumption"),
    z.literal("global_market_price"),
    z.literal("historical_mid_price"),
    z.literal("live_quote"),
    z.literal("route_recommendation"),
    z.literal("best_route"),
    z.literal("transaction_building"),
    z.literal("signing_data"),
    z.literal("signing_readiness"),
    z.literal("profit_or_pnl"),
    z.literal("cost_basis")
  ])
}).strict();

const deepbookUsdcPriceHistoryResponseSummarySchema = z.object({
  questionKind: z.literal("deepbook_usdc_price_history"),
  evidenceKind: z.literal("official_deepbook_indexer_candles"),
  sourceStatement: z.literal(DEEPBOOK_OFFICIAL_INDEXER_RESPONSE_TEXT.sourceStatement),
  usdcDisclaimer: z.literal(DEEPBOOK_OFFICIAL_INDEXER_RESPONSE_TEXT.usdcDisclaimer),
  candleMeaning: z.literal("Each candle is returned by the DeepBookV3 official Indexer for the requested interval."),
  excludedFromConclusion: z.array(deepbookUsdcPriceHistoryUnsupportedClaimSchema)
}).strict();

const deepbookUsdcPriceHistoryCommonOutputSchema = z.object({
  fetchedAt: fetchedAtSchema,
  requested: deepbookUsdcPriceHistoryRequestedSchema,
  userAnswerUse: userAnswerUseSchema,
  quantitySemantics: deepbookUsdcPriceHistoryQuantitySemanticsSchema,
  responseSummary: deepbookUsdcPriceHistoryResponseSummarySchema,
  unsupportedClaims: z.array(deepbookUsdcPriceHistoryUnsupportedClaimSchema)
}).strict();

const deepbookUsdcPriceHistoryOutputSchema = z.object({
  ok: z.literal(true),
  data: z.discriminatedUnion("status", [
    deepbookUsdcPriceHistoryCommonOutputSchema.extend({
      status: z.literal("ok"),
      pair: deepbookUsdcPriceHistoryPairSchema,
      candleAvailability: z.enum(DEEPBOOK_USDC_CANDLE_AVAILABILITY),
      barCount: z.number().int().nonnegative().max(MAX_DEEPBOOK_USDC_PRICE_HISTORY_BARS),
      bars: z.array(deepbookOfficialIndexerCandleSchema).max(MAX_DEEPBOOK_USDC_PRICE_HISTORY_BARS),
      source: deepbookUsdcPriceHistorySourceSchema
    }).strict(),
    deepbookUsdcPriceHistoryCommonOutputSchema.extend({
      status: z.literal("unsupported_pair"),
      reason: z.enum(DEEPBOOK_USDC_PRICE_HISTORY_UNSUPPORTED_PAIR_REASONS),
      matchingPoolNames: z.array(z.string()),
      availablePoolNames: z.array(z.string())
    }).strict(),
    deepbookUsdcPriceHistoryCommonOutputSchema.extend({
      status: z.literal("unsupported_range"),
      reason: z.literal("requested_range_exceeds_max_bars")
    }).strict(),
    deepbookUsdcPriceHistoryCommonOutputSchema.extend({
      status: z.literal("source_unavailable"),
      reason: z.enum(DEEPBOOK_USDC_PRICE_HISTORY_SOURCE_UNAVAILABLE_REASONS),
      pair: deepbookUsdcPriceHistoryPairSchema.optional(),
      source: deepbookUsdcPriceHistorySourceSchema.optional()
    }).strict()
  ])
}).strict();

const deepbookUsdcPriceAtTimeTargetSchema = z.object({
  targetTime: fetchedAtSchema,
  searchWindow: z.object({
    start: fetchedAtSchema,
    end: fetchedAtSchema,
    maxDistanceMinutes: z.number().int().positive()
  }).strict()
}).strict();

const deepbookUsdcPriceAtTimeMatchSchema = z.object({
  kind: z.enum(["exact_bucket", "nearest_before", "nearest_after"]),
  distanceMinutes: z.number().nonnegative(),
  representativePrice: z.object({
    field: z.literal("matchedCandle.close"),
    value: z.string().regex(/^\d+(?:\.\d+)?$/),
    quoteAsset: z.literal(DEEPBOOK_OFFICIAL_INDEXER_USDC_REFERENCE.quoteAsset),
    baseAssetSymbol: z.string().min(1),
    priceConvention: z.literal(DEEPBOOK_OFFICIAL_INDEXER_USDC_REFERENCE.priceConvention)
  }).strict()
}).strict();

const deepbookUsdcPriceAtTimeCommonOutputSchema = deepbookUsdcPriceHistoryCommonOutputSchema.extend({
  target: deepbookUsdcPriceAtTimeTargetSchema
}).strict();

const deepbookUsdcPriceAtTimeOutputSchema = z.object({
  ok: z.literal(true),
  data: z.discriminatedUnion("status", [
    deepbookUsdcPriceAtTimeCommonOutputSchema.extend({
      status: z.literal("ok"),
      pair: deepbookUsdcPriceHistoryPairSchema,
      match: deepbookUsdcPriceAtTimeMatchSchema,
      matchedCandle: deepbookOfficialIndexerCandleSchema,
      candleAvailability: z.enum(DEEPBOOK_USDC_CANDLE_AVAILABILITY),
      source: deepbookUsdcPriceHistorySourceSchema
    }).strict(),
    deepbookUsdcPriceAtTimeCommonOutputSchema.extend({
      status: z.literal("no_price_in_search_window"),
      pair: deepbookUsdcPriceHistoryPairSchema,
      candleAvailability: z.enum(DEEPBOOK_USDC_CANDLE_AVAILABILITY),
      source: deepbookUsdcPriceHistorySourceSchema
    }).strict(),
    deepbookUsdcPriceAtTimeCommonOutputSchema.extend({
      status: z.literal("unsupported_pair"),
      reason: z.enum(DEEPBOOK_USDC_PRICE_HISTORY_UNSUPPORTED_PAIR_REASONS),
      matchingPoolNames: z.array(z.string()),
      availablePoolNames: z.array(z.string())
    }).strict(),
    deepbookUsdcPriceAtTimeCommonOutputSchema.extend({
      status: z.literal("unsupported_range"),
      reason: z.literal("requested_range_exceeds_max_bars")
    }).strict(),
    deepbookUsdcPriceAtTimeCommonOutputSchema.extend({
      status: z.literal("source_unavailable"),
      reason: z.enum(DEEPBOOK_USDC_PRICE_HISTORY_SOURCE_UNAVAILABLE_REASONS),
      pair: deepbookUsdcPriceHistoryPairSchema.optional(),
      source: deepbookUsdcPriceHistorySourceSchema.optional()
    }).strict()
  ])
}).strict();

const deepbookQuoteQuantitySemanticsSchema = z.object({
  kind: z.literal(DEEPBOOK_QUOTE_QUANTITY_KIND),
  inputAmountKind: z.enum(["raw_u64", "display_source_amount_converted_to_raw_u64"]),
  allowedUse: z.literal("indicative_deepbook_pool_quote"),
  rawAmountAvailable: z.literal(true),
  rawEvidenceField: z.literal("rawQuote"),
  paymentCoverageAvailable: z.literal(false),
  shortfallContributionAvailable: z.literal(false),
  routeDependentPaymentSupportAvailable: z.literal(false),
  requiresIntentEvidenceForCoverage: z.literal(true),
  canUseForPaymentAnswer: z.literal(false),
  canUseForShortfallAnswer: z.literal(false),
  doNotCombineWithPaymentAnswer: z.literal(true),
  requiredPaymentAnswerTool: z.literal("read_preview_intent_evidence"),
  paymentAnswerUseBlockedReason: z.literal("quote_output_is_price_reference_not_payment_answer"),
  requiredPaymentAnswerField: z.literal("responseSummary"),
  fiatUsdCashOutAvailable: z.literal(false),
  externalMarketPriceConversionAvailable: z.literal(false),
  externalMarketLookupAvailable: z.literal(false),
  usdPegAssumptionAvailable: z.literal(false),
  bankCashOutEstimateAvailable: z.literal(false),
  profitAndLossAvailable: z.literal(false),
  costBasisAvailable: z.literal(false),
  priceImpactAvailable: z.literal(false),
  midPriceSlippageAvailable: z.literal(false),
  venueComparisonAvailable: z.literal(false),
  routeRecommendationAvailable: z.literal(false),
  notFor: z.tuple([
    z.literal("signing"),
    z.literal("funding"),
    z.literal("payment_coverage"),
    z.literal("shortfall_contribution"),
    z.literal("route_dependent_payment_support"),
    z.literal("route_liquidity"),
    z.literal("min_out"),
    z.literal("liquidity_verdict"),
    z.literal("price_impact"),
    z.literal("mid_price_slippage"),
    z.literal("quote_vs_mid_slippage"),
    z.literal("effective_price"),
    z.literal("venue_comparison"),
    z.literal("best_route"),
    z.literal("route_recommendation"),
    z.literal("transaction_building"),
    z.literal("fiat_usd_cash_out"),
    z.literal("external_market_price_conversion"),
    z.literal("external_market_lookup"),
    z.literal("usd_peg_assumption"),
    z.literal("bank_cash_out_estimate"),
    z.literal("profit_or_pnl"),
    z.literal("cost_basis")
  ])
});

const deepbookDisplayQuoteInputAmountSchema = z.object({
  display: z.string(),
  raw: z.string().regex(/^[1-9]\d*$/),
  asset: z.object({
    symbol: z.string(),
    coinType: z.string(),
    decimals: z.number().int().nonnegative(),
    unitSource: z.literal(DEEPBOOK_SCALAR_UNIT_SOURCE)
  })
});

const deepbookDisplayQuoteSchema = z.object({
  baseOut: z.string().regex(/^\d+(?:\.\d+)?$/),
  quoteOut: z.string().regex(/^\d+(?:\.\d+)?$/),
  deepRequired: z.string().regex(/^\d+(?:\.\d+)?$/)
});

const deepbookRawQuoteAmountSchema = z.object({
  raw: z.string().regex(/^\d+$/),
  symbol: z.string(),
  coinType: z.string(),
  decimals: z.number().int().nonnegative(),
  unitSource: z.literal(DEEPBOOK_SCALAR_UNIT_SOURCE)
});

const deepbookRawQuoteSchema = z.object({
  kind: z.literal("deepbook_quote_raw_u64"),
  sourceMoveFunction: z.enum(["pool::get_quote_quantity_out", "pool::get_base_quantity_out"]),
  returnValueSourceMoveFunction: z.literal("pool::get_quantity_out"),
  returnValueOrder: z.tuple([
    z.literal("base_quantity_out"),
    z.literal("quote_quantity_out"),
    z.literal("deep_quantity_required")
  ]),
  inputAmount: deepbookRawQuoteAmountSchema,
  baseOut: deepbookRawQuoteAmountSchema,
  quoteOut: deepbookRawQuoteAmountSchema,
  deepRequired: deepbookRawQuoteAmountSchema,
  directionalOutput: deepbookRawQuoteAmountSchema,
  boundary: z.object({
    outputBeforeSlippagePolicy: z.literal(true),
    notFor: z.tuple([
      z.literal("final_min_out"),
      z.literal("transaction_building"),
      z.literal("signing_data"),
      z.literal("signing_readiness"),
      z.literal("price_impact"),
      z.literal("mid_price_slippage"),
      z.literal("quote_vs_mid_slippage"),
      z.literal("effective_price"),
      z.literal("venue_comparison"),
      z.literal("best_route"),
      z.literal("route_recommendation"),
      z.literal("fiat_usd_cash_out"),
      z.literal("external_market_price_conversion"),
      z.literal("external_market_lookup"),
      z.literal("usd_peg_assumption"),
      z.literal("bank_cash_out_estimate"),
      z.literal("profit_or_pnl"),
      z.literal("cost_basis")
    ])
  })
});

const deepbookAccountInventoryDetailStatusSchema = z.enum([
  "manager_discovery_only",
  "pool_key_required",
  "manager_address_required",
  "manager_address_not_discovered_for_active_account",
  "account_not_found",
  "available"
]);

const deepbookAccountSummarySchema = z.object({
  epoch: z.string(),
  settledBalances: deepbookDisplayAccountBalancesSchema,
  owedBalances: deepbookDisplayAccountBalancesSchema,
  unclaimedRebates: deepbookDisplayAccountBalancesSchema
});

const deepbookTokenRegistryEntrySchema = z.object({
  symbol: z.string(),
  address: z.string(),
  type: z.string(),
  scalar: z.number(),
  decimals: z.number().int().nonnegative(),
  unitSource: z.literal(DEEPBOOK_SCALAR_UNIT_SOURCE),
  feed: z.string().optional(),
  currencyId: z.string().optional(),
  priceInfoObjectId: z.string().optional(),
  poolKeys: z.array(z.string())
});

export function registerDeepbookReadTools(server: McpServer, deps: McpServerDeps): void {
  server.registerTool(
    TOOL_NAMES.readListDeepbookPools,
    {
      title: "List DeepBook pools",
      description: "List DeepBook mainnet pools from pinned SDK constants. Static registry only; not live liquidity.",
      inputSchema: noParamsInputSchema,
      outputSchema: successOutputSchema({
        source: z.string(),
        pools: z.array(unknownRecordSchema)
      }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () =>
      okToolResult({
        source: "@mysten/deepbook-v3 mainnetPools",
        pools: Object.entries(mainnetPools).map(([key, pool]) => ({ key, ...pool }))
      })
  );

  server.registerTool(
    TOOL_NAMES.readListDeepbookTokens,
    {
      title: "List DeepBook tokens",
      description: "List DeepBook mainnet tokens from the pinned SDK constants.",
      inputSchema: noParamsInputSchema,
      outputSchema: successOutputSchema({
        source: z.string(),
        tokens: z.array(deepbookTokenRegistryEntrySchema)
      }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => {
      try {
        return okToolResult({
          source: "@mysten/deepbook-v3 mainnetCoins",
          tokens: deps.readService.listDeepbookTokenRegistry()
        });
      } catch (error) {
        return readServiceError(error, deps);
      }
    }
  );

  server.registerTool(
    TOOL_NAMES.readInspectDeepbookOrderbook,
    {
      title: "Inspect DeepBook orderbook",
      description: "Return a pinned-SDK DeepBook mainnet orderbook snapshot at fetchedAt. Not a live stream.",
      inputSchema: z.object({
        poolKey: z.string().min(1),
        ticks: z.number().int().min(1).max(MAX_DEEPBOOK_ORDERBOOK_TICKS).optional()
      }),
      outputSchema: successOutputSchema({
        status: z.literal("ok"),
        poolKey: z.string().optional(),
        ticks: z.number().int().positive().optional(),
        fetchedAt: fetchedAtSchema.optional(),
        userAnswerUse: userAnswerUseSchema,
        source: readSourceSchema.optional(),
        midPrice: z.number().optional(),
        poolBookParams: unknownRecordSchema.optional(),
        level2TicksFromMid: unknownRecordSchema.optional()
      }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ poolKey, ticks }) => {
      try {
        return okToolResult(
          await deps.readService.inspectDeepbookOrderbook({
            poolKey,
            ticks: ticks ?? 5,
            simulationSender: DEFAULT_DEEPBOOK_SIMULATION_SENDER
          })
        );
      } catch (error) {
        return readServiceError(error, deps);
      }
    }
  );

  server.registerTool(
    TOOL_NAMES.readGetDeepbookMidPrice,
    {
      title: "Get DeepBook mid price",
      description:
        "Return a DeepBook pool mid-price snapshot. Not price impact, route quality, global market price, fiat cash-out, transaction building, or signing readiness.",
      inputSchema: z.object({
        poolKey: z.string().min(1)
      }),
      outputSchema: successOutputSchema({
        status: z.literal("ok"),
        poolKey: z.string(),
        base: z.string(),
        quote: z.string(),
        price: z.number(),
        userAnswerUse: userAnswerUseSchema,
        priceDirection: z.literal(DEEPBOOK_MID_PRICE_DIRECTION),
        priceType: z.literal(DEEPBOOK_MID_PRICE_TYPE),
        fetchedAt: fetchedAtSchema,
        source: deepbookMidPriceSourceSchema,
        priceSemantics: deepbookMidPriceSemanticsSchema
      }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ poolKey }) => {
      try {
        return okToolResult(
          await deps.readService.getDeepbookMidPrice({
            poolKey,
            simulationSender: DEFAULT_DEEPBOOK_SIMULATION_SENDER
          })
        );
      } catch (error) {
        return readServiceError(error, deps);
      }
    }
  );

  server.registerTool(
    TOOL_NAMES.readGetDeepbookUsdcPriceHistory,
    {
      title: "Get DeepBook USDC price history",
      description: "Return DeepBookV3 official Indexer USDC candle evidence.",
      inputSchema: z.object({
        poolName: z.string().min(1).optional(),
        assetSymbol: z.string().min(1).optional(),
        coinType: z.string().min(1).optional(),
        interval: deepbookOfficialIndexerIntervalSchema.optional(),
        start: fetchedAtSchema,
        end: fetchedAtSchema
      }),
      outputSchema: deepbookUsdcPriceHistoryOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ poolName, assetSymbol, coinType, interval, start, end }) => {
      try {
        return okToolResult(
          await deps.readService.getDeepbookUsdcPriceHistory({
            poolName,
            assetSymbol,
            coinType,
            interval,
            start,
            end
          })
        );
      } catch (error) {
        return readServiceError(error, deps);
      }
    }
  );

  server.registerTool(
    TOOL_NAMES.readGetDeepbookUsdcPriceAtTime,
    {
      title: "Get DeepBook USDC price at time",
      description: "Return DeepBookV3 official Indexer USDC candle evidence and representative price from close around a target UTC time.",
      inputSchema: z.object({
        poolName: z.string().min(1).optional(),
        assetSymbol: z.string().min(1).optional(),
        coinType: z.string().min(1).optional(),
        interval: deepbookOfficialIndexerIntervalSchema.optional(),
        targetTime: fetchedAtSchema,
        maxDistanceMinutes: z.number().int().positive().optional()
      }),
      outputSchema: deepbookUsdcPriceAtTimeOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ poolName, assetSymbol, coinType, interval, targetTime, maxDistanceMinutes }) => {
      try {
        return okToolResult(
          await deps.readService.getDeepbookUsdcPriceAtTime({
            poolName,
            assetSymbol,
            coinType,
            interval,
            targetTime,
            maxDistanceMinutes
          })
        );
      } catch (error) {
        return readServiceError(error, deps);
      }
    }
  );

  server.registerTool(
    TOOL_NAMES.readQuoteDeepbookAction,
    {
      title: "Quote DeepBook action",
      description: "Pinned-SDK DeepBook raw-quantity quote evidence. Not P&L, price impact, route quality, fiat cash-out, external USD lookup, signing data, or execution promise.",
      inputSchema: z.object({
        poolKey: z.string().min(1),
        direction: z.enum(["base_to_quote", "quote_to_base"]),
        amountRaw: z.string().regex(/^[1-9]\d*$/)
      }),
      outputSchema: successOutputSchema({
        status: z.literal("ok"),
        poolKey: z.string().optional(),
        direction: z.enum(["base_to_quote", "quote_to_base"]).optional(),
        amountRaw: z.string().optional(),
        fetchedAt: fetchedAtSchema.optional(),
        userAnswerUse: userAnswerUseSchema,
        source: readSourceSchema.optional(),
        quote: deepbookDisplayQuoteSchema.optional(),
        rawQuote: deepbookRawQuoteSchema.optional(),
        quantitySemantics: deepbookQuoteQuantitySemanticsSchema.optional()
      }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ poolKey, direction, amountRaw }) => {
      try {
        return okToolResult(
          await deps.readService.quoteDeepbookAction({
            poolKey,
            direction,
            amountRaw,
            simulationSender: DEFAULT_DEEPBOOK_SIMULATION_SENDER
          })
        );
      } catch (error) {
        return readServiceError(error, deps);
      }
    }
  );

  server.registerTool(
    TOOL_NAMES.readQuoteDeepbookDisplayAmount,
    {
      title: "Quote DeepBook display amount",
      description: "Pinned-SDK DeepBook display-amount quote evidence. Not fiat cash-out, external USD lookup, P&L, price impact, route, final min-out, signing data, or signing readiness.",
      inputSchema: z.object({
        poolKey: z.string().min(1),
        direction: z.enum(["base_to_quote", "quote_to_base"]),
        amountDisplay: z.string().min(1)
      }),
      outputSchema: successOutputSchema({
        status: z.literal("ok"),
        pool: z.object({
          poolKey: z.string(),
          base: z.string(),
          quote: z.string()
        }),
        direction: z.enum(["base_to_quote", "quote_to_base"]),
        inputAmount: deepbookDisplayQuoteInputAmountSchema,
        fetchedAt: fetchedAtSchema,
        userAnswerUse: userAnswerUseSchema,
        source: deepbookDisplayQuoteSourceSchema,
        quote: deepbookDisplayQuoteSchema,
        rawQuote: deepbookRawQuoteSchema,
        quantitySemantics: deepbookQuoteQuantitySemanticsSchema
      }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ poolKey, direction, amountDisplay }) => {
      try {
        return okToolResult(
          await deps.readService.quoteDeepbookDisplayAmount({
            poolKey,
            direction,
            amountDisplay,
            simulationSender: DEFAULT_DEEPBOOK_SIMULATION_SENDER
          })
        );
      } catch (error) {
        return readServiceError(error, deps);
      }
    }
  );

  server.registerTool(
    TOOL_NAMES.readSummarizeDeepbookAccountInventory,
    {
      title: "Summarize DeepBook account inventory",
      description: "Pinned-SDK DeepBook BalanceManager inventory. Display-like facts, not raw amounts or signing readiness.",
      inputSchema: z.object({
        poolKey: z.string().min(1).optional(),
        managerAddress: z.string().min(1).optional()
      }),
      outputSchema: successOutputSchema({
        account: z.string(),
        status: z.literal("ok"),
        fetchedAt: fetchedAtSchema,
        source: deepbookAccountInventorySourceSchema,
        requested: z.object({
          poolKey: z.string().optional(),
          managerAddress: z.string().optional()
        }),
        detailStatus: deepbookAccountInventoryDetailStatusSchema,
        managerAddresses: z.array(z.string()),
        userAnswerUse: userAnswerUseSchema,
        quantitySemantics: deepbookAccountQuantitySemanticsSchema,
        pool: z
          .object({
            poolKey: z.string(),
            base: z.string(),
            quote: z.string()
          })
          .optional(),
        accountExists: z.boolean().optional(),
        accountSummary: deepbookAccountSummarySchema.optional(),
        lockedBalances: deepbookDisplayAccountBalancesSchema.optional(),
        openOrderIds: z.array(z.string()).max(MAX_DEEPBOOK_ACCOUNT_OPEN_ORDER_IDS).optional(),
        openOrderCount: z.number().int().nonnegative().optional(),
        openOrderIdsTruncated: z.boolean().optional()
      }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ poolKey, managerAddress }) => {
      const target = await resolveExplicitOrActiveAccount({ mode: "connected_only" }, deps);
      if (target.status !== "ok") return target.result;
      try {
        return okToolResult(
          await deps.readService.summarizeDeepbookAccountInventory({
            account: target.account,
            poolKey,
            managerAddress
          })
        );
      } catch (error) {
        return readServiceError(error, deps);
      }
    }
  );
}
