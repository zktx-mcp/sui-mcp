import type { UserAnswerUse } from "../evidence/userAnswerUse.js";
import type {
  DeepbookAccountInventoryDetailStatus,
  IntentEvidenceResponseEvidence,
  IntentEvidenceSettlementAssetCoverage
} from "./readServiceTypes.js";
import {
  DEEPBOOK_ANSWER_USE,
  DEEPBOOK_READ_RESPONSE_UNSUPPORTED
} from "./deepbookSourceOwners.js";

const intentEvidenceConclusionRuleFields = [
  "responseSummary.doNotCallQuoteToolsForThisQuestion",
  "responseSummary.separateQuoteOutputs",
  "responseSummary.doNotUseForConclusion",
  "responseSummary.excludedFromConclusion",
  "unsupportedClaims"
] as const;

export function walletBalanceUserAnswerUse(): UserAnswerUse {
  return {
    canAnswer: [
      "current_coin_balance_snapshot",
      "current_coin_balance_display_amount_when_balance_unit_status_is_available"
    ],
    cannotAnswer: [
      "transaction_history",
      "specific_transaction_receipt",
      "specific_transaction_balance_delta",
      "acquisition_source",
      "object_provenance",
      "payment_coverage_or_shortfall",
      "usd_denominated_settlement_asset_balance_total",
      "fiat_usd_cash_out",
      "profit_or_pnl",
      "cost_basis",
      "signing_data_or_readiness"
    ],
    answerFields: [
      "account",
      "fetchedAt",
      "balances[].coinType",
      "balances[].balance",
      "balances[].unit",
      "balances[].display"
    ],
    diagnosticOnlyFields: ["source", "quantitySemantics", "hasNextPage", "cursor"],
    followUp: {
      tool: "read_preview_intent_evidence",
      inputFields: ["account"],
      answerFields: ["responseSummary"],
      reason: "Use for USD-denominated payment coverage, balance-total, or shortfall answers; wallet balances are current coin snapshots only."
    }
  };
}

export function walletClassificationUserAnswerUse(): UserAnswerUse {
  return {
    canAnswer: [
      "current_coin_balance_classification",
      "current_coin_balance_display_amount_when_balance_unit_status_is_available",
      "which_asset_classes_were_not_inspected_by_this_classifier"
    ],
    cannotAnswer: [
      "complete_portfolio_inventory",
      "transaction_history",
      "specific_transaction_receipt",
      "payment_coverage_or_shortfall",
      "usd_denominated_settlement_asset_balance_total",
      "route_or_funding_plan",
      "fiat_usd_cash_out",
      "profit_or_pnl",
      "cost_basis",
      "signing_data_or_readiness"
    ],
    answerFields: [
      "account",
      "fetchedAt",
      "classifiedAssets[].balance",
      "classifiedAssets[].classification",
      "uninspectedAssetClasses"
    ],
    diagnosticOnlyFields: ["source", "quantitySemantics", "hasNextPage", "cursor"],
    followUp: {
      tool: "read_preview_intent_evidence",
      inputFields: ["account"],
      answerFields: ["responseSummary"],
      reason: "Use for USD-denominated payment coverage, balance-total, or shortfall answers; classification labels are not payment evidence."
    }
  };
}

export function settlementAssetGroupParityUserAnswerUse(): UserAnswerUse {
  return {
    canAnswer: [
      "settlement_asset_group_internal_parity_statistics",
      "highest_lowest_mean_or_median_parity_from_available_direct_deepbook_mid_price_snapshots"
    ],
    cannotAnswer: [
      "settlement_token_selection",
      "payment_coverage_or_shortfall",
      "fiat_usd_cash_out",
      "external_market_price_conversion",
      "usd_peg_assumption",
      "payment_execution_readiness",
      "route_recommendation",
      "transaction_building",
      "signing_data_or_readiness",
      "profit_or_pnl",
      "cost_basis"
    ],
    answerFields: [
      "responseSummary",
      "responseSummary.min",
      "responseSummary.max",
      "responseSummary.mean",
      "responseSummary.median",
      "responseSummary.referenceAssetRole",
      "fetchedAt"
    ],
    conclusionRuleFields: ["responseSummary.excludedFromConclusion", "unsupportedClaims"],
    diagnosticOnlyFields: ["assets", "statistics", "evidenceSources", "quantitySemantics"]
  };
}

