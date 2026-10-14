import type { SuiClientTypes } from "@mysten/sui/client";
import type {
  AccountBalances,
  AccountInfo,
  BalanceManager,
  Coin,
  Level2TicksFromMid,
  LockedBalances,
  PoolBookParams
} from "@mysten/deepbook-v3";
import {
  DEEPBOOK_SCALAR_UNIT_SOURCE,
  type CoinMetadataCache,
  type WalletBalanceWithUnit
} from "./coinMetadata.js";
import type {
  DeepbookOfficialIndexerCandle,
  DeepbookOfficialIndexerInterval,
  DeepbookOfficialIndexerSourceClient
} from "./deepbookOfficialIndexerSource.js";
import type {
  DEEPBOOK_OFFICIAL_INDEXER_CANDLE_USE,
  DEEPBOOK_OFFICIAL_INDEXER_RESPONSE_TEXT,
  DEEPBOOK_OFFICIAL_INDEXER_SOURCE_BASE,
  DEEPBOOK_PINNED_SDK_METADATA_SOURCE,
  DEEPBOOK_SDK_SIMULATION_SOURCE_BASE,
  DEEPBOOK_SOURCE_FIELD_VALUES
} from "./deepbookSourceOwners.js";
import type { UserAnswerUse } from "../evidence/userAnswerUse.js";

export type QuoteDirection = "base_to_quote" | "quote_to_base";
export const MAX_DEEPBOOK_ORDERBOOK_TICKS = 50;
export const MAX_DEEPBOOK_ACCOUNT_OPEN_ORDER_IDS = 100;
export const DEEPBOOK_MID_PRICE_TYPE = "deepbook_mid_price";
export const DEEPBOOK_MID_PRICE_DIRECTION = "quote_per_base";
export const DEEPBOOK_MID_PRICE_PRECISION = "deepbook_v3_to_fixed_9_js_number";
export const DEEPBOOK_MID_PRICE_SEMANTICS_KIND = "deepbook_mid_price_snapshot";
export const WALLET_BALANCE_QUANTITY_KIND = "sui_wallet_balance_snapshot";
export const DEEPBOOK_ACCOUNT_QUANTITY_KIND = "deepbook_display_number";
export const DEEPBOOK_QUOTE_QUANTITY_KIND = "deepbook_quote_display_amount";
export const DEEPBOOK_RAW_QUOTE_QUANTITY_KIND = "deepbook_quote_raw_u64";
export const DEEPBOOK_USDC_PRICE_HISTORY_QUANTITY_KIND = "deepbook_official_indexer_candles";
export const INTENT_EVIDENCE_QUANTITY_KIND = "sui_intent_evidence_report";
export const SETTLEMENT_ASSET_GROUP_PARITY_QUANTITY_KIND = "settlement_asset_group_parity_snapshot";
export const SUI_USD_SETTLEMENT_ASSET_GROUP_ID = "SUI_USD_SETTLEMENT_ASSETS";
export const MAX_WALLET_BALANCE_SCAN_PAGES = 20;
export const MAX_DEEPBOOK_USDC_PRICE_HISTORY_BARS = 1_008;
export const DEEPBOOK_USDC_PRICE_HISTORY_UNSUPPORTED_CLAIMS = [
  "fiat_usd_cash_out",
  "usd_peg_assumption",
  "global_market_price",
  "historical_mid_price",
  "live_quote",
  "route_recommendation",
  "best_route",
  "transaction_building",
  "signing_readiness",
  "profit_or_pnl",
  "cost_basis",
  "independent_chain_recomputation"
] as const;
export const DEEPBOOK_USDC_CANDLE_AVAILABILITY = [
  "available",
  "no_candles_in_range"
] as const;
export const DEEPBOOK_USDC_PRICE_HISTORY_UNSUPPORTED_PAIR_REASONS = [
  "selector_not_in_official_indexer",
  "selector_resolves_to_multiple_usdc_pools"
] as const;
export const DEEPBOOK_USDC_PRICE_HISTORY_SOURCE_UNAVAILABLE_REASONS = [
  "official_indexer_not_configured",
  "pool_list_unavailable",
  "candle_fetch_failed",
  "official_indexer_invalid_payload"
] as const;
// Internal placeholder for sender-independent DeepBook market reads. The pinned Sui gRPC
// resolver uses the same dummy sender when no transaction sender is provided.
export const DEFAULT_DEEPBOOK_SIMULATION_SENDER =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

export type WalletBalanceInput = {
  account: string;
  cursor?: string | null | undefined;
};

export type WalletBalanceSummary = {
  status: "ok";
  account: string;
  fetchedAt: string;
  userAnswerUse: UserAnswerUse;
  quantitySemantics: WalletBalanceQuantitySemantics;
  source: {
    sdk: "@mysten/sui";
    transport: "grpc";
    method: "client.core.listBalances";
  };
  balances: WalletBalanceWithUnit[];
  hasNextPage: boolean;
  cursor: string | null;
};

export type WalletBalanceQuantitySemantics = {
  kind: typeof WALLET_BALANCE_QUANTITY_KIND;
  allowedUse: "current_coin_balance_snapshot";
  currentBalanceSnapshot: true;
  transactionHistoryAvailable: false;
  transactionReceiptProofAvailable: false;
  transactionBalanceDeltaAvailable: false;
  acquisitionSourceAvailable: false;
  objectProvenanceAvailable: false;
  fiatUsdCashOutAvailable: false;
  profitAndLossAvailable: false;
  costBasisAvailable: false;
  notFor: [
    "transaction_history",
    "transaction_receipt_proof",
    "specific_transaction_balance_delta",
    "acquisition_source",
    "object_provenance",
    "fiat_usd_cash_out",
    "profit_or_pnl",
    "cost_basis",
    "signing_data"
  ];
};

export type WalletAssetClassificationRole = "gas_candidate" | "deepbook_registered";
export type WalletAssetBalanceStatus = "nonzero" | "zero";

export type ClassifiedWalletAsset = {
  balance: WalletBalanceWithUnit;
  classification: {
    assetClass: "coin_balance";
    balanceStatus: WalletAssetBalanceStatus;
    roles: WalletAssetClassificationRole[];
  };
};

export type UninspectedAssetClass =
  | {
      assetClass: "staked_or_locked_asset";
      reason: "requires_separate_stake_read_not_inspected";
    }
  | {
      assetClass: "deepbook_balance_manager_or_open_order";
      reason: "requires_separate_deepbook_account_read_not_inspected";
    }
  | {
      assetClass: "lp_vault_or_position";
      reason: "requires_separate_protocol_read_not_inspected";
    }
  | {
      assetClass: "nft_or_object_asset";
      reason: "requires_separate_object_read_not_inspected";
    };

