import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  DEEPBOOK_SCALAR_UNIT_SOURCE,
  DISPLAY_AMOUNT_SOURCE,
  SUI_METADATA_UNIT_SOURCE
} from "../../../core/read/coinMetadata.js";
import { DEEPBOOK_SOURCE_FIELD_VALUES } from "../../../core/read/deepbookSourceOwners.js";
import {
  DEEPBOOK_MID_PRICE_DIRECTION,
  DEEPBOOK_MID_PRICE_PRECISION,
  DEFAULT_DEEPBOOK_SIMULATION_SENDER,
  INTENT_EVIDENCE_QUANTITY_KIND,
  INTENT_EVIDENCE_TARGET_ASSET_SELECTION_SOURCES,
  SETTLEMENT_ASSET_GROUP_PARITY_QUANTITY_KIND,
  SUI_USD_SETTLEMENT_ASSET_GROUP_ID,
  WALLET_BALANCE_QUANTITY_KIND
} from "../../../core/read/readServiceTypes.js";
import type { UserAnswerUse } from "../../../core/evidence/userAnswerUse.js";
import { suiAddressStringSchema } from "../../../core/suiAddress.js";
import { successOutputSchema } from "../../schemas.js";
import { okToolResult } from "../../result.js";
import type { McpServerDeps } from "../../server.js";
import {
  toolAvailability,
  USD_INTENT_ANSWER_REQUIRED_TOOLS,
  USD_PARITY_ANSWER_REQUIRED_TOOLS,
  type ToolAvailability
} from "../../serverInfo.js";
import { TOOL_NAMES } from "../../toolNames.js";
import { fetchedAtSchema, readSourceSchema, userAnswerUseSchema } from "./commonSchemas.js";
import { readServiceError, resolveExplicitOrActiveAccount } from "./readToolHelpers.js";

type ResponseWithUserAnswerUse = {
  userAnswerUse: UserAnswerUse;
};

function withToolAvailability<T extends ResponseWithUserAnswerUse>(
  data: T,
  requiredTools: readonly string[]
): T & { toolAvailability: ToolAvailability } {
  const preconditionFields = new Set(data.userAnswerUse.preconditionFields ?? []);
  preconditionFields.add("toolAvailability");
  return {
    ...data,
    userAnswerUse: {
      ...data.userAnswerUse,
      preconditionFields: [...preconditionFields]
    },
    toolAvailability: toolAvailability(requiredTools)
  };
}

const toolAvailabilitySchema = z.object({
  statusTool: z.literal(TOOL_NAMES.readGetServerStatus),
  packageName: z.string(),
  version: z.string(),
  evidencePolicyVersion: z.string(),
  network: z.literal("mainnet"),
  implementedToolsCount: z.number().int().nonnegative(),
  requiredTools: z.array(z.object({ name: z.string(), available: z.boolean() })),
  missingRequiredTools: z.array(z.string()),
  requiredToolsAvailable: z.boolean(),
  unavailableReason: z.literal("required_tool_missing_from_current_server_build").nullable()
}).strict();

const walletBalanceUnitSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("available"),
    source: z.enum([SUI_METADATA_UNIT_SOURCE, DEEPBOOK_SCALAR_UNIT_SOURCE]),
    decimals: z.number().int().nonnegative(),
    symbol: z.string(),
    name: z.string(),
    cacheStatus: z.enum(["hit", "miss", "expired_refetched"]).optional()
  }),
  z.object({
    status: z.literal("unavailable"),
    reason: z.enum([
      "metadata_not_found",
      "metadata_lookup_failed",
      "coin_type_unresolved",
      "no_verified_decimals"
    ])
  })
]);

const walletBalanceDisplaySchema = z.object({
  amount: z.string(),
  symbol: z.string(),
  source: z.literal(DISPLAY_AMOUNT_SOURCE)
});

