import { normalizeCoinType } from "./coinMetadata.js";
import { INDEXER_SOURCE_STATEMENT, type DeepbookChartIndexer, type IndexedChartCatalog, type IndexedChartResult } from "./deepbookChartIndexer.js";
import type { ChartCardInput, OfferedChartMarket } from "./readCardInputs.js";
import {
  ambiguousMarketName, candleMarketIdentityKey, marketIdentity, type MarketIdentity, type ReadCandlePreview,
  candleBucketStart, candleQueryWindow,
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
import { curateUsdcChartPools, curatedChartCoinTypes } from "./deepbookRegistry.js";
import {
  DEEPBOOK_USDC_PRICE_HISTORY_UNSUPPORTED_CLAIMS,
  type DeepbookUsdcPriceHistoryPair
} from "./readServiceTypes.js";

export const DEEPBOOK_USDC_CHART_DEFAULT_LIMIT = 500;
export const DEEPBOOK_USDC_CHART_MAX_CANDLES = 10_000;
export const DEEPBOOK_USDC_CHART_CACHE_TTL_MS = 5 * 60 * 1000;

export type DeepbookUsdcChartServiceOptions = {
  source?: DeepbookCandleSourceClient | undefined;
  indexer?: Pick<DeepbookChartIndexer, "fetchPools" | "fetchCandles">;
  now?: (() => Date) | undefined;
  cacheTtlMs?: number | undefined;
  assertCurrent?: (() => void) | undefined;
};

export type DeepbookUsdcChartResult = DeepbookUsdcChartPoolsResponse | DeepbookUsdcChartCandlesResponse;

export type DeepbookUsdcChartCommonFields = ReturnType<typeof chartReadFacts> | ReturnType<typeof chartCandleFacts>;

export type DeepbookUsdcChartSourceUnavailableReason =
  | "candle_coverage_incomplete"
  | "source_unavailable"
  | "pool_list_incomplete"
  | "market_not_created"
  | "source_timeout"
  | "source_http_error"
  | "invalid_chain_candle_evidence"
  | "invalid_indexer_candle_evidence";

export type DeepbookUsdcChartPoolsResponse =
  | ({
      status: "ok";
      unavailablePools?: (MarketIdentity & { poolName?: string })[];
      poolCount: number;
      pools: (DeepbookUsdcPriceHistoryPair & Pick<OfferedChartMarket, "catalogEndpoint">)[];
      mixedCatalog?: true;
      intervals: typeof DEEPBOOK_CANDLE_INTERVALS;
      defaultInterval: typeof DEFAULT_DEEPBOOK_CANDLE_INTERVAL;
      defaultLimit: number;
      maxCandles: number;
      source: ChartEvidence;
    } & ReturnType<typeof chartReadFacts>)
  | ({
      status: "source_unavailable";
      candidates?: MarketIdentity[];
      reason: DeepbookUsdcChartSourceUnavailableReason;
    } & ReturnType<typeof chartReadFacts>);

export type DeepbookUsdcChartCandlesQuery = ChartCardInput & { poolName: string };

export type DeepbookUsdcChartCandlesResponse =
  | ({
      status: "ok" | "partial_coverage" | "preview";
      query: DeepbookUsdcChartCandlesQuery;
      pair: DeepbookUsdcPriceHistoryPair;
      candleCount: number;
      candles: DeepbookTradeCandle[];
      source: ChartEvidence;
    } & ReturnType<typeof chartCandleFacts>)
  | ({
      status: "empty_result";
      query: DeepbookUsdcChartCandlesQuery;
      pair: DeepbookUsdcPriceHistoryPair;
      candleCount: 0;
      candles: [];
      source: ChartEvidence;
    } & ReturnType<typeof chartCandleFacts>)
  | ({
      status: "unsupported_input";
      reason: "missing_pool_name" | "invalid_timestamp";
      field?: string | undefined;
      query?: Partial<DeepbookUsdcChartCandlesQuery> | undefined;
    } & ReturnType<typeof chartReadFacts>)
  | ({
      status: "over_limit";
      reason: "limit_exceeds_chart_cap";
      maxCandles: typeof DEEPBOOK_USDC_CHART_MAX_CANDLES;
      requestedLimit: number;
      query?: Partial<DeepbookUsdcChartCandlesQuery> | undefined;
    } & ReturnType<typeof chartReadFacts>)
  | ({
      status: "unsupported_pool";
      reason: "pool_not_in_mainnet_usdc_markets" | "ambiguous_pool_name" | "selected_market_changed";
      query: DeepbookUsdcChartCandlesQuery;
      candidates?: MarketIdentity[];
      availablePoolNames: string[];
      source: ChartEvidence;
    } & ReturnType<typeof chartReadFacts>)
  | ({
      status: "source_unavailable";
      candidates?: MarketIdentity[];
      reason: DeepbookUsdcChartSourceUnavailableReason;
      query?: DeepbookUsdcChartCandlesQuery | undefined;
      pair?: DeepbookUsdcPriceHistoryPair | undefined;
      source?: ChartEvidence | undefined;
    } & ReturnType<typeof chartReadFacts>);

type ChartEvidence = DeepbookCandleSourceEvidence | IndexedChartCatalog["source"] | IndexedChartResult["source"];
type ChartCatalog = { pools: DeepbookCandlePool[]; unavailablePools?: MarketIdentity[]; source: ChartEvidence };

// Resolve names before either building a menu or reading candles. Keep both
// observations of a disagreement for the caller; an absent name has no conflict.
function chartMarkets(catalog: ChartCatalog, index?: IndexedChartCatalog, registryOnly = false) {
  const listed = index ?? (catalog.source.endpoint === "get_pools" ? catalog : undefined);
  const indexedNames = new Set(registryOnly ? [] : listed?.pools.filter(p => p.active !== false).map(p => p.pool_name));
  const observations = (index ? [...catalog.pools, ...index.pools] : catalog.pools).filter(p => p.active !== false);
  const groups = new Map<string, DeepbookCandlePool[]>();
  const namesById = new Map<string, Set<string>>();
  for (const pool of observations) {
    const rows = groups.get(pool.pool_name) ?? [];
    rows.push(pool);
    groups.set(pool.pool_name, rows);
    const names = namesById.get(pool.pool_id) ?? new Set<string>();
    names.add(pool.pool_name);
    namesById.set(pool.pool_id, names);
  }
  const conflicts = new Map<string, MarketIdentity[]>();
  for (const [name, rows] of groups) {
    const disputed = (catalog.unavailablePools ?? []).filter(candidate => rows.some(pool =>
      pool.pool_id === candidate.poolId && (candidate.unavailableReason === "pool_identity_mismatch" ||
        normalizeCoinType(pool.base_asset_id) !== normalizeCoinType(candidate.baseCoinType) ||
        normalizeCoinType(pool.quote_asset_id) !== normalizeCoinType(candidate.quoteCoinType))));
    if (disputed.length || rows.some(pool => namesById.get(pool.pool_id)!.size > 1) || ambiguousMarketName(rows, name)) {
      conflicts.set(name, [...rows.map(marketIdentity), ...disputed]);
    }
  }
  const byName = new Map<string, DeepbookCandlePool>();
  for (const pool of selectDeepbookCandleCanonicalUsdcPools(registryOnly ? catalog.pools : observations)) {
    const existing = byName.get(pool.pool_name);
    if (!existing || existing.active === false) byName.set(pool.pool_name, pool);
  }
  return { ...catalog, pools: [...byName.values()], indexedNames, conflicts, mixed: !!index && !registryOnly };
}

// A market retains its revision across snapshots with the same binding, even
// when another market changes. A replacement gets a new revision on each change.
type CatalogObservation = IndexedChartCatalog & {
  directory: ReturnType<typeof chartMarkets>;
  markets: ReadonlyMap<string, { identity: string | null; revision: number }>;
};
type ChartDirectory = ReturnType<typeof chartMarkets> & { observedIndex?: CatalogObservation };

type CacheEntry<T> = {
  expiresAtMs: number;
  value: T;
};

type ChartInputFailure = Extract<DeepbookUsdcChartCandlesResponse, { status: "unsupported_input" }>;
export type PreparedChartRead = { status: "ready"; query: DeepbookUsdcChartCandlesQuery; named: boolean } | ChartInputFailure;

export function prepareChartRead(input: ChartCardInput, now: Date): PreparedChartRead {
  const poolName = input.poolName ?? input.poolId;
  if (!poolName?.trim()) {
    return { status: "unsupported_input", reason: "missing_pool_name", field: "poolName", ...chartReadFacts("input") };
  }
  const query: DeepbookUsdcChartCandlesQuery = { ...input, poolName };
  const requestedAtMs = now.getTime();
  for (const field of ["endTimeMs", "startTimeMs"] as const) {
    const boundary = query[field];
    if (boundary !== undefined && boundary > requestedAtMs) {
      return { status: "unsupported_input", reason: "invalid_timestamp", field, query, ...chartReadFacts("input") };
    }
  }
  return { status: "ready", query, named: input.poolName !== undefined };
}

export function createDeepbookUsdcChartService(options: DeepbookUsdcChartServiceOptions = {}) {
  const source = options.source;
  const now = options.now ?? (() => new Date());
  const cacheTtlMs = options.cacheTtlMs ?? DEEPBOOK_USDC_CHART_CACHE_TTL_MS;
  const poolCache = new Map<string, CacheEntry<PoolList> & { sequence: number }>();
  let registrySequence = 0;
  const unresolved = new Map<string, MarketIdentity[]>();

  let catalogFlight: Promise<CatalogObservation> | undefined;
  let lastCatalog: CacheEntry<CatalogObservation> | undefined;
  let catalogSequence = 0;
  const indexedReads = new Map<string, Promise<IndexedChartResult>>();

  // A new selection checks the current catalog. Only simultaneous lookups share it.
  function readCatalog(indexer: NonNullable<DeepbookUsdcChartServiceOptions["indexer"]>) {
    if (catalogFlight) return catalogFlight;
    const pending = indexer.fetchPools().then(value => {
      options.assertCurrent?.();
      if (catalogFlight !== pending) throw new Error("The chart source was reset.");
      const directory = chartMarkets(value);
      const revision = ++catalogSequence;
      const markets: Map<string, { identity: string | null; revision: number }> = new Map();
      for (const pool of directory.pools) {
        const name = pool.pool_name;
        const identity = directory.conflicts.has(name) ? null : candleMarketIdentityKey(pool);
        const prior = lastCatalog?.value.markets.get(name);
        markets.set(name, prior && prior.identity === identity ? prior : { identity, revision });
      }
      const observed = { ...value, directory, markets };
      lastCatalog = { value: observed, expiresAtMs: now().getTime() + cacheTtlMs };
      return observed;
    }).finally(() => {
      if (catalogFlight === pending) catalogFlight = undefined;
    });
    catalogFlight = pending;
    return pending;
  }

  type Selection = Omit<OfferedChartMarket, "poolName"> & { poolName?: string };

  // Full and menu reads cover different sets of registry entries. A newer
  // menu replaces only its curated slice of the last complete enumeration.
  function observedRegistry(): PoolList | undefined {
    const all = poolCache.get("all");
    const menu = poolCache.get("menu");
    if (!all) return menu?.value;
    if (!menu || all.sequence > menu.sequence) return all.value;
    const curated = (type: string) => curatedChartCoinTypes.includes(normalizeCoinType(type));
    return {
      source: all.value.source,
      pools: [...all.value.pools.filter(p => !curated(p.base_asset_id)), ...menu.value.pools],
      unavailablePools: [...(all.value.unavailablePools ?? []).filter(p => !curated(p.baseCoinType)),
        ...(menu.value.unavailablePools ?? [])]
    };
  }

  function invalidateRegistryLists() {
    // Retain identity evidence; expiration only prevents serving a cached list.
    for (const entry of poolCache.values()) entry.expiresAtMs = 0;
    fetchingPools.clear();
  }

  // Only a current observation of both catalogs can resolve a previously
  // disputed name. An unrelated unread row must not erase that observation.
  function reconcile(registry: ChartCatalog, index?: CatalogObservation, registryOnly = false, fresh = false): ChartDirectory {
    options.assertCurrent?.();
    const latest = index && lastCatalog?.value;
    if (index && !latest) throw new Error("The chart source was reset.");
    const directory = chartMarkets(registry, latest, registryOnly);
    for (const [name, previous] of unresolved) {
      const current = directory.conflicts.get(name);
      const unreadCandidate = registry.unavailablePools?.some(p => previous.some(candidate => candidate.poolId === p.poolId));
      if (current) {
        // Keep an unread contender until the registry can account for it.
        for (const candidate of previous) {
          if (registry.unavailablePools?.some(p => p.poolId === candidate.poolId) &&
              !current.some(p => p.poolId === candidate.poolId && p.baseCoinType === candidate.baseCoinType && p.quoteCoinType === candidate.quoteCoinType)) {
            current.push(candidate);
          }
        }
      } else if (fresh && index?.markets.get(name)?.revision === latest?.markets.get(name)?.revision &&
          !unreadCandidate && registry.pools.some(p => p.pool_name === name && p.active !== false)) {
        unresolved.delete(name);
      } else {
        directory.conflicts.set(name, previous);
      }
    }
    for (const [name, candidates] of directory.conflicts) unresolved.set(name, candidates);
    return index ? { ...directory, observedIndex: index } : directory;
  }

  async function marketsFor(name?: string, selected?: Selection): Promise<ChartDirectory> {
    const registryOffer = selected?.catalogEndpoint === "pool_registry";
    const registry = () => selected && source
      ? source.fetchPools(selected.poolId, true)
      : fetchPoolsCached(!name && !selected);

    // An outage menu was explicitly offered from the registry. Keep its
    // selection usable without requiring another request to the failed index.
    if (!options.indexer) return chartMarkets(await registry(), undefined, true);
    if (registryOffer && !selected.mixedCatalog) {
      const current = await registry();
      const prior = lastCatalog && lastCatalog.expiresAtMs > now().getTime() ? lastCatalog.value : undefined;
      return reconcile(current, registryOffer ? prior : undefined, true);
    }

    let index: CatalogObservation;
    try {
      index = await readCatalog(options.indexer);
    } catch (error) {
      options.assertCurrent?.();
      if (error instanceof Error && error.name === "AbortError") throw error;
      if (selected ? !registryOffer : name !== undefined && !knownUnlistedName(name)) throw error;
      const current = await registry();
      const prior = lastCatalog && lastCatalog.expiresAtMs > now().getTime() ? lastCatalog.value : undefined;
      return reconcile(current, prior, true);
    }

    const pairs = selectDeepbookCandleCanonicalUsdcPools(index.pools).map(deepbookUsdcPriceHistoryPairFromPool);
    const complete = curatedChartCoinTypes.every(type => pairs.some(p => p.baseAsset.coinType === type));
    const lookupName = selected?.poolName ?? name;
    const listed = !lookupName || index.pools.some(p => p.pool_name === lookupName || p.pool_id === selected?.poolId);
    const relevantConflict = (conflicts: Map<string, MarketIdentity[]>) => lookupName
      ? conflicts.has(lookupName)
      : pairs.some(p => curatedChartCoinTypes.includes(p.baseAsset.coinType) && conflicts.has(p.poolName));
    const canUseIndex = complete && listed && !registryOffer;
    if (canUseIndex) {
      const observed = observedRegistry();
      if (observed) reconcile(observed, index);
    }
    if (canUseIndex && !relevantConflict(unresolved)) return { ...index.directory, observedIndex: index };

    const recheckRegistry = !complete || !!selected || listed || relevantConflict(unresolved);
    let currentRegistry: PoolList;
    try {
      currentRegistry = await fetchPoolsCached(false, recheckRegistry);
    } catch (error) {
      options.assertCurrent?.();
      if (!canUseIndex || !relevantConflict(unresolved) || (error instanceof Error && error.name === "AbortError")) throw error;
      // A failed recheck keeps the disputed choices blocked. Independent
      // indexed markets in the same menu still have a usable price source.
      const latest = lastCatalog?.value;
      if (!latest) throw error;
      return { ...reconcile(latest), observedIndex: index };
    }
    const evidence = observedRegistry();
    return reconcile(evidence ?? currentRegistry, index, registryOffer,
      recheckRegistry && poolCache.get("all")?.value === currentRegistry);
  }

  async function getPools(): Promise<DeepbookUsdcChartPoolsResponse> {
    let directory: Awaited<ReturnType<typeof marketsFor>>;
    try {
      directory = await marketsFor();
    } catch (error) {
      return { status: "source_unavailable", reason: chartSourceUnavailableReason(error), ...chartReadFacts("market_lookup") };
    }
    const unavailablePools: (MarketIdentity & { poolName?: string })[] = [];
    for (const [poolName, candidates] of directory.conflicts) {
      if (candidates.some(c => curatedChartCoinTypes.includes(normalizeCoinType(c.baseCoinType)))) {
        unavailablePools.push(...candidates.map(c => ({ ...c, poolName, unavailableReason: "pool_identity_mismatch" as const })));
      }
    }
    const curated = curateUsdcChartPools(directory.pools.filter(p => p.active !== false).map(deepbookUsdcPriceHistoryPairFromPool));
    const pools = curated.filter(p => !directory.conflicts.has(p.poolName)).map(pair => ({
      ...pair, catalogEndpoint: directory.indexedNames.has(pair.poolName) ? "get_pools" as const : "pool_registry" as const
    }));
    for (const candidate of directory.unavailablePools ?? []) {
      if (!pools.some(p => p.poolId === candidate.poolId) && !unavailablePools.some(p => p.poolId === candidate.poolId)) {
        unavailablePools.push(candidate);
      }
    }
    if (pools.length === 0 && unavailablePools.length) {
      return {status:"source_unavailable", reason:"pool_list_incomplete", candidates:unavailablePools, ...chartReadFacts("market_lookup")};
    }
    return {
      status: "ok",
      ...(unavailablePools.length ? { unavailablePools } : {}),
      ...(directory.mixed ? { mixedCatalog: true } : {}),
      poolCount: pools.length,
      pools,
      intervals: DEEPBOOK_CANDLE_INTERVALS,
      defaultInterval: DEFAULT_DEEPBOOK_CANDLE_INTERVAL,
      defaultLimit: DEEPBOOK_USDC_CHART_DEFAULT_LIMIT,
      maxCandles: DEEPBOOK_USDC_CHART_MAX_CANDLES,
      source: directory.source,
      ...chartReadFacts("market_list")
    };
  }

  // Only a previously observed absence and a known registry market can outlive
  // a transient catalog failure. Neither cache establishes a new market binding.
  function knownUnlistedName(name: string): boolean {
    const at = now().getTime();
    const registry = poolCache.get("all");
    return !!lastCatalog && lastCatalog.expiresAtMs > at && !!registry && registry.expiresAtMs > at &&
      !lastCatalog.value.pools.some(p => p.pool_name === name) && registry.value.pools.some(p => p.pool_name === name);
  }

  async function readCandles(prepared: PreparedChartRead, selected?: Selection, onPreview?: (read: () => DeepbookUsdcChartCandlesResponse) => void): Promise<DeepbookUsdcChartResult> {
    if (prepared.status !== "ready") return prepared;
    const { query, named } = prepared;
    const directId = !!query.poolId && !selected;
    let directory: Awaited<ReturnType<typeof marketsFor>>;
    try {
      if (directId) {
        if (!source) throw new Error("Market source unavailable.");
        const exact = await source.fetchPools(query.poolId);
        directory = chartMarkets({ ...exact, pools: exact.pools.filter(p => p.pool_id === query.poolId) });
      } else {
        directory = await marketsFor(named ? query.poolName : undefined, selected);
      }
    } catch (error) {
      const attemptedIndexer = !!options.indexer && !directId && selected?.catalogEndpoint !== "pool_registry";
      return { status: "source_unavailable", reason: chartSourceUnavailableReason(error, attemptedIndexer),
        query, ...chartReadFacts("market_lookup") };
    }
    const pools = directory.pools;
    const pool = pools.find(candidate => query.poolId ? candidate.pool_id === query.poolId : candidate.active !== false && candidate.pool_name === query.poolName);
    const marketName = selected?.poolName ?? pool?.pool_name ?? query.poolName;
    const indexed = !directId && selected?.catalogEndpoint !== "pool_registry" && directory.indexedNames.has(marketName);
    const observed = directory.observedIndex;
    const revision = observed?.markets.get(marketName)?.revision;
    const bindingChanged = () => {
      if (!observed) return false;
      if (!lastCatalog) return true;
      const latest = lastCatalog.value.markets.get(marketName);
      if (revision === latest?.revision) return false;
      // A registry offer remains bound to its own source if the index starts
      // or stops listing that same market while the card is open.
      if (selected?.catalogEndpoint === "pool_registry" && pool) {
        return latest !== undefined && latest.identity !== candleMarketIdentityKey(pool);
      }
      return true;
    };
    const changedMarket = (): DeepbookUsdcChartCandlesResponse => ({
      status: "unsupported_pool", reason: "selected_market_changed", query,
      availablePoolNames: [], source: directory.source, ...chartReadFacts("market_lookup")
    });
    const conflict = !directId && directory.conflicts.get(marketName);
    if (selected && (!pool || selected.poolId !== pool.pool_id || pool.active === false || conflict ||
        (selected.catalogEndpoint === "get_pools" && !indexed))) {
      // Retain a current registry observation that establishes a conflict.
      // Even a subsequently complete index must reconcile that disagreement.
      if (!conflict) invalidateRegistryLists();
      return { status: "unsupported_pool", reason: "selected_market_changed", query,
        ...(conflict ? { candidates: conflict } : {}), availablePoolNames: [], source: directory.source, ...chartReadFacts("market_lookup") };
    }
    const ambiguous = !!conflict;
    const matches = conflict || pools.filter(candidate => candidate.active !== false && candidate.pool_name === query.poolName).map(marketIdentity);
    if (!indexed && !query.poolId && !ambiguous && directory.unavailablePools?.length) {
      return {status:"source_unavailable", reason:"pool_list_incomplete", candidates:[...matches,...directory.unavailablePools], query, ...chartReadFacts("market_lookup")};
    }
    if (pool === undefined || ambiguous) {
      return {
        status: "unsupported_pool",
        candidates: matches,
        reason: ambiguous ? "ambiguous_pool_name" : "pool_not_in_mainnet_usdc_markets",
        query,
        availablePoolNames: pools.map((candidate) => candidate.pool_name),
        source: directory.source,
        ...chartReadFacts("market_lookup")
      };
    }

    if (bindingChanged()) return changedMarket();
    const pair = deepbookUsdcPriceHistoryPairFromPool(pool);
    if ((named && pool.pool_name !== query.poolName) || selected && ((selected.poolName !== undefined && selected.poolName !== pool.pool_name) || selected.baseAsset.coinType !== pair.baseAsset.coinType ||
        selected.quoteAsset.coinType !== pair.quoteAsset.coinType)) {
      return { status: "unsupported_pool", reason: "selected_market_changed", query,
        availablePoolNames: pools.map(p => p.pool_name), source: directory.source, ...chartReadFacts("market_lookup") };
    }
    const allAtSelection = poolCache.get("all");
    const menuAtSelection = poolCache.get("menu");
    let candleResult: CandleList | IndexedChartResult;
    const marketQuery = { ...query, poolName: pool.pool_name };
    try {
      if (!indexed && !query.poolId && !selected && source?.currentPoolId &&
          await source.currentPoolId(pool.base_asset_id, pool.quote_asset_id) !== pool.pool_id) {
        throw new DeepbookCandleSourceError("market_changed", "The registered pool changed.");
      }
      if (indexed && options.indexer) {
        const window = candleQueryWindow(marketQuery, now().getTime());
        const key = JSON.stringify([revision, pool.pool_name, pool.pool_id, pair.baseAsset.coinType, pair.quoteAsset.coinType,
          query.interval, query.startTimeMs, query.endTimeMs, window.firstBucket, window.lastBucket, query.limit]);
        let read = indexedReads.get(key);
        if (!read) {
          read = options.indexer.fetchCandles(marketQuery, pool.pool_id, window).finally(() => {
            if (indexedReads.get(key) === read) indexedReads.delete(key);
          });
          indexedReads.set(key, read);
        }
        candleResult = await read;
        options.assertCurrent?.();
      } else {
        candleResult = await readChainCandles(marketQuery, pool, !!query.poolId && !selected, onPreview && (preview => {
          onPreview(() => {
            const { candles, source } = preview();
            return { status: "preview", query: marketQuery, pair, candles, candleCount: candles.length, source, ...chartCandleFacts() };
          });
        }));
      }
    } catch (error) {
      if (error instanceof DeepbookCandleSourceError && error.reason === "market_changed") {
        invalidateRegistryLists();
        return { status: "unsupported_pool", reason: "selected_market_changed", query,
          availablePoolNames: pools.filter(p => p.active !== false).map(p => p.pool_name), source: directory.source, ...chartReadFacts("market_lookup") };
      }
      return {
        status: "source_unavailable",
        reason: chartSourceUnavailableReason(error, indexed),
        query,
        pair,
        source: directory.source,
        ...chartReadFacts(indexed ? "indexer_candles" : "onchain_candles")
      };
    }

    const pendingConflict = !directId && unresolved.get(marketName);
    if (pendingConflict) {
      return { status: "unsupported_pool", reason: selected ? "selected_market_changed" : "ambiguous_pool_name",
        candidates: pendingConflict, availablePoolNames: [], query, source: directory.source, ...chartReadFacts("market_lookup") };
    }
    if (bindingChanged()) return changedMarket();
    if (!directId && (allAtSelection !== poolCache.get("all") ||
        menuAtSelection !== poolCache.get("menu") && curatedChartCoinTypes.includes(pair.baseAsset.coinType))) {
      const registry = observedRegistry();
      if (!registry) return changedMarket();
      const latest = chartMarkets(registry, lastCatalog?.value, selected?.catalogEndpoint === "pool_registry");
      const current = latest.pools.find(candidate => candidate.pool_name === marketName);
      if (latest.conflicts.has(marketName) || !current || candleMarketIdentityKey(current) !== candleMarketIdentityKey(pool) ||
          latest.indexedNames.has(marketName) !== indexed) return changedMarket();
    }
    const partial = "coverage" in candleResult.source && candleResult.source.coverage === "partial_tail";
    if (candleResult.candles.length === 0 && !partial) {
      return {
        status: "empty_result",
        query: marketQuery,
        pair,
        candleCount: 0,
        candles: [],
        source: candleResult.source,
        ...chartCandleFacts(indexed)
      };
    }

    return {
      status: partial ? "partial_coverage" : "ok",
      query: marketQuery,
      pair,
      candleCount: candleResult.candles.length,
      candles: candleResult.candles,
      source: candleResult.source,
      ...chartCandleFacts(indexed)
    };
  }

  type PoolList = Awaited<ReturnType<DeepbookCandleSourceClient["fetchPools"]>>;
  type CandleList = Awaited<ReturnType<DeepbookCandleSourceClient["fetchCandles"]>>;
  const fetchingPools = new Map<string, Promise<PoolList>>();
  type Listener = (preview: ReadCandlePreview) => void;
  type Flight = {result: Promise<CandleList>; listeners:Set<Listener>; preview?:ReadCandlePreview};
  const fetchingCandles = new Map<string, Flight>();
  async function fetchPoolsCached(menu = false, fresh = false): Promise<PoolList> {
    if (!source) throw new Error("Market source unavailable.");
    const key = menu && source.fetchMenuPools ? "menu" : "all";
    const cached = poolCache.get(key);
    if (!fresh && cached && !cached.value.unavailablePools?.length && cached.expiresAtMs > now().getTime()) return cached.value;
    const existing = fetchingPools.get(key);
    if (existing) return existing;
    const sequence = ++registrySequence;
    const loading = key === "menu" ? source.fetchMenuPools!() : source.fetchPools();
    const pending = loading.then(value => {
      options.assertCurrent?.();
      if (fetchingPools.get(key) === pending) {
        poolCache.set(key, { expiresAtMs: now().getTime() + cacheTtlMs, sequence, value });
      }
      return value;
    }).finally(() => { if (fetchingPools.get(key) === pending) fetchingPools.delete(key); });
    fetchingPools.set(key,pending);
    return pending;
  }
  async function readChainCandles(query: DeepbookUsdcChartCandlesQuery, market: DeepbookCandlePool, directId: boolean, listener?: Listener): Promise<CandleList> {
    if (!source) throw new Error("Market source unavailable.");
    // Selection and current-registration checks precede sharing. Only values that
    // determine the verified OHLCV result belong to its identity.
    const requestedAt = now().getTime();
    const window = candleQueryWindow(query, requestedAt);
    const key = JSON.stringify([
      market.pool_id, market.initialSharedVersion, market.base_asset_id, market.base_asset_decimals,
      market.quote_asset_id, market.quote_asset_decimals, query.interval, query.startTimeMs,
      query.endTimeMs, query.endMode, window.firstBucket, window.lastBucket, query.limit
    ]);
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
    }, requestedAt)).then((value) => {
      if (value.source.poolId !== market.pool_id) throw new Error("The candle source returned a different or unidentified market.");
      validatePoolCandles(value.candles, query);
      options.assertCurrent?.();
      return value;
    }).finally(() => { if (fetchingCandles.get(key) === flight) fetchingCandles.delete(key); });
    const flight: Flight = {result:pending, listeners};
    fetchingCandles.set(key, flight);
    return pending;
  }
  return { getPools, readCandles, clearCache: () => {
    catalogFlight = undefined; lastCatalog = undefined; indexedReads.clear();
    fetchingPools.clear(); fetchingCandles.clear(); poolCache.clear(); unresolved.clear();
  } };
}

