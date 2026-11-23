import { AccountInventoryReader } from "./accountInventoryReader.js";
import { DeepbookUsdcPriceService } from "./deepbookUsdcPriceService.js";
import type { SuiClientTypes } from "@mysten/sui/client";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import {
  COIN_METADATA_CACHE_TTL_MS,
  DEEPBOOK_SCALAR_UNIT_SOURCE,
  assertValidDecimals,
  parseDisplayAmountToRaw,
  normalizeCoinType,
  type CoinMetadataCache,
  type CoinUnit,
  type CoinMetadataCacheLookup,
  type CoinMetadataCacheRecord,
  type WalletBalanceWithUnit
} from "./coinMetadata.js";
import { createDeepBookReadClient } from "./deepbookRawQuoteClient.js";
import { DEEPBOOK_SDK_SIMULATION_SOURCE_BASE, DEEPBOOK_SOURCE_FIELD_VALUES } from "./deepbookSourceOwners.js";
import {
  deepbookUnitForCoinType,
  canonicalDeepbookSymbol,
  deepbookQuoteAssets,
  getKnownPool,
  listDeepbookTokenRegistry,
  PINNED_DEEPBOOK_COINS,
  resolveDeepbookPoolForSymbols
} from "./deepbookRegistry.js";
import { sumRawAmounts } from "./amounts.js";
import {
  buildUsdSettlementAssetGroup,
  commonAssetGroupDecimals,
  formatSettlementAssetRawAmount,
  normalizeSettlementDenomination
} from "../evidence/settlementFamilies.js";
import {
  assertDeepbookDisplayBalances,
  assertPositiveInteger,
  assertValidDeepbookMidPrice,
  deepbookQuoteInputFlow,
  deepbookMinimumInputRaw,
  deepbookQuoteGetters,
  deepbookAccountInventorySource,
  deepbookDisplayQuantitySemantics,
  deepbookMidPriceSemantics,
  deepbookQuoteQuantitySemantics,
  normalizeManagerAddresses,
  normalizeOptionalManagerAddress,
  parseQuoteDisplayAmount,
  parseRawAmount,
  toDeepbookAccountSummary,
  toDeepbookDisplayQuoteFromRaw
} from "./deepbookReadHelpers.js";
import {
  classifyWalletBalance,
  unavailableUnit,
  unitFromDeepbook,
  unitFromMetadataRecord,
  walletBalanceQuantitySemantics,
  withResolvedUnit,
  withUnavailableUnit
} from "./walletReadHelpers.js";
import {
  deepbookAccountInventoryUserAnswerUse,
  deepbookMidPriceUserAnswerUse,
  deepbookOrderbookUserAnswerUse,
  deepbookQuoteUserAnswerUse,
  intentEvidenceUserAnswerUse,
  settlementAssetGroupParityUserAnswerUse,
  walletBalanceUserAnswerUse,
  walletClassificationUserAnswerUse
} from "./readResponseGuidance.js";
import {
  intentEvidenceQuantitySemantics,
  intentEvidenceResponseEvidence,
  intentEvidenceResponseSummary,
  intentEvidenceSettlementAssetCoverageBoundary,
  intentEvidenceSupportedClaims,
  isIntentEvidenceTargetAssetSelectionSource,
  isSupportedIntentEvidenceKind
} from "./intentEvidenceResponseFormatting.js";
import {
  roundPriceInReferenceAsset,
  settlementAssetGroupParityQuantitySemantics,
  settlementAssetGroupParityResponseSummary,
  settlementAssetGroupParityStatistics
} from "./settlementParityFormatting.js";
import {
  DEEPBOOK_MID_PRICE_DIRECTION,
  DEEPBOOK_MID_PRICE_PRECISION,
  DEEPBOOK_MID_PRICE_TYPE,
  DEEPBOOK_RAW_QUOTE_QUANTITY_KIND,
  DEFAULT_DEEPBOOK_SIMULATION_SENDER,
  INTENT_EVIDENCE_TARGET_ASSET_SELECTION_SOURCES,
  MAX_DEEPBOOK_ACCOUNT_OPEN_ORDER_IDS,
  MAX_DEEPBOOK_ORDERBOOK_TICKS,
  NOT_INSPECTED_ASSET_CLASSES,
  ReadServiceCacheError,
  ReadServiceInputError,
  type ClassifiedWalletAsset,
  type DeepBookCoinRegistry,
  type DeepBookFactoryOptions,
  type DeepBookReadClient,
  type DeepbookAccountInventoryInput,
  type DeepbookAccountInventorySummary,
  type DeepbookDisplayQuoteSummary,
  type DeepbookMidPriceSummary,
  type DeepbookOrderbookSummary,
  type DeepbookRawQuoteEvidence,
  type DeepbookRawQuoteInput,
  type DeepbookRawQuoteReturnValues,
  type DeepbookQuoteSummary,
  type DeepbookUsdcPriceAtTimeInput,
  type DeepbookUsdcPriceHistoryInput,
  type DeepbookTokenRegistryEntry,
  type IntentEvidenceBlockedReason,
  type IntentEvidenceCandidateConversion,
  type IntentEvidenceInput,
  type IntentEvidenceSummary,
  type IntentEvidenceSettlementAssetBalance,
  type IntentEvidenceSettlementAssetCoverage,
  type IntentEvidenceSelectedTarget,
  type IntentEvidenceKind,
  type IntentEvidenceTargetAssetSelectionSource,
  type UninspectedAssetClass,
  type QuoteDirection,
  type SettlementAssetGroup,
  type SettlementAssetGroupAsset,
  type SettlementAssetGroupListSummary,
  type SettlementAssetGroupParityAsset,
  type SettlementAssetGroupParityInput,
  type SettlementAssetGroupParitySummary,
  type SuiReadCoreClient,
  type SuiReadServiceOptions,
  type WalletAssetClassificationSummary,
  type WalletBalanceInput,
  type WalletBalanceSummary,
  type DeepbookQuoteFeeMode
} from "./readServiceTypes.js";

export * from "./readServiceTypes.js";
export { listDeepbookTokenRegistry } from "./deepbookRegistry.js";

type WalletBalanceClassificationScan = {
  classifiedAssets: ClassifiedWalletAsset[];
  uninspectedAssetClasses: UninspectedAssetClass[];
  inspectedBalancePages: number;
  inspectedCoinBalanceCount: number;
  blockedReason?: IntentEvidenceBlockedReason | undefined;
};

export class SuiReadService {
  readonly #client: SuiReadCoreClient;
  readonly #network: "mainnet";
  readonly #chainIdentifier: string;
  readonly #coinMetadataCache: CoinMetadataCache;
  readonly #now: () => Date;
  readonly #deepbookFactory: (simulationSender: string, options?: DeepBookFactoryOptions) => DeepBookReadClient;
  readonly #coinMetadataTtlMs: number;
  readonly #deepbookCoins: DeepBookCoinRegistry;
  readonly prices: DeepbookUsdcPriceService;
  readonly #accounts: AccountInventoryReader;

