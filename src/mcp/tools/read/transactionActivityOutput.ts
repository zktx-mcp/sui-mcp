import type { ExternalActivityTransactionRecord } from "../../../core/activity/activityStore.js";
import {
  compactExternalActivityTransactionDetails,
  type ExternalActivityTransactionCompactFacts
} from "../../../core/activity/transactionActivityDetails.js";
import type {
  SummarizeSuiAccountActivityResult,
  SuiTransactionAccountEffects,
  SuiTransactionActivityFact
} from "../../../core/activity/transactionActivityTypes.js";
import type { UserAnswerUse } from "../../../core/evidence/userAnswerUse.js";
import { TOOL_NAMES } from "../../toolNames.js";

export const SUI_ACTIVITY_QUANTITY_SEMANTICS = {
  kind: "sui_activity_raw_amounts",
  rawAmountsOnly: true,
  displayConversionRequires: "verified_coin_metadata_decimals",
  gasRawUnit: "MIST",
  gasUnitSource: "@mysten/sui MIST_PER_SUI",
  gasDisplayFields: [
    "transaction.compact.gasCost.display",
    "requestedAccountTransactionFacts[].transactionContext.gasCost.display",
    "transactions[].transactionContext.gasCost.display",
    "analysis.gas.netGasCost.display"
  ],
  rawAmountFields: [
    "transaction.details.balanceChanges[].amountRaw",
    "transaction.requestedAccountEffect.balanceChanges[].amountRaw",
    "transaction.requestedAccountEffect.coinFlows[].*Raw",
    "requestedAccount.coinFlows[].*Raw",
    "requestedAccountTransactionFacts[].accountBalanceChanges[].amountRaw",
    "requestedAccountTransactionFacts[].accountCoinFlows[].*Raw",
    "requestedAccountTransactionFacts[].requestedAccountEffect.balanceChanges[].amountRaw",
    "requestedAccountTransactionFacts[].requestedAccountEffect.coinFlows[].*Raw",
    "transactions[].requestedAccountEffect.balanceChanges[].amountRaw",
    "transactions[].requestedAccountEffect.coinFlows[].*Raw",
    "transactions[].details.balanceChanges[].amountRaw",
    "transactions[].compact.balanceChanges[].amountRaw",
    "accountCoinFlows.rows[].*Raw",
    "analysis.coinFlows[].*Raw"
  ],
  notFor: [
    "display_conversion_without_verified_decimals",
    "fiat_usd_cash_out",
    "profit_or_pnl",
    "position_valuation"
  ]
} as const;

export function suiActivityQuantitySemantics(scope: "inspect" | "stored" | "scan" | "analysis") {
  function exposed(field: string) {
    if (scope === "inspect") return field.startsWith("transaction.");
    if (scope === "stored") return field.startsWith("accountCoinFlows.") ||
      field.startsWith("transactions[].details") || field.startsWith("transactions[].compact") || field.startsWith("analysis.gas.");
    return !field.startsWith("transaction.") && !field.startsWith("accountCoinFlows.") &&
      !field.startsWith("transactions[].details") && !field.startsWith("transactions[].compact") &&
      (!field.startsWith("analysis.") || scope === "analysis");
  }
  return { ...SUI_ACTIVITY_QUANTITY_SEMANTICS,
    rawAmountFields: SUI_ACTIVITY_QUANTITY_SEMANTICS.rawAmountFields.filter(exposed),
    gasDisplayFields: SUI_ACTIVITY_QUANTITY_SEMANTICS.gasDisplayFields.filter(exposed) };
}
export type SuiActivityQuantitySemantics = ReturnType<typeof suiActivityQuantitySemantics>;

export const ACCOUNT_ASSET_TIMELINE_QUANTITY_SEMANTICS = {
  kind: "sui_account_asset_timeline_raw_net_flows",
  rawAmountsOnly: true,
  netFlowFields: [
    "netFlowBars[].increaseRaw",
    "netFlowBars[].decreaseRaw",
    "netFlowBars[].netRaw"
  ],
  balanceBarsAvailable: false,
  balanceStatusField: "balanceStatus",
  balanceBarRule: "balanceBars are unavailable unless a stored balance anchor exists",
  notFor: [
    "held_balance_without_balance_anchor",
    "complete_wallet_history",
    "display_conversion_without_verified_decimals",
    "fiat_usd_cash_out",
    "usd_peg_assumption",
    "profit_or_pnl",
    "cost_basis",
    "route_recommendation",
    "transaction_building",
    "signing_data_or_readiness"
  ]
} as const;

