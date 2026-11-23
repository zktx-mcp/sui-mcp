import { normalizeCoinType } from "./coinMetadata.js";
import {
  DEFAULT_DEEPBOOK_CANDLE_INTERVAL,
  candleBucketStart, marketIdentity, validatePoolCandles,
  DeepbookCandleSourceError,
  deepbookCandleIntervalDurationMs,
  parseDeepbookCandleInterval,
  selectDeepbookCandleCanonicalUsdcPools,
  type DeepbookTradeCandle,
  type DeepbookCandleSourceEvidence,
  type DeepbookCandleInterval,
  type DeepbookCandlePool,
  type DeepbookCandleSourceClient
} from "./deepbookCandleSource.js";
import { DEEPBOOK_CANDLE_SOURCE_BASE } from "./deepbookSourceOwners.js";
import {
  deepbookUsdcPriceHistoryPairFromPool,
  deepbookUsdcPriceHistoryQuantitySemantics,
  deepbookUsdcPriceHistoryResponseSummary
} from "./deepbookReadHelpers.js";
import { candleUserAnswerUse, type PriceHistoryFacts, type PriceAtTimeFacts } from "./readResponseGuidance.js";
import {
  DEEPBOOK_USDC_PRICE_HISTORY_UNSUPPORTED_CLAIMS,
  MAX_DEEPBOOK_USDC_PRICE_HISTORY_BARS,
  ReadServiceInputError,
  type DeepbookUsdcPriceAtTimeInput,
  type DeepbookUsdcPriceAtTimeMatch,
  type DeepbookUsdcPriceAtTimeSummary,
  type DeepbookUsdcPriceAtTimeTarget,
  type DeepbookUsdcPriceHistoryBar,
  type DeepbookUsdcPriceHistoryInput,
  type DeepbookUsdcPriceHistoryPair,
  type DeepbookUsdcPriceHistoryQuantitySemantics,
  type DeepbookUsdcPriceHistoryRange,
  type DeepbookUsdcPriceHistoryResponseSummary,
  type DeepbookUsdcPriceHistorySelector,
  type DeepbookUsdcPriceHistorySource,
  type DeepbookUsdcPriceHistorySummary,
  type DeepbookUsdcPriceHistoryUnsupportedClaim
} from "./readServiceTypes.js";

const DEFAULT_DEEPBOOK_USDC_PRICE_AT_TIME_MAX_DISTANCE_MINUTES = 360;

const DEEPBOOK_USDC_PRICE_HISTORY_RESPONSE_SUMMARY = {
  ...deepbookUsdcPriceHistoryResponseSummary()
} as const satisfies DeepbookUsdcPriceHistoryResponseSummary;

function deepbookUsdcPriceHistorySelector(input: Pick<DeepbookUsdcPriceHistoryInput, "poolId" | "poolName" | "coinType" | "assetSymbol">): DeepbookUsdcPriceHistorySelector {
  const selectors = [
    input.poolId === undefined ? undefined : ({ kind: "pool_id", value: input.poolId.toLowerCase() } as const),
    input.poolName === undefined ? undefined : ({ kind: "pool_name", value: input.poolName.trim().toUpperCase() } as const),
    input.assetSymbol === undefined
      ? undefined
      : ({ kind: "asset_symbol", value: input.assetSymbol.trim().toUpperCase() } as const),
    input.coinType === undefined
      ? undefined
      : ({ kind: "coin_type", value: normalizedHistoryCoinType(input.coinType) } as const)
  ].filter((selector): selector is DeepbookUsdcPriceHistorySelector => selector !== undefined && selector.value.length > 0);

  if (selectors.length !== 1) {
    throw new ReadServiceInputError(
      "input_invalid",
      "Provide exactly one DeepBook USDC history selector: poolId, poolName, assetSymbol, or coinType",
      {
        fields: ["poolId", "poolName", "assetSymbol", "coinType"],
        providedSelectorCount: selectors.length
      }
    );
  }
  return selectors[0]!;
}

function normalizedHistoryCoinType(value: string): string {
  try {
    return normalizeCoinType(value);
  } catch {
    throw new ReadServiceInputError("input_invalid", "coinType must be a valid Sui coin type", {
      field: "coinType",
      value
    });
  }
}

