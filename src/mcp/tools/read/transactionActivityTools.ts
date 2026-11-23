import { scanContinuitySchema } from "../../../core/activity/transactionActivityScanPolicy.js";
import { MarketReadRequests, resumableReadInput, resumableReadOutput } from "./marketReadRequests.js";
import { deepbookUsdcPriceHistoryQuantitySemanticsSchema, deepbookUsdcPriceHistoryResponseSummarySchema, deepbookUsdcPriceHistoryPairSchema, deepbookUsdcPriceHistorySourceSchema } from "./deepbookReadTools.js";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { buildAccountAssetTimeline } from "../../../core/activity/accountAssetTimeline.js";
import {
  attachDeepbookUsdcReferencesToTimeline,
  type AccountAssetTimelinePriceScope
} from "../../../core/activity/accountAssetTimelineUsdcReferences.js";
import {
  EXTERNAL_ACTIVITY_SCAN_MAX_LIMIT,
  REVIEW_ACTIVITY_LIST_MAX_LIMIT,
  REVIEW_ACTIVITY_LOW_SAMPLE_THRESHOLD
} from "../../../core/activity/activityStore.js";
import {
  externalActivityGasCostFactSchema,
  externalActivityTransactionCompactFactsSchema,
  externalActivityTransactionDetailSchema
} from "../../../core/activity/transactionActivityDetails.js";
import type {
  ScanSuiAccountActivityResult,
  ScanSuiFunctionActivityResult,
  SuiTransactionActivityFact,
  SummarizeSuiActivityScanResult,
  SummarizeSuiFunctionActivityScanResult
} from "../../../core/activity/transactionActivityTypes.js";
import { suiActivityAnalysisLimitations } from "../../../core/activity/transactionActivityAnalysis.js";
import {
  deepbookTradeCandleSchema,
  deepbookCandleIntervalSchema,
  DEFAULT_DEEPBOOK_CANDLE_INTERVAL, marketIdentitySchema
} from "../../../core/read/deepbookCandleSource.js";
import {
  DEEPBOOK_CANDLE_SOURCE_BASE,
  DEEPBOOK_CANDLE_USDC_REFERENCE
} from "../../../core/read/deepbookSourceOwners.js";
import { DEEPBOOK_USDC_CANDLE_AVAILABILITY, DEEPBOOK_USDC_PRICE_HISTORY_SOURCE_UNAVAILABLE_REASONS, DEEPBOOK_USDC_PRICE_HISTORY_UNSUPPORTED_CLAIMS } from "../../../core/read/readServiceTypes.js";
import { suiTransactionDigestSchema } from "../../../core/suiAddress.js";
import { okToolResult } from "../../result.js";
import { successOutputSchema } from "../../schemas.js";
import type { McpServerDeps } from "../../server.js";
import { transactionActivityToolError } from "../../toolErrors.js";
import { TOOL_NAMES } from "../../toolNames.js";
import {
  fetchedAtSchema,
  reviewActivityAccountSourceSchema,
  reviewActivityDataScopeSchema,
  reviewActivityInputSchema,
  utcTimestampInputSchema,
  userAnswerUseSchema
} from "./commonSchemas.js";
import {
  accountAssetTimelineQuantitySemantics,
  accountAssetTimelineUserAnswerUse,
  externalActivityTransactionRecordOutput,
  inspectSuiTransactionUserAnswerUse,
  liveSuiActivityUserAnswerUse,
  requestedAccountTransactionFactOutput,
  storedSuiActivityUserAnswerUse,
  suiActivityQuantitySemantics, SUI_ACTIVITY_QUANTITY_SEMANTICS,
  transactionDetailAvailability,
  transactionFactAuditOutput,
  transactionFactOutput
} from "./transactionActivityOutput.js";

const transactionDigestSchema = suiTransactionDigestSchema;
const externalActivityRelationshipSchema = z.enum(["affected", "sent"]);
const externalActivityStatusSchema = z.enum(["success", "failure", "unknown"]);
const externalActivityScanIncompleteReasonSchema = z.enum([
  "limit_reached",
  "ordering_unverified",
  "cursor_invalid",
  "provider_error"
]);
const suiActivityScanInputSchema = {
  account: z.string().min(1).optional(),
  relationship: externalActivityRelationshipSchema.optional(),
  limit: z.number().int().min(1).max(EXTERNAL_ACTIVITY_SCAN_MAX_LIMIT).optional(),
  cursor: z.string().min(1).optional(),
  fromCheckpoint: z.string().regex(/^\d+$/).optional(),
  toCheckpoint: z.string().regex(/^\d+$/).optional(),
  fromTimestamp: utcTimestampInputSchema.optional(),
  toTimestamp: utcTimestampInputSchema.optional()
};
const suiFunctionActivityScanInputSchema = {
  function: z.string().min(1),
  account: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(EXTERNAL_ACTIVITY_SCAN_MAX_LIMIT).optional(),
  cursor: z.string().min(1).optional(),
  fromCheckpoint: z.string().regex(/^\d+$/).optional(),
  toCheckpoint: z.string().regex(/^\d+$/).optional(),
  fromTimestamp: utcTimestampInputSchema.optional(),
  toTimestamp: utcTimestampInputSchema.optional()
};
const accountAssetTimelineInputSchema = {
  account: z.string().min(1).optional(),
  start: utcTimestampInputSchema,
  end: utcTimestampInputSchema,
  interval: deepbookCandleIntervalSchema.optional()
};