export type AccountAssetTimelineQuantitySemantics = typeof ACCOUNT_ASSET_TIMELINE_QUANTITY_SEMANTICS;

export function accountAssetTimelineQuantitySemantics(): AccountAssetTimelineQuantitySemantics {
  return ACCOUNT_ASSET_TIMELINE_QUANTITY_SEMANTICS;
}

export type TransactionDetailAvailabilityStatus = "none" | "some" | "all";

export type TransactionDetailAvailability = {
  totalTransactions: number;
  withDetails: number;
  withoutDetails: number;
  detailAvailability: TransactionDetailAvailabilityStatus;
  allReturnedTransactionsHaveDetails: boolean;
};

export function transactionDetailAvailability(
  transactions: readonly { details?: unknown | undefined }[]
): TransactionDetailAvailability {
  const totalTransactions = transactions.length;
  const withDetails = transactions.filter((transaction) => transaction.details !== undefined).length;
  const withoutDetails = totalTransactions - withDetails;
  const detailAvailability: TransactionDetailAvailabilityStatus =
    withDetails === 0 ? "none" : withoutDetails === 0 ? "all" : "some";
  return {
    totalTransactions,
    withDetails,
    withoutDetails,
    detailAvailability,
    allReturnedTransactionsHaveDetails: detailAvailability === "all"
  };
}

function normalizeDetailAvailability(
  input: TransactionDetailAvailability | TransactionDetailAvailabilityStatus
): TransactionDetailAvailability {
  if (typeof input !== "string") {
    return input;
  }
  return {
    totalTransactions: input === "some" ? 2 : input === "none" ? 0 : 1,
    withDetails: input === "none" ? 0 : 1,
    withoutDetails: input === "some" ? 1 : 0,
    detailAvailability: input,
    allReturnedTransactionsHaveDetails: input === "all"
  };
}

export function inspectSuiTransactionUserAnswerUse(
  fields: {
    hasSender?: boolean;
    hasRequestedAccountEffect?: boolean;
    hasDetails?: boolean;
  } = {}
): UserAnswerUse {
  const hasSender = fields.hasSender ?? true;
  const hasRequestedAccountEffect = fields.hasRequestedAccountEffect ?? true;
  const hasDetails = fields.hasDetails ?? true;

  return {
    canAnswer: [
      "one_sui_transaction_digest_status_and_context",
      ...(hasRequestedAccountEffect ? ["requested_account_balance_effect_for_this_digest"] : []),
      ...(hasDetails ? ["transaction_level_move_call_object_event_gas_and_protocol_label_facts"] : [])
    ],
    cannotAnswer: [
      "complete_wallet_history",
      ...(hasRequestedAccountEffect ? [] : ["requested_account_balance_effect_without_requestedAccountEffect_field"]),
      ...(hasDetails ? [] : ["transaction_level_move_call_object_event_gas_and_protocol_label_facts_without_details_field"]),
      "display_token_amounts_without_verified_decimals",
      "fiat_usd_cash_out",
      "profit_or_pnl",
      "position_valuation",
      "route_recommendation",
      "transaction_building",
      "signing_data_or_readiness"
    ],
    answerFields: [
      "transaction.digest",
      "transaction.status",
      ...(hasSender ? ["transaction.sender"] : []),
      ...(hasRequestedAccountEffect ? ["transaction.requestedAccountEffect"] : []),
      ...(hasDetails ? ["transaction.compact", "transaction.details"] : []),
      "fetchedAt"
    ],
    diagnosticOnlyFields: ["source", "quantitySemantics", "persistence"]
  };
}