export const NOT_INSPECTED_ASSET_CLASSES = [
  {
    assetClass: "staked_or_locked_asset",
    reason: "requires_separate_stake_read_not_inspected"
  },
  {
    assetClass: "deepbook_balance_manager_or_open_order",
    reason: "requires_separate_deepbook_account_read_not_inspected"
  },
  {
    assetClass: "lp_vault_or_position",
    reason: "requires_separate_protocol_read_not_inspected"
  },
  {
    assetClass: "nft_or_object_asset",
    reason: "requires_separate_object_read_not_inspected"
  }
] as const satisfies readonly UninspectedAssetClass[];

export type WalletAssetClassificationSummary = {
  status: "ok";
  account: string;
  fetchedAt: string;
  userAnswerUse: UserAnswerUse;
  quantitySemantics: WalletBalanceQuantitySemantics;
  source: WalletBalanceSummary["source"];
  classifiedAssets: ClassifiedWalletAsset[];
  uninspectedAssetClasses: UninspectedAssetClass[];
  hasNextPage: boolean;
  cursor: string | null;
};

export type SettlementAssetGroupId = typeof SUI_USD_SETTLEMENT_ASSET_GROUP_ID;
export type SettlementAssetGroupAlias =
  | "dollar"
  | "dollars"
  | "usd"
  | "usd-like"
  | "stablecoin"
  | "stablecoins";

export type SettlementAssetGroupAsset = {
  symbol: string;
  coinType: string;
  decimals: number;
  unitSource: typeof DEEPBOOK_SCALAR_UNIT_SOURCE;
  poolKeys: string[];
};

export type SettlementAssetGroupExcludedAsset = {
  symbol: string;
  coinType: string;
  reason:
    | "protocol_fee_asset"
    | "gas_or_volatile_asset"
    | "volatile_or_non_usd_asset"
    | "not_in_usd_settlement_asset_group";
};

export type SettlementAssetGroup = {
  id: SettlementAssetGroupId;
  label: "Sui USD-denominated settlement assets";
  aliases: SettlementAssetGroupAlias[];
  includedAssets: SettlementAssetGroupAsset[];
  excludedAssets: SettlementAssetGroupExcludedAsset[];
  evidenceSources: {
    sdk: typeof DEEPBOOK_PINNED_SDK_METADATA_SOURCE.sdk;
    registry: typeof DEEPBOOK_PINNED_SDK_METADATA_SOURCE.registry;
    network: typeof DEEPBOOK_PINNED_SDK_METADATA_SOURCE.network;
    unitSource: typeof DEEPBOOK_PINNED_SDK_METADATA_SOURCE.unitSource;
  };
  limitations: [
    "static_pinned_sdk_registry_not_live_liquidity",
    "not_fiat_usd_cash_out",
    "not_payment_execution",
    "not_route_recommendation",
    "not_signing_readiness"
  ];
};

export type SettlementAssetGroupListSummary = {
  status: "ok";
  fetchedAt: string;
  assetGroups: SettlementAssetGroup[];
};

export type SettlementAssetGroupParityInput = {
  denomination: string;
  referenceAssetSymbol?: string | undefined;
};

export type SettlementAssetGroupParityQuantitySemantics = {
  kind: typeof SETTLEMENT_ASSET_GROUP_PARITY_QUANTITY_KIND;
  allowedUse: "settlement_asset_group_internal_parity_evidence";
  referenceAssetRole: "measurement_reference_not_settlement_choice";
  priceSource: "deepbook_mid_price_snapshot";
  fiatUsdCashOutAvailable: false;
  externalMarketPriceConversionAvailable: false;
  externalMarketLookupAvailable: false;
  usdPegAssumptionAvailable: false;
  settlementTokenSelectionAvailable: false;
  paymentExecutionReadinessAvailable: false;
  routeRecommendationAvailable: false;
  profitAndLossAvailable: false;
  costBasisAvailable: false;
  notFor: [
    "settlement_token_selection",
    "fiat_usd_cash_out",
    "external_market_price_conversion",
    "external_market_lookup",
    "usd_peg_assumption",
    "bank_cash_out_estimate",
    "payment_execution_readiness",
    "route_recommendation",
    "best_route",
    "transaction_building",
    "signing_readiness",
    "profit_or_pnl",
    "cost_basis"
  ];
};

export type SettlementAssetGroupParityAsset =
  | (SettlementAssetGroupAsset & {
      status: "reference_asset";
      priceInReferenceAsset: number;
      parityDirection: "reference_asset_per_group_asset";
      reason: "reference_asset_is_measurement_baseline_not_settlement_choice";
    })
  | (SettlementAssetGroupAsset & {
      status: "measured";
      priceInReferenceAsset: number;
      parityDirection: "reference_asset_per_group_asset";
      poolKey: string;
      direction: QuoteDirection;
      poolMidPrice: number;
      poolMidPriceDirection: typeof DEEPBOOK_MID_PRICE_DIRECTION;
    })
  | (SettlementAssetGroupAsset & {
      status: "no_direct_deepbook_pool";
      reason: string;
    })
  | (SettlementAssetGroupAsset & {
      status: "mid_price_unavailable";
      poolKey: string;
      direction: QuoteDirection;
      reason: string;
    });

export type SettlementAssetGroupParitySummary = {
  status: "ok";
  fetchedAt: string;
  denomination: SettlementAssetGroupAlias;
  assetGroupId: typeof SUI_USD_SETTLEMENT_ASSET_GROUP_ID;
  userAnswerUse: UserAnswerUse;
  referenceAsset: SettlementAssetGroupAsset & {
    role: "measurement_reference_not_settlement_choice";
  };
  quantitySemantics: SettlementAssetGroupParityQuantitySemantics;
  evidenceSources: {
    settlementAssetGroup: SettlementAssetGroup["evidenceSources"];
    midPrice: {
      sdk: typeof DEEPBOOK_SDK_SIMULATION_SOURCE_BASE.sdk;
      transport: typeof DEEPBOOK_SDK_SIMULATION_SOURCE_BASE.transport;
      simulation: typeof DEEPBOOK_SDK_SIMULATION_SOURCE_BASE.simulation;
      method: "midPrice";
      precision: typeof DEEPBOOK_MID_PRICE_PRECISION;
    };
  };
  assets: SettlementAssetGroupParityAsset[];
  statistics: {
    status: "available";
    sampleCount: number;
    unavailableAssetCount: number;
    parityDirection: "reference_asset_per_group_asset";
    calculation: "computed_from_available_direct_deepbook_mid_price_snapshots";
    min: {
      symbol: string;
      priceInReferenceAsset: number;
    };
    max: {
      symbol: string;
      priceInReferenceAsset: number;
    };
    mean: {
      priceInReferenceAsset: number;
    };
    median: {
      priceInReferenceAsset: number;
    };
  };
  responseSummary: SettlementAssetGroupParityResponseSummary;
  unsupportedClaims: [
    "settlement_token_selection",
    "fiat_usd_cash_out",
    "payment_execution_readiness",
    "route_recommendation",
    "best_route",
    "transaction_building",
    "signing_readiness",
    "profit_or_pnl",
    "cost_basis"
  ];
};