const suiTransactionActivitySourceSchema = z.discriminatedUnion("transport", [
  z.object({
    transport: z.literal("graphql"),
    endpointHost: z.string(),
    chainIdentifier: z.string(),
    method: z.enum(["Query.transaction", "Query.transactions"])
  }),
  z.object({
    transport: z.literal("local_db"),
    method: z.literal("stored_normalized_facts")
  })
]);

const accountBalanceChangeCompletenessSchema = z.enum(["complete", "truncated", "unavailable"]);
const accountBalanceChangeEvidenceSchema = z.enum([
  "account_balance_changes_returned",
  "no_account_balance_changes_returned",
  "incomplete_account_balance_changes",
  "account_balance_changes_unavailable"
]);
const accountBalanceChangeInferencePolicySchema = z.enum([
  "use_returned_account_balance_changes",
  "no_account_balance_changes_in_complete_details",
  "do_not_infer_from_transaction_context"
]);
const transactionAccountRoleSchema = z.enum(["sender", "affected_only", "unconfirmed"]);
const transactionAccountEffectLimitationSchema = z.enum([
  "provider_balance_changes_truncated",
  "transaction_details_unavailable"
]);

const requestedAccountCoinFlowSchema = z.object({
  coinType: z.string(),
  increaseRaw: z.string().regex(/^\d+$/),
  decreaseRaw: z.string().regex(/^\d+$/),
  netRaw: z.string().regex(/^-?\d+$/),
  transactionCount: z.number().int().positive()
}).strict();

const transactionAccountEffectsSchema = z.object({
  account: z.string(),
  scope: z.literal("requested_account"),
  role: transactionAccountRoleSchema,
  sentByAccount: z.boolean(),
  balanceChangeEvidence: accountBalanceChangeEvidenceSchema,
  accountBalanceChangeInferencePolicy: accountBalanceChangeInferencePolicySchema,
  balanceChangeCompleteness: accountBalanceChangeCompletenessSchema,
  balanceChanges: z.array(z.object({
    index: z.number().int().nonnegative(),
    coinType: z.string(),
    amountRaw: z.string().regex(/^-?\d+$/),
    direction: z.enum(["increase", "decrease", "zero"])
  }).strict()),
  coinFlows: z.array(z.object({
    coinType: z.string(),
    increaseRaw: z.string().regex(/^\d+$/),
    decreaseRaw: z.string().regex(/^\d+$/),
    netRaw: z.string().regex(/^-?\d+$/)
  }).strict()),
  limitations: z.array(transactionAccountEffectLimitationSchema)
}).strict();

const requestedAccountActivitySchema = z.object({
  account: z.string(),
  relationship: externalActivityRelationshipSchema,
  sentCount: z.number().int().nonnegative(),
  affectedOnlyCount: z.number().int().nonnegative(),
  unconfirmedCount: z.number().int().nonnegative(),
  balanceChangeCompleteness: accountBalanceChangeCompletenessSchema,
  coinFlows: z.array(requestedAccountCoinFlowSchema)
}).strict();

const suiActivityQuantitySemanticsSchema = z.object({
  kind: z.literal("sui_activity_raw_amounts"),
  rawAmountsOnly: z.literal(true),
  displayConversionRequires: z.literal("verified_coin_metadata_decimals"),
  gasRawUnit: z.literal("MIST"),
  gasUnitSource: z.literal("@mysten/sui MIST_PER_SUI"),
  gasDisplayFields: z.array(z.enum(SUI_ACTIVITY_QUANTITY_SEMANTICS.gasDisplayFields)),
  rawAmountFields: z.array(z.enum(SUI_ACTIVITY_QUANTITY_SEMANTICS.rawAmountFields)),
  notFor: z.tuple([
    z.literal("display_conversion_without_verified_decimals"),
    z.literal("fiat_usd_cash_out"),
    z.literal("profit_or_pnl"),
    z.literal("position_valuation")
  ])
}).strict();

const suiTransactionFactSchema = z.object({
  digest: z.string(),
  checkpoint: z.string().optional(),
  timestamp: fetchedAtSchema.optional(),
  status: externalActivityStatusSchema,
  sender: z.string().optional(),
  requestedAccountEffect: transactionAccountEffectsSchema.optional(),
  compact: externalActivityTransactionCompactFactsSchema.optional(),
  details: externalActivityTransactionDetailSchema.optional()
});

const requestedAccountTransactionContextSchema = externalActivityTransactionCompactFactsSchema.omit({
  balanceChanges: true
});