const walletBalanceQuantitySemanticsSchema = z.object({
  kind: z.literal(WALLET_BALANCE_QUANTITY_KIND),
  allowedUse: z.literal("current_coin_balance_snapshot"),
  currentBalanceSnapshot: z.literal(true),
  transactionHistoryAvailable: z.literal(false),
  transactionReceiptProofAvailable: z.literal(false),
  transactionBalanceDeltaAvailable: z.literal(false),
  acquisitionSourceAvailable: z.literal(false),
  objectProvenanceAvailable: z.literal(false),
  fiatUsdCashOutAvailable: z.literal(false),
  profitAndLossAvailable: z.literal(false),
  costBasisAvailable: z.literal(false),
  notFor: z.tuple([
    z.literal("transaction_history"),
    z.literal("transaction_receipt_proof"),
    z.literal("specific_transaction_balance_delta"),
    z.literal("acquisition_source"),
    z.literal("object_provenance"),
    z.literal("fiat_usd_cash_out"),
    z.literal("profit_or_pnl"),
    z.literal("cost_basis"),
    z.literal("signing_data")
  ])
}).strict();

const walletBalanceSchema = z.object({
  coinType: z.string(),
  balance: z.string(),
  coinBalance: z.string(),
  addressBalance: z.string(),
  unit: walletBalanceUnitSchema,
  display: walletBalanceDisplaySchema.optional()
});

const classifiedWalletAssetSchema = z.object({
  balance: walletBalanceSchema,
  classification: z.object({
    assetClass: z.literal("coin_balance"),
    balanceStatus: z.enum(["nonzero", "zero"]),
    roles: z.array(z.enum(["gas_candidate", "deepbook_registered"]))
  })
});

const uninspectedAssetClassSchema = z.discriminatedUnion("assetClass", [
  z.object({
    assetClass: z.literal("staked_or_locked_asset"),
    reason: z.literal("requires_separate_stake_read_not_inspected")
  }),
  z.object({
    assetClass: z.literal("deepbook_balance_manager_or_open_order"),
    reason: z.literal("requires_separate_deepbook_account_read_not_inspected")
  }),
  z.object({
    assetClass: z.literal("lp_vault_or_position"),
    reason: z.literal("requires_separate_protocol_read_not_inspected")
  }),
  z.object({
    assetClass: z.literal("nft_or_object_asset"),
    reason: z.literal("requires_separate_object_read_not_inspected")
  })
]);

const settlementAssetGroupAliasSchema = z.enum([
  "dollar",
  "dollars",
  "usd",
  "usd-like",
  "stablecoin",
  "stablecoins"
]);

const settlementAssetGroupAssetSchema = z.object({
  symbol: z.string(),
  coinType: z.string(),
  decimals: z.number().int().nonnegative(),
  unitSource: z.literal(DEEPBOOK_SCALAR_UNIT_SOURCE),
  poolKeys: z.array(z.string())
});

const settlementAssetGroupExcludedAssetSchema = z.object({
  symbol: z.string(),
  coinType: z.string(),
  reason: z.enum([
    "protocol_fee_asset",
    "gas_or_volatile_asset",
    "volatile_or_non_usd_asset",
    "not_in_usd_settlement_asset_group"
  ])
});

const settlementAssetGroupEvidenceSourcesSchema = z.object({
  sdk: z.literal("@mysten/deepbook-v3"),
  registry: z.tuple([z.literal("mainnetCoins"), z.literal("mainnetPools")]),
  network: z.literal("mainnet"),
  unitSource: z.literal(DEEPBOOK_SCALAR_UNIT_SOURCE)
});

const settlementAssetGroupLimitationsSchema = z.tuple([
  z.literal("static_pinned_sdk_registry_not_live_liquidity"),
  z.literal("not_fiat_usd_cash_out"),
  z.literal("not_payment_execution"),
  z.literal("not_route_recommendation"),
  z.literal("not_signing_readiness")
]);

const settlementAssetGroupSchema = z.object({
  id: z.literal(SUI_USD_SETTLEMENT_ASSET_GROUP_ID),
  label: z.literal("Sui USD-denominated settlement assets"),
  aliases: z.array(settlementAssetGroupAliasSchema),
  includedAssets: z.array(settlementAssetGroupAssetSchema),
  excludedAssets: z.array(settlementAssetGroupExcludedAssetSchema),
  evidenceSources: settlementAssetGroupEvidenceSourcesSchema,
  limitations: settlementAssetGroupLimitationsSchema
});

