import type { ChartCardInput } from "./readCardInputs.js";
import {
  ambiguousMarketName, marketIdentity, type MarketIdentity, type ReadCandlePreview,
  candleBucketStart,
  validatePoolCandles,
  DEFAULT_DEEPBOOK_CANDLE_INTERVAL,
  DEEPBOOK_CANDLE_INTERVALS,

  DeepbookCandleSourceError,
  selectDeepbookCandleCanonicalUsdcPools,
  type DeepbookTradeCandle,
  type DeepbookCandleSourceEvidence,
  type DeepbookCandlePool,
  type DeepbookCandleSourceClient
} from "./deepbookCandleSource.js";
import {
  deepbookUsdcPriceHistoryPairFromPool,
  deepbookUsdcPriceHistoryQuantitySemantics,
  deepbookUsdcPriceHistoryResponseSummary
} from "./deepbookReadHelpers.js";
import { curateUsdcChartPools } from "./deepbookRegistry.js";
import {
  DEEPBOOK_USDC_PRICE_HISTORY_UNSUPPORTED_CLAIMS,
  type DeepbookUsdcPriceHistoryPair,
  type DeepbookUsdcPriceHistoryQuantitySemantics,
  type DeepbookUsdcPriceHistoryResponseSummary,
  type DeepbookUsdcPriceHistoryUnsupportedClaim
} from "./readServiceTypes.js";

export const DEEPBOOK_USDC_CHART_DEFAULT_LIMIT = 500;
export const DEEPBOOK_USDC_CHART_MAX_CANDLES = 10_000;
export const DEEPBOOK_USDC_CHART_CACHE_TTL_MS = 5 * 60 * 1000;
const DEEPBOOK_USDC_CHART_CANDLE_CACHE_SIZE = 256;

export type DeepbookUsdcChartServiceOptions = {
  source?: DeepbookCandleSourceClient | undefined;
  now?: (() => Date) | undefined;
  cacheTtlMs?: number | undefined;
  maxCandleCacheEntries?: number | undefined;
  assertCurrent?: (() => void) | undefined;
};

export type DeepbookUsdcChartResult = DeepbookUsdcChartPoolsResponse | DeepbookUsdcChartCandlesResponse;

export type DeepbookUsdcChartCommonFields = {
  responseSummary: DeepbookUsdcPriceHistoryResponseSummary;
  quantitySemantics: DeepbookUsdcPriceHistoryQuantitySemantics;
  unsupportedClaims: DeepbookUsdcPriceHistoryUnsupportedClaim[];
};

export type DeepbookUsdcChartSourceUnavailableReason =
  | "candle_coverage_incomplete"
  | "source_unavailable"
  | "pool_list_incomplete"
  | "market_not_created"
  | "source_timeout"
  | "source_http_error"
  | "invalid_chain_candle_evidence";

export type DeepbookUsdcChartPoolsResponse =
  | ({
      status: "ok";
      unavailablePools?: MarketIdentity[];
      poolCount: number;
      pools: DeepbookUsdcPriceHistoryPair[];
      intervals: typeof DEEPBOOK_CANDLE_INTERVALS;
      defaultInterval: typeof DEFAULT_DEEPBOOK_CANDLE_INTERVAL;
      defaultLimit: number;
      maxCandles: number;
      source: DeepbookCandleSourceEvidence;
    } & DeepbookUsdcChartCommonFields)
  | ({
      status: "source_unavailable";
      candidates?: MarketIdentity[];
      reason: DeepbookUsdcChartSourceUnavailableReason;
    } & DeepbookUsdcChartCommonFields);

export type DeepbookUsdcChartCandlesQuery = ChartCardInput & { poolName: string };

export type DeepbookUsdcChartCandlesResponse =
  | ({
      status: "ok" | "partial_coverage" | "preview";
      query: DeepbookUsdcChartCandlesQuery;
      pair: DeepbookUsdcPriceHistoryPair;
      candleCount: number;
      candles: DeepbookTradeCandle[];
      source: DeepbookCandleSourceEvidence;
    } & DeepbookUsdcChartCommonFields)
  | ({
      status: "empty_result";
      query: DeepbookUsdcChartCandlesQuery;
      pair: DeepbookUsdcPriceHistoryPair;
      candleCount: 0;
      candles: [];
      source: DeepbookCandleSourceEvidence;
    } & DeepbookUsdcChartCommonFields)
  | ({
      status: "unsupported_input";
      reason: "missing_pool_name" | "invalid_timestamp";
      field?: string | undefined;
      query?: Partial<DeepbookUsdcChartCandlesQuery> | undefined;
    } & DeepbookUsdcChartCommonFields)
  | ({
      status: "over_limit";
      reason: "limit_exceeds_chart_cap";
      maxCandles: typeof DEEPBOOK_USDC_CHART_MAX_CANDLES;
      requestedLimit: number;
      query?: Partial<DeepbookUsdcChartCandlesQuery> | undefined;
    } & DeepbookUsdcChartCommonFields)
  | ({
      status: "unsupported_pool";
      reason: "pool_not_in_mainnet_usdc_markets" | "ambiguous_pool_name" | "selected_market_changed";
      query: DeepbookUsdcChartCandlesQuery;
      candidates?: MarketIdentity[];
      availablePoolNames: string[];
      source: DeepbookCandleSourceEvidence;
    } & DeepbookUsdcChartCommonFields)
  | ({
      status: "source_unavailable";
      candidates?: MarketIdentity[];
      reason: DeepbookUsdcChartSourceUnavailableReason;
      query?: DeepbookUsdcChartCandlesQuery | undefined;
      pair?: DeepbookUsdcPriceHistoryPair | undefined;
      source?: DeepbookCandleSourceEvidence | undefined;
    } & DeepbookUsdcChartCommonFields);

