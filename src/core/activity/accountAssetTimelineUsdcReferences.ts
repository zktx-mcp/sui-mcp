import type { MarketIdentity, DeepbookTradeCandle } from "../read/deepbookCandleSource.js";
import {
  deepbookUsdcPriceHistoryQuantitySemantics,
  deepbookUsdcPriceHistoryResponseSummary
} from "../read/deepbookReadHelpers.js";
import {
  DEEPBOOK_CANDLE_SOURCE_BASE,
  DEEPBOOK_CANDLE_USDC_REFERENCE
} from "../read/deepbookSourceOwners.js";
import {
  DEEPBOOK_USDC_PRICE_HISTORY_UNSUPPORTED_CLAIMS, MAX_DEEPBOOK_USDC_PRICE_HISTORY_BARS,
  type DeepbookUsdcPriceHistoryInput,
  type DeepbookUsdcPriceHistorySummary
} from "../read/readServiceTypes.js";
import type {
  AccountAssetTimelineNetFlowBar,
  AccountAssetTimelineResult
} from "./accountAssetTimeline.js";

export type AccountAssetTimelineUsdcPriceHistoryReader = (
  input: DeepbookUsdcPriceHistoryInput
) => Promise<DeepbookUsdcPriceHistorySummary>;

export type AccountAssetTimelineWithUsdcReferences = AccountAssetTimelineResult & {
  usdcReferences: AccountAssetTimelineUsdcReferenceSummary;
};

export type AccountAssetTimelineUsdcReferenceSummary = {
  status:
    | "available"
    | "partial"
    | "unavailable"
    | "no_timeline_bars";
  quoteAsset: typeof DEEPBOOK_CANDLE_USDC_REFERENCE.quoteAsset;
  priceConvention: typeof DEEPBOOK_CANDLE_USDC_REFERENCE.priceConvention;
  usdcIsFiatUsd: typeof DEEPBOOK_CANDLE_USDC_REFERENCE.usdcIsFiatUsd;
  usdPegGuaranteeAvailable: typeof DEEPBOOK_CANDLE_USDC_REFERENCE.usdPegGuaranteeAvailable;
  source: typeof DEEPBOOK_CANDLE_SOURCE_BASE.kind;
  chainRecomputedBySuiMcp: typeof DEEPBOOK_CANDLE_SOURCE_BASE.chainRecomputedBySuiMcp;
  quantitySemantics: ReturnType<typeof deepbookUsdcPriceHistoryQuantitySemantics>;
  responseSummary: ReturnType<typeof deepbookUsdcPriceHistoryResponseSummary>;
  unsupportedClaims: typeof DEEPBOOK_USDC_PRICE_HISTORY_UNSUPPORTED_CLAIMS[number][];
  coinReferences: AccountAssetTimelineCoinUsdcReference[];
};

export type AccountAssetTimelinePriceScope = {
  coinType: string;
  range: { start: string; end: string };
};

export type AccountAssetTimelineCoinUsdcReference = AccountAssetTimelinePriceScope & AccountAssetTimelinePriceResult;

type AccountAssetTimelinePriceResult =
  | {
      status: "available" | "partial";
      pair: Extract<DeepbookUsdcPriceHistorySummary, { status: "ok" }>["pair"];
      candleAvailability: Extract<DeepbookUsdcPriceHistorySummary, { status: "ok" }>["candleAvailability"];
      source: Extract<DeepbookUsdcPriceHistorySummary, { status: "ok" }>["source"];
      barReferences: AccountAssetTimelineUsdcBarReference[];
    }
  | {
      status: "unsupported_asset";
      candidates?: MarketIdentity[];
      reason: Extract<DeepbookUsdcPriceHistorySummary, { status: "unsupported_pair" }>["reason"];
      matchingPoolNames: string[];
      availablePoolNames: string[];
    }
  | {
      status: "unsupported_range";
      reason: Extract<DeepbookUsdcPriceHistorySummary, { status: "unsupported_range" }>["reason"];
      requested: Extract<DeepbookUsdcPriceHistorySummary, { status: "unsupported_range" }>["requested"];
    }
  | {
      status: "source_unavailable";
      candidates?: MarketIdentity[];
      reason: Extract<DeepbookUsdcPriceHistorySummary, { status: "source_unavailable" }>["reason"];
      pair?: Extract<DeepbookUsdcPriceHistorySummary, { status: "source_unavailable" }>["pair"] | undefined;
      source?: Extract<DeepbookUsdcPriceHistorySummary, { status: "source_unavailable" }>["source"] | undefined;
    };

export type AccountAssetTimelineUsdcBarReference =
  | {
      bucketStart: string;
      bucketEnd: string;
      status: "available";
      candle: DeepbookTradeCandle;
    }
  | {
      bucketStart: string;
      bucketEnd: string;
      status: "missing_candle" | "source_unavailable";
    };