const suiTransactionAuditFactSchema = z.object({
  digest: z.string(),
  checkpoint: z.string().optional(),
  timestamp: fetchedAtSchema.optional(),
  status: externalActivityStatusSchema,
  sender: z.string().optional(),
  requestedAccountEffect: transactionAccountEffectsSchema.optional(),
  transactionContext: requestedAccountTransactionContextSchema.optional(),
  detailLookup: z.object({
    tool: z.literal("read_inspect_sui_transaction"),
    digest: z.string()
  })
});

const requestedAccountTransactionFactSchema = z.object({
  digest: z.string(),
  checkpoint: z.string().optional(),
  timestamp: fetchedAtSchema.optional(),
  status: externalActivityStatusSchema,
  sender: z.string().optional(),
  requestedAccount: z.string(),
  accountScope: z.literal("requested_account"),
  accountRole: transactionAccountRoleSchema,
  sentByAccount: z.boolean(),
  accountBalanceChangeEvidence: accountBalanceChangeEvidenceSchema,
  accountBalanceChangeInferencePolicy: accountBalanceChangeInferencePolicySchema,
  accountBalanceChangeCompleteness: accountBalanceChangeCompletenessSchema,
  accountBalanceChanges: transactionAccountEffectsSchema.shape.balanceChanges,
  accountCoinFlows: transactionAccountEffectsSchema.shape.coinFlows,
  accountEffectLimitations: z.array(transactionAccountEffectLimitationSchema),
  requestedAccountEffect: transactionAccountEffectsSchema,
  transactionContext: requestedAccountTransactionContextSchema.optional(),
  detailLookup: z.object({
    tool: z.literal("read_inspect_sui_transaction"),
    digest: z.string()
  })
});

const suiActivityAnalysisSchema = z.object({
  overview: z.object({
    transactionCount: z.number().int().nonnegative(),
    analyzedTransactionCount: z.number().int().nonnegative(),
    statusCounts: z.object({
      success: z.number().int().nonnegative(),
      failure: z.number().int().nonnegative(),
      unknown: z.number().int().nonnegative()
    }).strict(),
    relationshipObservationCounts: z.object({ affected: z.number().int().nonnegative(), sent: z.number().int().nonnegative() }).optional(),
    relationshipCounts: z.object({
      affected: z.number().int().nonnegative(),
      sent: z.number().int().nonnegative()
    }).strict(),
    earliestTimestamp: fetchedAtSchema.optional(),
    latestTimestamp: fetchedAtSchema.optional(),
    earliestCheckpoint: z.string().optional(),
    latestCheckpoint: z.string().optional()
  }).strict(),
  moveCallTargets: z.array(z.object({
    target: z.string(),
    count: z.number().int().positive()
  }).strict()),
  protocols: z.array(z.object({
    protocolId: z.string(),
    displayName: z.string().optional(),
    statusCounts: z.object({ success: z.number().int().nonnegative(), failure: z.number().int().nonnegative(), unknown: z.number().int().nonnegative() }).strict(),
    count: z.number().int().positive()
  }).strict()),
  coinFlows: z.array(z.object({
    coinType: z.string(),
    increaseRaw: z.string().regex(/^\d+$/),
    decreaseRaw: z.string().regex(/^\d+$/),
    netRaw: z.string().regex(/^-?\d+$/),
    transactionCount: z.number().int().positive()
  }).strict()),
  objectChanges: z.object({
    created: z.number().int().nonnegative(),
    mutated: z.number().int().nonnegative(),
    deleted: z.number().int().nonnegative()
  }).strict(),
  eventTypes: z.array(z.object({
    eventType: z.string(),
    count: z.number().int().positive()
  }).strict()),
  gas: z.object({
    transactionCount: z.number().int().positive(),
    netGasCostRaw: z.string().regex(/^-?\d+$/),
    netGasCost: externalActivityGasCostFactSchema
  }).strict().optional(),
  failures: z.array(z.object({
    message: z.string(),
    count: z.number().int().positive(),
    abortCodeRaw: z.string().regex(/^\d+$/).optional(),
    package: z.string().optional(),
    module: z.string().optional(),
    function: z.string().optional()
  }).strict()),
  limitations: z.array(z.enum(suiActivityAnalysisLimitations))
}).strict();

const externalActivityScanRecordSchema = z.object({
  scanId: z.string(),
  kind: z.enum(["digest_lookup", "account_scan", "function_scan"]),
  accountId: z.number().int().positive(),
  account: z.string(),
  relationship: externalActivityRelationshipSchema,
  inputDigest: z.string().optional(),
  continuity: scanContinuitySchema.optional(),
  functionTarget: z.string().optional(), sourceUpperTimestamp: z.string().optional(), sourceUpperCheckpoint: z.string().optional(),
  fromCheckpoint: z.string().optional(),
  toCheckpoint: z.string().optional(),
  fromTimestamp: fetchedAtSchema.optional(),
  toTimestamp: fetchedAtSchema.optional(),
  limit: z.number().int().min(1).max(EXTERNAL_ACTIVITY_SCAN_MAX_LIMIT),
  requestCursor: z.string().optional(),
  responseCursor: z.string().optional(),
  endpointHost: z.string(),
  chainIdentifier: z.string(),
  fetchedAt: fetchedAtSchema,
  storedCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  skippedReasons: z.object({ outsideFilter: z.number().int().nonnegative(), unconfirmedRelation: z.number().int().nonnegative(),
    repeatedDigest: z.number().int().nonnegative() }).optional(),
  hasMore: z.boolean(),
  windowComplete: z.boolean().nullable(),
  incompleteReason: externalActivityScanIncompleteReasonSchema.optional()
});