const settlementAssetGroupParityQuantitySemanticsSchema = z.object({
  kind: z.literal(SETTLEMENT_ASSET_GROUP_PARITY_QUANTITY_KIND),
  allowedUse: z.literal("settlement_asset_group_internal_parity_evidence"),
  referenceAssetRole: z.literal("measurement_reference_not_settlement_choice"),
  priceSource: z.literal("deepbook_mid_price_snapshot"),
  fiatUsdCashOutAvailable: z.literal(false),
  externalMarketPriceConversionAvailable: z.literal(false),
  externalMarketLookupAvailable: z.literal(false),
  usdPegAssumptionAvailable: z.literal(false),
  settlementTokenSelectionAvailable: z.literal(false),
  paymentExecutionReadinessAvailable: z.literal(false),
  routeRecommendationAvailable: z.literal(false),
  profitAndLossAvailable: z.literal(false),
  costBasisAvailable: z.literal(false),
  notFor: z.tuple([
    z.literal("settlement_token_selection"),
    z.literal("fiat_usd_cash_out"),
    z.literal("external_market_price_conversion"),
    z.literal("external_market_lookup"),
    z.literal("usd_peg_assumption"),
    z.literal("bank_cash_out_estimate"),
    z.literal("payment_execution_readiness"),
    z.literal("route_recommendation"),
    z.literal("best_route"),
    z.literal("transaction_building"),
    z.literal("signing_readiness"),
    z.literal("profit_or_pnl"),
    z.literal("cost_basis")
  ])
});

const settlementAssetGroupParityAssetSchema = z.discriminatedUnion("status", [
  settlementAssetGroupAssetSchema.extend({
    status: z.literal("reference_asset"),
    priceInReferenceAsset: z.number().positive(),
    parityDirection: z.literal("reference_asset_per_group_asset"),
    reason: z.literal("reference_asset_is_measurement_baseline_not_settlement_choice")
  }),
  settlementAssetGroupAssetSchema.extend({
    status: z.literal("measured"),
    priceInReferenceAsset: z.number().positive(),
    parityDirection: z.literal("reference_asset_per_group_asset"),
    poolKey: z.string(),
    direction: z.enum(["base_to_quote", "quote_to_base"]),
    poolMidPrice: z.number().positive(),
    poolMidPriceDirection: z.literal(DEEPBOOK_MID_PRICE_DIRECTION)
  }),
  settlementAssetGroupAssetSchema.extend({
    status: z.literal("no_direct_deepbook_pool"),
    reason: z.string()
  }),
  settlementAssetGroupAssetSchema.extend({
    status: z.literal("mid_price_unavailable"),
    poolKey: z.string(),
    direction: z.enum(["base_to_quote", "quote_to_base"]),
    reason: z.string()
  })
]);

const settlementAssetGroupParityUnsupportedClaimsSchema = z.enum([
  "settlement_token_selection",
  "fiat_usd_cash_out",
  "payment_execution_readiness",
  "route_recommendation",
  "best_route",
  "transaction_building",
  "signing_readiness",
  "profit_or_pnl",
  "cost_basis"
]);

const settlementAssetGroupParityResponseSummarySchema = z.object({
  questionKind: z.literal("settlement_asset_group_parity"),
  conclusionKind: z.literal("parity_statistics_available"),
  assetGroupId: z.literal(SUI_USD_SETTLEMENT_ASSET_GROUP_ID),
  referenceAssetSymbol: z.string(),
  referenceAssetRole: z.literal("measurement_reference_not_settlement_choice"),
  parityDirection: z.literal("reference_asset_per_group_asset"),
  min: z.object({
    symbol: z.string(),
    priceInReferenceAsset: z.number().positive()
  }),
  max: z.object({
    symbol: z.string(),
    priceInReferenceAsset: z.number().positive()
  }),
  mean: z.object({
    priceInReferenceAsset: z.number().positive()
  }),
  median: z.object({
    priceInReferenceAsset: z.number().positive()
  }),
  excludedFromConclusion: z.tuple([
    z.literal("settlement_token_selection"),
    z.literal("fiat_usd_cash_out"),
    z.literal("payment_execution_readiness"),
    z.literal("route_recommendation"),
    z.literal("best_route"),
    z.literal("transaction_building"),
    z.literal("signing_readiness"),
    z.literal("profit_or_pnl"),
    z.literal("cost_basis")
  ])
});