export type SettlementAssetGroupParityResponseSummary = {
  questionKind: "settlement_asset_group_parity";
  conclusionKind: "parity_statistics_available";
  assetGroupId: typeof SUI_USD_SETTLEMENT_ASSET_GROUP_ID;
  referenceAssetSymbol: string;
  referenceAssetRole: "measurement_reference_not_settlement_choice";
  parityDirection: "reference_asset_per_group_asset";
  min: {
    symbol: string;
    priceInReferenceAsset: number;
  };
  max: {
    symbol: string;
    priceInReferenceAsset: number;
  };
  mean: {
    priceInReferenceAsset: number;
  };
  median: {
    priceInReferenceAsset: number;
  };
  excludedFromConclusion: [
    "settlement_token_selection",
    "fiat_usd_cash_out",
    "payment_execution_readiness",
    "route_recommendation",
    "best_route",
    "transaction_building",
    "signing_readiness",
    "profit_or_pnl",
    "cost_basis"
  ];
};

export type IntentEvidenceKind = "cover_payment_like_amount" | "summarize_settlement_asset_group_balance";
export type IntentEvidenceDenomination = SettlementAssetGroupAlias;
export const INTENT_EVIDENCE_TARGET_ASSET_SELECTION_SOURCES = [
  "user_explicit",
  "prior_user_explicit_context"
] as const;
export type IntentEvidenceTargetAssetSelectionSource =
  (typeof INTENT_EVIDENCE_TARGET_ASSET_SELECTION_SOURCES)[number];
export type IntentEvidenceBlockedReason =
  | "wallet_balance_page_limit_exceeded"
  | "wallet_balance_pagination_did_not_advance";
export type IntentEvidenceUnsupportedClaims =
  | "settlement_token_selection"
  | "fiat_usd_cash_out"
  | "gas_reserve_or_fee_readiness"
  | "best_route_or_venue_comparison"
  | "route_dependent_payment_support"
  | "payment_execution_readiness"
  | "transaction_building"
  | "signing_readiness"
  | "profit_or_pnl"
  | "cost_basis";

export type IntentEvidenceInput = {
  account: string;
  intentKind: IntentEvidenceKind;
  denomination: string;
  requiredDisplayAmount?: string | undefined;
  targetAssetSymbol?: string | undefined;
  targetAssetSelectionSource?: IntentEvidenceTargetAssetSelectionSource | undefined;
  acceptedSourceAssetSymbols?: string[] | undefined;
};

export type IntentEvidenceQuantitySemantics = {
  kind: typeof INTENT_EVIDENCE_QUANTITY_KIND;
  allowedUse: "pre_transaction_evidence";
  naturalLanguageIntentEvidence: true;
  transactionBuildingAvailable: false;
  signingReadinessAvailable: false;
  routeRecommendationAvailable: false;
  fiatUsdCashOutAvailable: false;
  profitAndLossAvailable: false;
  costBasisAvailable: false;
  notFor: [
    "transaction_building",
    "signing_data",
    "signing_readiness",
    "payment_execution",
    "best_route",
    "route_recommendation",
    "fiat_usd_cash_out",
    "external_market_price_conversion",
    "profit_or_pnl",
    "cost_basis"
  ];
};

export type IntentEvidenceSettlementAssetBalance = SettlementAssetGroupAsset & {
  currentRawAmount: string;
  currentDisplayAmount: string;
  walletBalanceEvidence: "current_wallet_coin_balance_snapshot";
};

export type IntentEvidenceAggregate =
  | {
      status: "available";
      requiredDisplayAmount?: string | undefined;
      requiredRawAmount?: string | undefined;
      currentRawAmount: string;
      currentDisplayAmount: string;
      shortfallRawAmount?: string | undefined;
      shortfallDisplayAmount?: string | undefined;
      decimals: number;
      unitSource: typeof DEEPBOOK_SCALAR_UNIT_SOURCE;
    }
  | {
      status: "unavailable_mixed_decimals";
      requiredDisplayAmount?: string | undefined;
    }
  | {
      status: "unavailable_wallet_balance_scan_incomplete";
      requiredDisplayAmount?: string | undefined;
      reason: IntentEvidenceBlockedReason;
    };

export type IntentEvidenceSettlementAssetCoverageBoundary = [
  "current_wallet_coin_balance_snapshot",
  "settlement_asset_assets_only",
  "not_settlement_token_selection",
  "not_route_dependent_payment_support",
  "not_payment_execution_readiness",
  "not_gas_readiness"
];

export type IntentEvidenceSettlementAssetCoverage =
  | {
      status: "balance_total_only";
      currentRawAmount: string;
      currentDisplayAmount: string;
      decimals: number;
      unitSource: typeof DEEPBOOK_SCALAR_UNIT_SOURCE;
      boundary: IntentEvidenceSettlementAssetCoverageBoundary;
    }
  | {
      status: "covered_by_settlement_asset_balance" | "shortfall_in_settlement_asset_balance";
      requiredDisplayAmount: string;
      requiredRawAmount: string;
      currentRawAmount: string;
      currentDisplayAmount: string;
      shortfallRawAmount: string;
      shortfallDisplayAmount: string;
      decimals: number;
      unitSource: typeof DEEPBOOK_SCALAR_UNIT_SOURCE;
      boundary: IntentEvidenceSettlementAssetCoverageBoundary;
    }
  | {
      status: "unavailable_mixed_decimals";
      requiredDisplayAmount?: string | undefined;
      reason: "asset_group_assets_do_not_share_verified_decimals";
      boundary: IntentEvidenceSettlementAssetCoverageBoundary;
    }
  | {
      status: "unavailable_wallet_balance_scan_incomplete";
      requiredDisplayAmount?: string | undefined;
      reason: IntentEvidenceBlockedReason;
      boundary: IntentEvidenceSettlementAssetCoverageBoundary;
    };

export type IntentEvidenceSupportedResponseClaim =
  | "current_settlement_asset_total"
  | "settlement_asset_coverage_status"
  | "settlement_asset_shortfall"
  | "settlement_asset_coverage_unavailable"
  | "selected_target_shortfall"
  | "direct_pool_quote_evidence"
  | "required_user_choices"
  | "unsupported_inferences";