export async function attachDeepbookUsdcReferencesToTimeline(input: {
  timeline: AccountAssetTimelineResult;
  getPriceHistory: AccountAssetTimelineUsdcPriceHistoryReader;
  signal?: AbortSignal;
}): Promise<AccountAssetTimelineWithUsdcReferences> {
  const baseSummary = emptyReferenceSummary();
  if (input.timeline.netFlowBars.length === 0) {
    return {
      ...input.timeline,
      usdcReferences: { ...baseSummary, status: "no_timeline_bars" }
    };
  }
  const barsByCoin = groupBarsByCoin(input.timeline.netFlowBars);
  const coinReferences: AccountAssetTimelineUsdcReferenceSummary["coinReferences"] = [];
  for (const [coinType, bars] of barsByCoin) {
    for (const run of adjacentActivityBuckets(bars)) {
      const start = run[0]!.bucketStart;
      const end = new Date(Math.min(Date.parse(run.at(-1)!.bucketEnd), Date.parse(input.timeline.requestedRange.to))).toISOString();
      const scope = { coinType, range: { start, end } };
      input.signal?.throwIfAborted();
      let history: DeepbookUsdcPriceHistorySummary;
      try {
        history = await input.getPriceHistory({ coinType, interval: input.timeline.bucket.interval, start, end });
      } catch {
        input.signal?.throwIfAborted();
        coinReferences.push({ ...scope, status: "source_unavailable", reason: "chain_candle_source_unavailable" });
        continue;
      }
      input.signal?.throwIfAborted();
      coinReferences.push({ ...scope, ...referenceForHistory(run, history) });
    }
  }

  return {
    ...input.timeline,
    usdcReferences: {
      ...baseSummary,
      status: referenceSummaryStatus(coinReferences),
      coinReferences
    }
  };
}

// Each returned source describes exactly one continuous read. A gap in account
// activity does not require market prices or establish coverage of that gap.
function* adjacentActivityBuckets(bars: AccountAssetTimelineNetFlowBar[]) {
  let run: AccountAssetTimelineNetFlowBar[] = [];
  // The timeline producer already orders each coin’s buckets by UTC start.
  for (const bar of bars) {
    if (run.length && (run.at(-1)!.bucketEnd !== bar.bucketStart || run.length === MAX_DEEPBOOK_USDC_PRICE_HISTORY_BARS)) {
      yield run;
      run = [];
    }
    run.push(bar);
  }
  if (run.length) yield run;
}

function emptyReferenceSummary(): AccountAssetTimelineUsdcReferenceSummary {
  return {
    status: "unavailable",
    ...DEEPBOOK_CANDLE_USDC_REFERENCE,
    source: DEEPBOOK_CANDLE_SOURCE_BASE.kind,
    chainRecomputedBySuiMcp: DEEPBOOK_CANDLE_SOURCE_BASE.chainRecomputedBySuiMcp,
    quantitySemantics: deepbookUsdcPriceHistoryQuantitySemantics(),
    responseSummary: deepbookUsdcPriceHistoryResponseSummary(),
    unsupportedClaims: [...DEEPBOOK_USDC_PRICE_HISTORY_UNSUPPORTED_CLAIMS],
    coinReferences: []
  };
}

function referenceForHistory(
  timelineBars: AccountAssetTimelineNetFlowBar[],
  history: DeepbookUsdcPriceHistorySummary
): AccountAssetTimelinePriceResult {
  if (history.status === "unsupported_pair") {
    return {
      status: "unsupported_asset",
      reason: history.reason,
      ...(history.candidates ? {candidates:history.candidates} : {}),
      matchingPoolNames: history.matchingPoolNames,
      availablePoolNames: history.availablePoolNames
    };
  }
  if (history.status === "unsupported_range") {
    return {
      status: "unsupported_range",
      reason: history.reason,
      requested: history.requested
    };
  }
  if (history.status === "source_unavailable") {
    return {
      status: "source_unavailable",
      reason: history.reason,
      ...(history.candidates ? {candidates:history.candidates} : {}),
      pair: history.pair,
      source: history.source
    };
  }

  const candlesByBucket = new Map(history.bars.map((bar) => [`${bar.start}\n${bar.end}`, bar]));
  const barReferences: AccountAssetTimelineUsdcBarReference[] = timelineBars.map((bar) => {
    const candle = candlesByBucket.get(`${bar.bucketStart}\n${bar.bucketEnd}`);
    return candle === undefined
      ? {
          bucketStart: bar.bucketStart,
          bucketEnd: bar.bucketEnd,
          status: history.candleAvailability === "partial_coverage" && Date.parse(bar.bucketEnd) > Date.parse(history.source.candles.coveredUntil!) ? "source_unavailable" : "missing_candle"
        }
      : {
          bucketStart: bar.bucketStart,
          bucketEnd: bar.bucketEnd,
          status: "available",
          candle
        };
  });
  return {
    status: history.candleAvailability === "partial_coverage" || barReferences.some((bar) => bar.status !== "available")
      ? "partial"
      : "available",
    pair: history.pair,
    candleAvailability: history.candleAvailability,
    source: history.source,
    barReferences
  };
}

function groupBarsByCoin(bars: AccountAssetTimelineNetFlowBar[]): Map<string, AccountAssetTimelineNetFlowBar[]> {
  const result = new Map<string, AccountAssetTimelineNetFlowBar[]>();
  for (const bar of bars) {
    const existing = result.get(bar.coinType) ?? [];
    existing.push(bar);
    result.set(bar.coinType, existing);
  }
  return result;
}

function referenceSummaryStatus(coinReferences: AccountAssetTimelineCoinUsdcReference[]): AccountAssetTimelineUsdcReferenceSummary["status"] {
  if (coinReferences.length === 0) {
    return "no_timeline_bars";
  }
  const availableCount = coinReferences.filter((entry) => entry.status === "available").length;
  if (availableCount === coinReferences.length) {
    return "available";
  }
  if (coinReferences.some(entry => "barReferences" in entry && entry.barReferences.some(bar => bar.status === "available"))) {
    return "partial";
  }
  return "unavailable";
}