function chartSourceUnavailableReason(error: unknown, indexed = false): DeepbookUsdcChartSourceUnavailableReason {
  if (error instanceof DeepbookCandleSourceError) {
    switch (error.reason) {
      case "invalid_payload":
        return indexed ? "invalid_indexer_candle_evidence" : "invalid_chain_candle_evidence";
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

type ChartReadStage = "input" | "market_lookup" | "market_list" | "indexer_candles" | "onchain_candles";
function chartReadFacts(stage: ChartReadStage) {
  const statements: Record<ChartReadStage, string> = {
    input: "The chart input was not accepted.",
    market_lookup: "The requested market could not be confirmed.",
    market_list: "Only market choices were retrieved.",
    indexer_candles: "The chart could not obtain usable candles from DeepBook Indexer.",
    onchain_candles: "The chart could not verify candles from onchain fills."
  };
  return {
    responseSummary: { evidenceKind: stage, sourceStatement: statements[stage],
      usdcDisclaimer: deepbookUsdcPriceHistoryResponseSummary().usdcDisclaimer },
    unsupportedClaims: [...DEEPBOOK_USDC_PRICE_HISTORY_UNSUPPORTED_CLAIMS]
  };
}

function chartCandleFacts(indexed = false) {
  if (indexed) return {
    responseSummary: { ...deepbookUsdcPriceHistoryResponseSummary(), evidenceKind: "official_deepbook_indexer_candles" as const,
      sourceStatement: INDEXER_SOURCE_STATEMENT, candleMeaning: "Each candle is reported by DeepBook Indexer for the selected market name." },
    quantitySemantics: { ...deepbookUsdcPriceHistoryQuantitySemantics(), allowedUse: "official_deepbook_usdc_candle_history" as const,
      source: "deepbook_v3_official_indexer" as const, chainRecomputedBySuiMcp: false as const },
    unsupportedClaims: [...DEEPBOOK_USDC_PRICE_HISTORY_UNSUPPORTED_CLAIMS]
  };
  return {
    responseSummary: deepbookUsdcPriceHistoryResponseSummary(),
    quantitySemantics: deepbookUsdcPriceHistoryQuantitySemantics(),
    unsupportedClaims: [...DEEPBOOK_USDC_PRICE_HISTORY_UNSUPPORTED_CLAIMS]
  };
}