export type IntentEvidenceResponseEvidence =
  | {
      mode: "settlement_asset_only";
      primaryEvidenceFields: ["responseSummary"];
      supportedResponseClaims: IntentEvidenceSupportedResponseClaim[];
    }
  | {
      mode: "selected_target_context";
      primaryEvidenceFields: [
        "responseSummary",
        "selectedTarget",
        "candidateConversions",
        "requiredUserChoices"
      ];
      supportedResponseClaims: IntentEvidenceSupportedResponseClaim[];
    };

export type IntentEvidenceResponseSummary = {
  questionKind: "payment_coverage" | "settlement_asset_group_balance_total";
  conclusionKind:
    | "covered_by_settlement_asset_balance"
    | "shortfall_in_settlement_asset_balance"
    | "current_settlement_asset_total"
    | "settlement_asset_coverage_unavailable";
  answerCompleteness: {
    answerCompleteFor:
      | "settlement_asset_group_answer"
      | "selected_target_context_answer"
      | "settlement_asset_coverage_unavailable_answer";
    requiredAnswerFields: string[];
    notCompleteFor: string[];
  };
  doNotCallQuoteToolsForThisQuestion: true;
  coverageBasis: "settlement_asset_wallet_balance_only";
  assetGroupId: typeof SUI_USD_SETTLEMENT_ASSET_GROUP_ID;
  currentDisplayAmount: string | null;
  requiredDisplayAmount: string | null;
  shortfallDisplayAmount: string | null;
  unavailableReason?:
    | "asset_group_assets_do_not_share_verified_decimals"
    | IntentEvidenceBlockedReason
    | undefined;
  amountsUsedForAnswer: {
    currentDisplayAmount: "current_wallet_balance_in_settlement_asset_group" | null;
    requiredDisplayAmount: "amount_requested_by_user" | null;
    shortfallDisplayAmount: "required_amount_minus_current_settlement_asset_balance" | null;
  };
  separateQuoteOutputs: {
    usedForPaymentAnswer: false;
    usedForShortfallAnswer: false;
    reason: "separate_quote_tool_outputs_are_price_estimates_only";
    paymentAnswerField: "responseSummary";
  };
  requiredUserChoices: string[];
  doNotUseForConclusion: [
    "separate_quote_tool_results",
    "assets_outside_settlement_group",
    "route_dependent_payment_support"
  ];
  excludedFromConclusion: [
    "separate_quote_tool_results",
    "candidate_conversion_quote_evidence",
    "assets_outside_settlement_group",
    "settlement_token_selection",
    "route_dependent_payment_support",
    "gas_reserve_or_fee_readiness",
    "payment_execution_readiness",
    "transaction_building",
    "signing_readiness",
    "fiat_usd_cash_out",
    "profit_or_pnl",
    "cost_basis"
  ];
};

export type IntentEvidenceSelectedTarget = SettlementAssetGroupAsset & {
  selectionSource: IntentEvidenceTargetAssetSelectionSource;
  requiredRawAmount: string;
  currentRawAmount: string;
  currentDisplayAmount: string;
  shortfallRawAmount: string;
  shortfallDisplayAmount: string;
};

export type IntentEvidenceCandidateConversion =
  | {
      sourceSymbol: string;
      targetSymbol: string;
      sourceRawAmount: string;
      sourceDisplayAmount: string;
      status: "quoted";
      directPool: {
        poolKey: string;
        direction: QuoteDirection;
      };
      quote: DeepbookQuoteSummary;
      boundary: [
        "quote_snapshot_only",
        "not_final_min_out",
        "not_route_recommendation",
        "not_route_dependent_payment_support",
        "not_payment_readiness",
        "not_signing_readiness"
      ];
    }
  | {
      sourceSymbol: string;
      targetSymbol?: string | undefined;
      sourceRawAmount: string;
      sourceDisplayAmount: string;
      status:
        | "target_asset_not_selected"
        | "no_direct_deepbook_pool"
        | "quote_unavailable"
        | "filtered_by_accepted_source_assets";
      reason: string;
      directPool?: {
        poolKey: string;
        direction: QuoteDirection;
      } | undefined;
    };

export type IntentEvidenceSummary = {
  status: "ok";
  account: string;
  fetchedAt: string;
  userAnswerUse: UserAnswerUse;
  intent: {
    intentKind: IntentEvidenceKind;
    denomination: IntentEvidenceDenomination;
    requiredDisplayAmount?: string | undefined;
    targetAssetSymbol?: string | undefined;
    targetAssetSelectionSource?: IntentEvidenceTargetAssetSelectionSource | undefined;
    acceptedSourceAssetSymbols?: string[] | undefined;
  };
  quantitySemantics: IntentEvidenceQuantitySemantics;
  evidenceSources: {
    walletBalances: WalletBalanceSummary["source"];
    settlementAssetGroup: SettlementAssetGroup["evidenceSources"];
    quoteEvidence: typeof DEEPBOOK_SOURCE_FIELD_VALUES.pinnedSdkWhenTargetAssetSelected;
  };
  settlementAssetGroup: Omit<SettlementAssetGroup, "excludedAssets">;
  balances: IntentEvidenceSettlementAssetBalance[];
  aggregate: IntentEvidenceAggregate;
  settlementAssetCoverage: IntentEvidenceSettlementAssetCoverage;
  selectedTarget?: IntentEvidenceSelectedTarget | undefined;
  candidateConversions: IntentEvidenceCandidateConversion[];
  blockedReasons: IntentEvidenceBlockedReason[];
  responseEvidence: IntentEvidenceResponseEvidence;
  responseSummary: IntentEvidenceResponseSummary;
  requiredUserChoices: string[];
  supportedClaims: string[];
  unsupportedClaims: IntentEvidenceUnsupportedClaims[];
  uninspectedAssetClasses: UninspectedAssetClass[];
  inspectedBalancePages: number;
  inspectedCoinBalanceCount: number;
};

export type DeepbookOrderbookSummary = {
  status: "ok";
  poolKey: string;
  ticks: number;
  fetchedAt: string;
  userAnswerUse: UserAnswerUse;
  source: {
    sdk: typeof DEEPBOOK_SDK_SIMULATION_SOURCE_BASE.sdk;
    transport: typeof DEEPBOOK_SDK_SIMULATION_SOURCE_BASE.transport;
    simulation: typeof DEEPBOOK_SDK_SIMULATION_SOURCE_BASE.simulation;
    methods: ["midPrice", "poolBookParams", "getLevel2TicksFromMid"];
  };
  midPrice: number;
  poolBookParams: PoolBookParams;
  level2TicksFromMid: Level2TicksFromMid;
};