function parseDeepbookUsdcPriceHistoryInterval(
  value: DeepbookCandleInterval | undefined
): DeepbookCandleInterval {
  if (value === undefined) {
    return DEFAULT_DEEPBOOK_CANDLE_INTERVAL;
  }
  if (typeof value !== "string") {
    throw new ReadServiceInputError("input_invalid", "interval must be a supported DeepBook supported UTC interval", {
      field: "interval",
      value
    });
  }
  try {
    return parseDeepbookCandleInterval(value);
  } catch (error) {
    if (error instanceof DeepbookCandleSourceError && error.reason === "invalid_payload") {
      throw new ReadServiceInputError("input_invalid", "interval must be a supported DeepBook supported UTC interval", {
        field: "interval",
        value
      });
    }
    throw error;
  }
}

function deepbookUsdcPriceHistoryRange(
  start: string,
  end: string,
  interval: DeepbookCandleInterval | undefined
): DeepbookUsdcPriceHistoryRange {
  const startDate = parseUtcIsoHistoryDate(start, "start");
  const endDate = parseUtcIsoHistoryDate(end, "end");
  const durationMs = endDate.getTime() - startDate.getTime();
  if (durationMs <= 0) {
    throw new ReadServiceInputError("input_invalid", "end must be after start for DeepBook USDC history", {
      start,
      end
    });
  }
  const selectedInterval = parseDeepbookUsdcPriceHistoryInterval(interval);
  const intervalDurationMs = deepbookCandleIntervalDurationMs(selectedInterval);
  return {
    start: startDate.toISOString(),
    end: endDate.toISOString(),
    timeZone: "UTC",
    interval: selectedInterval,
    intervalDurationMs,
    maxBars: MAX_DEEPBOOK_USDC_PRICE_HISTORY_BARS,
    requestedCandleSlots: Math.ceil(durationMs / intervalDurationMs)
  };
}

function deepbookUsdcPriceAtTimeTarget(input: DeepbookUsdcPriceAtTimeInput, interval: DeepbookCandleInterval): DeepbookUsdcPriceAtTimeTarget {
  const target = parseUtcIsoHistoryDate(input.targetTime, "targetTime");
  const maxDistanceMinutes = input.maxDistanceMinutes ?? DEFAULT_DEEPBOOK_USDC_PRICE_AT_TIME_MAX_DISTANCE_MINUTES;
  if (!Number.isInteger(maxDistanceMinutes) || maxDistanceMinutes <= 0) {
    throw new ReadServiceInputError("input_invalid", "maxDistanceMinutes must be a positive integer", {
      field: "maxDistanceMinutes",
      value: input.maxDistanceMinutes
    });
  }
  const intervalDurationMs = deepbookCandleIntervalDurationMs(interval);
  const intervalMinutes = intervalDurationMs / 60_000;
  const maxSearchMinutes = Math.floor(
    (MAX_DEEPBOOK_USDC_PRICE_HISTORY_BARS * intervalMinutes -
      intervalMinutes) /
      2
  );
  if (maxDistanceMinutes > maxSearchMinutes) {
    throw new ReadServiceInputError("input_invalid", "maxDistanceMinutes exceeds the supported DeepBook USDC search window", {
      field: "maxDistanceMinutes",
      maxDistanceMinutes,
      maxSupportedMinutes: maxSearchMinutes
    });
  }

  const targetMs = target.getTime();
  const start = new Date(targetMs - maxDistanceMinutes * 60 * 1000);
  const end = new Date(targetMs + maxDistanceMinutes * 60 * 1000 + intervalDurationMs);
  return {
    targetTime: target.toISOString(),
    searchWindow: {
      start: start.toISOString(),
      end: end.toISOString(),
      maxDistanceMinutes
    }
  };
}

function parseUtcIsoHistoryDate(value: string, field: "start" | "end" | "targetTime"): Date {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new ReadServiceInputError("input_invalid", `${field} must be an ISO UTC timestamp`, { field, value });
  }
  const date = new Date(timestamp);
  if (date.toISOString() !== value) {
    throw new ReadServiceInputError("input_invalid", `${field} must be a canonical ISO UTC timestamp`, {
      field,
      value
    });
  }
  return date;
}

function deepbookUsdcPriceHistoryMatchingPairs(
  usdcPools: DeepbookCandlePool[],
  selector: DeepbookUsdcPriceHistorySelector
): DeepbookCandlePool[] {
  switch (selector.kind) {
    case "pool_id": return usdcPools.filter(p => p.pool_id === selector.value);
    case "pool_name":
      return usdcPools.filter((pool) => pool.pool_name.toUpperCase() === selector.value);
    case "asset_symbol":
      return usdcPools.filter((pool) => pool.base_asset_symbol.toUpperCase() === selector.value);
    case "coin_type":
      return usdcPools.filter((pool) => normalizeCoinType(pool.base_asset_id) === selector.value);
  }
}