const intentEvidenceQuantitySemanticsSchema = z.object({
  kind: z.literal(INTENT_EVIDENCE_QUANTITY_KIND),
  allowedUse: z.literal("pre_transaction_evidence"),
  naturalLanguageIntentEvidence: z.literal(true),
  transactionBuildingAvailable: z.literal(false),
  signingReadinessAvailable: z.literal(false),
  routeRecommendationAvailable: z.literal(false),
  fiatUsdCashOutAvailable: z.literal(false),
  profitAndLossAvailable: z.literal(false),
  costBasisAvailable: z.literal(false),
  notFor: z.tuple([
    z.literal("transaction_building"),
    z.literal("signing_data"),
    z.literal("signing_readiness"),
    z.literal("payment_execution"),
    z.literal("best_route"),
    z.literal("route_recommendation"),
    z.literal("fiat_usd_cash_out"),
    z.literal("external_market_price_conversion"),
    z.literal("profit_or_pnl"),
    z.literal("cost_basis")
  ])
});

const intentEvidenceUnsupportedClaimsSchema = z.enum([
  "settlement_token_selection",
  "fiat_usd_cash_out",
  "gas_reserve_or_fee_readiness",
  "best_route_or_venue_comparison",
  "route_dependent_payment_support",
  "payment_execution_readiness",
  "transaction_building",
  "signing_readiness",
  "profit_or_pnl",
  "cost_basis"
]);

const intentEvidenceAssetGroupBalanceSchema = settlementAssetGroupAssetSchema.extend({
  currentRawAmount: z.string().regex(/^\d+$/),
  currentDisplayAmount: z.string(),
  walletBalanceEvidence: z.literal("current_wallet_coin_balance_snapshot")
});

const intentEvidenceAggregateSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("available"),
    requiredDisplayAmount: z.string().optional(),
    requiredRawAmount: z.string().regex(/^\d+$/).optional(),
    currentRawAmount: z.string().regex(/^\d+$/),
    currentDisplayAmount: z.string(),
    shortfallRawAmount: z.string().regex(/^\d+$/).optional(),
    shortfallDisplayAmount: z.string().optional(),
    decimals: z.number().int().nonnegative(),
    unitSource: z.literal(DEEPBOOK_SCALAR_UNIT_SOURCE)
  }),
  z.object({
    status: z.literal("unavailable_mixed_decimals"),
    requiredDisplayAmount: z.string().optional()
  }),
  z.object({
    status: z.literal("unavailable_wallet_balance_scan_incomplete"),
    requiredDisplayAmount: z.string().optional(),
    reason: z.enum(["wallet_balance_page_limit_exceeded", "wallet_balance_pagination_did_not_advance"])
  })
]);

const intentEvidenceSettlementAssetCoverageBoundarySchema = z.tuple([
  z.literal("current_wallet_coin_balance_snapshot"),
  z.literal("settlement_asset_assets_only"),
  z.literal("not_settlement_token_selection"),
  z.literal("not_route_dependent_payment_support"),
  z.literal("not_payment_execution_readiness"),
  z.literal("not_gas_readiness")
]);

const intentEvidenceSettlementAssetCoverageSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("balance_total_only"),
    currentRawAmount: z.string().regex(/^\d+$/),
    currentDisplayAmount: z.string(),
    decimals: z.number().int().nonnegative(),
    unitSource: z.literal(DEEPBOOK_SCALAR_UNIT_SOURCE),
    boundary: intentEvidenceSettlementAssetCoverageBoundarySchema
  }),
  z.object({
    status: z.enum(["covered_by_settlement_asset_balance", "shortfall_in_settlement_asset_balance"]),
    requiredDisplayAmount: z.string(),
    requiredRawAmount: z.string().regex(/^\d+$/),
    currentRawAmount: z.string().regex(/^\d+$/),
    currentDisplayAmount: z.string(),
    shortfallRawAmount: z.string().regex(/^\d+$/),
    shortfallDisplayAmount: z.string(),
    decimals: z.number().int().nonnegative(),
    unitSource: z.literal(DEEPBOOK_SCALAR_UNIT_SOURCE),
    boundary: intentEvidenceSettlementAssetCoverageBoundarySchema
  }),
  z.object({
    status: z.literal("unavailable_mixed_decimals"),
    requiredDisplayAmount: z.string().optional(),
    reason: z.literal("asset_group_assets_do_not_share_verified_decimals"),
    boundary: intentEvidenceSettlementAssetCoverageBoundarySchema
  }),
  z.object({
    status: z.literal("unavailable_wallet_balance_scan_incomplete"),
    requiredDisplayAmount: z.string().optional(),
    reason: z.enum(["wallet_balance_page_limit_exceeded", "wallet_balance_pagination_did_not_advance"]),
    boundary: intentEvidenceSettlementAssetCoverageBoundarySchema
  })
]);