export type DeepbookMidPriceSummary = {
  status: "ok";
  poolKey: string;
  base: string;
  quote: string;
  userAnswerUse: UserAnswerUse;
  priceSemantics: DeepbookMidPriceSemantics;
  price: number;
  priceDirection: typeof DEEPBOOK_MID_PRICE_DIRECTION;
  priceType: typeof DEEPBOOK_MID_PRICE_TYPE;
  fetchedAt: string;
  source: {
    sdk: typeof DEEPBOOK_SDK_SIMULATION_SOURCE_BASE.sdk;
    transport: typeof DEEPBOOK_SDK_SIMULATION_SOURCE_BASE.transport;
    simulation: typeof DEEPBOOK_SDK_SIMULATION_SOURCE_BASE.simulation;
    method: "midPrice";
    precision: typeof DEEPBOOK_MID_PRICE_PRECISION;
  };
};

export type DeepbookMidPriceSemantics = {
  kind: typeof DEEPBOOK_MID_PRICE_SEMANTICS_KIND;
  allowedUse: "deepbook_pool_mid_price_snapshot";
  globalMarketPriceAvailable: false;
  fiatUsdCashOutAvailable: false;
  externalMarketPriceConversionAvailable: false;
  externalMarketLookupAvailable: false;
  usdPegAssumptionAvailable: false;
  bankCashOutEstimateAvailable: false;
  quoteComparisonAvailable: false;
  priceImpactAvailable: false;
  venueComparisonAvailable: false;
  routeRecommendationAvailable: false;
  profitAndLossAvailable: false;
  costBasisAvailable: false;
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
  ];
};

export type DeepbookQuoteSummary = {
  status: "ok";
  poolKey: string;
  direction: QuoteDirection;
  amountRaw: string;
  fetchedAt: string;
  userAnswerUse: UserAnswerUse;
  quantitySemantics: DeepbookQuoteQuantitySemantics;
  source: {
    sdk: typeof DEEPBOOK_SDK_SIMULATION_SOURCE_BASE.sdk;
    transport: typeof DEEPBOOK_SDK_SIMULATION_SOURCE_BASE.transport;
    simulation: typeof DEEPBOOK_SDK_SIMULATION_SOURCE_BASE.simulation;
    method: "getQuoteQuantityOut" | "getBaseQuantityOut" | "getQuoteQuantityOutInputFee" | "getBaseQuantityOutInputFee";
    returnValueEncoding: "bcs.u64";
  };
  quote: DeepbookDisplayQuote;
  rawQuote: DeepbookRawQuoteEvidence;
};

export type DeepbookQuoteQuantitySemantics = {
  kind: typeof DEEPBOOK_QUOTE_QUANTITY_KIND;
  inputAmountKind: "raw_u64" | "display_source_amount_converted_to_raw_u64";
  allowedUse: "indicative_deepbook_pool_quote";
  rawAmountAvailable: true;
  rawEvidenceField: "rawQuote";
  paymentCoverageAvailable: false;
  shortfallContributionAvailable: false;
  routeDependentPaymentSupportAvailable: false;
  requiresIntentEvidenceForCoverage: true;
  canUseForPaymentAnswer: false;
  canUseForShortfallAnswer: false;
  doNotCombineWithPaymentAnswer: true;
  requiredPaymentAnswerTool: "read_preview_intent_evidence";
  paymentAnswerUseBlockedReason: "quote_output_is_price_reference_not_payment_answer";
  requiredPaymentAnswerField: "responseSummary";
  fiatUsdCashOutAvailable: false;
  externalMarketPriceConversionAvailable: false;
  externalMarketLookupAvailable: false;
  usdPegAssumptionAvailable: false;
  bankCashOutEstimateAvailable: false;
  profitAndLossAvailable: false;
  costBasisAvailable: false;
  priceImpactAvailable: false;
  midPriceSlippageAvailable: false;
  venueComparisonAvailable: false;
  routeRecommendationAvailable: false;
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
  ];
};

export type DeepbookQuoteFeeMode = "deep" | "input_coin";

export type DeepbookRawQuoteReturnValues = {
  baseOutRaw: string;
  quoteOutRaw: string;
  deepRequiredRaw: string;
};

export type DeepbookRawQuoteAmount = {
  raw: string;
  symbol: string;
  coinType: string;
  decimals: number;
  unitSource: typeof DEEPBOOK_SCALAR_UNIT_SOURCE;
};

export type DeepbookRawQuoteSourceMoveFunction =
  | "pool::get_quote_quantity_out"
  | "pool::get_base_quantity_out"
  | "pool::get_quote_quantity_out_input_fee"
  | "pool::get_base_quantity_out_input_fee";

export type DeepbookRawQuoteEvidence = {
  kind: typeof DEEPBOOK_RAW_QUOTE_QUANTITY_KIND;
  sourceMoveFunction: DeepbookRawQuoteSourceMoveFunction;
  returnValueSourceMoveFunction: "pool::get_quantity_out" | "pool::get_quantity_out_input_fee";
  returnValueOrder: ["base_quantity_out", "quote_quantity_out", "deep_quantity_required"];
  inputAmount: DeepbookRawQuoteAmount;
  baseOut: DeepbookRawQuoteAmount;
  quoteOut: DeepbookRawQuoteAmount;
  deepRequired: DeepbookRawQuoteAmount;
  directionalOutput: DeepbookRawQuoteAmount;
  boundary: {
    outputBeforeSlippagePolicy: true;
    notFor: [
      "final_min_out",
      "transaction_building",
      "signing_data",
      "signing_readiness",
      "price_impact",
      "mid_price_slippage",
      "quote_vs_mid_slippage",
      "effective_price",
      "venue_comparison",
      "best_route",
      "route_recommendation",
      "fiat_usd_cash_out",
      "external_market_price_conversion",
      "external_market_lookup",
      "usd_peg_assumption",
      "bank_cash_out_estimate",
      "profit_or_pnl",
      "cost_basis"
    ];
  };
};

export type DeepbookDisplayQuoteInputAmount = {
  display: string;
  raw: string;
  asset: {
    symbol: string;
    coinType: string;
    decimals: number;
    unitSource: typeof DEEPBOOK_SCALAR_UNIT_SOURCE;
  };
};

export type DeepbookDisplayQuote = {
  baseOut: string;
  quoteOut: string;
  deepRequired: string;
};

export type DeepbookDisplayQuoteSummary = {
  status: "ok";
  pool: {
    poolKey: string;
    base: string;
    quote: string;
  };
  direction: QuoteDirection;
  inputAmount: DeepbookDisplayQuoteInputAmount;
  fetchedAt: string;
  userAnswerUse: UserAnswerUse;
  quantitySemantics: DeepbookQuoteQuantitySemantics;
  source: DeepbookQuoteSummary["source"];
  quote: DeepbookDisplayQuote;
  rawQuote: DeepbookRawQuoteEvidence;
};