function deepbookUsdcPriceHistorySource(input: {
  poolSource: DeepbookCandleSourceEvidence;
  candleSource: DeepbookCandleSourceEvidence;
}): DeepbookUsdcPriceHistorySource {
  return {
    kind: DEEPBOOK_CANDLE_SOURCE_BASE.kind,
    baseUrl: input.poolSource.baseUrl,
    sourceStatement: input.candleSource.sourceStatement,
    poolList: {
      url: input.poolSource.url,
      fetchedAt: input.poolSource.fetchedAt
    },
    candles: {
      poolId: input.candleSource.poolId!,
      ...(input.candleSource.coverage ? { coverage: input.candleSource.coverage } : {}),
      ...(input.candleSource.readEndpoints ? {readEndpoints:input.candleSource.readEndpoints} : {}),
      ...(input.candleSource.coveredFrom ? { coveredFrom: input.candleSource.coveredFrom } : {}),
      ...(input.candleSource.coveredUntil ? { coveredUntil: input.candleSource.coveredUntil } : {}),
      ...(input.candleSource.indexedCheckpoint !== undefined ? { indexedCheckpoint: input.candleSource.indexedCheckpoint, indexedAt: input.candleSource.indexedAt! } : {}),
      url: input.candleSource.url,
      fetchedAt: input.candleSource.fetchedAt,
      poolName: input.candleSource.poolName ?? "",
      interval: input.candleSource.interval ?? DEFAULT_DEEPBOOK_CANDLE_INTERVAL,
      startTimeMs: input.candleSource.startTimeMs ?? 0,
      endTimeMs: input.candleSource.endTimeMs ?? 0,
      limit: input.candleSource.limit ?? MAX_DEEPBOOK_USDC_PRICE_HISTORY_BARS
    },
    chainRecomputedBySuiMcp: DEEPBOOK_CANDLE_SOURCE_BASE.chainRecomputedBySuiMcp
  };
}

function priceSourceUnavailableReason(
  error: unknown,
  phase: "pools" | "candles"
): "pool_list_unavailable" | "candle_fetch_failed" | "invalid_chain_candle_evidence" | "candle_coverage_incomplete" {
  if (error instanceof DeepbookCandleSourceError) {
    if (error.reason === "candle_coverage_incomplete") return error.reason;
    if (error.reason === "invalid_payload") return "invalid_chain_candle_evidence";
  }
  return phase === "pools" ? "pool_list_unavailable" : "candle_fetch_failed";
}

function deepbookUsdcPriceAtTimeMatch(input: {
  target: DeepbookUsdcPriceAtTimeTarget;
  pair: DeepbookUsdcPriceHistoryPair;
  bars: DeepbookUsdcPriceHistoryBar[];
}): { candle: DeepbookTradeCandle; match: DeepbookUsdcPriceAtTimeMatch; distanceMs: number } | undefined {
  const targetMs = Date.parse(input.target.targetTime);
  const maxDistanceMs = input.target.searchWindow.maxDistanceMinutes * 60_000;
  let best: { candle: DeepbookTradeCandle; kind: DeepbookUsdcPriceAtTimeMatch["kind"]; distanceMs: number } | undefined;
  for (const candle of input.bars) {
    const start = Date.parse(candle.start);
    const end = Date.parse(candle.end);
    if (start <= targetMs && targetMs < end) {
      best = { candle, kind: "exact_bucket", distanceMs: 0 };
      break;
    }
    const before = end <= targetMs;
    const distanceMs = before ? targetMs - end : start - targetMs;
    if (distanceMs > maxDistanceMs) continue;
    if (!best || distanceMs < best.distanceMs || (distanceMs === best.distanceMs && before && best.kind === "nearest_after")) {
      best = { candle, kind: before ? "nearest_before" : "nearest_after", distanceMs };
    }
  }
  if (!best) return undefined;
  return {
    candle: best.candle, distanceMs: best.distanceMs,
    match: deepbookUsdcPriceAtTimeMatchFromBar({
      kind: best.kind, distanceMinutes: best.distanceMs / 60_000, pair: input.pair, candle: best.candle
    })
  };
}