const externalActivityCoverageLimitationSchema = z.enum([
  "no_stored_activity_scans",
  "no_complete_affected_account_scan",
  "sent_only_scan_not_full_account_coverage",
  "scan_window_incomplete",
  "scan_window_unbounded",
  "scan_records_truncated"
]);

const externalActivityCoverageSchema = z.object({
  dataScope: reviewActivityDataScopeSchema,
  accountSource: reviewActivityAccountSourceSchema,
  accountKnown: z.boolean(),
  requestedRange: z.object({
    from: fetchedAtSchema,
    to: fetchedAtSchema
  }).strict(),
  coverageStatus: z.enum(["complete", "partial", "no_stored_scans"]),
  scanCount: z.number().int().nonnegative(),
  returnedScanCount: z.number().int().nonnegative(),
  scansTruncated: z.boolean(),
  storedTransactionCount: z.number().int().nonnegative(),
  transactionsWithoutTime: z.number().int().nonnegative().optional(),
  storedTransactionRange: z.object({
    earliestTimestamp: fetchedAtSchema.optional(),
    latestTimestamp: fetchedAtSchema.optional(),
    earliestCheckpoint: z.string().optional(),
    latestCheckpoint: z.string().optional()
  }).strict().optional(),
  coverageEvidence: z.object({
    completeAffectedAccountScanIds: z.array(z.string()),
    incompleteScanIds: z.array(z.string()),
    sentOnlyScanIds: z.array(z.string())
  }).strict(),
  limitations: z.array(externalActivityCoverageLimitationSchema),
  scans: z.array(externalActivityScanRecordSchema)
}).strict();

const externalActivityTransactionRecordSchema = z.object({
  conflictingMetadata: z.array(z.enum(["checkpoint","timestamp","knownSender"])).optional(),
  accountId: z.number().int().positive(),
  account: z.string(),
  digest: z.string(),
  relationship: externalActivityRelationshipSchema,
  checkpoint: z.string().optional(),
  timestamp: fetchedAtSchema.optional(),
  status: externalActivityStatusSchema,
  knownSenderAccountId: z.number().int().positive().optional(),
  firstScanId: z.string(),
  lastScanId: z.string(),
  firstFetchedAt: fetchedAtSchema,
  lastFetchedAt: fetchedAtSchema,
  lastScanIncompleteReason: externalActivityScanIncompleteReasonSchema.optional(),
  lastObservationDetail: z.enum(["available","missing","size_limit"]).optional(), observationCount: z.number().int().positive().optional(),
  compact: externalActivityTransactionCompactFactsSchema.optional(),
  details: externalActivityTransactionDetailSchema.optional(),
  detailLookup: z.object({
    tool: z.literal("read_inspect_sui_transaction"),
    digest: z.string()
  }).optional()
});

const transactionDetailAvailabilitySchema = z.object({
  totalTransactions: z.number().int().nonnegative(),
  withDetails: z.number().int().nonnegative(),
  withoutDetails: z.number().int().nonnegative(),
  detailAvailability: z.enum(["none", "some", "all"]),
  allReturnedTransactionsHaveDetails: z.boolean()
}).strict();

const accountAssetTimelineQuantitySemanticsSchema = z.object({
  kind: z.literal("sui_account_asset_timeline_raw_net_flows"),
  rawAmountsOnly: z.literal(true),
  netFlowFields: z.tuple([
    z.literal("netFlowBars[].increaseRaw"),
    z.literal("netFlowBars[].decreaseRaw"),
    z.literal("netFlowBars[].netRaw")
  ]),
  balanceBarsAvailable: z.literal(false),
  balanceStatusField: z.literal("balanceStatus"),
  balanceBarRule: z.literal("balanceBars are unavailable unless a stored balance anchor exists"),
  notFor: z.tuple([
    z.literal("held_balance_without_balance_anchor"),
    z.literal("complete_wallet_history"),
    z.literal("display_conversion_without_verified_decimals"),
    z.literal("fiat_usd_cash_out"),
    z.literal("usd_peg_assumption"),
    z.literal("profit_or_pnl"),
    z.literal("cost_basis"),
    z.literal("route_recommendation"),
    z.literal("transaction_building"),
    z.literal("signing_data_or_readiness")
  ])
}).strict();

const accountAssetTimelineLimitationSchema = z.enum([
  "no_balance_anchor",
  "account_not_known",
  "no_stored_activity_scans",
  "no_complete_affected_account_scan",
  "sent_only_scan_not_full_account_coverage",
  "scan_window_incomplete",
  "scan_window_unbounded",
  "scan_records_truncated",
  "source_transactions_truncated",
  "transaction_timestamp_unavailable",
  "transaction_details_unavailable",
  "provider_balance_changes_truncated",
  "no_observed_account_balance_changes"
]);