const intentEvidenceSelectedTargetSchema = settlementAssetGroupAssetSchema.extend({
  selectionSource: z.enum(INTENT_EVIDENCE_TARGET_ASSET_SELECTION_SOURCES),
  requiredRawAmount: z.string().regex(/^\d+$/),
  currentRawAmount: z.string().regex(/^\d+$/),
  currentDisplayAmount: z.string(),
  shortfallRawAmount: z.string().regex(/^\d+$/),
  shortfallDisplayAmount: z.string()
});

const intentEvidenceResponseEvidenceSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("settlement_asset_only"),
    primaryEvidenceFields: z.tuple([z.literal("responseSummary")]),
    supportedResponseClaims: z.array(
      z.enum([
        "current_settlement_asset_total",
        "settlement_asset_coverage_status",
        "settlement_asset_shortfall",
        "settlement_asset_coverage_unavailable",
        "selected_target_shortfall",
        "direct_pool_quote_evidence",
        "required_user_choices",
        "unsupported_inferences"
      ])
    )
  }),
  z.object({
    mode: z.literal("selected_target_context"),
    primaryEvidenceFields: z.tuple([
      z.literal("responseSummary"),
      z.literal("selectedTarget"),
      z.literal("candidateConversions"),
      z.literal("requiredUserChoices")
    ]),
    supportedResponseClaims: z.array(
      z.enum([
        "current_settlement_asset_total",
        "settlement_asset_coverage_status",
        "settlement_asset_shortfall",
        "settlement_asset_coverage_unavailable",
        "selected_target_shortfall",
        "direct_pool_quote_evidence",
        "required_user_choices",
        "unsupported_inferences"
      ])
    )
  })
]);

const intentEvidenceResponseSummarySchema = z.object({
  questionKind: z.enum(["payment_coverage", "settlement_asset_group_balance_total"]),
  conclusionKind: z.enum([
    "covered_by_settlement_asset_balance",
    "shortfall_in_settlement_asset_balance",
    "current_settlement_asset_total",
    "settlement_asset_coverage_unavailable"
  ]),
  answerCompleteness: z.object({
    answerCompleteFor: z.enum([
      "settlement_asset_group_answer",
      "selected_target_context_answer",
      "settlement_asset_coverage_unavailable_answer"
    ]),
    requiredAnswerFields: z.array(z.string()),
    notCompleteFor: z.array(z.string())
  }),
  doNotCallQuoteToolsForThisQuestion: z.literal(true),
  coverageBasis: z.literal("settlement_asset_wallet_balance_only"),
  assetGroupId: z.literal(SUI_USD_SETTLEMENT_ASSET_GROUP_ID),
  currentDisplayAmount: z.string().nullable(),
  requiredDisplayAmount: z.string().nullable(),
  shortfallDisplayAmount: z.string().nullable(),
  unavailableReason: z
    .enum([
      "asset_group_assets_do_not_share_verified_decimals",
      "wallet_balance_page_limit_exceeded",
      "wallet_balance_pagination_did_not_advance"
    ])
    .optional(),
  amountsUsedForAnswer: z.object({
    currentDisplayAmount: z.literal("current_wallet_balance_in_settlement_asset_group").nullable(),
    requiredDisplayAmount: z.literal("amount_requested_by_user").nullable(),
    shortfallDisplayAmount: z.literal("required_amount_minus_current_settlement_asset_balance").nullable()
  }),
  separateQuoteOutputs: z.object({
    usedForPaymentAnswer: z.literal(false),
    usedForShortfallAnswer: z.literal(false),
    reason: z.literal("separate_quote_tool_outputs_are_price_estimates_only"),
    paymentAnswerField: z.literal("responseSummary")
  }),
  requiredUserChoices: z.array(z.string()),
  doNotUseForConclusion: z.tuple([
    z.literal("separate_quote_tool_results"),
    z.literal("assets_outside_settlement_group"),
    z.literal("route_dependent_payment_support")
  ]),
  excludedFromConclusion: z.tuple([
    z.literal("separate_quote_tool_results"),
    z.literal("candidate_conversion_quote_evidence"),
    z.literal("assets_outside_settlement_group"),
    z.literal("settlement_token_selection"),
    z.literal("route_dependent_payment_support"),
    z.literal("gas_reserve_or_fee_readiness"),
    z.literal("payment_execution_readiness"),
    z.literal("transaction_building"),
    z.literal("signing_readiness"),
    z.literal("fiat_usd_cash_out"),
    z.literal("profit_or_pnl"),
    z.literal("cost_basis")
  ])
});