function deepbookUsdcPriceAtTimeMatchFromBar(input: {
  kind: DeepbookUsdcPriceAtTimeMatch["kind"];
  distanceMinutes: number;
  pair: DeepbookUsdcPriceHistoryPair;
  candle: DeepbookTradeCandle;
}): DeepbookUsdcPriceAtTimeMatch {
  return {
    kind: input.kind,
    distanceMinutes: Number(input.distanceMinutes.toFixed(6)),
    representativePrice: {
      field: "matchedCandle.close",
      value: input.candle.close,
      quoteAsset: "USDC",
      baseAssetSymbol: input.pair.baseAsset.symbol,
      priceConvention: "USDC_PER_BASE"
    }
  };
}

function historyQuery(input: DeepbookUsdcPriceHistoryInput) {
  return { selector: deepbookUsdcPriceHistorySelector(input), range: deepbookUsdcPriceHistoryRange(input.start, input.end, input.interval) };
}

export class DeepbookUsdcPriceService {
  constructor(private readonly source: DeepbookCandleSourceClient | undefined,
    private readonly fetchedAt: () => string) {}

  private poolReader(signal?: AbortSignal, baseTypes?: readonly string[]): DeepbookCandleSourceClient["fetchPools"] {
    const pools = new Map<string, ReturnType<DeepbookCandleSourceClient["fetchPools"]>>();
    return (id?: string) => {
      const key = id ?? "";
      const pending = pools.get(key);
      if (pending) return pending;
      const read = this.source!.fetchPools(id, false, signal, id ? undefined : baseTypes).then(directory => {
        if (!id) for (const pool of directory.pools) {
          pools.set(pool.pool_id, Promise.resolve({ source: directory.source, pools: [pool] }));
        }
        return directory;
      });
      pools.set(key, read);
      return read;
    };
  }

  priceHistoryReaderForRequest(signal?: AbortSignal, baseTypes?: readonly string[]) {
    const readPools = this.poolReader(signal, baseTypes);
    return async (input: DeepbookUsdcPriceHistoryInput) => {
      const facts = await this.readHistory(historyQuery(input), signal, readPools);
      return { ...facts, userAnswerUse: candleUserAnswerUse(facts) };
    };
  }

  prepareHistory(input: DeepbookUsdcPriceHistoryInput) {
    const query = historyQuery(input);
    this.requireElapsed(query.range.start, "start");
    return { query, read: async (signal?: AbortSignal): Promise<DeepbookUsdcPriceHistorySummary> => {
      const facts = await this.readHistory(query, signal);
      return { ...facts, userAnswerUse: candleUserAnswerUse(facts) };
    } };
  }

  private requireElapsed(timestamp: string, field: "start" | "targetTime") {
    if (Date.parse(timestamp) > Date.parse(this.fetchedAt())) {
      throw new ReadServiceInputError("input_invalid", "Historical price requests require an elapsed time", { field, value: timestamp });
    }
  }