export function intentEvidenceUserAnswerUse(
  settlementAssetCoverageStatus?: IntentEvidenceSettlementAssetCoverage["status"],
  responseEvidence: IntentEvidenceResponseEvidence | IntentEvidenceResponseEvidence["mode"] = "settlement_asset_only"
): UserAnswerUse {
  const responseEvidenceMode = typeof responseEvidence === "string" ? responseEvidence : responseEvidence.mode;
  const hasDirectQuoteEvidence =
    typeof responseEvidence !== "string" &&
    responseEvidence.supportedResponseClaims.includes("direct_pool_quote_evidence");

  if (
    settlementAssetCoverageStatus === "unavailable_mixed_decimals" ||
    settlementAssetCoverageStatus === "unavailable_wallet_balance_scan_incomplete"
  ) {
    return {
      canAnswer: [
        "why_usd_denominated_payment_coverage_is_unavailable",
        "required_user_choices_for_the_supported_settlement_asset_group"
      ],
      cannotAnswer: [
        "usd_denominated_settlement_asset_balance_total",
        "usd_denominated_payment_coverage_status",
        "usd_denominated_payment_shortfall",
        "settlement_token_selection",
        "route_dependent_payment_support",
        "gas_reserve_or_fee_readiness",
        "payment_execution_readiness",
        "transaction_building",
        "signing_data_or_readiness",
        "fiat_usd_cash_out",
        "profit_or_pnl",
        "cost_basis"
      ],
      answerFields: [
        "responseSummary",
        "responseSummary.conclusionKind",
        "responseSummary.requiredDisplayAmount",
        "responseSummary.unavailableReason",
        "responseSummary.requiredUserChoices",
        "blockedReasons"
      ],
      conclusionRuleFields: [...intentEvidenceConclusionRuleFields],
      diagnosticOnlyFields: [
        "evidenceSources",
        "quantitySemantics",
        "settlementAssetGroup",
        "balances",
        "aggregate",
        "candidateConversions",
        "uninspectedAssetClasses"
      ]
    };
  }

  const selectedTargetAnswerFields =
    responseEvidenceMode === "selected_target_context"
      ? [
          "selectedTarget",
          "selectedTarget.selectionSource",
          "selectedTarget.currentDisplayAmount",
          "selectedTarget.shortfallDisplayAmount",
          "candidateConversions",
          "candidateConversions[].sourceSymbol",
          "candidateConversions[].targetSymbol",
          "candidateConversions[].sourceDisplayAmount",
          "candidateConversions[].status",
          "requiredUserChoices"
        ]
      : [];
  const selectedTargetCanAnswer =
    responseEvidenceMode === "selected_target_context"
      ? [
          "selected_target_shortfall",
          ...(hasDirectQuoteEvidence ? ["direct_pool_quote_evidence_for_user_selected_target"] : [])
        ]
      : [];

  return {
    canAnswer: [
      "usd_denominated_settlement_asset_balance_total",
      "usd_denominated_payment_coverage_status",
      "usd_denominated_payment_shortfall",
      "required_user_choices_for_the_supported_settlement_asset_group",
      ...selectedTargetCanAnswer
    ],
    cannotAnswer: [
      "settlement_token_selection",
      "route_dependent_payment_support",
      "gas_reserve_or_fee_readiness",
      "payment_execution_readiness",
      "transaction_building",
      "signing_data_or_readiness",
      "fiat_usd_cash_out",
      "profit_or_pnl",
      "cost_basis"
    ],
    answerFields: [
      "responseSummary",
      "responseSummary.currentDisplayAmount",
      "responseSummary.requiredDisplayAmount",
      "responseSummary.shortfallDisplayAmount",
      "responseSummary.amountsUsedForAnswer",
      "responseSummary.requiredUserChoices",
      ...selectedTargetAnswerFields
    ],
    conclusionRuleFields: [...intentEvidenceConclusionRuleFields],
    diagnosticOnlyFields: [
      "evidenceSources",
      "quantitySemantics",
      "settlementAssetGroup",
      "balances",
      "aggregate",
      "blockedReasons",
      "uninspectedAssetClasses"
    ]
  };
}