const intentEvidenceCandidateConversionSchema = z.union([
  z.object({
    sourceSymbol: z.string(),
    targetSymbol: z.string(),
    sourceRawAmount: z.string().regex(/^\d+$/),
    sourceDisplayAmount: z.string(),
    status: z.literal("quoted"),
    directPool: z.object({
      poolKey: z.string(),
      direction: z.enum(["base_to_quote", "quote_to_base"])
    }),
    quote: z.object({ status: z.literal("ok") }).loose(),
    boundary: z.tuple([
      z.literal("quote_snapshot_only"),
      z.literal("not_final_min_out"),
      z.literal("not_route_recommendation"),
      z.literal("not_route_dependent_payment_support"),
      z.literal("not_payment_readiness"),
      z.literal("not_signing_readiness")
    ])
  }),
  z.object({
    sourceSymbol: z.string(),
    targetSymbol: z.string().optional(),
    sourceRawAmount: z.string().regex(/^\d+$/),
    sourceDisplayAmount: z.string(),
    status: z.enum([
      "target_asset_not_selected",
      "no_direct_deepbook_pool",
      "quote_unavailable",
      "filtered_by_accepted_source_assets"
    ]),
    reason: z.string(),
    directPool: z
      .object({
        poolKey: z.string(),
        direction: z.enum(["base_to_quote", "quote_to_base"])
      })
      .optional()
  })
]);

const intentEvidenceSettlementAssetGroupSchema = settlementAssetGroupSchema.omit({ excludedAssets: true });