export type DeepbookAccountInventoryDetailStatus =
  | "manager_discovery_only"
  | "pool_key_required"
  | "manager_address_required"
  | "manager_address_not_discovered_for_active_account"
  | "account_not_found"
  | "available";

export type DeepbookAccountInventoryInput = {
  account: string;
  poolKey?: string | undefined;
  managerAddress?: string | undefined;
};

export type DeepbookDisplayQuantitySemantics = {
  kind: typeof DEEPBOOK_ACCOUNT_QUANTITY_KIND;
  rawAmountAvailable: false;
  notFor: ["signing", "funding", "route_liquidity", "withdrawal_readiness", "transaction_building"];
};

export type DeepbookAccountInventoryPool = {
  poolKey: string;
  base: string;
  quote: string;
};

export type DeepbookAccountSummary = {
  epoch: string;
  settledBalances: AccountBalances;
  owedBalances: AccountBalances;
  unclaimedRebates: AccountBalances;
};

export type DeepbookAccountInventorySummary = {
  status: "ok";
  account: string;
  fetchedAt: string;
  userAnswerUse: UserAnswerUse;
  source: {
    sdk: typeof DEEPBOOK_SDK_SIMULATION_SOURCE_BASE.sdk;
    transport: typeof DEEPBOOK_SDK_SIMULATION_SOURCE_BASE.transport;
    simulation: typeof DEEPBOOK_SDK_SIMULATION_SOURCE_BASE.simulation;
    methods: string[];
  };
  requested: {
    poolKey?: string | undefined;
    managerAddress?: string | undefined;
  };
  detailStatus: DeepbookAccountInventoryDetailStatus;
  managerAddresses: string[];
  quantitySemantics: DeepbookDisplayQuantitySemantics;
  pool?: DeepbookAccountInventoryPool | undefined;
  accountExists?: boolean | undefined;
  accountSummary?: DeepbookAccountSummary | undefined;
  lockedBalances?: LockedBalances | undefined;
  openOrderIds?: string[] | undefined;
  openOrderCount?: number | undefined;
  openOrderIdsTruncated?: boolean | undefined;
};

export type DeepbookUsdcPriceHistorySelector =
  | {
      kind: "pool_name";
      value: string;
    }
  | {
      kind: "asset_symbol";
      value: string;
    }
  | {
      kind: "coin_type";
      value: string;
    };

export type DeepbookUsdcPriceHistoryInput = {
  poolName?: string | undefined;
  assetSymbol?: string | undefined;
  coinType?: string | undefined;
  interval?: DeepbookOfficialIndexerInterval | undefined;
  start: string;
  end: string;
};

export type DeepbookUsdcPriceAtTimeInput = {
  poolName?: string | undefined;
  assetSymbol?: string | undefined;
  coinType?: string | undefined;
  interval?: DeepbookOfficialIndexerInterval | undefined;
  targetTime: string;
  maxDistanceMinutes?: number | undefined;
};

export type DeepbookUsdcPriceHistoryRange = {
  start: string;
  end: string;
  timeZone: "UTC";
  interval: DeepbookOfficialIndexerInterval;
  intervalDurationMs: number;
  maxBars: typeof MAX_DEEPBOOK_USDC_PRICE_HISTORY_BARS;
  requestedCandleSlots: number;
};

export type DeepbookUsdcPriceHistoryQuantitySemantics = {
  kind: typeof DEEPBOOK_USDC_PRICE_HISTORY_QUANTITY_KIND;
  allowedUse: typeof DEEPBOOK_OFFICIAL_INDEXER_CANDLE_USE.allowedUse;
  source: typeof DEEPBOOK_OFFICIAL_INDEXER_CANDLE_USE.source;
  quoteAsset: typeof DEEPBOOK_OFFICIAL_INDEXER_CANDLE_USE.quoteAsset;
  priceConvention: typeof DEEPBOOK_OFFICIAL_INDEXER_CANDLE_USE.priceConvention;
  usdcIsFiatUsd: typeof DEEPBOOK_OFFICIAL_INDEXER_CANDLE_USE.usdcIsFiatUsd;
  usdPegGuaranteeAvailable: typeof DEEPBOOK_OFFICIAL_INDEXER_CANDLE_USE.usdPegGuaranteeAvailable;
  chainRecomputedBySuiMcp: typeof DEEPBOOK_OFFICIAL_INDEXER_CANDLE_USE.chainRecomputedBySuiMcp;
  liveQuoteAvailable: false;
  historicalMidPriceAvailable: false;
  globalMarketPriceAvailable: false;
  fiatUsdCashOutAvailable: false;
  routeRecommendationAvailable: false;
  transactionBuildingAvailable: false;
  signingReadinessAvailable: false;
  profitAndLossAvailable: false;
  costBasisAvailable: false;
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
  ];
};

export type DeepbookUsdcPriceHistoryUnsupportedClaim = typeof DEEPBOOK_USDC_PRICE_HISTORY_UNSUPPORTED_CLAIMS[number];

export type DeepbookUsdcPriceHistoryPair = {
  poolName: string;
  poolId: string;
  baseAsset: {
    symbol: string;
    coinType: string;
    decimals: number;
  };
  quoteAsset: {
    symbol: "USDC";
    coinType: string;
    decimals: number;
  };
  priceConvention: "USDC_PER_BASE";
};

export type DeepbookUsdcPriceHistorySource = {
  kind: typeof DEEPBOOK_OFFICIAL_INDEXER_SOURCE_BASE.kind;
  baseUrl: string;
  sourceStatement: string;
  poolList: {
    url: string;
    fetchedAt: string;
  };
  candles: {
    url: string;
    fetchedAt: string;
    poolName: string;
    interval: DeepbookOfficialIndexerInterval;
    startTimeMs: number;
    endTimeMs: number;
    limit: number;
  };
  chainRecomputedBySuiMcp: typeof DEEPBOOK_OFFICIAL_INDEXER_SOURCE_BASE.chainRecomputedBySuiMcp;
};

export type DeepbookUsdcPriceHistoryBar = DeepbookOfficialIndexerCandle;

export type DeepbookUsdcPriceHistoryResponseSummary = {
  questionKind: "deepbook_usdc_price_history";
  evidenceKind: "official_deepbook_indexer_candles";
  sourceStatement: typeof DEEPBOOK_OFFICIAL_INDEXER_RESPONSE_TEXT.sourceStatement;
  usdcDisclaimer: typeof DEEPBOOK_OFFICIAL_INDEXER_RESPONSE_TEXT.usdcDisclaimer;
  candleMeaning: "Each candle is returned by the DeepBookV3 official Indexer for the requested interval.";
  excludedFromConclusion: DeepbookUsdcPriceHistoryUnsupportedClaim[];
};