  private async readHistory({ selector, range }: ReturnType<typeof historyQuery>, signal?: AbortSignal,
    readPools?: DeepbookCandleSourceClient["fetchPools"]): Promise<PriceHistoryFacts> {
    const fetchedAt = this.fetchedAt();
    const common = {
      fetchedAt,
      requested: { selector, range },
      quantitySemantics: deepbookUsdcPriceHistoryQuantitySemantics(),
      responseSummary: DEEPBOOK_USDC_PRICE_HISTORY_RESPONSE_SUMMARY,
      unsupportedClaims: [...DEEPBOOK_USDC_PRICE_HISTORY_UNSUPPORTED_CLAIMS]
    } satisfies {
      fetchedAt: string;
      requested: { selector: DeepbookUsdcPriceHistorySelector; range: DeepbookUsdcPriceHistoryRange };
      quantitySemantics: DeepbookUsdcPriceHistoryQuantitySemantics;
      responseSummary: DeepbookUsdcPriceHistoryResponseSummary;
      unsupportedClaims: DeepbookUsdcPriceHistoryUnsupportedClaim[];
    };

    if (range.requestedCandleSlots > MAX_DEEPBOOK_USDC_PRICE_HISTORY_BARS) {
      return {
        status: "unsupported_range",
        ...common,
        reason: "requested_range_exceeds_max_bars"
      };
    }

    if (this.source === undefined) {
      return {
        status: "source_unavailable",
        ...common,
        reason: "chain_candle_source_unavailable"
      };
    }

    let poolResult: Awaited<ReturnType<DeepbookCandleSourceClient["fetchPools"]>>;
    try {
      const id = selector.kind === "pool_id" ? selector.value : undefined;
      poolResult = await (readPools ? readPools(id) : this.source.fetchPools(id, false, signal, selector.kind === "coin_type" ? [selector.value] : undefined));
    } catch (error) {
      return {
        status: "source_unavailable",
        ...common,
        reason: priceSourceUnavailableReason(error, "pools")
      };
    }

    const usdcPools = selectDeepbookCandleCanonicalUsdcPools(poolResult.pools);
    const matchingPools = deepbookUsdcPriceHistoryMatchingPairs(selector.kind === "pool_id" ? usdcPools : usdcPools.filter(p => p.active !== false), selector);
    const unavailable = (poolResult.unavailablePools ?? []).filter(pool => selector.kind !== "coin_type" || normalizeCoinType(pool.baseCoinType) === selector.value);
    const candidates = matchingPools.map(marketIdentity);
    if (matchingPools.length < 2 && unavailable.length) {
      return {status: "source_unavailable", ...common, reason: "pool_list_incomplete", candidates: [...candidates, ...unavailable]};
    }
    if (matchingPools.length !== 1) {
      return {
        status: "unsupported_pair",
        ...common,
        reason:
          matchingPools.length === 0
            ? "market_not_in_mainnet_pool_catalog"
            : "selector_resolves_to_multiple_usdc_pools",
        candidates,
        matchingPoolNames: matchingPools.map((pool) => pool.pool_name),
        availablePoolNames: usdcPools.map((pool) => pool.pool_name)
      };
    }

    const pool = matchingPools[0]!;
    const outputPair = deepbookUsdcPriceHistoryPairFromPool(pool);
    let candleResult: Awaited<ReturnType<DeepbookCandleSourceClient["fetchCandles"]>>;
    try {
      const query = {
        poolName: pool.pool_name, poolId: pool.pool_id, market: pool, directId: selector.kind === "pool_id", window: "history" as const,
        interval: range.interval,
        startTimeMs: Date.parse(range.start),
        endTimeMs: Date.parse(range.end),
        limit: MAX_DEEPBOOK_USDC_PRICE_HISTORY_BARS
      };
      candleResult = await this.source.fetchCandles(query, signal);
      if (candleResult.source.poolId !== pool.pool_id) throw new Error("Unconfirmed candle market.");
      validatePoolCandles(candleResult.candles, query);
    } catch (error) {
      return {
        status: "source_unavailable",
        ...common,
        reason: priceSourceUnavailableReason(error, "candles"),
        pair: outputPair,
        source: {
          kind: DEEPBOOK_CANDLE_SOURCE_BASE.kind,
          baseUrl: poolResult.source.baseUrl,
          sourceStatement: poolResult.source.sourceStatement,
          poolList: {
            url: poolResult.source.url,
            fetchedAt: poolResult.source.fetchedAt
          },
          chainRecomputedBySuiMcp: DEEPBOOK_CANDLE_SOURCE_BASE.chainRecomputedBySuiMcp
        }
      };
    }

    const source = deepbookUsdcPriceHistorySource({
      poolSource: poolResult.source,
      candleSource: candleResult.source
    });

    const startMs = Date.parse(range.start);
    const endMs = Date.parse(range.end);
    const bars = candleResult.candles
      .filter((candle) => {
        const candleStart = Date.parse(candle.start);
        return candleStart >= startMs && candleStart < endMs;
      })
      .sort((left, right) => Date.parse(left.start) - Date.parse(right.start));
    const candleAvailability = candleResult.source.coverage === "partial_tail" ? "partial_coverage" : bars.length === 0 ? "no_candles_in_range" : "available";

    return {
      status: "ok",
      ...common,
      pair: outputPair,
      candleAvailability,
      barCount: bars.length,
      bars,
      source
    };
  }

  preparePoint(input: DeepbookUsdcPriceAtTimeInput) {
    const selector = deepbookUsdcPriceHistorySelector(input);
    const interval = parseDeepbookUsdcPriceHistoryInterval(input.interval);
    const target = deepbookUsdcPriceAtTimeTarget(input, interval);
    this.requireElapsed(target.targetTime, "targetTime");
    const query = { selector, interval, target };
    return { query, read: async (signal?: AbortSignal): Promise<DeepbookUsdcPriceAtTimeSummary> => {
      const facts = await this.readPoint(query, signal);
      return { ...facts, userAnswerUse: candleUserAnswerUse(facts) };
    } };
  }