  constructor(options: SuiReadServiceOptions) {
    this.#client = options.client;
    this.#network = options.network;
    this.#chainIdentifier = options.chainIdentifier;
    this.#coinMetadataCache = options.coinMetadataCache;
    this.#now = options.now ?? (() => new Date());
    this.#coinMetadataTtlMs = options.coinMetadataTtlMs ?? COIN_METADATA_CACHE_TTL_MS;
    this.#deepbookCoins = options.deepbookCoins ?? PINNED_DEEPBOOK_COINS;
    this.#deepbookFactory =
      options.deepbookFactory ??
      ((simulationSender, factoryOptions) =>
        createDeepBookReadClient({
          client: options.client as SuiGrpcClient,
          simulationSender,
          network: this.#network,
          ...(factoryOptions?.balanceManagers === undefined
            ? {}
            : { balanceManagers: factoryOptions.balanceManagers })
        }));
    this.prices = new DeepbookUsdcPriceService(options.deepbookCandleSource, () => this.#fetchedAt());
    this.#accounts = new AccountInventoryReader(options.client, balance => this.#withUnit(balance), () => this.#fetchedAt());
  }

  async summarizeWalletAssets(input: WalletBalanceInput): Promise<WalletBalanceSummary> {
    const options: SuiClientTypes.ListBalancesOptions = { owner: input.account };
    if (input.cursor !== undefined) {
      options.cursor = input.cursor;
    }
    const result = await this.#client.core.listBalances(options);
    const balances: WalletBalanceWithUnit[] = [];
    for (const balance of result.balances) {
      balances.push(await this.#withUnit(balance));
    }

    return {
      status: "ok",
      account: input.account,
      fetchedAt: this.#fetchedAt(),
      userAnswerUse: walletBalanceUserAnswerUse(),
      quantitySemantics: walletBalanceQuantitySemantics(),
      source: {
        sdk: "@mysten/sui",
        transport: "grpc",
        method: "client.core.listBalances"
      },
      balances,
      hasNextPage: result.hasNextPage,
      cursor: result.cursor
    };
  }

  async classifyWalletAssets(input: WalletBalanceInput): Promise<WalletAssetClassificationSummary> {
    const summary = await this.summarizeWalletAssets(input);
    return {
      status: "ok",
      account: summary.account,
      fetchedAt: summary.fetchedAt,
      userAnswerUse: walletClassificationUserAnswerUse(),
      quantitySemantics: summary.quantitySemantics,
      source: summary.source,
      classifiedAssets: summary.balances.map((balance) => classifyWalletBalance(balance, this.#deepbookCoins)),
      uninspectedAssetClasses: NOT_INSPECTED_ASSET_CLASSES.map((assetClass) => ({ ...assetClass })),
      hasNextPage: summary.hasNextPage,
      cursor: summary.cursor
    };
  }

  // The public account snapshot for the account page: the SuiNS name, coin
  // balances (with the held-as split), owned NFTs, and other owned objects grouped
  // by type. Each part is read independently so a missing name or object scan never
  // blocks the balances.
  summarizeAccountInventory(input: WalletBalanceInput) { return this.#accounts.summarizeAccountInventory(input); }

  listSettlementAssetGroups(): SettlementAssetGroupListSummary {
    return {
      status: "ok",
      fetchedAt: this.#fetchedAt(),
      assetGroups: [buildUsdSettlementAssetGroup(this.#deepbookCoins)]
    };
  }

  async summarizeSettlementAssetGroupParity(
    input: SettlementAssetGroupParityInput & { simulationSender: string }
  ): Promise<SettlementAssetGroupParitySummary> {
    let denomination: SettlementAssetGroupParitySummary["denomination"];
    try {
      denomination = normalizeSettlementDenomination(input.denomination);
    } catch {
      throw new ReadServiceInputError("input_invalid", "Unsupported settlement denomination", {
        field: "denomination",
        value: input.denomination,
        supportedAliases: buildUsdSettlementAssetGroup(this.#deepbookCoins).aliases
      });
    }

    const assetGroup = buildUsdSettlementAssetGroup(this.#deepbookCoins);
    if (assetGroup.includedAssets.length === 0) {
      throw new ReadServiceInputError("registry_miss", "No pinned USD-denominated settlement assets are available", {
        assetGroupId: assetGroup.id
      });
    }
    const referenceAsset = this.#resolveSettlementAssetGroupSymbol(
      input.referenceAssetSymbol ?? "USDC",
      assetGroup,
      "referenceAssetSymbol"
    );
    const deepbook = this.#deepbookFactory(input.simulationSender);
    const assets = await Promise.all(
      assetGroup.includedAssets.map((asset) => this.#settlementAssetGroupParityAsset(asset, referenceAsset, deepbook))
    );
    const samples = assets.filter(
      (asset): asset is Extract<SettlementAssetGroupParityAsset, { status: "reference_asset" | "measured" }> =>
        asset.status === "reference_asset" || asset.status === "measured"
    );
    if (samples.length === 0) {
      throw new ReadServiceInputError("registry_miss", "No parity samples are available for the settlement asset group", {
        assetGroupId: assetGroup.id,
        referenceAssetSymbol: referenceAsset.symbol
      });
    }
    const statistics = settlementAssetGroupParityStatistics(samples, assets.length - samples.length);

    return {
      status: "ok",
      fetchedAt: this.#fetchedAt(),
      denomination,
      assetGroupId: assetGroup.id,
      userAnswerUse: settlementAssetGroupParityUserAnswerUse(),
      referenceAsset: {
        ...referenceAsset,
        role: "measurement_reference_not_settlement_choice"
      },
      quantitySemantics: settlementAssetGroupParityQuantitySemantics(),
      evidenceSources: {
        settlementAssetGroup: assetGroup.evidenceSources,
        midPrice: {
          ...DEEPBOOK_SDK_SIMULATION_SOURCE_BASE,
          method: "midPrice",
          precision: DEEPBOOK_MID_PRICE_PRECISION
        }
      },
      assets,
      statistics,
      responseSummary: settlementAssetGroupParityResponseSummary({
        assetGroupId: assetGroup.id,
        referenceAssetSymbol: referenceAsset.symbol,
        statistics
      }),
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
      ]
    };
  }

  async previewIntentEvidence(input: IntentEvidenceInput): Promise<IntentEvidenceSummary> {
    if (!isSupportedIntentEvidenceKind(input.intentKind)) {
      throw new ReadServiceInputError("input_invalid", "Unsupported intentKind", {
        field: "intentKind",
        value: input.intentKind
      });
    }
    if (input.intentKind === "cover_payment_like_amount" && input.requiredDisplayAmount === undefined) {
      throw new ReadServiceInputError("input_invalid", "requiredDisplayAmount is required for cover_payment_like_amount", {
        field: "requiredDisplayAmount",
        intentKind: input.intentKind
      });
    }
    if (
      input.targetAssetSelectionSource !== undefined &&
      !isIntentEvidenceTargetAssetSelectionSource(input.targetAssetSelectionSource)
    ) {
      throw new ReadServiceInputError("input_invalid", "Unsupported targetAssetSelectionSource", {
        field: "targetAssetSelectionSource",
        value: input.targetAssetSelectionSource,
        supportedValues: [...INTENT_EVIDENCE_TARGET_ASSET_SELECTION_SOURCES]
      });
    }
    if (input.intentKind === "summarize_settlement_asset_group_balance") {
      if (input.requiredDisplayAmount !== undefined) {
        throw new ReadServiceInputError(
          "input_invalid",
          "requiredDisplayAmount is only supported for cover_payment_like_amount",
          {
            field: "requiredDisplayAmount",
            intentKind: input.intentKind
          }
        );
      }
      if (input.targetAssetSymbol !== undefined) {
        throw new ReadServiceInputError(
          "input_invalid",
          "targetAssetSymbol is only supported for cover_payment_like_amount",
          {
            field: "targetAssetSymbol",
            intentKind: input.intentKind
          }
        );
      }
      if (input.targetAssetSelectionSource !== undefined) {
        throw new ReadServiceInputError(
          "input_invalid",
          "targetAssetSelectionSource is only supported for cover_payment_like_amount",
          {
            field: "targetAssetSelectionSource",
            intentKind: input.intentKind
          }
        );
      }
      if (input.acceptedSourceAssetSymbols !== undefined) {
        throw new ReadServiceInputError(
          "input_invalid",
          "acceptedSourceAssetSymbols is only supported for cover_payment_like_amount",
          {
            field: "acceptedSourceAssetSymbols",
            intentKind: input.intentKind
          }
        );
      }
    }
    if (input.intentKind === "cover_payment_like_amount") {
      if (input.targetAssetSymbol !== undefined && input.targetAssetSelectionSource === undefined) {
        throw new ReadServiceInputError(
          "input_invalid",
          "targetAssetSelectionSource is required when targetAssetSymbol is supplied",
          {
            field: "targetAssetSelectionSource",
            requiredWith: "targetAssetSymbol",
            supportedValues: [...INTENT_EVIDENCE_TARGET_ASSET_SELECTION_SOURCES]
          }
        );
      }
      if (input.targetAssetSymbol === undefined && input.targetAssetSelectionSource !== undefined) {
        throw new ReadServiceInputError(
          "input_invalid",
          "targetAssetSymbol is required when targetAssetSelectionSource is supplied",
          {
            field: "targetAssetSymbol",
            requiredWith: "targetAssetSelectionSource"
          }
        );
      }
    }

    let denomination: IntentEvidenceSummary["intent"]["denomination"];
    try {
      denomination = normalizeSettlementDenomination(input.denomination);
    } catch {
      throw new ReadServiceInputError("input_invalid", "Unsupported settlement denomination", {
        field: "denomination",
        value: input.denomination,
        supportedAliases: buildUsdSettlementAssetGroup(this.#deepbookCoins).aliases
      });
    }

    const assetGroup = buildUsdSettlementAssetGroup(this.#deepbookCoins);
    if (assetGroup.includedAssets.length === 0) {
      throw new ReadServiceInputError("registry_miss", "No pinned USD-denominated settlement assets are available", {
        assetGroupId: assetGroup.id
      });
    }

    const targetAsset =
      input.intentKind !== "cover_payment_like_amount" || input.targetAssetSymbol === undefined
        ? undefined
        : this.#resolveSettlementAssetGroupSymbol(input.targetAssetSymbol, assetGroup, "targetAssetSymbol");
    const targetAssetSelectionSource =
      targetAsset === undefined ? undefined : input.targetAssetSelectionSource;
    const acceptedSourceSymbols =
      input.intentKind !== "cover_payment_like_amount" || input.acceptedSourceAssetSymbols === undefined
        ? undefined
        : input.acceptedSourceAssetSymbols.map((symbol, index) =>
            this.#resolveSettlementAssetGroupSymbol(symbol, assetGroup, `acceptedSourceAssetSymbols[${index}]`).symbol
          );
    const acceptedSourceSet =
      acceptedSourceSymbols === undefined ? undefined : new Set(acceptedSourceSymbols);

    const scan = await this.#scanWalletAssetClassificationPages(input.account);
    const balances = this.#intentEvidenceAssetGroupBalances(assetGroup, scan.classifiedAssets);
    const commonDecimals = commonAssetGroupDecimals(assetGroup.includedAssets);
    const aggregate = this.#intentEvidenceAggregate({
      requiredDisplayAmount: input.requiredDisplayAmount,
      balances,
      commonDecimals,
      blockedReason: scan.blockedReason
    });
    const settlementAssetCoverage = this.#intentEvidenceSettlementAssetCoverage(aggregate);
    const requiredDisplayAmount = input.requiredDisplayAmount;
    let selectedTarget: IntentEvidenceSelectedTarget | undefined;
    if (targetAsset !== undefined) {
      if (requiredDisplayAmount === undefined) {
        throw new Error("target settlement evidence requires requiredDisplayAmount");
      }
      if (targetAssetSelectionSource === undefined) {
        throw new Error("target settlement evidence requires user selection provenance");
      }
      if (scan.blockedReason === undefined) {
        selectedTarget = this.#intentEvidenceSelectedTarget({
          targetAsset,
          selectionSource: targetAssetSelectionSource,
          requiredDisplayAmount,
          balances
        });
      }
    }

    const candidateConversions =
      input.intentKind === "cover_payment_like_amount" && scan.blockedReason === undefined
        ? await this.#intentEvidenceCandidateConversions({
            targetAsset,
            balances,
            acceptedSourceSet
          })
        : [];
    const requiredUserChoices = this.#intentEvidenceRequiredUserChoices(
      input.intentKind,
      targetAsset,
      candidateConversions
    );
    const responseEvidence = intentEvidenceResponseEvidence(targetAsset, settlementAssetCoverage, candidateConversions);
    const responseSummary = intentEvidenceResponseSummary({
      intentKind: input.intentKind,
      assetGroupId: assetGroup.id,
      settlementAssetCoverage,
      responseEvidenceMode: responseEvidence.mode,
      requiredUserChoices
    });
    const { excludedAssets: _excludedAssets, ...settlementAssetGroup } = assetGroup;

    return {
      status: "ok",
      account: input.account,
      fetchedAt: this.#fetchedAt(),
      userAnswerUse: intentEvidenceUserAnswerUse(settlementAssetCoverage.status, responseEvidence),
      intent: {
        intentKind: input.intentKind,
        denomination,
        ...(input.requiredDisplayAmount === undefined ? {} : { requiredDisplayAmount: input.requiredDisplayAmount }),
        ...(targetAsset === undefined
          ? {}
          : { targetAssetSymbol: targetAsset.symbol, targetAssetSelectionSource }),
        ...(acceptedSourceSymbols === undefined ? {} : { acceptedSourceAssetSymbols: acceptedSourceSymbols })
      },
      quantitySemantics: intentEvidenceQuantitySemantics(),
      evidenceSources: {
        walletBalances: {
          sdk: "@mysten/sui",
          transport: "grpc",
          method: "client.core.listBalances"
        },
        settlementAssetGroup: assetGroup.evidenceSources,
        quoteEvidence: DEEPBOOK_SOURCE_FIELD_VALUES.pinnedSdkWhenTargetAssetSelected
      },
      settlementAssetGroup,
      balances,
      aggregate,
      settlementAssetCoverage,
      ...(selectedTarget === undefined ? {} : { selectedTarget }),
      candidateConversions,
      blockedReasons: scan.blockedReason === undefined ? [] : [scan.blockedReason],
      responseEvidence,
      responseSummary,
      requiredUserChoices,
      supportedClaims: intentEvidenceSupportedClaims(settlementAssetCoverage, selectedTarget, candidateConversions),
      unsupportedClaims: [
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
      ],
      uninspectedAssetClasses: scan.uninspectedAssetClasses,
      inspectedBalancePages: scan.inspectedBalancePages,
      inspectedCoinBalanceCount: scan.inspectedCoinBalanceCount
    };
  }

  async inspectDeepbookOrderbook(input: {
    poolKey: string;
    ticks: number;
    simulationSender: string;
  }): Promise<DeepbookOrderbookSummary> {
    getKnownPool(input.poolKey);
    assertPositiveInteger(input.ticks, "ticks", MAX_DEEPBOOK_ORDERBOOK_TICKS);

    const deepbook = this.#deepbookFactory(input.simulationSender);
    const [midPrice, poolBookParams, level2TicksFromMid] = await Promise.all([
      deepbook.midPrice(input.poolKey),
      deepbook.poolBookParams(input.poolKey),
      deepbook.getLevel2TicksFromMid(input.poolKey, input.ticks)
    ]);
    const checkedMidPrice = assertValidDeepbookMidPrice(input.poolKey, midPrice);

    return {
      status: "ok",
      poolKey: input.poolKey,
      ticks: input.ticks,
      fetchedAt: this.#fetchedAt(),
      userAnswerUse: deepbookOrderbookUserAnswerUse(),
      source: {
        ...DEEPBOOK_SDK_SIMULATION_SOURCE_BASE,
        methods: ["midPrice", "poolBookParams", "getLevel2TicksFromMid"]
      },
      midPrice: checkedMidPrice,
      poolBookParams,
      level2TicksFromMid
    };
  }

  async getDeepbookMidPrice(input: {
    poolKey: string;
    simulationSender: string;
  }): Promise<DeepbookMidPriceSummary> {
    const pool = getKnownPool(input.poolKey);
    const deepbook = this.#deepbookFactory(input.simulationSender);
    const midPrice = assertValidDeepbookMidPrice(input.poolKey, await deepbook.midPrice(input.poolKey));

    return {
      status: "ok",
      poolKey: input.poolKey,
      base: pool.baseCoin,
      quote: pool.quoteCoin,
      userAnswerUse: deepbookMidPriceUserAnswerUse(),
      priceSemantics: deepbookMidPriceSemantics(),
      price: midPrice,
      priceDirection: DEEPBOOK_MID_PRICE_DIRECTION,
      priceType: DEEPBOOK_MID_PRICE_TYPE,
      fetchedAt: this.#fetchedAt(),
      source: {
        ...DEEPBOOK_SDK_SIMULATION_SOURCE_BASE,
        method: "midPrice",
        precision: DEEPBOOK_MID_PRICE_PRECISION
      }
    };
  }

  priceHistoryReaderForRequest(signal?: AbortSignal, baseTypes?: readonly string[]) {
    return this.prices.priceHistoryReaderForRequest(signal, baseTypes);
  }
  async getDeepbookUsdcPriceHistory(input: DeepbookUsdcPriceHistoryInput, signal?: AbortSignal) { return this.prices.prepareHistory(input).read(signal); }
  async getDeepbookUsdcPriceAtTime(input: DeepbookUsdcPriceAtTimeInput, signal?: AbortSignal) { return this.prices.preparePoint(input).read(signal); }

  async quoteDeepbookAction(input: DeepbookRawQuoteInput): Promise<DeepbookQuoteSummary> {
    return this.#readDeepbookQuote(input, deepbookQuoteAssets(input.poolKey, this.#deepbookCoins));
  }

  async #readDeepbookQuote(
    input: DeepbookRawQuoteInput,
    assets: ReturnType<typeof deepbookQuoteAssets>
  ): Promise<DeepbookQuoteSummary> {
    const amount = parseRawAmount(input.amountRaw);
    const feeMode = input.feeMode ?? "deep";
    const getter = deepbookQuoteGetters[input.direction][feeMode];
    const deepbook = this.#deepbookFactory(input.simulationSender);
    const read = deepbook[`${getter.method}Raw`];
    if (!read) {
      throw new ReadServiceInputError("quote_unavailable", "DeepBook quote getter is unavailable", {
        poolKey: input.poolKey, method: getter.method
      });
    }
    const [{ rawReturnValues, fetchedAt }, gasFeePolicy] = await Promise.all([
      read.call(deepbook, input.poolKey, amount).then(rawReturnValues => ({
        rawReturnValues, fetchedAt: this.#fetchedAt()
      })),
      deepbook.gasFeePolicy?.(input.poolKey).then(
        policy => ({ status: policy.enabled ? "enabled" as const : "disabled" as const, additionalTakerFeeRaw: policy.additionalTakerFeeRaw }),
        () => ({ status: "unavailable" as const }))
    ]);
    const rawQuote = this.#toDeepbookRawQuoteEvidence({
      assets, direction: input.direction, amountRaw: input.amountRaw, feeMode,
      rawReturnValues: gasFeePolicy && rawReturnValues.poolTerms ? { ...rawReturnValues, poolTerms: { ...rawReturnValues.poolTerms, gasFeePolicy } } : rawReturnValues
    });
    const quote = toDeepbookDisplayQuoteFromRaw(rawReturnValues, {
      baseDecimals: rawQuote.baseOut.decimals,
      quoteDecimals: rawQuote.quoteOut.decimals,
      deepDecimals: rawQuote.deepRequired.decimals
    });
    const inputFlow = deepbookQuoteInputFlow(rawQuote);
    const minimumInput = deepbookMinimumInputRaw(rawQuote);
    if (minimumInput !== undefined) rawQuote.minimumInputRaw = minimumInput.toString();
    let quoteOutcome: DeepbookQuoteSummary["quoteOutcome"];
    if (minimumInput !== undefined && amount < minimumInput) quoteOutcome = "below_minimum_input";
    else if (BigInt(rawQuote.directionalOutput.raw) > 0n) quoteOutcome = BigInt(inputFlow.expectedReturnRaw) === 0n ? "full_input_spend" : "input_returned";
    else if (rawQuote.poolTerms?.bestOppositePriceRaw === null) quoteOutcome = "empty_opposite_book";
    else if (rawQuote.poolTerms?.minimumBuyQuoteRaw === null) quoteOutcome = "insufficient_depth_for_minimum";
    else quoteOutcome = "no_output";
    return {
      status: "ok",
      poolKey: input.poolKey,
      direction: input.direction,
      amountRaw: input.amountRaw,
      fetchedAt,
      userAnswerUse: deepbookQuoteUserAnswerUse("raw", !!rawQuote.poolTerms?.gasFeePolicy),
      quantitySemantics: deepbookQuoteQuantitySemantics("raw_u64"),
      source: {
        ...DEEPBOOK_SDK_SIMULATION_SOURCE_BASE,
        method: getter.method,
        returnValueEncoding: "bcs.u64"
      },
      quote,
      inputFlow,
      quoteOutcome,
      rawQuote
    };
  }