export type DeepbookUsdcCandleAvailability = typeof DEEPBOOK_USDC_CANDLE_AVAILABILITY[number];

export type DeepbookUsdcPriceHistoryUnsupportedPairReason =
  typeof DEEPBOOK_USDC_PRICE_HISTORY_UNSUPPORTED_PAIR_REASONS[number];

export type DeepbookUsdcPriceHistorySourceUnavailableReason =
  typeof DEEPBOOK_USDC_PRICE_HISTORY_SOURCE_UNAVAILABLE_REASONS[number];

export type DeepbookUsdcPriceHistorySummary =
  | {
      status: "ok";
      fetchedAt: string;
      requested: {
        selector: DeepbookUsdcPriceHistorySelector;
        range: DeepbookUsdcPriceHistoryRange;
      };
      pair: DeepbookUsdcPriceHistoryPair;
      candleAvailability: DeepbookUsdcCandleAvailability;
      barCount: number;
      bars: DeepbookUsdcPriceHistoryBar[];
      source: DeepbookUsdcPriceHistorySource;
      userAnswerUse: UserAnswerUse;
      quantitySemantics: DeepbookUsdcPriceHistoryQuantitySemantics;
      responseSummary: DeepbookUsdcPriceHistoryResponseSummary;
      unsupportedClaims: DeepbookUsdcPriceHistoryUnsupportedClaim[];
    }
  | {
      status: "unsupported_pair";
      fetchedAt: string;
      requested: {
        selector: DeepbookUsdcPriceHistorySelector;
        range: DeepbookUsdcPriceHistoryRange;
      };
      reason: DeepbookUsdcPriceHistoryUnsupportedPairReason;
      matchingPoolNames: string[];
      availablePoolNames: string[];
      userAnswerUse: UserAnswerUse;
      quantitySemantics: DeepbookUsdcPriceHistoryQuantitySemantics;
      responseSummary: DeepbookUsdcPriceHistoryResponseSummary;
      unsupportedClaims: DeepbookUsdcPriceHistoryUnsupportedClaim[];
    }
  | {
      status: "unsupported_range";
      fetchedAt: string;
      requested: {
        selector: DeepbookUsdcPriceHistorySelector;
        range: DeepbookUsdcPriceHistoryRange;
      };
      reason: "requested_range_exceeds_max_bars";
      userAnswerUse: UserAnswerUse;
      quantitySemantics: DeepbookUsdcPriceHistoryQuantitySemantics;
      responseSummary: DeepbookUsdcPriceHistoryResponseSummary;
      unsupportedClaims: DeepbookUsdcPriceHistoryUnsupportedClaim[];
    }
  | {
      status: "source_unavailable";
      fetchedAt: string;
      requested: {
        selector: DeepbookUsdcPriceHistorySelector;
        range: DeepbookUsdcPriceHistoryRange;
      };
      reason: DeepbookUsdcPriceHistorySourceUnavailableReason;
      pair?: DeepbookUsdcPriceHistoryPair | undefined;
      source?: Partial<DeepbookUsdcPriceHistorySource> | undefined;
      userAnswerUse: UserAnswerUse;
      quantitySemantics: DeepbookUsdcPriceHistoryQuantitySemantics;
      responseSummary: DeepbookUsdcPriceHistoryResponseSummary;
      unsupportedClaims: DeepbookUsdcPriceHistoryUnsupportedClaim[];
    };

export type DeepbookUsdcPriceAtTimeMatchKind = "exact_bucket" | "nearest_before" | "nearest_after";

export type DeepbookUsdcPriceAtTimeTarget = {
  targetTime: string;
  searchWindow: {
    start: string;
    end: string;
    maxDistanceMinutes: number;
  };
};

export type DeepbookUsdcPriceAtTimeMatch = {
  kind: DeepbookUsdcPriceAtTimeMatchKind;
  distanceMinutes: number;
  representativePrice: {
    field: "matchedCandle.close";
    value: string;
    quoteAsset: "USDC";
    baseAssetSymbol: string;
    priceConvention: "USDC_PER_BASE";
  };
};

export type DeepbookUsdcPriceAtTimeSummary =
  | {
      status: "ok";
      fetchedAt: string;
      target: DeepbookUsdcPriceAtTimeTarget;
      requested: {
        selector: DeepbookUsdcPriceHistorySelector;
        range: DeepbookUsdcPriceHistoryRange;
      };
      pair: DeepbookUsdcPriceHistoryPair;
      match: DeepbookUsdcPriceAtTimeMatch;
      matchedCandle: DeepbookUsdcPriceHistoryBar;
      candleAvailability: DeepbookUsdcCandleAvailability;
      source: DeepbookUsdcPriceHistorySource;
      userAnswerUse: UserAnswerUse;
      quantitySemantics: DeepbookUsdcPriceHistoryQuantitySemantics;
      responseSummary: DeepbookUsdcPriceHistoryResponseSummary;
      unsupportedClaims: DeepbookUsdcPriceHistoryUnsupportedClaim[];
    }
  | {
      status: "no_price_in_search_window";
      fetchedAt: string;
      target: DeepbookUsdcPriceAtTimeTarget;
      requested: {
        selector: DeepbookUsdcPriceHistorySelector;
        range: DeepbookUsdcPriceHistoryRange;
      };
      pair: DeepbookUsdcPriceHistoryPair;
      candleAvailability: DeepbookUsdcCandleAvailability;
      source: DeepbookUsdcPriceHistorySource;
      userAnswerUse: UserAnswerUse;
      quantitySemantics: DeepbookUsdcPriceHistoryQuantitySemantics;
      responseSummary: DeepbookUsdcPriceHistoryResponseSummary;
      unsupportedClaims: DeepbookUsdcPriceHistoryUnsupportedClaim[];
    }
  | {
      status: "unsupported_pair";
      fetchedAt: string;
      target: DeepbookUsdcPriceAtTimeTarget;
      requested: {
        selector: DeepbookUsdcPriceHistorySelector;
        range: DeepbookUsdcPriceHistoryRange;
      };
      reason: DeepbookUsdcPriceHistoryUnsupportedPairReason;
      matchingPoolNames: string[];
      availablePoolNames: string[];
      userAnswerUse: UserAnswerUse;
      quantitySemantics: DeepbookUsdcPriceHistoryQuantitySemantics;
      responseSummary: DeepbookUsdcPriceHistoryResponseSummary;
      unsupportedClaims: DeepbookUsdcPriceHistoryUnsupportedClaim[];
    }
  | {
      status: "unsupported_range";
      fetchedAt: string;
      target: DeepbookUsdcPriceAtTimeTarget;
      requested: {
        selector: DeepbookUsdcPriceHistorySelector;
        range: DeepbookUsdcPriceHistoryRange;
      };
      reason: "requested_range_exceeds_max_bars";
      userAnswerUse: UserAnswerUse;
      quantitySemantics: DeepbookUsdcPriceHistoryQuantitySemantics;
      responseSummary: DeepbookUsdcPriceHistoryResponseSummary;
      unsupportedClaims: DeepbookUsdcPriceHistoryUnsupportedClaim[];
    }
  | {
      status: "source_unavailable";
      fetchedAt: string;
      target: DeepbookUsdcPriceAtTimeTarget;
      requested: {
        selector: DeepbookUsdcPriceHistorySelector;
        range: DeepbookUsdcPriceHistoryRange;
      };
      reason: DeepbookUsdcPriceHistorySourceUnavailableReason;
      pair?: DeepbookUsdcPriceHistoryPair | undefined;
      source?: Partial<DeepbookUsdcPriceHistorySource> | undefined;
      userAnswerUse: UserAnswerUse;
      quantitySemantics: DeepbookUsdcPriceHistoryQuantitySemantics;
      responseSummary: DeepbookUsdcPriceHistoryResponseSummary;
      unsupportedClaims: DeepbookUsdcPriceHistoryUnsupportedClaim[];
    };

