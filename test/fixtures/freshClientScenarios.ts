import { TOOL_NAMES } from "../../src/mcp/toolNames.js";

export type FreshClientToolExpectation = {
  /** userAnswerUse.answerFields must include every entry. */
  requiredAnswerFields?: readonly string[];
  /** userAnswerUse.answerFields must NOT include any of these (they would be invalid for this question). */
  forbiddenAnswerFields?: readonly string[];
  /** userAnswerUse.answerFields must NOT match any of these patterns. */
  forbiddenAnswerFieldPatterns?: readonly RegExp[];
  /** userAnswerUse.canAnswer must include every entry. */
  requiredCanAnswerClaims?: readonly string[];
  /** userAnswerUse.canAnswer must NOT include any of these. */
  forbiddenCanAnswerClaims?: readonly string[];
  /** userAnswerUse.cannotAnswer must include every entry. */
  requiredCannotAnswerClaims?: readonly string[];
  /** userAnswerUse.conclusionRuleFields must include every entry. */
  requiredConclusionRuleFields?: readonly string[];
  /** userAnswerUse.preconditionFields must include every entry. */
  requiredPreconditionFields?: readonly string[];
  /** userAnswerUse.followUp.tool must equal this when followUp is present. */
  expectedFollowUpTool?: string;
  /** userAnswerUse.followUp.answerFields must include every entry. */
  expectedFollowUpAnswerFields?: readonly string[];
};

export type FreshClientResponseRule = {
  /** Dotted path into the response payload (under data). e.g., "quantitySemantics.doNotCombineWithPaymentAnswer". */
  fieldPath: string;
  /** Required exact value at fieldPath. */
  equals?: unknown;
  /** fieldPath value must be one of these. */
  oneOf?: readonly unknown[];
  /** fieldPath value must NOT be one of these. */
  notOneOf?: readonly unknown[];
  /** fieldPath value must be an array that contains every entry. */
  arrayContains?: readonly unknown[];
  /** fieldPath value must be an array that does NOT contain any entry. */
  arrayDoesNotContain?: readonly unknown[];
};

export type FreshClientScenario = {
  id: string;
  /** Short description of the user-facing question this scenario codifies. */
  description: string;
  /** Tool to call to expose the response under test. */
  tool: string;
  /** Expectations applied to the response.userAnswerUse object. */
  toolExpectation: FreshClientToolExpectation;
  /** Additional structural rules over the response.data object. */
  responseRules?: readonly FreshClientResponseRule[];
};