  private async readPoint({ selector, interval, target }: { selector: DeepbookUsdcPriceHistorySelector;
    interval: DeepbookCandleInterval; target: DeepbookUsdcPriceAtTimeTarget }, signal?: AbortSignal): Promise<PriceAtTimeFacts> {
    const width = deepbookCandleIntervalDurationMs(interval);
    const time = Date.parse(target.targetTime);
    const distance = target.searchWindow.maxDistanceMinutes * 60_000;
    // A preceding bucket whose exclusive end is exactly the distance boundary is eligible.
    const first = candleBucketStart(time - distance - 1, interval);
    const split = candleBucketStart(time, interval) + width;
    const lastStart = candleBucketStart(time + distance, interval);
    const initialRange = { start: new Date(first).toISOString(), end: new Date(split).toISOString() };
    const readPools = this.poolReader(signal, selector.kind === "coin_type" ? [selector.value] : undefined);
    const history = await this.readHistory({ selector, range: deepbookUsdcPriceHistoryRange(initialRange.start, initialRange.end, interval) }, signal, readPools);
    if (history.status !== "ok") return { ...history, target };

    let { requested, source, candleAvailability } = history;
    let matched = deepbookUsdcPriceAtTimeMatch({ target, pair: history.pair, bars: history.bars });
    const tip = source.candles.indexedAt;
    const indexedEnd = tip === undefined ? Infinity : Date.parse(tip) + 1;
    const incomplete = () => ({
      status: "source_unavailable" as const, reason: "candle_coverage_incomplete" as const,
      target, requested, source, pair: history.pair, fetchedAt: history.fetchedAt,
      quantitySemantics: history.quantitySemantics, responseSummary: history.responseSummary, unsupportedClaims: history.unsupportedClaims
    });
    if (time >= indexedEnd || candleAvailability === "partial_coverage" && matched?.match.kind !== "exact_bucket") {
      return incomplete();
    }
    // Earlier wins a tie. Limit the second leg to buckets that could improve the answer.
    const lastCompetitiveStart = matched
      ? Math.min(lastStart, candleBucketStart(time + matched.distanceMs - 1, interval))
      : lastStart;
    if (split <= lastCompetitiveStart) {
      if (split >= indexedEnd) return incomplete();
      const end = Math.min(lastCompetitiveStart + width, indexedEnd);
      const fullRange = deepbookUsdcPriceHistoryRange(initialRange.start, new Date(end).toISOString(), interval);
      requested = { selector: requested.selector, range: fullRange };
      const later = await this.readHistory({ selector: { kind: "pool_id", value: history.pair.poolId },
        range: deepbookUsdcPriceHistoryRange(initialRange.end, fullRange.end, interval) }, signal, readPools);
      if (later.status !== "ok") return { ...later, requested, target };
      const next = deepbookUsdcPriceAtTimeMatch({ target, pair: history.pair, bars: later.bars });
      if (next && (!matched || next.distanceMs < matched.distanceMs)) matched = next;

      const tail = later.source.candles;
      const verifiedEnd = Math.min(end, tail.coveredUntil ? Date.parse(tail.coveredUntil) : end);
      const unknownStart = candleBucketStart(verifiedEnd, interval);
      const partial = unknownStart <= lastCompetitiveStart;
      const endpoints = [...new Set([...(source.candles.readEndpoints ?? []), ...(tail.readEndpoints ?? [])])];
      source = { ...source, candles: {
        ...tail, startTimeMs: first, endTimeMs: end, coverage: partial ? "partial_tail" : "complete",
        ...(source.candles.coveredFrom ? { coveredFrom: source.candles.coveredFrom } : {}),
        ...(endpoints.length ? { readEndpoints: endpoints } : {})
      } };
      if (partial && (!matched || unknownStart - time < matched.distanceMs)) return incomplete();
      candleAvailability = partial ? "partial_coverage" :
        history.barCount + later.barCount ? "available" : "no_candles_in_range";
    }
    const common = { target, requested, source, candleAvailability, pair: history.pair, fetchedAt: history.fetchedAt,
      quantitySemantics: history.quantitySemantics, responseSummary: history.responseSummary, unsupportedClaims: history.unsupportedClaims };
    return matched ? { ...common, status: "ok", match: matched.match, matchedCandle: matched.candle } :
      { ...common, status: "no_price_in_search_window" };
  }
}