type CacheEntry<T> = {
  expiresAtMs: number;
  value: T;
};

type ChartInputFailure = Extract<DeepbookUsdcChartCandlesResponse, { status: "unsupported_input" }>;
export type PreparedChartRead = { status: "ready"; query: DeepbookUsdcChartCandlesQuery; named: boolean } | ChartInputFailure;

export function prepareChartRead(input: ChartCardInput, now: Date): PreparedChartRead {
  const poolName = input.poolName ?? input.poolId;
  if (!poolName?.trim()) {
    return { status: "unsupported_input", reason: "missing_pool_name", field: "poolName", ...chartCommonFields() };
  }
  const query: DeepbookUsdcChartCandlesQuery = { ...input, poolName };
  const requestedAtMs = now.getTime();
  for (const field of ["endTimeMs", "startTimeMs"] as const) {
    const boundary = query[field];
    if (boundary !== undefined && boundary > requestedAtMs) {
      return { status: "unsupported_input", reason: "invalid_timestamp", field, query, ...chartCommonFields() };
    }
  }
  return { status: "ready", query, named: input.poolName !== undefined };
}

export function createDeepbookUsdcChartService(options: DeepbookUsdcChartServiceOptions = {}) {
  const source = options.source;
  const now = options.now ?? (() => new Date());
  const cacheTtlMs = options.cacheTtlMs ?? DEEPBOOK_USDC_CHART_CACHE_TTL_MS;
  const maxCandleCacheEntries = options.maxCandleCacheEntries ?? DEEPBOOK_USDC_CHART_CANDLE_CACHE_SIZE;
  const poolCache = new Map<string, CacheEntry<PoolList>>();
  const candleCache = new Map<string, CacheEntry<Awaited<ReturnType<DeepbookCandleSourceClient["fetchCandles"]>>>>();

  async function getPools(): Promise<DeepbookUsdcChartPoolsResponse> {
    let poolResult: Awaited<ReturnType<DeepbookCandleSourceClient["fetchPools"]>>;
    try {
      poolResult = await fetchPoolsCached(true);
    } catch (error) {
      return {
        status: "source_unavailable",
        reason: chartSourceUnavailableReason(error),
        ...chartCommonFields()
      };
    }
    const pools = curateUsdcChartPools(
      selectDeepbookCandleCanonicalUsdcPools(poolResult.pools).filter(pool => pool.active !== false).map(deepbookUsdcPriceHistoryPairFromPool)
    );
    if (pools.length === 0 && poolResult.unavailablePools?.length) {
      return {status:"source_unavailable", reason:"pool_list_incomplete", candidates:poolResult.unavailablePools, ...chartCommonFields()};
    }
    return {
      status: "ok",
      ...(poolResult.unavailablePools ? { unavailablePools: poolResult.unavailablePools } : {}),
      poolCount: pools.length,
      pools,
      intervals: DEEPBOOK_CANDLE_INTERVALS,
      defaultInterval: DEFAULT_DEEPBOOK_CANDLE_INTERVAL,
      defaultLimit: DEEPBOOK_USDC_CHART_DEFAULT_LIMIT,
      maxCandles: DEEPBOOK_USDC_CHART_MAX_CANDLES,
      source: poolResult.source,
      ...chartCommonFields()
    };
  }

  async function readCandles(prepared: PreparedChartRead, selected?: { poolId: string; baseAsset: { coinType: string }; quoteAsset: { coinType: string } }, onPreview?: (read: () => DeepbookUsdcChartCandlesResponse) => void): Promise<DeepbookUsdcChartResult> {
    if (prepared.status !== "ready") return prepared;
    const { query, named } = prepared;
    let poolResult: Awaited<ReturnType<DeepbookCandleSourceClient["fetchPools"]>>;
    try {
      const requestedId = selected?.poolId ?? query.poolId;
      poolResult = requestedId && source ? await source.fetchPools(requestedId, !!selected) : await fetchPoolsCached();
    } catch (error) {
      return {
        status: "source_unavailable",
        reason: chartSourceUnavailableReason(error),
        query,
        ...chartCommonFields()
      };
    }

    const pools = selectDeepbookCandleCanonicalUsdcPools(poolResult.pools);
    const pool = pools.find(candidate => query.poolId ? candidate.pool_id === query.poolId : candidate.active !== false && candidate.pool_name === query.poolName);
    if (selected && (!pool || selected.poolId !== pool.pool_id || pool.active === false)) {
      poolCache.clear(); fetchingPools.clear();
      return { status: "unsupported_pool", reason: "selected_market_changed", query,
        availablePoolNames: [], source: poolResult.source, ...chartCommonFields() };
    }
    const ambiguous = !query.poolId && ambiguousMarketName(pools.filter(candidate => candidate.active !== false), query.poolName);
    const matches = pools.filter(candidate => candidate.active !== false && candidate.pool_name === query.poolName).map(marketIdentity);
    if (!query.poolId && !ambiguous && poolResult.unavailablePools?.length) {
      return {status:"source_unavailable", reason:"pool_list_incomplete", candidates:[...matches,...poolResult.unavailablePools], query, ...chartCommonFields()};
    }
    if (pool === undefined || ambiguous) {
      return {
        status: "unsupported_pool",
        candidates: matches,
        reason: pool === undefined ? "pool_not_in_mainnet_usdc_markets" : "ambiguous_pool_name",
        query,
        availablePoolNames: pools.map((candidate) => candidate.pool_name),
        source: poolResult.source,
        ...chartCommonFields()
      };
    }

    const pair = deepbookUsdcPriceHistoryPairFromPool(pool);
    if ((named && pool.pool_name !== query.poolName) || selected && (selected.baseAsset.coinType !== pair.baseAsset.coinType ||
        selected.quoteAsset.coinType !== pair.quoteAsset.coinType)) {
      return { status: "unsupported_pool", reason: "selected_market_changed", query,
        availablePoolNames: pools.map(p => p.pool_name), source: poolResult.source, ...chartCommonFields() };
    }
    let candleResult: Awaited<ReturnType<DeepbookCandleSourceClient["fetchCandles"]>>;
    try {
      if (!query.poolId && !selected && source?.currentPoolId &&
          await source.currentPoolId(pool.base_asset_id, pool.quote_asset_id) !== pool.pool_id) {
        throw new DeepbookCandleSourceError("market_changed", "The registered pool changed.");
      }
      candleResult = await fetchCandlesCached({ ...query, poolName: pool.pool_name }, pool, !!query.poolId && !selected, onPreview && ((preview) => {
        onPreview(() => {
          const { candles, source } = preview();
          return { status: "preview", query, pair, candles, candleCount: candles.length, source, ...chartCommonFields() };
        });
      }));
    } catch (error) {
      if (error instanceof DeepbookCandleSourceError && error.reason === "market_changed") {
        poolCache.clear(); fetchingPools.clear();
        return { status: "unsupported_pool", reason: "selected_market_changed", query,
          availablePoolNames: pools.filter(p => p.active !== false).map(p => p.pool_name), source: poolResult.source, ...chartCommonFields() };
      }
      return {
        status: "source_unavailable",
        reason: chartSourceUnavailableReason(error),
        query,
        pair,
        source: poolResult.source,
        ...chartCommonFields()
      };
    }

    if (candleResult.candles.length === 0 && candleResult.source.coverage !== "partial_tail") {
      return {
        status: "empty_result",
        query,
        pair,
        candleCount: 0,
        candles: [],
        source: candleResult.source,
        ...chartCommonFields()
      };
    }

    return {
      status: candleResult.source.coverage === "partial_tail" ? "partial_coverage" : "ok",
      query,
      pair,
      candleCount: candleResult.candles.length,
      candles: candleResult.candles,
      source: candleResult.source,
      ...chartCommonFields()
    };
  }

  type PoolList = Awaited<ReturnType<DeepbookCandleSourceClient["fetchPools"]>>;
  type CandleList = Awaited<ReturnType<DeepbookCandleSourceClient["fetchCandles"]>>;
  const fetchingPools = new Map<string, Promise<PoolList>>();
  type Listener = (preview: ReadCandlePreview) => void;
  type Flight = {result: Promise<CandleList>; listeners:Set<Listener>; preview?:ReadCandlePreview};
  const fetchingCandles = new Map<string, Flight>();
  async function fetchPoolsCached(menu = false): Promise<PoolList> {
    if (!source) throw new Error("Market source unavailable.");
    const key = menu && source.fetchMenuPools ? "menu" : "all";
    const cached = poolCache.get(key);
    if (cached && cached.expiresAtMs > now().getTime()) return cached.value;
    const existing = fetchingPools.get(key);
    if (existing) return existing;
    const loading = key === "menu" ? source.fetchMenuPools!() : source.fetchPools();
    const pending = loading.then(value => {
      options.assertCurrent?.();
      if (!value.unavailablePools?.length && fetchingPools.get(key) === pending) {
        poolCache.set(key,{expiresAtMs: now().getTime() + cacheTtlMs, value});
      }
      return value;
    }).finally(() => { if (fetchingPools.get(key) === pending) fetchingPools.delete(key); });
    fetchingPools.set(key,pending);
    return pending;
  }
  async function fetchCandlesCached(query: DeepbookUsdcChartCandlesQuery, market: DeepbookCandlePool, directId: boolean, listener?: Listener): Promise<CandleList> {
    if (!source) throw new Error("Market source unavailable.");
    // Selection and current-registration checks precede sharing. Only values that
    // determine the verified OHLCV result belong to its identity.
    const key = JSON.stringify([
      market.pool_id, market.initialSharedVersion, market.base_asset_id, market.base_asset_decimals,
      market.quote_asset_id, market.quote_asset_decimals, query.interval, query.startTimeMs,
      query.endTimeMs, query.endMode, query.limit
    ]);
    const cached = candleCache.get(key);
    if (cached && cached.expiresAtMs > now().getTime()) {
      options.assertCurrent?.();
      candleCache.delete(key);
      candleCache.set(key, cached);
      return cached.value;
    }
    const current = fetchingCandles.get(key);
    if (current) {
      if (listener && current.preview) listener(current.preview);
      else if (listener) current.listeners.add(listener);
      return current.result;
    }
    const listeners = new Set(listener ? [listener] : []);
    const pending = Promise.resolve().then(() => source.fetchCandles({ ...query, market, poolId: market.pool_id, directId }, undefined, preview => {
      if (fetchingCandles.get(key) !== flight || flight.preview) return;
      options.assertCurrent?.();
      let verified: CandleList | undefined;
      flight.preview = () => {
        const result = preview();
        if (result === verified) return verified;
        const { candles, source: proof } = result;
        validatePoolCandles(candles, query);
        const cutoff = Date.parse(proof.indexedAt ?? "");
        if (!candles.length || proof.poolId !== market.pool_id || proof.interval !== query.interval || !Number.isFinite(cutoff) ||
            candles.some((candle, i) => candleBucketStart(candle.timestampMs, query.interval) !== candle.timestampMs ||
              Date.parse(candle.end) > cutoff + 1 || (i > 0 && candle.timestampMs <= candles[i - 1]!.timestampMs)))
          throw new Error("Unconfirmed chart preview.");
        verified = result;
        return result;
      };
      for (const notify of listeners) notify(flight.preview);
      listeners.clear();
    })).then((value) => {
      if (value.source.poolId !== market.pool_id) throw new Error("The candle source returned a different or unidentified market.");
      validatePoolCandles(value.candles, query);
      options.assertCurrent?.();
      if (fetchingCandles.get(key) === flight) {
        candleCache.set(key, { expiresAtMs: now().getTime() + cacheTtlMs, value });
        while (candleCache.size > maxCandleCacheEntries) candleCache.delete(candleCache.keys().next().value!);
      }
      return value;
    }).finally(() => { if (fetchingCandles.get(key) === flight) fetchingCandles.delete(key); });
    const flight: Flight = {result:pending, listeners};
    fetchingCandles.set(key, flight);
    return pending;
  }
  return { getPools, readCandles, clearCache: () => {
    fetchingPools.clear(); fetchingCandles.clear(); poolCache.clear(); candleCache.clear();
  } };
}

function chartSourceUnavailableReason(error: unknown): DeepbookUsdcChartSourceUnavailableReason {
  if (error instanceof DeepbookCandleSourceError) {
    switch (error.reason) {
      case "invalid_payload":
        return "invalid_chain_candle_evidence";
      case "source_timeout":
        return "source_timeout";
      case "source_http_error":
        return "source_http_error";
      case "candle_coverage_incomplete": return error.reason;
      case "market_not_created": return "market_not_created";
      case "market_changed":
      case "source_unavailable":
        return "source_unavailable";
    }
  }
  return "source_unavailable";
}

function chartCommonFields(): DeepbookUsdcChartCommonFields {
  return {
    responseSummary: deepbookUsdcPriceHistoryResponseSummary(),
    quantitySemantics: deepbookUsdcPriceHistoryQuantitySemantics(),
    unsupportedClaims: [...DEEPBOOK_USDC_PRICE_HISTORY_UNSUPPORTED_CLAIMS]
  };
}