export function liveSuiActivityUserAnswerUse(
  input:
    | boolean
    | {
        includeAnalysis: boolean;
        transactionDetailAvailability?: TransactionDetailAvailability | TransactionDetailAvailabilityStatus;
      }
): UserAnswerUse {
  const includeAnalysis = typeof input === "boolean" ? input : input.includeAnalysis;
  const detailAvailability = normalizeDetailAvailability(
    typeof input === "boolean" ? "all" : input.transactionDetailAvailability ?? "all"
  );
  const allTransactionsHaveContext = detailAvailability.allReturnedTransactionsHaveDetails;
  const someTransactionsHaveContext = detailAvailability.withDetails > 0;

  return {
    canAnswer: [
      "bounded_requested_account_activity_page",
      "requested_account_raw_coin_flows_in_returned_rows",
      "transaction_detail_availability_for_returned_rows",
      ...(allTransactionsHaveContext ? ["transaction_context_for_all_returned_rows"] : []),
      ...(!allTransactionsHaveContext && someTransactionsHaveContext
        ? ["transaction_context_for_some_returned_rows"]
        : []),
      ...(includeAnalysis ? ["deterministic_summary_over_returned_normalized_rows"] : [])
    ],
    cannotAnswer: [
      "complete_wallet_history",
      "complete_dapp_history",
      ...(allTransactionsHaveContext ? [] : ["transaction_context_for_all_returned_rows_without_all_details"]),
      "display_token_amounts_without_verified_decimals",
      "fiat_usd_cash_out",
      "profit_or_pnl",
      "position_valuation",
      "route_recommendation",
      "transaction_building",
      "signing_data_or_readiness"
    ],
    answerFields: [
      "requestedAccount",
      "requestedAccountTransactionFacts",
      "requestedAccountTransactionFacts[].requestedAccountEffect",
      "requestedAccountTransactionFacts[].accountCoinFlows",
      "transactionDetailAvailability",
      ...(allTransactionsHaveContext ? ["transactions[].transactionContext"] : []),
      ...(includeAnalysis ? ["analysis"] : []),
      "fetchedAt"
    ],
    conclusionRuleFields: ["transactionDetailAvailability"],
    diagnosticOnlyFields: [
      "source",
      "quantitySemantics",
      "persistence",
      "hasMore",
      "continuationCursor",
      "windowComplete",
      "orderingVerified",
      "incompleteReason"
    ],
    followUp: {
      tool: TOOL_NAMES.readInspectSuiTransaction,
      inputFields: ["transactions[].detailLookup.digest"],
      answerFields: ["transaction"],
      reason: "Use when the user asks for full normalized details for a returned digest; scan rows intentionally omit full details."
    }
  };
}

export function storedSuiActivityUserAnswerUse(
  input: TransactionDetailAvailability | TransactionDetailAvailabilityStatus,
  flows: Pick<SummarizeSuiAccountActivityResult["accountCoinFlows"], "completeTransactions" | "incompleteTransactions" | "rowsTruncated">
): UserAnswerUse {
  const detailAvailability = normalizeDetailAvailability(input);
  const allTransactionsHaveDetails = detailAvailability.allReturnedTransactionsHaveDetails;
  const someTransactionsHaveDetails = detailAvailability.withDetails > 0;

  return {
    canAnswer: [
      "stored_local_normalized_activity_summary_for_the_selected_account",
      ...(flows.completeTransactions > 0 ? ["account_flows_from_complete_returned_stored_transactions"] : []),
      "deterministic_summary_over_stored_normalized_rows",
      "stored_transaction_detail_availability_for_returned_rows",
      ...(allTransactionsHaveDetails ? ["stored_transaction_context_for_all_returned_rows"] : []),
      ...(!allTransactionsHaveDetails && someTransactionsHaveDetails
        ? ["stored_transaction_context_for_some_returned_rows"]
        : [])
    ],
    cannotAnswer: [
      "live_latest_activity",
      "complete_wallet_history",
      "complete_dapp_history",
      ...(flows.rowsTruncated ? ["complete_asset_list_or_zero_flow_for_an_unlisted_asset"] : []),
      ...(flows.incompleteTransactions > 0 ? ["account_amounts_for_transactions_with_incomplete_balances"] : []),
      ...(allTransactionsHaveDetails ? [] : ["stored_transaction_context_for_all_returned_rows_without_all_details"]),
      "display_token_amounts_without_verified_decimals",
      "fiat_usd_cash_out",
      "profit_or_pnl",
      "position_valuation",
      "route_recommendation",
      "transaction_building",
      "signing_data_or_readiness"
    ],
    answerFields: [
      "summary", "accountCoinFlows", "accountCoinFlows.rows", "accountCoinFlows.rowsTruncated", "accountCoinFlows.completeTransactions", "accountCoinFlows.incompleteTransactions",
      "analysis",
      "transactions",
      "transactionDetailAvailability",
      ...(allTransactionsHaveDetails ? ["transactions[].compact", "transactions[].details"] : [])
    ],
    conclusionRuleFields: ["transactionDetailAvailability", "accountCoinFlows.completeTransactions",
      "accountCoinFlows.incompleteTransactions", "accountCoinFlows.rowsTruncated"],
    diagnosticOnlyFields: [
      "dataScope",
      "accountSource",
      "lowSampleWarning",
      "lowSampleThreshold",
      "truncated",
      "source",
      "quantitySemantics"
    ],
    followUp: {
      tool: TOOL_NAMES.readSummarizeSuiActivityScan,
      inputFields: ["dataScope.account"],
      answerFields: ["requestedAccountTransactionFacts", "analysis"],
      reason: "Use for recent live requested-account activity; stored summaries are local facts only."
    }
  };
}