const accountAssetTimelineNetFlowBarSchema = z.object({
  bucketStart: fetchedAtSchema,
  bucketEnd: fetchedAtSchema,
  coinType: z.string(),
  increaseRaw: z.string().regex(/^\d+$/),
  decreaseRaw: z.string().regex(/^\d+$/),
  netRaw: z.string().regex(/^-?\d+$/),
  transactionCount: z.number().int().positive()
}).strict();

const timelinePriceScopeSchema = z.object({
  coinType: z.string(),
  range: z.object({ start: fetchedAtSchema, end: fetchedAtSchema }).strict()
}).strict() satisfies z.ZodType<AccountAssetTimelinePriceScope>;

const accountAssetTimelineUsdcReferenceSummarySchema = z.object({
  status: z.enum(["available", "partial", "unavailable", "no_timeline_bars"]),
  quoteAsset: z.literal(DEEPBOOK_CANDLE_USDC_REFERENCE.quoteAsset),
  priceConvention: z.literal(DEEPBOOK_CANDLE_USDC_REFERENCE.priceConvention),
  usdcIsFiatUsd: z.literal(DEEPBOOK_CANDLE_USDC_REFERENCE.usdcIsFiatUsd),
  usdPegGuaranteeAvailable: z.literal(DEEPBOOK_CANDLE_USDC_REFERENCE.usdPegGuaranteeAvailable),
  source: z.literal(DEEPBOOK_CANDLE_SOURCE_BASE.kind),
  chainRecomputedBySuiMcp: z.literal(DEEPBOOK_CANDLE_SOURCE_BASE.chainRecomputedBySuiMcp),
  quantitySemantics: deepbookUsdcPriceHistoryQuantitySemanticsSchema,
  responseSummary: deepbookUsdcPriceHistoryResponseSummarySchema,
  unsupportedClaims: z.array(z.enum(DEEPBOOK_USDC_PRICE_HISTORY_UNSUPPORTED_CLAIMS)),
  coinReferences: z.array(z.union([
    timelinePriceScopeSchema.extend({
      status: z.enum(["available", "partial"]),
      pair: deepbookUsdcPriceHistoryPairSchema,
      candleAvailability: z.enum(DEEPBOOK_USDC_CANDLE_AVAILABILITY),
      source: deepbookUsdcPriceHistorySourceSchema,
      barReferences: z.array(z.union([
        z.object({
          bucketStart: fetchedAtSchema,
          bucketEnd: fetchedAtSchema,
          status: z.literal("available"),
          candle: deepbookTradeCandleSchema
        }).strict(),
        z.object({
          bucketStart: fetchedAtSchema,
          bucketEnd: fetchedAtSchema,
          status: z.enum(["missing_candle", "source_unavailable"])
        }).strict()
      ]))
    }),
    timelinePriceScopeSchema.extend({
      status: z.literal("unsupported_asset"),
      reason: z.enum(["market_not_in_mainnet_pool_catalog", "selector_resolves_to_multiple_usdc_pools"]),
      matchingPoolNames: z.array(z.string()),
      candidates: z.array(marketIdentitySchema).optional(),
      availablePoolNames: z.array(z.string())
    }),
    timelinePriceScopeSchema.extend({
      status: z.literal("unsupported_range"),
      reason: z.literal("requested_range_exceeds_max_bars"),
      requested: z.unknown()
    }),
    timelinePriceScopeSchema.extend({
      status: z.literal("source_unavailable"),
      candidates: z.array(marketIdentitySchema).optional(),
      reason: z.enum(DEEPBOOK_USDC_PRICE_HISTORY_SOURCE_UNAVAILABLE_REASONS),
      pair: z.unknown().optional(),
      source: z.unknown().optional()
    })
  ]))
}).strict();

const liveActivityScanPersistenceSchema = z.object({
  stored: z.boolean(),
  reason: z.enum(["account_not_known"]).optional(),
  scan: externalActivityScanRecordSchema.optional()
});

const liveActivityScanOutputBase = {
  status: z.literal("ok"),
  fetchedAt: fetchedAtSchema,
  account: z.string(),
  accountKnown: z.boolean(),
  accountSource: reviewActivityAccountSourceSchema,
  relationship: externalActivityRelationshipSchema,
  userAnswerUse: userAnswerUseSchema,
  requestedAccount: requestedAccountActivitySchema,
  requestedAccountTransactionFacts: z.array(requestedAccountTransactionFactSchema),
  transactionDetailAvailability: transactionDetailAvailabilitySchema,
  quantitySemantics: suiActivityQuantitySemanticsSchema,
  source: suiTransactionActivitySourceSchema,
  hasMore: z.boolean(),
  continuationCursor: z.string().optional(),
  windowComplete: z.boolean().nullable(),
  orderingVerified: z.boolean(),
  incompleteReason: externalActivityScanIncompleteReasonSchema.optional(),
  persistence: liveActivityScanPersistenceSchema
};

const liveFunctionActivityScanOutputBase = {
  ...liveActivityScanOutputBase,
  function: z.string(),
  relationship: z.literal("sent")
};