export const FRESH_CLIENT_SCENARIOS: readonly FreshClientScenario[] = [
  {
    id: "payment_coverage_1000_usd",
    description:
      'User asks "1000 dollar payment possible?". The settlement-asset evidence response must carry every field a fresh client needs to answer without leaking quote or route conclusions.',
    tool: TOOL_NAMES.readPreviewIntentEvidence,
    toolExpectation: {
      requiredPreconditionFields: ["toolAvailability"],
      requiredAnswerFields: ["responseSummary"],
      requiredCanAnswerClaims: [
        "usd_denominated_payment_coverage_status",
        "usd_denominated_payment_shortfall"
      ],
      requiredCannotAnswerClaims: [
        "settlement_token_selection",
        "route_dependent_payment_support",
        "fiat_usd_cash_out",
        "profit_or_pnl"
      ],
      requiredConclusionRuleFields: [
        "responseSummary.doNotCallQuoteToolsForThisQuestion",
        "responseSummary.doNotUseForConclusion",
        "responseSummary.excludedFromConclusion",
        "unsupportedClaims"
      ],
      forbiddenAnswerFields: ["balances", "candidateConversions"]
    },
    responseRules: [
      { fieldPath: "responseSummary.doNotCallQuoteToolsForThisQuestion", equals: true },
      { fieldPath: "toolAvailability.requiredToolsAvailable", equals: true }
    ]
  },
  {
    id: "settlement_balance_total_check",
    description:
      'User asks "is my balance enough?" before payment, and the same evidence path must answer balance-total without inventing a payment target.',
    tool: TOOL_NAMES.readPreviewIntentEvidence,
    toolExpectation: {
      requiredPreconditionFields: ["toolAvailability"],
      requiredAnswerFields: ["responseSummary"],
      requiredCannotAnswerClaims: [
        "settlement_token_selection",
        "route_dependent_payment_support",
        "profit_or_pnl"
      ],
      requiredConclusionRuleFields: [
        "responseSummary.doNotCallQuoteToolsForThisQuestion",
        "responseSummary.doNotUseForConclusion"
      ]
    },
    responseRules: [
      { fieldPath: "responseSummary.questionKind", equals: "settlement_asset_group_balance_total" },
      { fieldPath: "responseSummary.conclusionKind", equals: "current_settlement_asset_total" },
      { fieldPath: "responseSummary.doNotCallQuoteToolsForThisQuestion", equals: true }
    ]
  },
  {
    id: "settlement_asset_group_parity_reference_not_choice",
    description:
      'User asks "Which USD settlement asset is closest/highest/lowest?". The parity response must answer only from responseSummary parity statistics and must identify the reference asset as a measurement reference, not a settlement choice.',
    tool: TOOL_NAMES.readSummarizeSettlementAssetGroupParity,
    toolExpectation: {
      requiredPreconditionFields: ["toolAvailability"],
      requiredAnswerFields: [
        "responseSummary",
        "responseSummary.min",
        "responseSummary.max",
        "responseSummary.mean",
        "responseSummary.median",
        "responseSummary.referenceAssetRole"
      ],
      forbiddenAnswerFields: [
        "referenceAsset",
        "quantitySemantics",
        "assets",
        "statistics",
        "unsupportedClaims",
        "settlementTokenSelection",
        "selectedSettlementAsset",
        "route",
        "transactionBytes",
        "signingReadiness",
        "profit",
        "pnl",
        "costBasis"
      ],
      forbiddenAnswerFieldPatterns: [
        /settlement.*choice|settlement.*selection|selected.*settlement/i,
        /route/i,
        /transaction/i,
        /signing|signature|signatures|signable|signed/i,
        /fiat|cashOut/i,
        /profit|pnl|costBasis/i
      ],
      requiredCanAnswerClaims: [
        "settlement_asset_group_internal_parity_statistics",
        "highest_lowest_mean_or_median_parity_from_available_direct_deepbook_mid_price_snapshots"
      ],
      forbiddenCanAnswerClaims: [
        "settlement_token_selection",
        "fiat_usd_cash_out",
        "external_market_lookup",
        "usd_peg_assumption",
        "route_recommendation",
        "transaction_building",
        "signing_data_or_readiness",
        "profit_or_pnl",
        "cost_basis"
      ],
      requiredCannotAnswerClaims: [
        "settlement_token_selection",
        "fiat_usd_cash_out",
        "external_market_price_conversion",
        "usd_peg_assumption",
        "route_recommendation",
        "transaction_building",
        "signing_data_or_readiness",
        "profit_or_pnl",
        "cost_basis"
      ],
      requiredConclusionRuleFields: ["responseSummary.excludedFromConclusion", "unsupportedClaims"]
    },
    responseRules: [
      { fieldPath: "toolAvailability.requiredToolsAvailable", equals: true },
      { fieldPath: "responseSummary.questionKind", equals: "settlement_asset_group_parity" },
      {
        fieldPath: "responseSummary.referenceAssetRole",
        equals: "measurement_reference_not_settlement_choice"
      },
      { fieldPath: "referenceAsset.role", equals: "measurement_reference_not_settlement_choice" },
      { fieldPath: "quantitySemantics.kind", equals: "settlement_asset_group_parity_snapshot" },
      {
        fieldPath: "userAnswerUse.answerFields",
        arrayContains: [
          "responseSummary",
          "responseSummary.min",
          "responseSummary.max",
          "responseSummary.mean",
          "responseSummary.median",
          "responseSummary.referenceAssetRole"
        ]
      },
      {
        fieldPath: "userAnswerUse.answerFields",
        arrayDoesNotContain: [
          "settlementTokenSelection",
          "selectedSettlementAsset",
          "route",
          "transactionBytes",
          "signingReadiness"
        ]
      },
      { fieldPath: "quantitySemantics.settlementTokenSelectionAvailable", equals: false },
      { fieldPath: "quantitySemantics.fiatUsdCashOutAvailable", equals: false },
      { fieldPath: "quantitySemantics.externalMarketLookupAvailable", equals: false },
      { fieldPath: "quantitySemantics.usdPegAssumptionAvailable", equals: false },
      { fieldPath: "quantitySemantics.routeRecommendationAvailable", equals: false },
      { fieldPath: "quantitySemantics.paymentExecutionReadinessAvailable", equals: false },
      { fieldPath: "quantitySemantics.profitAndLossAvailable", equals: false },
      { fieldPath: "quantitySemantics.costBasisAvailable", equals: false },
      {
        fieldPath: "quantitySemantics.notFor",
        arrayContains: [
          "settlement_token_selection",
          "fiat_usd_cash_out",
          "external_market_lookup",
          "usd_peg_assumption",
          "route_recommendation",
          "transaction_building",
          "signing_readiness",
          "profit_or_pnl",
          "cost_basis"
        ]
      },
      {
        fieldPath: "responseSummary.excludedFromConclusion",
        arrayContains: [
          "settlement_token_selection",
          "fiat_usd_cash_out",
          "route_recommendation",
          "transaction_building",
          "signing_readiness",
          "profit_or_pnl",
          "cost_basis"
        ]
      },
      {
        fieldPath: "unsupportedClaims",
        arrayContains: [
          "settlement_token_selection",
          "fiat_usd_cash_out",
          "route_recommendation",
          "transaction_building",
          "signing_readiness",
          "profit_or_pnl",
          "cost_basis"
        ]
      }
    ]
  },
  {
    id: "deepbook_quote_is_price_reference_not_payment",
    description:
      "User asks for a DeepBook quote. The response must carry response-local rules saying quote outputs cannot be used for payment coverage or shortfall conclusions.",
    tool: TOOL_NAMES.readQuoteDeepbookDisplayAmount,
    toolExpectation: {
      requiredAnswerFields: ["quote.quoteOut", "rawQuote.directionalOutput"],
      requiredCannotAnswerClaims: [
        "payment_coverage",
        "payment_shortfall",
        "route_dependent_payment_support",
        "final_min_out",
        "profit_or_pnl",
        "cost_basis"
      ],
      requiredConclusionRuleFields: [
        "quantitySemantics.canUseForPaymentAnswer",
        "quantitySemantics.canUseForShortfallAnswer",
        "quantitySemantics.doNotCombineWithPaymentAnswer",
        "quantitySemantics.requiredPaymentAnswerTool",
        "quantitySemantics.requiredPaymentAnswerField"
      ],
      expectedFollowUpTool: TOOL_NAMES.readPreviewIntentEvidence,
      expectedFollowUpAnswerFields: ["responseSummary"],
      forbiddenAnswerFields: ["responseSummary"]
    },
    responseRules: [
      { fieldPath: "quantitySemantics.canUseForPaymentAnswer", equals: false },
      { fieldPath: "quantitySemantics.canUseForShortfallAnswer", equals: false },
      { fieldPath: "quantitySemantics.doNotCombineWithPaymentAnswer", equals: true },
      {
        fieldPath: "quantitySemantics.requiredPaymentAnswerTool",
        equals: TOOL_NAMES.readPreviewIntentEvidence
      },
      { fieldPath: "quantitySemantics.requiredPaymentAnswerField", equals: "responseSummary" }
    ]
  },
  {
    id: "deepbook_mid_price_not_transaction_or_signing",
    description:
      'User asks "can I trade or sign with this DeepBook mid price?". The mid-price response must expose a pool price snapshot only and explicitly refuse transaction-building and signing conclusions.',
    tool: TOOL_NAMES.readGetDeepbookMidPrice,
    toolExpectation: {
      requiredAnswerFields: ["poolKey", "price", "fetchedAt"],
      requiredCanAnswerClaims: ["deepbook_pool_mid_price_context"],
      requiredCannotAnswerClaims: [
        "transaction_building",
        "signing_data_or_readiness",
        "payment_coverage_or_shortfall",
        "price_impact",
        "route_recommendation",
        "fiat_usd_cash_out",
        "profit_or_pnl"
      ],
      expectedFollowUpTool: TOOL_NAMES.readPreviewIntentEvidence,
      expectedFollowUpAnswerFields: ["responseSummary"],
      forbiddenAnswerFields: ["rawQuote", "transactionBytes", "signingReadiness"]
    },
    responseRules: [
      {
        fieldPath: "priceSemantics.notFor",
        arrayContains: ["transaction_building", "signing_data", "signing_readiness"]
      },
      { fieldPath: "priceSemantics.allowedUse", equals: "deepbook_pool_mid_price_snapshot" }
    ]
  },
  {
    id: "deepbook_inventory_discovery_not_detail_inventory",
    description:
      "User asks what DeepBook inventory the active account has, but the discovery-only response must advertise only manager discovery and missing detail status, not detailed pool inventory.",
    tool: TOOL_NAMES.readSummarizeDeepbookAccountInventory,
    toolExpectation: {
      requiredPreconditionFields: ["detailStatus"],
      requiredAnswerFields: ["account", "detailStatus", "managerAddresses", "requested"],
      requiredCanAnswerClaims: ["active_account_deepbook_balance_manager_discovery"],
      forbiddenCanAnswerClaims: ["deepbook_pool_account_inventory_when_pool_and_manager_are_supplied"],
      requiredCannotAnswerClaims: [
        "deepbook_pool_account_inventory_when_detailStatus_is_not_available",
        "current_wallet_coin_balance",
        "funding_source",
        "transaction_building",
        "signing_data_or_readiness"
      ],
      forbiddenAnswerFields: ["accountSummary", "lockedBalances", "openOrderIds", "openOrderCount"]
    },
    responseRules: [
      { fieldPath: "detailStatus", equals: "manager_discovery_only" },
      {
        fieldPath: "userAnswerUse.diagnosticOnlyFields",
        arrayDoesNotContain: ["openOrderIdsTruncated"]
      }
    ]
  },
  {
    id: "deepbook_swap_review_signing_blocked",
    description:
      'User asks "make me a DeepBook swap review". The prepare response must create a local review session, keep signing data out of MCP output, and direct the client to account-bound review status.',
    tool: TOOL_NAMES.actionStartReview,
    toolExpectation: {
      requiredAnswerFields: ["reviewSessionId", "card", "plans[].preliminaryChecks"],
      requiredCanAnswerClaims: [
        "internal_review_card_for_user_review",
        "preliminary_check_results_for_proposed_plan",
        "proposed_plan_asset_flow_preview"
      ],
      requiredCannotAnswerClaims: [
        "transaction_execution_guarantee",
        "transaction_building",
        "signing_data_or_readiness",
        "wallet_custody_or_authorization",
        "profit_or_pnl"
      ],
      requiredConclusionRuleFields: ["plans[].preliminaryChecks", "preliminaryChecks"],
      expectedFollowUpTool: TOOL_NAMES.sessionGetReviewStatus
    },
    responseRules: [
      { fieldPath: "preliminaryChecks[0].status", equals: "warning" },
      { fieldPath: "preliminaryChecks[0].id", equals: "account_bound_review_required" },
      { fieldPath: "preliminaryChecks[1].status", equals: "warning" },
      { fieldPath: "preliminaryChecks[1].id", equals: "signing_via_local_review_only" }
    ]
  },
  {
    id: "execution_wait_user_action_required_not_final",
    description:
      "User asks the server to wait for an execution result on a blocked session. The wait response must structurally tell a fresh client that wait-stopping does not equal final.",
    tool: TOOL_NAMES.sessionWaitExecutionResult,
    toolExpectation: {
      requiredAnswerFields: ["status", "statusCategory", "pollingHint", "waitOutcome"],
      requiredCanAnswerClaims: [
        "current_local_execution_polling_status",
        "whether_user_action_or_chain_polling_is_still_pending"
      ],
      requiredCannotAnswerClaims: [
        "transaction_execution_guarantee",
        "signing_data_or_readiness",
        "profit_or_pnl"
      ],
      requiredConclusionRuleFields: [
        "statusCategory",
        "pollingHint.finalStatuses",
        "pollingHint.userActionRequiredStatuses"
      ],
      expectedFollowUpTool: TOOL_NAMES.sessionGetReviewStatus
    },
    responseRules: [
      { fieldPath: "waitOutcome", equals: "status_reached" },
      { fieldPath: "status", equals: "blocked" },
      { fieldPath: "statusCategory", equals: "user_action_required" },
      { fieldPath: "statusCategory", notOneOf: ["final"] },
      {
        fieldPath: "pollingHint.userActionRequiredStatuses",
        arrayContains: ["blocked", "refresh_required"]
      },
      {
        fieldPath: "pollingHint.finalStatuses",
        arrayDoesNotContain: ["blocked", "refresh_required"]
      }
    ]
  },
  {
    id: "review_status_ready_not_signing_or_safety",
    description:
      'User asks "is this review ready?" for a ready-for-wallet-review session. The status response must describe local review status and checks without claiming transaction execution, absolute safety, wallet authorization, transaction building, or signing readiness.',
    tool: TOOL_NAMES.sessionGetReviewStatus,
    toolExpectation: {
      requiredAnswerFields: [
        "reviewSessionId",
        "status",
        "pollingStatus",
        "statusCategory",
        "reviewState.status",
        "reviewState.checks"
      ],
      requiredCanAnswerClaims: [
        "current_local_review_session_status",
        "current_review_checks_when_reviewState_is_present",
        "whether_user_action_or_chain_polling_is_still_pending"
      ],
      requiredCannotAnswerClaims: [
        "transaction_execution_guarantee",
        "absolute_safety_verdict",
        "route_quality",
        "wallet_custody_or_authorization",
        "transaction_building",
        "signing_data_or_readiness",
        "complete_wallet_history",
        "profit_or_pnl"
      ],
      forbiddenAnswerFields: ["executionResult"],
      expectedFollowUpTool: TOOL_NAMES.sessionGetExecutionResult,
      expectedFollowUpAnswerFields: ["executionResult"]
    },
    responseRules: [
      { fieldPath: "status", equals: "ready_for_wallet_review" },
      { fieldPath: "pollingStatus", equals: "ready_for_wallet_review" },
      { fieldPath: "statusCategory", equals: "user_action_required" },
      { fieldPath: "statusCategory", notOneOf: ["final"] },
      { fieldPath: "reviewState.status", equals: "ready_for_wallet_review" }
    ]
  },
  {
    id: "execution_result_absent_not_execution_proof",
    description:
      'User asks "did it execute?" before any execution result exists. The execution polling response must expose local polling status and say that recorded execution result detail is unavailable, without turning awaiting-signature status into execution proof or signing readiness.',
    tool: TOOL_NAMES.sessionGetExecutionResult,
    toolExpectation: {
      requiredAnswerFields: ["reviewSessionId", "status", "statusCategory", "pollingHint"],
      requiredCanAnswerClaims: [
        "current_local_execution_polling_status",
        "whether_user_action_or_chain_polling_is_still_pending"
      ],
      requiredCannotAnswerClaims: [
        "recorded_review_execution_result_without_executionResult_field",
        "transaction_execution_guarantee",
        "absolute_safety_verdict",
        "route_quality",
        "wallet_custody_or_authorization",
        "transaction_building",
        "signing_data_or_readiness",
        "complete_wallet_history",
        "profit_or_pnl"
      ],
      requiredConclusionRuleFields: [
        "statusCategory",
        "pollingHint.finalStatuses",
        "pollingHint.userActionRequiredStatuses",
        "pollingHint.nonTerminalStatuses"
      ],
      forbiddenAnswerFields: ["executionResult"],
      expectedFollowUpTool: TOOL_NAMES.sessionGetReviewStatus,
      expectedFollowUpAnswerFields: ["pollingStatus", "statusCategory", "reviewState"]
    },
    responseRules: [
      { fieldPath: "status", equals: "ready_for_wallet_review" },
      { fieldPath: "statusCategory", equals: "user_action_required" },
      { fieldPath: "statusCategory", notOneOf: ["final"] },
      { fieldPath: "pollingHint.nonTerminalStatuses", arrayContains: ["awaiting_signature"] },
      {
        fieldPath: "pollingHint.finalStatuses",
        arrayDoesNotContain: ["awaiting_signature", "blocked", "refresh_required"]
      },
      {
        fieldPath: "pollingHint.userActionRequiredStatuses",
        arrayDoesNotContain: ["awaiting_signature"]
      }
    ]
  },
  {
    id: "recent_activity_summary_with_no_details",
    description:
      "User asks for a recent activity summary. When no transaction-level details are available, the response must omit transactions[].transactionContext from answerFields and mark transactionDetailAvailability as a conclusion rule.",
    tool: TOOL_NAMES.readSummarizeSuiActivityScan,
    toolExpectation: {
      requiredAnswerFields: ["requestedAccountTransactionFacts", "transactionDetailAvailability"],
      requiredCannotAnswerClaims: [
        "complete_wallet_history",
        "transaction_context_for_all_returned_rows_without_all_details",
        "display_token_amounts_without_verified_decimals",
        "fiat_usd_cash_out",
        "profit_or_pnl"
      ],
      requiredConclusionRuleFields: ["transactionDetailAvailability"],
      forbiddenAnswerFields: ["transactions[].transactionContext"]
    },
    responseRules: [
      { fieldPath: "transactionDetailAvailability.allReturnedTransactionsHaveDetails", equals: false },
      { fieldPath: "transactionDetailAvailability.detailAvailability", oneOf: ["none", "some"] },
      {
        fieldPath: "requestedAccountTransactionFacts[0].accountBalanceChangeInferencePolicy",
        equals: "do_not_infer_from_transaction_context"
      },
      {
        fieldPath: "requestedAccountTransactionFacts[0].accountBalanceChangeEvidence",
        oneOf: ["account_balance_changes_returned", "incomplete_account_balance_changes", "account_balance_changes_unavailable"]
      }
    ]
  },
  {
    id: "wallet_balance_refuses_profit_calculation",
    description:
      'User asks "calculate my P&L". The wallet balance read response must explicitly refuse P&L, cost-basis, and USD settlement-total claims and never advertise a P&L answer field.',
    tool: TOOL_NAMES.readSummarizeWalletAssets,
    toolExpectation: {
      requiredCannotAnswerClaims: [
        "profit_or_pnl",
        "cost_basis",
        "payment_coverage_or_shortfall",
        "usd_denominated_settlement_asset_balance_total",
        "fiat_usd_cash_out",
        "transaction_history"
      ],
      forbiddenAnswerFields: ["profit", "pnl", "costBasis", "responseSummary"],
      expectedFollowUpTool: TOOL_NAMES.readPreviewIntentEvidence
    }
  },
] as const;