export function accountAssetTimelineUserAnswerUse(input: {
  hasNetFlowBars: boolean;
  hasUsdcReferenceCandles: boolean;
  scanNeeded: boolean;
  accountKnown: boolean;
}): UserAnswerUse {
  return {
    canAnswer: [
      "scan_coverage_status_for_requested_utc_range",
      "balance_anchor_availability",
      ...(input.hasNetFlowBars ? ["stored_account_asset_net_flow_timeline_for_selected_account"] : []),
      ...(input.hasUsdcReferenceCandles ? ["deepbook_usdc_token_denominated_reference_candles_for_supported_assets"] : [])
    ],
    cannotAnswer: [
      "live_latest_activity",
      "complete_wallet_history",
      "held_balances_without_balanceBars",
      "wallet_total_value",
      "fiat_usd_cash_out",
      "usd_peg_assumption",
      "profit_or_pnl",
      "cost_basis",
      "route_recommendation",
      "best_route",
      "transaction_building",
      "signing_data_or_readiness"
    ],
    answerFields: [
      "coverage",
      "status",
      "balanceStatus",
      "balanceBars",
      "quantitySemantics",
      ...(input.hasNetFlowBars ? ["netFlowBars"] : []),
      ...(input.hasUsdcReferenceCandles ? ["usdcReferences"] : [])
    ],
    conclusionRuleFields: ["coverage.coverageStatus", "balanceStatus", "limitations"],
    diagnosticOnlyFields: ["source", "sourceTransactions"],
    ...(input.scanNeeded && input.accountKnown
      ? {
          followUp: {
            tool: TOOL_NAMES.readScanSuiAccountActivity,
            inputFields: ["account", "requestedRange.from", "requestedRange.to"],
            answerFields: ["requestedAccountTransactionFacts", "persistence.scan"],
            reason: "Run a user-requested bounded account activity scan before using this timeline as activity evidence."
          }
        }
      : {})
  };
}

export type SuiTransactionActivityFactOutput = Omit<SuiTransactionActivityFact, "accountEffects"> & {
  requestedAccountEffect?: SuiTransactionAccountEffects | undefined;
  compact?: ExternalActivityTransactionCompactFacts | undefined;
};

export type SuiTransactionActivityAuditOutput = Omit<SuiTransactionActivityFact, "details" | "accountEffects"> & {
  requestedAccountEffect?: SuiTransactionAccountEffects | undefined;
  transactionContext?: Omit<ExternalActivityTransactionCompactFacts, "balanceChanges"> | undefined;
  detailLookup: {
    tool: typeof TOOL_NAMES.readInspectSuiTransaction;
    digest: string;
  };
};

export type ExternalActivityTransactionRecordOutput = ExternalActivityTransactionRecord & {
  compact?: ExternalActivityTransactionCompactFacts | undefined;
  detailLookup: {
    tool: typeof TOOL_NAMES.readInspectSuiTransaction;
    digest: string;
  };
};

export type RequestedAccountTransactionFactOutput = Pick<
  SuiTransactionActivityFact,
  "digest" | "checkpoint" | "timestamp" | "status" | "sender"
> & {
  requestedAccount: string;
  accountScope: "requested_account";
  accountRole: SuiTransactionAccountEffects["role"];
  sentByAccount: boolean;
  accountBalanceChangeEvidence: SuiTransactionAccountEffects["balanceChangeEvidence"];
  accountBalanceChangeInferencePolicy: SuiTransactionAccountEffects["accountBalanceChangeInferencePolicy"];
  accountBalanceChangeCompleteness: SuiTransactionAccountEffects["balanceChangeCompleteness"];
  accountBalanceChanges: SuiTransactionAccountEffects["balanceChanges"];
  accountCoinFlows: SuiTransactionAccountEffects["coinFlows"];
  accountEffectLimitations: SuiTransactionAccountEffects["limitations"];
  requestedAccountEffect: SuiTransactionAccountEffects;
  transactionContext?: Omit<ExternalActivityTransactionCompactFacts, "balanceChanges"> | undefined;
  detailLookup: {
    tool: typeof TOOL_NAMES.readInspectSuiTransaction;
    digest: string;
  };
};