export function registerWalletReadTools(server: McpServer, deps: McpServerDeps): void {
  server.registerTool(
    TOOL_NAMES.readSummarizeWalletAssets,
    {
      title: "Summarize wallet assets",
      description: "Snapshot current Sui mainnet coin balances via gRPC listBalances. Not transaction history or receipt proof.",
      inputSchema: z.object({
        account: suiAddressStringSchema.optional(),
        cursor: z.string().min(1).optional()
      }),
      outputSchema: successOutputSchema({
        account: z.string(),
        status: z.literal("ok"),
        fetchedAt: fetchedAtSchema,
        userAnswerUse: userAnswerUseSchema,
        quantitySemantics: walletBalanceQuantitySemanticsSchema,
        source: readSourceSchema,
        balances: z.array(walletBalanceSchema),
        hasNextPage: z.boolean(),
        cursor: z.string().nullable()
      }),
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async ({ account, cursor }) => {
      const target = await resolveExplicitOrActiveAccount({ mode: "explicit_or_connected", account }, deps);
      if (target.status !== "ok") {
        return target.result;
      }
      try {
        return okToolResult(await deps.readService.summarizeWalletAssets({ account: target.account, cursor }));
      } catch (error) {
        return readServiceError(error, deps);
      }
    }
  );

  server.registerTool(
    TOOL_NAMES.readClassifyWalletAssets,
    {
      title: "Classify wallet assets",
      description: "Classify current Sui mainnet coin balances. Not transaction history, receipt proof, or P&L.",
      inputSchema: z.object({
        account: suiAddressStringSchema.optional(),
        cursor: z.string().min(1).optional()
      }),
      outputSchema: successOutputSchema({
        account: z.string(),
        status: z.literal("ok"),
        fetchedAt: fetchedAtSchema,
        userAnswerUse: userAnswerUseSchema,
        quantitySemantics: walletBalanceQuantitySemanticsSchema,
        source: readSourceSchema,
        classifiedAssets: z.array(classifiedWalletAssetSchema),
        uninspectedAssetClasses: z.array(uninspectedAssetClassSchema),
        hasNextPage: z.boolean(),
        cursor: z.string().nullable()
      }),
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async ({ account, cursor }) => {
      const target = await resolveExplicitOrActiveAccount({ mode: "explicit_or_connected", account }, deps);
      if (target.status !== "ok") {
        return target.result;
      }
      try {
        return okToolResult(await deps.readService.classifyWalletAssets({ account: target.account, cursor }));
      } catch (error) {
        return readServiceError(error, deps);
      }
    }
  );

  server.registerTool(
    TOOL_NAMES.readListSettlementAssetGroups,
    {
      title: "List settlement asset groups",
      description: "List supported mainnet settlement asset groups derived from pinned SDK registries.",
      inputSchema: z.object({}).optional(),
      outputSchema: successOutputSchema({
        status: z.literal("ok"),
        fetchedAt: fetchedAtSchema,
        assetGroups: z.array(settlementAssetGroupSchema)
      }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => {
      try {
        return okToolResult(deps.readService.listSettlementAssetGroups());
      } catch (error) {
        return readServiceError(error, deps);
      }
    }
  );

  server.registerTool(
    TOOL_NAMES.readSummarizeSettlementAssetGroupParity,
    {
      title: "Summarize settlement asset group parity",
      description: "Summarize USD-denominated asset group parity from direct DeepBook mid-price snapshots. Not settlement selection or fiat cash-out.",
      inputSchema: z.object({
        denomination: z.string().min(1),
        referenceAssetSymbol: z.string().min(1).optional()
      }),
      outputSchema: successOutputSchema({
        status: z.literal("ok"),
        fetchedAt: fetchedAtSchema,
        denomination: settlementAssetGroupAliasSchema,
        assetGroupId: z.literal(SUI_USD_SETTLEMENT_ASSET_GROUP_ID),
        userAnswerUse: userAnswerUseSchema,
        toolAvailability: toolAvailabilitySchema,
        referenceAsset: settlementAssetGroupAssetSchema.extend({
          role: z.literal("measurement_reference_not_settlement_choice")
        }),
        quantitySemantics: settlementAssetGroupParityQuantitySemanticsSchema,
        evidenceSources: z.object({
          settlementAssetGroup: settlementAssetGroupEvidenceSourcesSchema,
          midPrice: z.object({
            sdk: z.literal("@mysten/deepbook-v3"),
            transport: z.literal("grpc"),
            simulation: z.literal("client.core.simulateTransaction"),
            method: z.literal("midPrice"),
            precision: z.literal(DEEPBOOK_MID_PRICE_PRECISION)
          })
        }),
        assets: z.array(settlementAssetGroupParityAssetSchema),
        statistics: z.object({
          status: z.literal("available"),
          sampleCount: z.number().int().nonnegative(),
          unavailableAssetCount: z.number().int().nonnegative(),
          parityDirection: z.literal("reference_asset_per_group_asset"),
          calculation: z.literal("computed_from_available_direct_deepbook_mid_price_snapshots"),
          min: z.object({
            symbol: z.string(),
            priceInReferenceAsset: z.number().positive()
          }),
          max: z.object({
            symbol: z.string(),
            priceInReferenceAsset: z.number().positive()
          }),
          mean: z.object({
            priceInReferenceAsset: z.number().positive()
          }),
          median: z.object({
            priceInReferenceAsset: z.number().positive()
          })
        }),
        responseSummary: settlementAssetGroupParityResponseSummarySchema,
        unsupportedClaims: z.array(settlementAssetGroupParityUnsupportedClaimsSchema)
      }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ denomination, referenceAssetSymbol }) => {
      try {
        return okToolResult(
          withToolAvailability(
            await deps.readService.summarizeSettlementAssetGroupParity({
              denomination,
              referenceAssetSymbol,
              simulationSender: DEFAULT_DEEPBOOK_SIMULATION_SENDER
            }),
            USD_PARITY_ANSWER_REQUIRED_TOOLS
          )
        );
      } catch (error) {
        return readServiceError(error, deps);
      }
    }
  );

  server.registerTool(
    TOOL_NAMES.readPreviewIntentEvidence,
    {
      title: "Preview intent evidence",
      description: "Build wallet and DeepBook evidence for a natural-language settlement intent.",
      inputSchema: z.object({
        account: suiAddressStringSchema.optional(),
        intentKind: z.enum(["cover_payment_like_amount", "summarize_settlement_asset_group_balance"]),
        denomination: z.string().min(1),
        requiredDisplayAmount: z.string().min(1).optional(),
        targetAssetSymbol: z.string().min(1).optional(),
        targetAssetSelectionSource: z.enum(INTENT_EVIDENCE_TARGET_ASSET_SELECTION_SOURCES).optional(),
        acceptedSourceAssetSymbols: z.array(z.string().min(1)).optional()
      }),
      outputSchema: successOutputSchema({
        status: z.literal("ok"),
        account: z.string(),
        fetchedAt: fetchedAtSchema,
        userAnswerUse: userAnswerUseSchema,
        toolAvailability: toolAvailabilitySchema,
        intent: z.object({
          intentKind: z.enum(["cover_payment_like_amount", "summarize_settlement_asset_group_balance"]),
          denomination: settlementAssetGroupAliasSchema,
          requiredDisplayAmount: z.string().optional(),
          targetAssetSymbol: z.string().optional(),
          targetAssetSelectionSource: z.enum(INTENT_EVIDENCE_TARGET_ASSET_SELECTION_SOURCES).optional(),
          acceptedSourceAssetSymbols: z.array(z.string()).optional()
        }),
        quantitySemantics: intentEvidenceQuantitySemanticsSchema,
        evidenceSources: z.object({
          walletBalances: readSourceSchema,
          settlementAssetGroup: settlementAssetGroupEvidenceSourcesSchema,
          quoteEvidence: z.literal(DEEPBOOK_SOURCE_FIELD_VALUES.pinnedSdkWhenTargetAssetSelected)
        }),
        settlementAssetGroup: intentEvidenceSettlementAssetGroupSchema,
        balances: z.array(intentEvidenceAssetGroupBalanceSchema),
        aggregate: intentEvidenceAggregateSchema,
        settlementAssetCoverage: intentEvidenceSettlementAssetCoverageSchema,
        selectedTarget: intentEvidenceSelectedTargetSchema.optional(),
        candidateConversions: z.array(intentEvidenceCandidateConversionSchema),
        blockedReasons: z.array(
          z.enum(["wallet_balance_page_limit_exceeded", "wallet_balance_pagination_did_not_advance"])
        ),
        responseEvidence: intentEvidenceResponseEvidenceSchema,
        responseSummary: intentEvidenceResponseSummarySchema,
        requiredUserChoices: z.array(z.string()),
        supportedClaims: z.array(z.string()),
        unsupportedClaims: z.array(intentEvidenceUnsupportedClaimsSchema),
        uninspectedAssetClasses: z.array(uninspectedAssetClassSchema),
        inspectedBalancePages: z.number().int().nonnegative(),
        inspectedCoinBalanceCount: z.number().int().nonnegative()
      }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({
      account,
      intentKind,
      denomination,
      requiredDisplayAmount,
      targetAssetSymbol,
      targetAssetSelectionSource,
      acceptedSourceAssetSymbols
    }) => {
      const target = await resolveExplicitOrActiveAccount({ mode: "explicit_or_connected", account }, deps);
      if (target.status !== "ok") {
        return target.result;
      }
      try {
        return okToolResult(
          withToolAvailability(
            await deps.readService.previewIntentEvidence({
              account: target.account,
              intentKind,
              denomination,
              requiredDisplayAmount,
              targetAssetSymbol,
              targetAssetSelectionSource,
              acceptedSourceAssetSymbols
            }),
            USD_INTENT_ANSWER_REQUIRED_TOOLS
          )
        );
      } catch (error) {
        return readServiceError(error, deps);
      }
    }
  );
}
