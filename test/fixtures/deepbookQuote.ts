import { DEEPBOOK_SDK_SIMULATION_SOURCE_BASE } from "../../src/core/read/deepbookSourceOwners.js";
import { DEEPBOOK_SCALAR_UNIT_SOURCE } from "../../src/core/read/coinMetadata.js";
import { deepbookQuoteUserAnswerUse } from "../../src/core/read/readResponseGuidance.js";
import type { DeepbookDisplayQuoteSummary } from "../../src/core/read/readServiceTypes.js";

export function deepbookDisplayQuote(
  overrides: Partial<Pick<DeepbookDisplayQuoteSummary, "fetchedAt">> = {}
): DeepbookDisplayQuoteSummary {
  const rawAmount = (raw: string, symbol: string, coinType: string, decimals: number) => ({
    raw,
    symbol,
    coinType,
    decimals,
    unitSource: DEEPBOOK_SCALAR_UNIT_SOURCE
  });

  return {
    status: "ok",
    pool: {
      poolKey: "SUI_USDC",
      base: "SUI",
      quote: "USDC"
    },
    direction: "base_to_quote",
    inputAmount: {
      display: "1",
      raw: "1000000000",
      asset: {
        symbol: "SUI",
        coinType: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
        decimals: 9,
        unitSource: DEEPBOOK_SCALAR_UNIT_SOURCE
      }
    },
    fetchedAt: overrides.fetchedAt ?? "2026-05-15T00:00:00.000Z",
    userAnswerUse: deepbookQuoteUserAnswerUse("display"),
    source: {
      ...DEEPBOOK_SDK_SIMULATION_SOURCE_BASE,
      method: "getQuoteQuantityOut",
      returnValueEncoding: "bcs.u64"
    },
    quote: {
      baseOut: "0",
      quoteOut: "123.456789",
      deepRequired: "0.025"
    },
    rawQuote: {
      kind: "deepbook_quote_raw_u64",
      sourceMoveFunction: "pool::get_quote_quantity_out",
      returnValueSourceMoveFunction: "pool::get_quantity_out",
      returnValueOrder: ["base_quantity_out", "quote_quantity_out", "deep_quantity_required"],
      inputAmount: rawAmount(
        "1000000000",
        "SUI",
        "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
        9
      ),
      baseOut: rawAmount(
        "0",
        "SUI",
        "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
        9
      ),
      quoteOut: rawAmount(
        "123456789",
        "USDC",
        "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
        6
      ),
      deepRequired: rawAmount(
        "25000",
        "DEEP",
        "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP",
        6
      ),
      directionalOutput: rawAmount(
        "123456789",
        "USDC",
        "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
        6
      ),
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
    },
    quantitySemantics: {
      kind: "deepbook_quote_display_amount",
      inputAmountKind: "display_source_amount_converted_to_raw_u64",
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
    }
  };
}