export function transactionFactOutput(transaction: SuiTransactionActivityFact): SuiTransactionActivityFactOutput {
  const { accountEffects } = transaction;
  return {
    digest: transaction.digest,
    ...(transaction.checkpoint === undefined ? {} : { checkpoint: transaction.checkpoint }),
    ...(transaction.timestamp === undefined ? {} : { timestamp: transaction.timestamp }),
    status: transaction.status,
    ...(transaction.sender === undefined ? {} : { sender: transaction.sender }),
    ...(accountEffects === undefined ? {} : { requestedAccountEffect: accountEffects }),
    ...(transaction.details === undefined
      ? {}
      : { compact: (transaction.compact ?? compactExternalActivityTransactionDetails(transaction.details, transaction.status)) }),
    ...(transaction.details === undefined ? {} : { details: transaction.details })
  };
}

export function transactionFactAuditOutput(transaction: SuiTransactionActivityFact): SuiTransactionActivityAuditOutput {
  const { accountEffects } = transaction;
  return {
    digest: transaction.digest,
    ...(transaction.checkpoint === undefined ? {} : { checkpoint: transaction.checkpoint }),
    ...(transaction.timestamp === undefined ? {} : { timestamp: transaction.timestamp }),
    status: transaction.status,
    ...(transaction.sender === undefined ? {} : { sender: transaction.sender }),
    ...(accountEffects === undefined ? {} : { requestedAccountEffect: accountEffects }),
    ...(transaction.details === undefined
      ? {}
      : { transactionContext: transactionContextOutput((transaction.compact ?? compactExternalActivityTransactionDetails(transaction.details, transaction.status))) }),
    detailLookup: {
      tool: TOOL_NAMES.readInspectSuiTransaction,
      digest: transaction.digest
    }
  };
}

export function requestedAccountTransactionFactOutput(
  transaction: SuiTransactionActivityFact
): RequestedAccountTransactionFactOutput | undefined {
  if (transaction.accountEffects === undefined) {
    return undefined;
  }

  const compact = transaction.details === undefined
    ? undefined
    : (transaction.compact ?? compactExternalActivityTransactionDetails(transaction.details, transaction.status));
  const transactionContext = compact === undefined
    ? undefined
    : transactionContextOutput(compact);

  return {
    digest: transaction.digest,
    ...(transaction.checkpoint === undefined ? {} : { checkpoint: transaction.checkpoint }),
    ...(transaction.timestamp === undefined ? {} : { timestamp: transaction.timestamp }),
    status: transaction.status,
    ...(transaction.sender === undefined ? {} : { sender: transaction.sender }),
    requestedAccount: transaction.accountEffects.account,
    accountScope: transaction.accountEffects.scope,
    accountRole: transaction.accountEffects.role,
    sentByAccount: transaction.accountEffects.sentByAccount,
    accountBalanceChangeEvidence: transaction.accountEffects.balanceChangeEvidence,
    accountBalanceChangeInferencePolicy: transaction.accountEffects.accountBalanceChangeInferencePolicy,
    accountBalanceChangeCompleteness: transaction.accountEffects.balanceChangeCompleteness,
    accountBalanceChanges: transaction.accountEffects.balanceChanges,
    accountCoinFlows: transaction.accountEffects.coinFlows,
    accountEffectLimitations: transaction.accountEffects.limitations,
    requestedAccountEffect: transaction.accountEffects,
    ...(transactionContext === undefined ? {} : { transactionContext }),
    detailLookup: {
      tool: TOOL_NAMES.readInspectSuiTransaction,
      digest: transaction.digest
    }
  };
}

function transactionContextOutput(
  compact: ExternalActivityTransactionCompactFacts
): Omit<ExternalActivityTransactionCompactFacts, "balanceChanges"> {
  return {
    balanceChangeScope: compact.balanceChangeScope,
    factScope: compact.factScope,
    requestedAccountScoped: compact.requestedAccountScoped,
    moveCallTargets: compact.moveCallTargets,
    objectChangeCounts: compact.objectChangeCounts,
    eventTypes: compact.eventTypes,
    ...(compact.gasCost === undefined ? {} : { gasCost: compact.gasCost }),
    ...(compact.gasNetCostRaw === undefined ? {} : { gasNetCostRaw: compact.gasNetCostRaw }),
    ...(compact.executionError === undefined ? {} : { executionError: compact.executionError }),
    detailTruncated: compact.detailTruncated,
    ...(compact.protocolMatches === undefined ? {} : { protocolMatches: compact.protocolMatches })
  };
}

export function externalActivityTransactionRecordOutput(
  transaction: ExternalActivityTransactionRecord
): ExternalActivityTransactionRecordOutput {
  return {
    ...transaction,
    ...(transaction.details === undefined
      ? {}
      : { compact: (transaction.compact ?? compactExternalActivityTransactionDetails(transaction.details, transaction.status)) }),
    detailLookup: {
      tool: TOOL_NAMES.readInspectSuiTransaction,
      digest: transaction.digest
    }
  };
}