export function deepbookOrderbookUserAnswerUse(): UserAnswerUse {
  return {
    canAnswer: [
      "deepbook_pool_orderbook_context_at_fetchedAt",
      "deepbook_pool_mid_price_context_returned_with_the_orderbook_snapshot"
    ],
    cannotAnswer: [...DEEPBOOK_READ_RESPONSE_UNSUPPORTED.orderbook],
    answerFields: [
      "poolKey",
      "ticks",
      "fetchedAt",
      "midPrice",
      "poolBookParams",
      "level2TicksFromMid"
    ],
    diagnosticOnlyFields: ["source"],
    followUp: {
      tool: "read_quote_deepbook_display_amount",
      inputFields: ["poolKey"],
      answerFields: ["quote"],
      reason: "Use for an indicative DeepBook quote after the user supplies an explicit source amount, pool, and direction."
    }
  };
}

export function deepbookMidPriceUserAnswerUse(): UserAnswerUse {
  return {
    canAnswer: ["deepbook_pool_mid_price_context"],
    cannotAnswer: [...DEEPBOOK_READ_RESPONSE_UNSUPPORTED.midPrice],
    answerFields: ["poolKey", "base", "quote", "price", "priceDirection", "priceType", "fetchedAt"],
    diagnosticOnlyFields: ["source", "priceSemantics"],
    followUp: {
      tool: "read_preview_intent_evidence",
      answerFields: ["responseSummary"],
      reason: "Use for USD-denominated payment coverage, balance-total, or shortfall answers; mid price is pool price context only."
    }
  };
}

export function deepbookUsdcPriceHistoryUserAnswerUse(): UserAnswerUse {
  return {
    canAnswer: [
      DEEPBOOK_ANSWER_USE.officialUsdcCandleHistory,
      DEEPBOOK_ANSWER_USE.officialCandleAvailabilityForRequestedUtcRange
    ],
    cannotAnswer: [...DEEPBOOK_READ_RESPONSE_UNSUPPORTED.officialUsdcCandles],
    answerFields: [
      "pair",
      "requested.range",
      "candleAvailability",
      "bars",
      "source.candles",
      "responseSummary",
      "unsupportedClaims"
    ],
    conclusionRuleFields: ["responseSummary", "quantitySemantics", "unsupportedClaims"],
    diagnosticOnlyFields: ["source.poolList", "source.baseUrl"]
  };
}

export function deepbookUsdcPriceAtTimeUserAnswerUse(matchAvailable: boolean): UserAnswerUse {
  return {
    canAnswer: [
      DEEPBOOK_ANSWER_USE.officialUsdcCandleForRequestedTime,
      ...(matchAvailable ? [DEEPBOOK_ANSWER_USE.representativeClosePriceForMatchedCandle] : [])
    ],
    cannotAnswer: [...DEEPBOOK_READ_RESPONSE_UNSUPPORTED.officialUsdcCandles],
    answerFields: [
      "target.targetTime",
      "target.searchWindow",
      "status",
      "pair",
      ...(matchAvailable
        ? [
            "match.kind",
            "match.distanceMinutes",
            "match.representativePrice",
            "matchedCandle.start",
            "matchedCandle.end",
            "matchedCandle.open",
            "matchedCandle.high",
            "matchedCandle.low",
            "matchedCandle.close"
          ]
        : []),
      "candleAvailability",
      "source.candles",
      "responseSummary",
      "unsupportedClaims"
    ],
    conclusionRuleFields: ["responseSummary", "quantitySemantics", "unsupportedClaims"],
    diagnosticOnlyFields: ["requested.range", "source.poolList", "source.baseUrl"]
  };
}