export type DeepBookFactoryOptions = {
  balanceManagers?: Record<string, BalanceManager>;
};

export type DeepBookReadClient = {
  midPrice(poolKey: string): Promise<number>;
  poolBookParams(poolKey: string): Promise<PoolBookParams>;
  getLevel2TicksFromMid(poolKey: string, ticks: number): Promise<Level2TicksFromMid>;
  getQuoteQuantityOutRaw(poolKey: string, baseQuantity: bigint): Promise<DeepbookRawQuoteReturnValues>;
  getQuoteQuantityOutInputFeeRaw?(poolKey: string, baseQuantity: bigint): Promise<DeepbookRawQuoteReturnValues>;
  getBaseQuantityOutRaw(poolKey: string, quoteQuantity: bigint): Promise<DeepbookRawQuoteReturnValues>;
  getBaseQuantityOutInputFeeRaw?(poolKey: string, quoteQuantity: bigint): Promise<DeepbookRawQuoteReturnValues>;
  getBalanceManagerIds(owner: string): Promise<string[]>;
  accountExists(poolKey: string, managerKey: string): Promise<boolean>;
  account(poolKey: string, managerKey: string): Promise<AccountInfo>;
  lockedBalance(poolKey: string, balanceManagerKey: string): Promise<LockedBalances>;
  accountOpenOrders(poolKey: string, managerKey: string): Promise<string[]>;
};

export type DeepBookCoinRegistry = Record<string, Coin>;

export type SuiReadCoreClient = {
  core: {
    listBalances(options: SuiClientTypes.ListBalancesOptions): Promise<SuiClientTypes.ListBalancesResponse>;
    getCoinMetadata(options: SuiClientTypes.GetCoinMetadataOptions): Promise<SuiClientTypes.GetCoinMetadataResponse>;
    // Optional client capabilities used only by the account inventory snapshot.
    // The production SuiGrpcClient implements both; a client without them yields an
    // empty inventory (no name, no objects) rather than failing.
    listOwnedObjects?: (
      options: SuiClientTypes.ListOwnedObjectsOptions<{ display: true }>
    ) => Promise<SuiClientTypes.ListOwnedObjectsResponse<{ display: true }>>;
    defaultNameServiceName?: (
      options: SuiClientTypes.DefaultNameServiceNameOptions
    ) => Promise<SuiClientTypes.DefaultNameServiceNameResponse>;
  };
};

// One owned NFT (an object that carries a Display name/image). `name`/`imageUrl`
// are optional because Display templates vary; the image is loaded directly by the
// browser on the public account page (img-src allows external https).
export type AccountNft = {
  objectId: string;
  type: string;
  name: string | undefined;
  imageUrl: string | undefined;
};

// A count of owned non-coin, non-NFT objects sharing one Move type.
export type AccountObjectGroup = {
  type: string;
  count: number;
};

// The public account snapshot: SuiNS name, coin balances, NFTs, and other owned
// objects grouped by type. Object enumeration is capped (a coin-heavy account can
// truncate), so `objectsTruncated` flags when not every object was scanned.
export type AccountInventorySummary = {
  status: "ok";
  account: string;
  fetchedAt: string;
  name: string | null;
  balances: WalletBalanceWithUnit[];
  nfts: AccountNft[];
  objectGroups: AccountObjectGroup[];
  scannedObjects: number;
  objectsTruncated: boolean;
};

export type SuiReadServiceOptions = {
  client: SuiReadCoreClient;
  network: "mainnet";
  chainIdentifier: string;
  coinMetadataCache: CoinMetadataCache;
  now?: () => Date;
  deepbookFactory?: (simulationSender: string, options?: DeepBookFactoryOptions) => DeepBookReadClient;
  coinMetadataTtlMs?: number;
  deepbookCoins?: DeepBookCoinRegistry;
  deepbookOfficialIndexerSource?: DeepbookOfficialIndexerSourceClient | undefined;
};

export class ReadServiceInputError extends Error {
  readonly kind: "input_invalid" | "registry_miss" | "quote_unavailable";
  readonly details: Record<string, unknown>;

  constructor(
    kind: "input_invalid" | "registry_miss" | "quote_unavailable",
    message: string,
    details: Record<string, unknown>
  ) {
    super(message);
    this.kind = kind;
    this.details = details;
  }
}

export type ReadServiceCacheOperation = "read" | "write";

export class ReadServiceCacheError extends Error {
  readonly kind = "metadata_cache_unavailable";
  readonly details: {
    resource: "coin_metadata_cache";
    operation: ReadServiceCacheOperation;
  };
  readonly cause: unknown;

  constructor(operation: ReadServiceCacheOperation, cause?: unknown) {
    super("Coin metadata cache is unavailable");
    this.details = { resource: "coin_metadata_cache", operation };
    this.cause = cause;
  }
}

export type DeepbookTokenRegistryEntry = {
  symbol: string;
  address: string;
  type: string;
  scalar: number;
  decimals: number;
  unitSource: typeof DEEPBOOK_SCALAR_UNIT_SOURCE;
  feed?: string;
  currencyId?: string;
  priceInfoObjectId?: string;
  poolKeys: string[];
};