  async quoteDeepbookDisplayAmount(input: {
    poolKey: string;
    direction: QuoteDirection;
    amountDisplay: string;
    simulationSender: string;
    feeMode?: DeepbookQuoteFeeMode | undefined;
  }): Promise<DeepbookDisplayQuoteSummary> {
    const assets = deepbookQuoteAssets(input.poolKey, this.#deepbookCoins);
    const sourceAsset = input.direction === "base_to_quote" ? assets.base : assets.quote;
    const amountRaw = parseQuoteDisplayAmount(input.amountDisplay, sourceAsset.decimals);
    const rawQuote = await this.#readDeepbookQuote({ ...input, amountRaw }, assets);

    return {
      status: "ok",
      pool: {
        poolKey: input.poolKey,
        base: assets.base.symbol,
        quote: assets.quote.symbol
      },
      direction: input.direction,
      inputAmount: {
        display: input.amountDisplay,
        raw: amountRaw,
        asset: sourceAsset
      },
      fetchedAt: rawQuote.fetchedAt,
      userAnswerUse: deepbookQuoteUserAnswerUse("display", !!rawQuote.rawQuote.poolTerms?.gasFeePolicy),
      quantitySemantics: deepbookQuoteQuantitySemantics("display_source_amount_converted_to_raw_u64"),
      source: rawQuote.source,
      inputFlow: rawQuote.inputFlow,
      quoteOutcome: rawQuote.quoteOutcome,
      quote: rawQuote.quote,
      rawQuote: rawQuote.rawQuote
    };
  }

  #toDeepbookRawQuoteEvidence(input: {
    assets: ReturnType<typeof deepbookQuoteAssets>;
    direction: QuoteDirection;
    amountRaw: string;
    rawReturnValues: DeepbookRawQuoteReturnValues;
    feeMode: DeepbookQuoteFeeMode;
  }): DeepbookRawQuoteEvidence {
    const baseOut = { ...input.assets.base, raw: input.rawReturnValues.baseOutRaw };
    const quoteOut = { ...input.assets.quote, raw: input.rawReturnValues.quoteOutRaw };
    return {
      kind: DEEPBOOK_RAW_QUOTE_QUANTITY_KIND,
      ...(input.rawReturnValues.poolTerms ? { poolTerms: input.rawReturnValues.poolTerms } : {}),
      sourceMoveFunction: deepbookQuoteGetters[input.direction][input.feeMode].move,
      returnValueSourceMoveFunction:
        input.feeMode === "input_coin" ? "pool::get_quantity_out_input_fee" : "pool::get_quantity_out",
      returnValueOrder: ["base_quantity_out", "quote_quantity_out", "deep_quantity_required"],
      inputAmount: { ...(input.direction === "base_to_quote" ? baseOut : quoteOut), raw: input.amountRaw },
      baseOut,
      quoteOut,
      deepRequired: { ...input.assets.deep, raw: input.rawReturnValues.deepRequiredRaw },
      directionalOutput: input.direction === "base_to_quote" ? quoteOut : baseOut,
      boundary: {
        outputBeforeSlippagePolicy: true,
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
        ]
      }
    };
  }

  async summarizeDeepbookAccountInventory(
    input: DeepbookAccountInventoryInput
  ): Promise<DeepbookAccountInventorySummary> {
    const normalizedManagerAddress = normalizeOptionalManagerAddress(input.managerAddress);
    const pool = input.poolKey === undefined ? undefined : getKnownPool(input.poolKey);
    const discoveryClient = this.#deepbookFactory(input.account);
    const managerAddresses = normalizeManagerAddresses(await discoveryClient.getBalanceManagerIds(input.account));
    const requested = {
      ...(input.poolKey === undefined ? {} : { poolKey: input.poolKey }),
      ...(normalizedManagerAddress === undefined ? {} : { managerAddress: normalizedManagerAddress })
    };
    const base = {
      status: "ok" as const,
      account: input.account,
      fetchedAt: this.#fetchedAt(),
      requested,
      managerAddresses,
      quantitySemantics: deepbookDisplayQuantitySemantics(),
      ...(input.poolKey === undefined || pool === undefined
        ? {}
        : {
            pool: {
              poolKey: input.poolKey,
              base: pool.baseCoin,
              quote: pool.quoteCoin
            }
          })
    };

    if (input.poolKey === undefined && normalizedManagerAddress === undefined) {
      return {
        ...base,
        userAnswerUse: deepbookAccountInventoryUserAnswerUse("manager_discovery_only"),
        detailStatus: "manager_discovery_only",
        source: deepbookAccountInventorySource(["getBalanceManagerIds"])
      };
    }
    if (input.poolKey === undefined) {
      return {
        ...base,
        userAnswerUse: deepbookAccountInventoryUserAnswerUse("pool_key_required"),
        detailStatus: "pool_key_required",
        source: deepbookAccountInventorySource(["getBalanceManagerIds"])
      };
    }
    if (normalizedManagerAddress === undefined) {
      return {
        ...base,
        userAnswerUse: deepbookAccountInventoryUserAnswerUse("manager_address_required"),
        detailStatus: "manager_address_required",
        source: deepbookAccountInventorySource(["getBalanceManagerIds"])
      };
    }
    if (!managerAddresses.includes(normalizedManagerAddress)) {
      return {
        ...base,
        userAnswerUse: deepbookAccountInventoryUserAnswerUse("manager_address_not_discovered_for_active_account"),
        detailStatus: "manager_address_not_discovered_for_active_account",
        source: deepbookAccountInventorySource(["getBalanceManagerIds"])
      };
    }

    const detailClient = this.#deepbookFactory(input.account, {
      balanceManagers: {
        [normalizedManagerAddress]: { address: normalizedManagerAddress }
      }
    });
    const accountExists = await detailClient.accountExists(input.poolKey, normalizedManagerAddress);
    if (!accountExists) {
      return {
        ...base,
        userAnswerUse: deepbookAccountInventoryUserAnswerUse("account_not_found"),
        detailStatus: "account_not_found",
        source: deepbookAccountInventorySource(["getBalanceManagerIds", "accountExists"]),
        accountExists
      };
    }

    const [accountSummary, lockedBalances, openOrderIds] = await Promise.all([
      detailClient.account(input.poolKey, normalizedManagerAddress),
      detailClient.lockedBalance(input.poolKey, normalizedManagerAddress),
      detailClient.accountOpenOrders(input.poolKey, normalizedManagerAddress)
    ]);
    const cappedOpenOrderIds = openOrderIds.slice(0, MAX_DEEPBOOK_ACCOUNT_OPEN_ORDER_IDS);

    return {
      ...base,
      userAnswerUse: deepbookAccountInventoryUserAnswerUse("available"),
      detailStatus: "available",
      source: deepbookAccountInventorySource([
        "getBalanceManagerIds",
        "accountExists",
        "account",
        "lockedBalance",
        "accountOpenOrders"
      ]),
      accountExists,
      accountSummary: toDeepbookAccountSummary(accountSummary),
      lockedBalances: assertDeepbookDisplayBalances(lockedBalances, "lockedBalances"),
      openOrderIds: cappedOpenOrderIds,
      openOrderCount: openOrderIds.length,
      openOrderIdsTruncated: openOrderIds.length > cappedOpenOrderIds.length
    };
  }

  #resolveSettlementAssetGroupSymbol(symbol: string, assetGroup: SettlementAssetGroup, field: string): SettlementAssetGroupAsset {
    const canonical = canonicalDeepbookSymbol(symbol, this.#deepbookCoins);
    if (canonical === undefined) {
      throw new ReadServiceInputError("input_invalid", "Settlement asset symbol is not in the pinned DeepBook registry", {
        field,
        value: symbol
      });
    }
    const asset = assetGroup.includedAssets.find((candidate) => candidate.symbol === canonical);
    if (asset === undefined) {
      throw new ReadServiceInputError("input_invalid", "Settlement asset symbol is not in the supported assetGroup", {
        field,
        value: symbol,
        canonicalSymbol: canonical,
        assetGroupId: assetGroup.id
      });
    }
    return asset;
  }

  #intentEvidenceAssetGroupBalances(
    assetGroup: SettlementAssetGroup,
    classifiedAssets: ClassifiedWalletAsset[]
  ): IntentEvidenceSettlementAssetBalance[] {
    return assetGroup.includedAssets.map((asset) => {
      const matchingBalances = classifiedAssets
        .filter((classified) => {
          try {
            return normalizeCoinType(classified.balance.coinType) === asset.coinType;
          } catch {
            return false;
          }
        })
        .map((classified) => classified.balance.balance);
      const currentRawAmount = sumRawAmounts(matchingBalances);
      return {
        ...asset,
        currentRawAmount,
        currentDisplayAmount: formatSettlementAssetRawAmount(currentRawAmount, asset.decimals),
        walletBalanceEvidence: "current_wallet_coin_balance_snapshot"
      };
    });
  }

  #intentEvidenceAggregate(input: {
    requiredDisplayAmount: string | undefined;
    balances: IntentEvidenceSettlementAssetBalance[];
    commonDecimals: number | undefined;
    blockedReason: IntentEvidenceBlockedReason | undefined;
  }): IntentEvidenceSummary["aggregate"] {
    if (input.blockedReason !== undefined) {
      return {
        status: "unavailable_wallet_balance_scan_incomplete",
        ...(input.requiredDisplayAmount === undefined ? {} : { requiredDisplayAmount: input.requiredDisplayAmount }),
        reason: input.blockedReason
      };
    }

    if (input.commonDecimals === undefined) {
      return {
        status: "unavailable_mixed_decimals",
        ...(input.requiredDisplayAmount === undefined ? {} : { requiredDisplayAmount: input.requiredDisplayAmount })
      };
    }
    const currentRawAmount = sumRawAmounts(input.balances.map((balance) => balance.currentRawAmount));
    if (input.requiredDisplayAmount === undefined) {
      return {
        status: "available",
        currentRawAmount,
        currentDisplayAmount: formatSettlementAssetRawAmount(currentRawAmount, input.commonDecimals),
        decimals: input.commonDecimals,
        unitSource: DEEPBOOK_SCALAR_UNIT_SOURCE
      };
    }
    const requiredRawAmount = this.#parseIntentDisplayAmount(
      input.requiredDisplayAmount,
      input.commonDecimals,
      "requiredDisplayAmount"
    );
    const shortfallRawAmount =
      BigInt(currentRawAmount) >= BigInt(requiredRawAmount)
        ? "0"
        : (BigInt(requiredRawAmount) - BigInt(currentRawAmount)).toString();
    return {
      status: "available",
      requiredDisplayAmount: input.requiredDisplayAmount,
      requiredRawAmount,
      currentRawAmount,
      currentDisplayAmount: formatSettlementAssetRawAmount(currentRawAmount, input.commonDecimals),
      shortfallRawAmount,
      shortfallDisplayAmount: formatSettlementAssetRawAmount(shortfallRawAmount, input.commonDecimals),
      decimals: input.commonDecimals,
      unitSource: DEEPBOOK_SCALAR_UNIT_SOURCE
    };
  }

  #intentEvidenceSettlementAssetCoverage(
    aggregate: IntentEvidenceSummary["aggregate"]
  ): IntentEvidenceSettlementAssetCoverage {
    const boundary = intentEvidenceSettlementAssetCoverageBoundary();
    if (aggregate.status === "unavailable_mixed_decimals") {
      return {
        status: "unavailable_mixed_decimals",
        ...(aggregate.requiredDisplayAmount === undefined
          ? {}
          : { requiredDisplayAmount: aggregate.requiredDisplayAmount }),
        reason: "asset_group_assets_do_not_share_verified_decimals",
        boundary
      };
    }
    if (aggregate.status === "unavailable_wallet_balance_scan_incomplete") {
      return {
        status: "unavailable_wallet_balance_scan_incomplete",
        ...(aggregate.requiredDisplayAmount === undefined
          ? {}
          : { requiredDisplayAmount: aggregate.requiredDisplayAmount }),
        reason: aggregate.reason,
        boundary
      };
    }

    if (aggregate.requiredDisplayAmount === undefined) {
      return {
        status: "balance_total_only",
        currentRawAmount: aggregate.currentRawAmount,
        currentDisplayAmount: aggregate.currentDisplayAmount,
        decimals: aggregate.decimals,
        unitSource: aggregate.unitSource,
        boundary
      };
    }

    if (
      aggregate.requiredRawAmount === undefined ||
      aggregate.shortfallRawAmount === undefined ||
      aggregate.shortfallDisplayAmount === undefined
    ) {
      throw new Error("settlement-asset coverage requires complete target amount evidence");
    }

    const shortfallRawAmount = aggregate.shortfallRawAmount;
    return {
      status: BigInt(shortfallRawAmount) === 0n ? "covered_by_settlement_asset_balance" : "shortfall_in_settlement_asset_balance",
      requiredDisplayAmount: aggregate.requiredDisplayAmount,
      requiredRawAmount: aggregate.requiredRawAmount,
      currentRawAmount: aggregate.currentRawAmount,
      currentDisplayAmount: aggregate.currentDisplayAmount,
      shortfallRawAmount,
      shortfallDisplayAmount: aggregate.shortfallDisplayAmount,
      decimals: aggregate.decimals,
      unitSource: aggregate.unitSource,
      boundary
    };
  }

  #intentEvidenceSelectedTarget(input: {
    targetAsset: SettlementAssetGroupAsset;
    selectionSource: IntentEvidenceTargetAssetSelectionSource;
    requiredDisplayAmount: string;
    balances: IntentEvidenceSettlementAssetBalance[];
  }): IntentEvidenceSelectedTarget {
    const targetBalance = input.balances.find((balance) => balance.symbol === input.targetAsset.symbol);
    const currentRawAmount = targetBalance?.currentRawAmount ?? "0";
    const requiredRawAmount = this.#parseIntentDisplayAmount(
      input.requiredDisplayAmount,
      input.targetAsset.decimals,
      "requiredDisplayAmount"
    );
    const shortfallRawAmount =
      BigInt(currentRawAmount) >= BigInt(requiredRawAmount)
        ? "0"
        : (BigInt(requiredRawAmount) - BigInt(currentRawAmount)).toString();
    return {
      ...input.targetAsset,
      selectionSource: input.selectionSource,
      requiredRawAmount,
      currentRawAmount,
      currentDisplayAmount: formatSettlementAssetRawAmount(currentRawAmount, input.targetAsset.decimals),
      shortfallRawAmount,
      shortfallDisplayAmount: formatSettlementAssetRawAmount(shortfallRawAmount, input.targetAsset.decimals)
    };
  }

  async #settlementAssetGroupParityAsset(
    asset: SettlementAssetGroupAsset,
    referenceAsset: SettlementAssetGroupAsset,
    deepbook: DeepBookReadClient
  ): Promise<SettlementAssetGroupParityAsset> {
    if (asset.symbol === referenceAsset.symbol) {
      return {
        ...asset,
        status: "reference_asset",
        priceInReferenceAsset: 1,
        parityDirection: "reference_asset_per_group_asset",
        reason: "reference_asset_is_measurement_baseline_not_settlement_choice"
      };
    }

    let directPool: { poolKey: string; direction: QuoteDirection };
    try {
      const resolved = resolveDeepbookPoolForSymbols({
        sourceSymbol: asset.symbol,
        targetSymbol: referenceAsset.symbol
      });
      directPool = { poolKey: resolved.poolKey, direction: resolved.direction };
    } catch {
      return {
        ...asset,
        status: "no_direct_deepbook_pool",
        reason: "No direct DeepBook mainnet pool exists between this group asset and the measurement reference asset."
      };
    }

    let poolMidPrice: number;
    try {
      poolMidPrice = assertValidDeepbookMidPrice(directPool.poolKey, await deepbook.midPrice(directPool.poolKey));
    } catch (error) {
      return {
        ...asset,
        status: "mid_price_unavailable",
        poolKey: directPool.poolKey,
        direction: directPool.direction,
        reason: error instanceof Error ? error.message : "DeepBook mid-price lookup failed."
      };
    }

    return {
      ...asset,
      status: "measured",
      priceInReferenceAsset: roundPriceInReferenceAsset(directPool.direction === "base_to_quote" ? poolMidPrice : 1 / poolMidPrice),
      parityDirection: "reference_asset_per_group_asset",
      poolKey: directPool.poolKey,
      direction: directPool.direction,
      poolMidPrice,
      poolMidPriceDirection: DEEPBOOK_MID_PRICE_DIRECTION
    };
  }

  async #intentEvidenceCandidateConversions(input: {
    targetAsset: SettlementAssetGroupAsset | undefined;
    balances: IntentEvidenceSettlementAssetBalance[];
    acceptedSourceSet: Set<string> | undefined;
  }): Promise<IntentEvidenceCandidateConversion[]> {
    const candidates: IntentEvidenceCandidateConversion[] = [];
    for (const balance of input.balances) {
      if (balance.currentRawAmount === "0" || balance.symbol === input.targetAsset?.symbol) {
        continue;
      }
      if (input.acceptedSourceSet !== undefined && !input.acceptedSourceSet.has(balance.symbol)) {
        candidates.push({
          sourceSymbol: balance.symbol,
          ...(input.targetAsset === undefined ? {} : { targetSymbol: input.targetAsset.symbol }),
          sourceRawAmount: balance.currentRawAmount,
          sourceDisplayAmount: balance.currentDisplayAmount,
          status: "filtered_by_accepted_source_assets",
          reason: "The source asset was not included in acceptedSourceAssetSymbols."
        });
        continue;
      }
      if (input.targetAsset === undefined) {
        candidates.push({
          sourceSymbol: balance.symbol,
          sourceRawAmount: balance.currentRawAmount,
          sourceDisplayAmount: balance.currentDisplayAmount,
          status: "target_asset_not_selected",
          reason: "No target settlement asset was selected, so conversion quotes are not requested."
        });
        continue;
      }

      let directPool: { poolKey: string; direction: QuoteDirection };
      try {
        const resolved = resolveDeepbookPoolForSymbols({
          sourceSymbol: balance.symbol,
          targetSymbol: input.targetAsset.symbol
        });
        directPool = { poolKey: resolved.poolKey, direction: resolved.direction };
      } catch {
        candidates.push({
          sourceSymbol: balance.symbol,
          targetSymbol: input.targetAsset.symbol,
          sourceRawAmount: balance.currentRawAmount,
          sourceDisplayAmount: balance.currentDisplayAmount,
          status: "no_direct_deepbook_pool",
          reason: "No direct DeepBook mainnet pool exists for this source and target pair."
        });
        continue;
      }

      try {
        const quote = await this.quoteDeepbookAction({
          poolKey: directPool.poolKey,
          direction: directPool.direction,
          amountRaw: balance.currentRawAmount,
          simulationSender: DEFAULT_DEEPBOOK_SIMULATION_SENDER
        });
        candidates.push({
          sourceSymbol: balance.symbol,
          targetSymbol: input.targetAsset.symbol,
          sourceRawAmount: balance.currentRawAmount,
          sourceDisplayAmount: balance.currentDisplayAmount,
          status: "quoted",
          directPool,
          quote,
          boundary: [
            "quote_snapshot_only",
            "not_final_min_out",
            "not_route_recommendation",
            "not_route_dependent_payment_support",
            "not_payment_readiness",
            "not_signing_readiness"
          ]
        });
      } catch (error) {
        candidates.push({
          sourceSymbol: balance.symbol,
          targetSymbol: input.targetAsset.symbol,
          sourceRawAmount: balance.currentRawAmount,
          sourceDisplayAmount: balance.currentDisplayAmount,
          status: "quote_unavailable",
          reason: error instanceof Error ? error.message : "DeepBook quote failed for this candidate.",
          directPool
        });
      }
    }
    return candidates;
  }

  #intentEvidenceRequiredUserChoices(
    intentKind: IntentEvidenceKind,
    targetAsset: SettlementAssetGroupAsset | undefined,
    candidateConversions: IntentEvidenceCandidateConversion[]
  ): string[] {
    if (intentKind === "summarize_settlement_asset_group_balance") {
      return [];
    }
    const choices: string[] = [];
    if (targetAsset === undefined) {
      choices.push(
        "Choose the onchain settlement asset or merchant-accepted USD-denominated asset set before target-specific settlement evidence can be completed."
      );
    }
    if (candidateConversions.some((candidate) => candidate.status === "quoted")) {
      choices.push("Choose which quoted candidate assets, if any, the user wants to convert.");
    }
    return choices;
  }

  #parseIntentDisplayAmount(displayAmount: string, decimals: number, field: string): string {
    try {
      return parseDisplayAmountToRaw(displayAmount, decimals);
    } catch (error) {
      throw new ReadServiceInputError(
        "input_invalid",
        "requiredDisplayAmount must be an unsigned decimal string within verified decimals",
        {
          field,
          value: displayAmount,
          decimals,
          reason: error instanceof Error ? error.message : "unknown"
        }
      );
    }
  }

  #fetchedAt(): string {
    return this.#now().toISOString();
  }

  // Resolve one coin type's verified unit (decimals/symbol) through the shared
  // coin-metadata cache and DeepBook fallback. Public so other readers (e.g. the
  // public chain-receipt reader) can render decimal amounts without duplicating
  // the cache logic. Fails soft to an unavailable unit on an unresolvable type.
  async resolveCoinUnit(coinType: string): Promise<CoinUnit> {
    let normalizedCoinType: string;
    try {
      normalizedCoinType = normalizeCoinType(coinType);
    } catch {
      return unavailableUnit("coin_type_unresolved");
    }
    return this.#resolveCoinUnitForNormalizedCoinType(normalizedCoinType);
  }

  async #withUnit(balance: SuiClientTypes.Balance): Promise<WalletBalanceWithUnit> {
    let normalizedCoinType: string;
    try {
      normalizedCoinType = normalizeCoinType(balance.coinType);
    } catch {
      return withUnavailableUnit(balance, "coin_type_unresolved");
    }

    const unit = await this.#resolveCoinUnitForNormalizedCoinType(normalizedCoinType);
    return withResolvedUnit(balance, unit);
  }

  async #resolveCoinUnitForNormalizedCoinType(normalizedCoinType: string): Promise<CoinUnit> {
    const now = this.#now();
    let cached: CoinMetadataCacheLookup;
    try {
      cached = await this.#coinMetadataCache.getCoinMetadata({
        coinType: normalizedCoinType,
        chainIdentifier: this.#chainIdentifier,
        now
      });
    } catch (error) {
      throw new ReadServiceCacheError("read", error);
    }
    if (cached.status === "hit") {
      return unitFromMetadataRecord(cached.record, "hit");
    }

    let metadata: SuiClientTypes.GetCoinMetadataResponse;
    try {
      metadata = await this.#client.core.getCoinMetadata({ coinType: normalizedCoinType });
    } catch {
      return unavailableUnit("metadata_lookup_failed");
    }

    if (metadata.coinMetadata !== null) {
      const record = this.#cacheRecordFromMetadata(normalizedCoinType, metadata.coinMetadata, now);
      try {
        await this.#coinMetadataCache.setCoinMetadata(record);
      } catch (error) {
        throw new ReadServiceCacheError("write", error);
      }
      return unitFromMetadataRecord(record, cached.status === "expired" ? "expired_refetched" : "miss");
    }

    try {
      const fallback = deepbookUnitForCoinType(normalizedCoinType, this.#deepbookCoins);
      if (fallback) {
        return unitFromDeepbook(fallback);
      }
    } catch (error) {
      if (error instanceof ReadServiceInputError) {
        return unavailableUnit("no_verified_decimals");
      }
      throw error;
    }
    return unavailableUnit("metadata_not_found");
  }

  async #scanWalletAssetClassificationPages(account: string): Promise<WalletBalanceClassificationScan> {
    const scan = await this.#accounts.scanBalancePages(account);
    const classifiedAssets = scan.balances.map((balance) => classifyWalletBalance(balance, this.#deepbookCoins));
    return { classifiedAssets, uninspectedAssetClasses: NOT_INSPECTED_ASSET_CLASSES.map((value) => ({ ...value })),
      inspectedBalancePages: scan.pages, inspectedCoinBalanceCount: classifiedAssets.length, blockedReason: scan.blockedReason };
  }

  #cacheRecordFromMetadata(
    coinType: string,
    metadata: SuiClientTypes.CoinMetadata,
    now: Date
  ): CoinMetadataCacheRecord {
    const decimals = assertValidDecimals(metadata.decimals);
    return {
      coinType,
      chainIdentifier: this.#chainIdentifier,
      decimals,
      symbol: metadata.symbol,
      name: metadata.name,
      fetchedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.#coinMetadataTtlMs).toISOString()
    };
  }

  listDeepbookTokenRegistry(): DeepbookTokenRegistryEntry[] {
    return listDeepbookTokenRegistry(this.#deepbookCoins);
  }
}

export function createSuiReadService(options: SuiReadServiceOptions): SuiReadService {
  return new SuiReadService(options);
}