export function deepbookQuoteUserAnswerUse(summaryKind: "raw" | "display"): UserAnswerUse {
  return {
    canAnswer: [
      "indicative_deepbook_pool_quote_for_explicit_source_input",
      "raw_sdk_quote_return_values_before_slippage_policy"
    ],
    cannotAnswer: [...DEEPBOOK_READ_RESPONSE_UNSUPPORTED.quote],
    answerFields:
      summaryKind === "raw"
        ? [
            "poolKey",
            "direction",
            "amountRaw",
            "quote.baseOut",
            "quote.quoteOut",
            "quote.deepRequired",
            "rawQuote.directionalOutput",
            "fetchedAt"
          ]
        : [
            "pool",
            "direction",
            "inputAmount",
            "quote.baseOut",
            "quote.quoteOut",
            "quote.deepRequired",
            "rawQuote.directionalOutput",
            "fetchedAt"
          ],
    diagnosticOnlyFields: ["source", "rawQuote.returnValueOrder", "rawQuote.boundary"],
    conclusionRuleFields: [
      "quantitySemantics.canUseForPaymentAnswer",
      "quantitySemantics.canUseForShortfallAnswer",
      "quantitySemantics.doNotCombineWithPaymentAnswer",
      "quantitySemantics.requiredPaymentAnswerTool",
      "quantitySemantics.requiredPaymentAnswerField",
      "quantitySemantics.paymentAnswerUseBlockedReason"
    ],
    followUp: {
      tool: "read_preview_intent_evidence",
      answerFields: ["responseSummary"],
      reason:
        "Use responseSummary for payment coverage, balance-total, or shortfall answers; if this quote was called during a payment question, do not combine its numbers into the conclusion."
    }
  };
}

export function deepbookAccountInventoryUserAnswerUse(detailStatus: DeepbookAccountInventoryDetailStatus): UserAnswerUse {
  const poolAnswerFields =
    detailStatus === "manager_discovery_only" || detailStatus === "pool_key_required" ? [] : ["pool"];
  const detailAnswerFields =
    detailStatus === "available"
      ? ["accountExists", "accountSummary", "lockedBalances", "openOrderIds", "openOrderCount"]
      : detailStatus === "account_not_found"
        ? ["accountExists"]
        : [];
  const detailUnavailableCanAnswer =
    detailStatus === "pool_key_required" ||
    detailStatus === "manager_address_required" ||
    detailStatus === "manager_address_not_discovered_for_active_account"
      ? ["why_deepbook_pool_account_inventory_detail_is_unavailable"]
      : [];
  const accountNotFoundCanAnswer =
    detailStatus === "account_not_found"
      ? ["deepbook_pool_account_absence_when_pool_and_manager_are_supplied"]
      : [];
  const detailCanAnswer =
    detailStatus === "available"
      ? ["deepbook_pool_account_inventory_when_pool_and_manager_are_supplied"]
      : [];
  const detailUnavailableCannotAnswer =
    detailStatus === "available" ? [] : ["deepbook_pool_account_inventory_when_detailStatus_is_not_available"];
  const diagnosticOnlyFields =
    detailStatus === "available"
      ? ["source", "quantitySemantics", "openOrderIdsTruncated"]
      : ["source", "quantitySemantics"];

  return {
    canAnswer: [
      "active_account_deepbook_balance_manager_discovery",
      ...detailUnavailableCanAnswer,
      ...accountNotFoundCanAnswer,
      ...detailCanAnswer
    ],
    cannotAnswer: [
      ...detailUnavailableCannotAnswer,
      ...DEEPBOOK_READ_RESPONSE_UNSUPPORTED.accountInventory
    ],
    answerFields: [
      "account",
      "fetchedAt",
      "detailStatus",
      "managerAddresses",
      "requested",
      ...poolAnswerFields,
      ...detailAnswerFields
    ],
    preconditionFields: ["detailStatus"],
    diagnosticOnlyFields,
    followUp: {
      tool: "read_summarize_wallet_assets",
      answerFields: ["balances"],
      reason: "Use for current wallet coin-balance snapshots; DeepBook BalanceManager inventory is a separate account surface."
    }
  };
}