export function registerTransactionActivityTools(server: McpServer, deps: McpServerDeps, reads: MarketReadRequests): void {
  server.registerTool(
    TOOL_NAMES.readInspectSuiTransaction,
    {
      title: "Inspect Sui transaction",
      description: "Lookup one Sui transaction digest. Stores only when sender or balance owner matches a known local wallet.",
      inputSchema: z.object({
        digest: transactionDigestSchema,
        account: z.string().min(1).optional()
      }),
      outputSchema: successOutputSchema({
        status: z.literal("ok"),
        fetchedAt: fetchedAtSchema,
        source: suiTransactionActivitySourceSchema,
        userAnswerUse: userAnswerUseSchema,
        quantitySemantics: suiActivityQuantitySemanticsSchema,
        transaction: suiTransactionFactSchema,
        persistence: z.object({
          stored: z.boolean(),
          reason: z.enum(["no_known_wallet_relation", "transaction_not_found"]).optional(),
          account: z.string().optional(),
          relationship: externalActivityRelationshipSchema.optional(),
          scan: externalActivityScanRecordSchema.optional()
        })
      }),
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false }
    },
    async ({ digest, account }) => {
      try {
        const result = await deps.transactionActivityService.inspectSuiTransaction({ digest, account });
        const transaction = transactionFactOutput(result.transaction);
        return okToolResult({
          ...result,
          userAnswerUse: inspectSuiTransactionUserAnswerUse({
            hasSender: transaction.sender !== undefined,
            hasRequestedAccountEffect: transaction.requestedAccountEffect !== undefined,
            hasDetails: transaction.details !== undefined
          }),
          quantitySemantics: suiActivityQuantitySemantics("inspect"),
          transaction
        });
      } catch (error) {
        return transactionActivityToolError(error, deps.logger);
      }
    }
  );

  server.registerTool(
    TOOL_NAMES.readScanSuiAccountActivity,
    {
      title: "Scan Sui account activity rows",
      description: "Bounded GraphQL account activity scan with requested-account facts and digest detail lookups. Not background indexing or complete history.",
      inputSchema: suiActivityScanInputSchema,
      outputSchema: successOutputSchema({
        ...liveActivityScanOutputBase,
        transactions: z.array(suiTransactionAuditFactSchema),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false }
    },
    async (input) => {
      try {
        const result = await deps.transactionActivityService.scanSuiAccountActivity(input);
        return okToolResult(liveActivityScanToolOutput(result, transactionFactAuditOutput));
      } catch (error) {
        return transactionActivityToolError(error, deps.logger);
      }
    }
  );

  server.registerTool(
    TOOL_NAMES.readScanSuiFunctionActivity,
    {
      title: "Scan sent Sui function activity rows",
      description: "Bounded GraphQL scan for transactions the account sent that called one full package::module::function. Returns requested-account facts and digest detail lookups.",
      inputSchema: suiFunctionActivityScanInputSchema,
      outputSchema: successOutputSchema({
        ...liveFunctionActivityScanOutputBase,
        transactions: z.array(suiTransactionAuditFactSchema),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false }
    },
    async (input) => {
      try {
        const result = await deps.transactionActivityService.scanSuiFunctionActivity(input);
        return okToolResult(liveActivityScanToolOutput(result, transactionFactAuditOutput));
      } catch (error) {
        return transactionActivityToolError(error, deps.logger);
      }
    }
  );

  server.registerTool(
    TOOL_NAMES.readSummarizeSuiAccountActivity,
    {
      title: "Summarize Sui account activity",
      description: "Summarize stored normalized Sui activity facts. Not complete history or P&L.",
      inputSchema: z.object({
        ...reviewActivityInputSchema,
        limit: z.number().int().min(1).max(REVIEW_ACTIVITY_LIST_MAX_LIMIT).optional()
      }),
      outputSchema: successOutputSchema({
        status: z.literal("ok"),
        dataScope: reviewActivityDataScopeSchema,
        accountSource: reviewActivityAccountSourceSchema,
        userAnswerUse: userAnswerUseSchema,
        quantitySemantics: suiActivityQuantitySemanticsSchema,
        lowSampleWarning: z.boolean(),
        lowSampleThreshold: z.literal(REVIEW_ACTIVITY_LOW_SAMPLE_THRESHOLD),
        truncated: z.boolean(),
        source: suiTransactionActivitySourceSchema,
        summary: z.object({
          transactionCount: z.number().int().nonnegative(),
          statusCounts: z.object({
            success: z.number().int().nonnegative(),
            failure: z.number().int().nonnegative(),
            unknown: z.number().int().nonnegative()
          }),
          relationshipObservationCounts: z.object({ affected: z.number().int().nonnegative(), sent: z.number().int().nonnegative() }).optional(),
    relationshipCounts: z.object({
            affected: z.number().int().nonnegative(),
            sent: z.number().int().nonnegative()
          }),
          earliestTimestamp: fetchedAtSchema.optional(),
          latestTimestamp: fetchedAtSchema.optional()
        }),
        analysis: suiActivityAnalysisSchema.omit({ coinFlows: true }),
        accountCoinFlows: z.object({ scope: z.literal("complete_stored_balance_changes_in_returned_transactions"),
          completeTransactions: z.number().int().nonnegative(), incompleteTransactions: z.number().int().nonnegative(),
          rowsTruncated: z.boolean(), rows: suiActivityAnalysisSchema.shape.coinFlows }),
        transactionDetailAvailability: transactionDetailAvailabilitySchema,
        transactions: z.array(externalActivityTransactionRecordSchema)
      }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ account, from, to, limit }) => {
      try {
        const summary = await deps.transactionActivityService.summarizeSuiAccountActivity({
          account,
          from,
          to,
          limit
        });
        const detailAvailability = transactionDetailAvailability(summary.transactions);
        return okToolResult({
          ...summary,
          userAnswerUse: storedSuiActivityUserAnswerUse(detailAvailability, summary.accountCoinFlows),
          quantitySemantics: suiActivityQuantitySemantics("stored"),
          source: {
            transport: "local_db",
            method: "stored_normalized_facts"
          },
          transactionDetailAvailability: detailAvailability,
          transactions: summary.transactions.map(externalActivityTransactionRecordOutput)
        });
      } catch (error) {
        return transactionActivityToolError(error, deps.logger);
      }
    }
  );

  server.registerTool(
    TOOL_NAMES.readGetAccountAssetTimeline,
    {
      title: "Get account asset timeline",
      description: "Return stored local account asset net-flow timeline evidence or a continuation. Not complete wallet history, P&L, or held balances.",
      inputSchema: resumableReadInput(accountAssetTimelineInputSchema),
      outputSchema: resumableReadOutput(successOutputSchema({
        status: z.enum(["ok", "partial_coverage", "scan_needed", "account_not_known"]),
        fetchedAt: fetchedAtSchema,
        account: z.string(),
        requestedRange: z.object({
          from: fetchedAtSchema,
          to: fetchedAtSchema
        }).strict(),
      bucket: z.object({
          interval: deepbookCandleIntervalSchema,
          durationMs: z.number().int().positive(),
          alignment: z.enum(["utc_epoch", "utc_monday"])
        }).strict(),
        balanceStatus: z.literal("unavailable_no_balance_anchor"),
        coverage: externalActivityCoverageSchema,
        source: suiTransactionActivitySourceSchema,
        sourceTransactions: z.object({
          storedTransactionCount: z.number().int().nonnegative(),
          returnedTransactionCount: z.number().int().nonnegative(),
          truncated: z.boolean(),
          detailAvailability: transactionDetailAvailabilitySchema
        }).strict(),
        sourceTransactionCount: z.number().int().nonnegative(),
        analyzedTransactionCount: z.number().int().nonnegative(),
        skippedTransactionCount: z.number().int().nonnegative(),
        netFlowBars: z.array(accountAssetTimelineNetFlowBarSchema),
        completeFlowBars: z.array(accountAssetTimelineNetFlowBarSchema),
        incompleteBuckets: z.array(z.object({ start: fetchedAtSchema, transactionCount: z.number().int().positive() })),
        completeTransactionCount: z.number().int().nonnegative(), incompleteTransactionCount: z.number().int().nonnegative(),
        balanceBars: z.tuple([]),
        quantitySemantics: accountAssetTimelineQuantitySemanticsSchema,
        usdcReferences: accountAssetTimelineUsdcReferenceSummarySchema,
        limitations: z.array(accountAssetTimelineLimitationSchema),
        userAnswerUse: userAnswerUseSchema,
        scanNeeded: z.object({
          tool: z.literal(TOOL_NAMES.readScanSuiAccountActivity),
          account: z.string(),
          relationship: z.literal("affected"),
          fromTimestamp: fetchedAtSchema,
          toTimestamp: fetchedAtSchema
        }).strict().optional()
      })),
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async (input) => {
      const tool = TOOL_NAMES.readGetAccountAssetTimeline;
      try {
        if ("requestId" in input) return await reads.resume(tool, input.requestId);
        const {start, end, interval} = input;
        return await deps.activityStore.withActivityWindow({
          account: input.account, from: start, to: end, limit: REVIEW_ACTIVITY_LIST_MAX_LIMIT
        }, binding => reads.readSnapshot(tool,
          JSON.stringify([binding.account, input.account !== undefined, start, end, interval ?? DEFAULT_DEEPBOOK_CANDLE_INTERVAL]),
          binding, async ({ coverage, activityTransactions }, signal) => {
          const timeline = buildAccountAssetTimeline({
            account: coverage.dataScope.account,
            from: start,
            to: end,
            interval,
            coverage,
            transactions: activityTransactions.transactions,
            transactionsTruncated: activityTransactions.truncated
          });
          const withUsdcReferences = await attachDeepbookUsdcReferencesToTimeline({
            timeline,
            signal,
            getPriceHistory: deps.readService.priceHistoryReaderForRequest(signal, [...new Set(timeline.netFlowBars.map(bar => bar.coinType))])
          });
          deps.assertCurrent?.();
          const detailAvailability = transactionDetailAvailability(activityTransactions.transactions);
          const scanNeeded = withUsdcReferences.status === "scan_needed";
          const accountKnown = withUsdcReferences.status !== "account_not_known";
          return okToolResult({
            ...withUsdcReferences,
            fetchedAt: new Date().toISOString(),
            source: {
              transport: "local_db",
              method: "stored_normalized_facts"
            },
            sourceTransactions: {
              storedTransactionCount: activityTransactions.transactionCount,
              returnedTransactionCount: activityTransactions.transactions.length,
              truncated: activityTransactions.truncated,
              detailAvailability
            },
            quantitySemantics: accountAssetTimelineQuantitySemantics(),
            userAnswerUse: accountAssetTimelineUserAnswerUse({
              hasNetFlowBars: withUsdcReferences.netFlowBars.length > 0,
              hasUsdcReferenceCandles: ["available", "partial"].includes(withUsdcReferences.usdcReferences.status),
              scanNeeded,
              accountKnown
            }),
            ...(scanNeeded && accountKnown
              ? {
                  scanNeeded: {
                    tool: TOOL_NAMES.readScanSuiAccountActivity,
                    account: coverage.dataScope.account,
                    relationship: "affected",
                    fromTimestamp: start,
                    toTimestamp: end
                  }
                }
              : {})
          });
        }));
      } catch (error) {
        return transactionActivityToolError(error, deps.logger);
      }
    }
  );

  server.registerTool(
    TOOL_NAMES.readSummarizeSuiActivityScan,
    {
      title: "Summarize Sui activity scan",
      description: "Bounded GraphQL account activity summary with requested-account facts and deterministic normalized-fact analysis. Not complete history or P&L.",
      inputSchema: suiActivityScanInputSchema,
      outputSchema: successOutputSchema({
        ...liveActivityScanOutputBase,
        analysis: suiActivityAnalysisSchema,
        transactions: z.array(suiTransactionAuditFactSchema),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false }
    },
    async (input) => {
      try {
        const result = await deps.transactionActivityService.summarizeSuiActivityScan(input);
        return okToolResult(liveActivityScanToolOutput(result, transactionFactAuditOutput));
      } catch (error) {
        return transactionActivityToolError(error, deps.logger);
      }
    }
  );

  server.registerTool(
    TOOL_NAMES.readSummarizeSuiFunctionActivityScan,
    {
      title: "Summarize sent Sui function activity",
      description: "Bounded sent-function activity summary with requested-account facts and deterministic normalized-fact analysis. Not route, P&L, or position analysis.",
      inputSchema: suiFunctionActivityScanInputSchema,
      outputSchema: successOutputSchema({
        ...liveFunctionActivityScanOutputBase,
        analysis: suiActivityAnalysisSchema,
        transactions: z.array(suiTransactionAuditFactSchema),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false }
    },
    async (input) => {
      try {
        const result = await deps.transactionActivityService.summarizeSuiFunctionActivityScan(input);
        return okToolResult(liveActivityScanToolOutput(result, transactionFactAuditOutput));
      } catch (error) {
        return transactionActivityToolError(error, deps.logger);
      }
    }
  );
}

type LiveActivityScanToolResult =
  | ScanSuiAccountActivityResult
  | ScanSuiFunctionActivityResult
  | SummarizeSuiActivityScanResult
  | SummarizeSuiFunctionActivityScanResult;

function liveActivityScanToolOutput<TTransactionOutput>(
  result: LiveActivityScanToolResult,
  transactionOutput: (transaction: SuiTransactionActivityFact) => TTransactionOutput
) {
  const detailAvailability = transactionDetailAvailability(result.transactions);
  return {
    status: result.status,
    fetchedAt: result.fetchedAt,
    account: result.account,
    accountKnown: result.accountKnown,
    accountSource: result.accountSource,
    ...("function" in result ? { function: result.function } : {}),
    relationship: result.relationship,
    userAnswerUse: liveSuiActivityUserAnswerUse({
      includeAnalysis: "analysis" in result,
      transactionDetailAvailability: detailAvailability
    }),
    requestedAccount: result.requestedAccount,
    requestedAccountTransactionFacts: requestedAccountTransactionFacts(result.transactions),
    transactionDetailAvailability: detailAvailability,
    quantitySemantics: suiActivityQuantitySemantics("analysis" in result ? "analysis" : "scan"),
    source: result.source,
    ...("analysis" in result ? { analysis: result.analysis } : {}),
    transactions: result.transactions.map(transactionOutput),
    hasMore: result.hasMore,
    ...(result.continuationCursor === undefined ? {} : { continuationCursor: result.continuationCursor }),
    windowComplete: result.windowComplete,
    orderingVerified: result.orderingVerified,
    ...(result.incompleteReason === undefined ? {} : { incompleteReason: result.incompleteReason }),
    persistence: result.persistence
  };
}

function requestedAccountTransactionFacts(
  transactions: Parameters<typeof requestedAccountTransactionFactOutput>[0][]
) {
  return transactions.flatMap((transaction) => {
    const fact = requestedAccountTransactionFactOutput(transaction);
    return fact === undefined ? [] : [fact];
  });
}
