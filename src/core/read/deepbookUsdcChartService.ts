import { normalizeCoinType } from "./coinMetadata.js";
import { INDEXER_SOURCE_STATEMENT, indexedChartWindow, type DeepbookChartIndexer, type IndexedChartCatalog, type IndexedChartResult } from "./deepbookChartIndexer.js";
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

type MarketFailure = Extract<DeepbookUsdcChartCandlesResponse, { status: "unsupported_pool" | "source_unavailable" }>;

function marketFailure(
  query: DeepbookUsdcChartCandlesQuery, catalog: ChartCatalog,
  reason: "selected_market_changed" | "ambiguous_pool_name" | "pool_list_incomplete",
  candidates?: MarketIdentity[], availablePoolNames: string[] = []
): MarketFailure {
  const facts = { query, source: catalog.source, ...(candidates ? { candidates } : {}), ...chartReadFacts("market_lookup") };
  return reason === "pool_list_incomplete" ? { ...facts, status: "source_unavailable", reason }
    : { ...facts, status: "unsupported_pool", reason, availablePoolNames };
}

// A registry row retains its object ID and coin types even when its metadata or object read failed.
function missingBoundMarket(query: DeepbookUsdcChartCandlesQuery, catalog: ChartCatalog, expected: MarketIdentity): MarketFailure {
  const row = catalog.unavailablePools?.find(candidate => candidate.poolId === expected.poolId);
  if (row && row.unavailableReason !== "pool_identity_mismatch" &&
      normalizeCoinType(row.baseCoinType) === normalizeCoinType(expected.baseCoinType) &&
      normalizeCoinType(row.quoteCoinType) === normalizeCoinType(expected.quoteCoinType)) {
    return marketFailure(query, catalog, "pool_list_incomplete", [row]);
  }
  return marketFailure(query, catalog, "selected_market_changed", row ? [row] : undefined);
}

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

  // Full, menu and single-pair checks all report the currently registered ID.
  // A slower response cannot supersede a newer observation covering the pair.
  let registrations = new Map<string, { sequence: number; identity: MarketIdentity }>();
  const pairKey = (base: string, quote: string) => JSON.stringify([normalizeCoinType(base), normalizeCoinType(quote)]);
  function recordRegistration(identity: MarketIdentity, sequence: number) {
    const key = pairKey(identity.baseCoinType, identity.quoteCoinType);
    const previous = registrations.get(key);
    const menu = curatedChartCoinTypes.includes(normalizeCoinType(identity.baseCoinType)) ? poolCache.get("menu") : undefined;
    if ((previous && previous.sequence > sequence) || (poolCache.get("all")?.sequence ?? 0) > sequence ||
        (menu && menu.sequence > sequence)) return previous?.identity.poolId;
    registrations.set(key, { sequence, identity });
    return identity.poolId;
  }

  function recordRegistryList(list: PoolList, scope: "all" | "menu", sequence: number) {
    for (const [key, entry] of registrations) {
      if (entry.sequence < sequence && (scope === "all" || curatedChartCoinTypes.includes(normalizeCoinType(entry.identity.baseCoinType)))) {
        registrations.delete(key);
      }
    }
    // Partial rows still identify registered types. If two rows disagree on the
    // ID for a pair, neither row alone establishes a pair-wide replacement.
    const pairs = new Map<string, MarketIdentity | null>();
    const rows = list.pools.filter(pool => pool.active !== false).map(marketIdentity);
    for (const row of [...rows, ...(list.unavailablePools ?? [])]) {
      const key = pairKey(row.baseCoinType, row.quoteCoinType);
      const previous = pairs.get(key);
      if (previous === undefined) pairs.set(key, row);
      else if (previous?.poolId !== row.poolId) pairs.set(key, null);
    }
    for (const identity of pairs.values()) {
      if (identity) recordRegistration(identity, sequence);
    }
  }

  function differentRegistration(pool: DeepbookCandlePool) {
    const current = registrations.get(pairKey(pool.base_asset_id, pool.quote_asset_id))?.identity;
    return current && current.poolId !== pool.pool_id ? current : undefined;
  }

  async function registeredPoolId(pool: DeepbookCandlePool) {
    if (!source?.currentPoolId) throw new Error("Pool registration lookup unavailable.");
    const generation = registrations;
    const sequence = ++registrySequence;
    const id = await source.currentPoolId(pool.base_asset_id, pool.quote_asset_id);
    options.assertCurrent?.();
    if (generation !== registrations) throw new Error("The chart source was reset.");
    const current = recordRegistration({ ...marketIdentity(pool), poolId: id }, sequence);
    if (current !== pool.pool_id) invalidateRegistryLists();
    for (const check of pendingSelections) check();
    return current;
  }

  // Only a current observation of both catalogs can resolve a previously
  // disputed name. An unrelated unread row must not erase that observation.
  function reconcile(registry: ChartCatalog, index?: CatalogObservation, registryOnly = false, fresh = false): ChartDirectory {
    options.assertCurrent?.();
    const latest = index && lastCatalog?.value;
    if (index && !latest) throw new Error("The chart source was reset.");
    const directory = chartMarkets(registry, latest, registryOnly);
    for (const pool of directory.pools) {
      const registered = differentRegistration(pool);
      if (pool.active === false || !registered) continue;
      const candidates = directory.conflicts.get(pool.pool_name) ?? [marketIdentity(pool)];
      if (!candidates.some(item => item.poolId === registered.poolId)) candidates.push(registered);
      directory.conflicts.set(pool.pool_name, candidates);
    }
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

  // Only unfinished, name-bound card reads follow market observations. An exact-ID
  // reader can keep consuming the same candle request after a name becomes disputed.
  const pendingSelections = new Set<() => void>();

  async function marketsFor(name?: string, selected?: Selection): Promise<ChartDirectory> {
    try {
      return await loadMarkets(name, selected);
    } finally {
      for (const check of pendingSelections) check();
    }
  }

  async function loadMarkets(name?: string, selected?: Selection): Promise<ChartDirectory> {
    const registryOffer = selected?.catalogEndpoint === "pool_registry";
    const registry = async () => {
      if (!selected || !source) return fetchPoolsCached(!name && !selected);
      const result = await source.fetchPools(selected.poolId);
      const offered = result.pools.find(p => p.pool_id === selected.poolId);
      if (!offered || !source.currentPoolId) return result;
      const current = await registeredPoolId(offered);
      return { ...result, pools: [{ ...offered, active: current === offered.pool_id }] };
    };

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
      else if (registrations.size) reconcile(index);
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
    const conflict = !directId && directory.conflicts.get(marketName);
    const conflictReason = selected ? "selected_market_changed" : "ambiguous_pool_name";
    if (conflict) return marketFailure(query, directory, conflictReason, conflict,
      selected ? [] : pools.map(candidate => candidate.pool_name));
    if (selected && !pool) {
      const failure = missingBoundMarket(query, directory, { poolId: selected.poolId,
        baseCoinType: selected.baseAsset.coinType, quoteCoinType: selected.quoteAsset.coinType });
      if (failure.status === "unsupported_pool") invalidateRegistryLists();
      return failure;
    }
    if (selected && (selected.poolId !== pool?.pool_id || pool.active === false ||
        selected.catalogEndpoint === "get_pools" && !indexed)) {
      invalidateRegistryLists();
      return marketFailure(query, directory, "selected_market_changed");
    }
    const matches = pools.filter(candidate => candidate.active !== false && candidate.pool_name === query.poolName).map(marketIdentity);
    if (!indexed && !query.poolId && directory.unavailablePools?.length) {
      return marketFailure(query, directory, "pool_list_incomplete", [...matches, ...directory.unavailablePools]);
    }
    if (pool === undefined) {
      return {
        status: "unsupported_pool",
        candidates: matches,
        reason: "pool_not_in_mainnet_usdc_markets",
        query,
        availablePoolNames: pools.map((candidate) => candidate.pool_name),
        source: directory.source,
        ...chartReadFacts("market_lookup")
      };
    }

    const pair = deepbookUsdcPriceHistoryPairFromPool(pool);
    if ((named && pool.pool_name !== query.poolName) || selected && ((selected.poolName !== undefined && selected.poolName !== pool.pool_name) || selected.baseAsset.coinType !== pair.baseAsset.coinType ||
        selected.quoteAsset.coinType !== pair.quoteAsset.coinType)) {
      return marketFailure(query, directory, "selected_market_changed", undefined, pools.map(candidate => candidate.pool_name));
    }
    let checkedAll = poolCache.get("all");
    let checkedMenu = poolCache.get("menu");
    const identity = marketIdentity(pool);
    const checkSelection = (): MarketFailure | undefined => {
      if (directId) return;
      const replacement = differentRegistration(pool);
      if (replacement) return marketFailure(query, directory, "selected_market_changed", [identity, replacement]);
      const pendingConflict = unresolved.get(marketName);
      if (pendingConflict) return marketFailure(query, directory, conflictReason, pendingConflict);
      if (observed) {
        const latest = lastCatalog?.value.markets.get(marketName);
        // Bind to the source of this read, regardless of how the user opened it.
        if (!lastCatalog || (revision !== latest?.revision &&
            (indexed || latest && latest.identity !== candleMarketIdentityKey(pool)))) {
          return marketFailure(query, directory, "selected_market_changed");
        }
      }
      const all = poolCache.get("all"), menu = poolCache.get("menu");
      if (checkedAll === all && (checkedMenu === menu || !curatedChartCoinTypes.includes(pair.baseAsset.coinType))) return;
      checkedAll = all;
      checkedMenu = menu;
      const registry = observedRegistry();
      if (!registry) return marketFailure(query, directory, "pool_list_incomplete");
      const latest = chartMarkets(registry, lastCatalog?.value, !indexed);
      const conflicts = latest.conflicts.get(marketName);
      if (conflicts) return marketFailure(query, latest, conflictReason, conflicts);
      const current = latest.pools.find(candidate => candidate.pool_name === marketName);
      if (!current) return missingBoundMarket(query, latest, identity);
      if (current.active === false || candleMarketIdentityKey(current) !== candleMarketIdentityKey(pool) ||
          latest.indexedNames.has(marketName) !== indexed) return marketFailure(query, latest, "selected_market_changed");
    };

    const marketQuery = { ...query, poolName: pool.pool_name };
    let failure: MarketFailure | undefined;
    const invalidated = Promise.withResolvers<MarketFailure>();
    const recheck = () => {
      failure ??= checkSelection();
      if (failure) invalidated.resolve(failure);
      return failure;
    };
    if (!directId) pendingSelections.add(recheck);
    let candleResult: CandleList | IndexedChartResult;
    let releaseScan: (() => void) | undefined;
    try {
      const initialIssue = recheck();
      if (initialIssue) return initialIssue;
      if (!indexed && !query.poolId && !selected && source?.currentPoolId) {
        const currentId = await registeredPoolId(pool);
        const issue = recheck();
        if (issue) return issue;
        if (currentId !== pool.pool_id) throw new DeepbookCandleSourceError("market_changed", "The registered pool changed.");
      }

      let read: Promise<CandleList | IndexedChartResult>;
      if (indexed && options.indexer) {
        const window = indexedChartWindow(marketQuery, now().getTime());
        const key = JSON.stringify([revision, pool.pool_name, pool.pool_id, pair.baseAsset.coinType, pair.quoteAsset.coinType,
          query.interval, query.startTimeMs, query.endTimeMs, window.firstBucket, window.lastBucket, window.lastBucketClosed, query.limit]);
        let shared = indexedReads.get(key);
        if (!shared) {
          shared = options.indexer.fetchCandles(marketQuery, pool.pool_id, window).finally(() => {
            if (indexedReads.get(key) === shared) indexedReads.delete(key);
          });
          indexedReads.set(key, shared);
        }
        read = shared;
      } else {
        const scan = readChainCandles(marketQuery, pool, directId, onPreview && (preview => {
          if (failure) return;
          onPreview(() => {
            const issue = recheck();
            if (issue) return issue;
            const { candles, source } = preview();
            return { status: "preview", query: marketQuery, pair, candles, candleCount: candles.length, source, ...chartCandleFacts() };
          });
        }));
        read = scan.result;
        releaseScan = scan.release;
      }
      const result = directId ? await read : await Promise.race([read, invalidated.promise]);
      options.assertCurrent?.();
      if ("status" in result) return result;
      const issue = recheck();
      if (issue) return issue;
      candleResult = result;
    } catch (error) {
      const issue = recheck();
      if (issue) return issue;
      if (error instanceof DeepbookCandleSourceError && error.reason === "market_changed") {
        invalidateRegistryLists();
        return marketFailure(query, directory, "selected_market_changed", undefined,
          pools.filter(candidate => candidate.active !== false).map(candidate => candidate.pool_name));
      }
      return {
        status: "source_unavailable",
        reason: chartSourceUnavailableReason(error, indexed),
        query,
        pair,
        source: directory.source,
        ...chartReadFacts(indexed ? "indexer_candles" : "onchain_candles")
      };
    } finally {
      pendingSelections.delete(recheck);
      releaseScan?.();
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
  type Flight = {
    result: Promise<CandleList>;
    controller: AbortController;
    readers: number;
    listeners: Set<Listener>;
    preview?: ReadCandlePreview;
  };
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
        recordRegistryList(value, key, sequence);
      }
      return value;
    }).finally(() => { if (fetchingPools.get(key) === pending) fetchingPools.delete(key); });
    fetchingPools.set(key,pending);
    return pending;
  }
  function readChainCandles(query: DeepbookUsdcChartCandlesQuery, market: DeepbookCandlePool, directId: boolean, listener?: Listener) {
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
    function join(flight: Flight) {
      if (listener && flight.preview) listener(flight.preview);
      else if (listener) flight.listeners.add(listener);
      flight.readers++;
      return { result: flight.result, release() {
        if (listener) flight.listeners.delete(listener);
        if (--flight.readers === 0 && fetchingCandles.get(key) === flight) {
          fetchingCandles.delete(key);
          flight.controller.abort();
        }
      } };
    }
    const current = fetchingCandles.get(key);
    if (current) return join(current);
    const controller = new AbortController();
    const listeners = new Set<Listener>();
    const pending = Promise.resolve().then(() => source.fetchCandles({ ...query, market, poolId: market.pool_id, directId }, controller.signal, preview => {
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
    const flight: Flight = { result: pending, listeners, controller, readers: 0 };
    fetchingCandles.set(key, flight);
    return join(flight);
  }
  return { getPools, readCandles, clearCache: () => {
    catalogFlight = undefined; lastCatalog = undefined; indexedReads.clear();
    fetchingPools.clear(); fetchingCandles.clear(); poolCache.clear(); registrations = new Map(); unresolved.clear();
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
