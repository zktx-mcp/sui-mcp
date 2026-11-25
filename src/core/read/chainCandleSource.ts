import { curatedChartCoinTypes } from "./deepbookRegistry.js";
import { bcs } from "@mysten/sui/bcs";
import { DeepBookClient, mainnetPackageIds, mainnetPools } from "@mysten/deepbook-v3";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { normalizeStructTag, parseStructTag } from "@mysten/sui/utils";
import { z } from "zod";
import { SUI_MAINNET_CHAIN_IDENTIFIER } from "../suiEndpoint.js";
import {
  DEEPBOOK_CANDLE_CANONICAL_USDC_COIN_TYPE,
  DEEPBOOK_CANDLE_SOURCE_STATEMENT,
  DeepbookCandleSourceError,
  candleBucketStart,
  deepbookCandleIntervalDurationMs,
  type DeepbookCandleQuery,
  type DeepbookCandleSourceEvidence,
  type DeepbookCandlePool, type DeepbookCandlePoolsResult, type ReadCandlePreview, type MarketIdentity,
} from "./deepbookCandleSource.js";
import {
  MarketGraphqlReader,
  FOUNDATION_GRAPHQL,
  DEEPBOOK_TYPE_ORIGIN,
  renderCandles,
  scanPoolBars,
  scanSplitPoolBars,
  grpcPoolFills,
  historicalPoolFills,
  type RawCandle,
  type RawFill,
} from "./deepbookChainHistory.js";

const id = z.string().regex(/^0x[0-9a-f]{64}$/);
const canonicalUsdc = normalizeStructTag(DEEPBOOK_CANDLE_CANONICAL_USDC_COIN_TYPE);
const poolType = DEEPBOOK_TYPE_ORIGIN + "::pool::Pool";
const registryType = DEEPBOOK_TYPE_ORIGIN + "::registry::";
const registryRoot = z.object({
  object: z.object({
    asMoveObject: z.object({
      contents: z.object({
        type: z.object({ repr: z.literal(registryType + "Registry") }),
        json: z.object({ inner: z.object({ id, version: z.string().regex(/^\d+$/) }) }),
      }),
    }),
  }),
});
const poolsBag = z.object({
  address: z.object({
    dynamicField: z.object({
      value: z.object({
        type: z.object({ repr: z.literal(registryType + "RegistryInner") }),
        json: z.object({ pools: z.object({ id }) }),
      }),
    }),
  }),
});
const registryPage = z.object({
  address: z.object({
    dynamicFields: z.object({
      nodes: z.array(
        z.object({
          name: z.object({
            type: z.object({ repr: z.literal(registryType + "PoolKey") }),
            json: z.object({ base: z.string(), quote: z.string() }),
          }),
          value: z.object({ type: z.object({ repr: z.literal(normalizeStructTag("0x2::object::ID")) }), json: id }),
        }),
      ),
      pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
    }),
  }),
});
class MarketDiscoveryError extends Error {
  constructor(readonly reason: NonNullable<MarketIdentity["unavailableReason"]>) { super(reason); }
}

const sdkNames = new Map(Object.entries(mainnetPools).map(([name, pool]) => [pool.address, name]));

// The 0.8.2 indexer's OHCLV_DEFAULT_WINDOW_MS was seven days. Its default
// window selected bucket starts, independently of the maximum number of rows.
const DEFAULT_CHART_WINDOW_MS = 7 * 24 * 60 * 60_000;

function resolveCandleWindow(query: DeepbookCandleQuery, birth: number, indexedAt: number, requestedAt: number) {
  const interval = query.interval;
  const width = deepbookCandleIntervalDurationMs(interval);
  const history = query.window === "history";
  const defaultStart = query.startTimeMs === undefined;
  const end = history ? query.endTimeMs - 1 : query.endTimeMs ?? (defaultStart ? requestedAt : indexedAt);
  const start = query.startTimeMs ?? Math.max(0, end - DEFAULT_CHART_WINDOW_MS);
  const bucket = candleBucketStart(start, interval);
  // An explicit Chart start still includes its overlapping bucket. History
  // and the default seven-day window select bucket starts within the range.
  const firstBucket = (history || defaultStart) && bucket < start ? bucket + width : bucket;
  const partial = end > indexedAt;
  if (!history && end < birth)
    throw new DeepbookCandleSourceError("market_not_created", "The requested period precedes this pool.");
  if (start > indexedAt || (!history && query.endTimeMs !== undefined && query.endMode !== "latest_indexed" &&
      partial && candleBucketStart(end, interval) > candleBucketStart(indexedAt, interval))) {
    throw new DeepbookCandleSourceError("source_unavailable", "The requested period extends beyond indexed chain data.");
  }
  const readUntil = Math.min(indexedAt + 1, candleBucketStart(end, interval) + width);
  const observedEnd = Math.min(end, indexedAt);
  // Buckets ending before creation are provably empty without reading any fills.
  const empty = (history || defaultStart) && (readUntil <= birth || firstBucket > observedEnd);
  return {
    observedEnd, readUntil, first: Math.max(birth, firstBucket),
    start, end, coveredFrom: history ? start : Math.max(birth, defaultStart ? start : firstBucket),
    coveredUntil: empty ? observedEnd + 1 : readUntil,
    coverage: partial ? "partial_tail" as const : "complete" as const,
    empty
  };
}

export class ChainCandleSource {
  private readonly reader: MarketGraphqlReader;
  private readonly registry: DeepBookClient;
  private readonly publicGraphqlUrl: string;
  private owner = new AbortController();

  constructor(
    private readonly rpc = new SuiGrpcClient({ network: "mainnet", baseUrl: "https://fullnode.mainnet.sui.io:443" }),
    graphqlUrl = FOUNDATION_GRAPHQL,
    private readonly grpcUrl = "https://fullnode.mainnet.sui.io:443",
  ) {
    this.reader = new MarketGraphqlReader(fetch, graphqlUrl);
    // Operator-specific paths may contain access credentials. The assertion of
    // mainnet identity comes from the node, independent of its public label.
    this.publicGraphqlUrl = graphqlUrl === FOUNDATION_GRAPHQL ? graphqlUrl : new URL(graphqlUrl).origin;
    this.registry = new DeepBookClient({ client: rpc, network: "mainnet", address: "0x0" });
  }

  get signal() {
    return this.owner.signal;
  }

  reset() {
    this.owner.abort();
    this.owner = new AbortController();
  }
  close() {
    this.owner.abort();
  }

  private source(
    endpoint: DeepbookCandleSourceEvidence["endpoint"],
    url = this.publicGraphqlUrl,
  ): DeepbookCandleSourceEvidence {
    return {
      baseUrl: url,
      endpoint,
      url,
      fetchedAt: new Date().toISOString(),
      sourceStatement: DEEPBOOK_CANDLE_SOURCE_STATEMENT,
    };
  }

  private async registeredPools(signal: AbortSignal) {
    const root = await this.reader.query(
      `query($id:SuiAddress!){chainIdentifier checkpoint{sequenceNumber} object(address:$id){asMoveObject{contents{type{repr} json}}}}`,
      { id: mainnetPackageIds.REGISTRY_ID },
      registryRoot.extend({
        chainIdentifier: z.literal(SUI_MAINNET_CHAIN_IDENTIFIER),
        checkpoint: z.object({ sequenceNumber: z.number().int().safe() }),
      }),
      signal,
    );
    const inner = root.object.asMoveObject.contents.json.inner;
    const cp = root.checkpoint.sequenceNumber;
    const bag = await this.reader.query(
      `query($cp:UInt53!,$id:SuiAddress!,$version:DynamicFieldName!){checkpoint(sequenceNumber:$cp){query{
      address(address:$id){dynamicField(name:$version){value{... on MoveValue{type{repr} json}}}}}}}`,
      { cp, id: inner.id, version: { type: "u64", bcs: bcs.u64().serialize(inner.version).toBase64() } },
      z.object({ checkpoint: z.object({ query: poolsBag }) }),
      signal,
    );
    const bagId = bag.checkpoint.query.address.dynamicField.value.json.pools.id;
    const markets = new Map<string, { base: string; quote: string }>();
    let after: string | null = null;
    const cursors = new Set<string>();
    do {
      const result: { checkpoint: { query: z.infer<typeof registryPage> } } = await this.reader.query(
        `query($cp:UInt53!,$id:SuiAddress!,$after:String){checkpoint(sequenceNumber:$cp){query{
        address(address:$id){dynamicFields(after:$after){nodes{name{type{repr} json} value{... on MoveValue{type{repr} json}}}
        pageInfo{hasNextPage endCursor}}}}}}`,
        { cp, id: bagId, after },
        z.object({ checkpoint: z.object({ query: registryPage }) }),
        signal,
      );
      const page = result.checkpoint.query.address.dynamicFields;
      for (const { name, value } of page.nodes) {
        const quote = normalizeStructTag(name.json.quote);
        if (quote === canonicalUsdc) markets.set(value.json, { base: normalizeStructTag(name.json.base), quote });
      }
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
      if (!after || cursors.has(after)) throw new Error("Registry cursor failed to advance.");
      cursors.add(after);
    } while (after);
    return markets;
  }

  async currentPoolId(base: string, quote: string) {
    const signal = this.owner.signal;
    const id = await this.registry.getPoolIdByAssets(base, quote);
    signal.throwIfAborted();
    return id;
  }

  fetchMenuPools() { return this.fetchPools(undefined, false, undefined, curatedChartCoinTypes); }

  async fetchPools(poolId?: string, checkRegistration = false, caller?: AbortSignal, baseTypes?: readonly string[]): Promise<DeepbookCandlePoolsResult> {
    const signal = caller ? AbortSignal.any([this.owner.signal, caller]) : this.owner.signal;
    const chain = await this.rpc.ledgerService.getServiceInfo({}, { abort: signal }).response;
    if (chain.chainId !== SUI_MAINNET_CHAIN_IDENTIFIER) throw new Error("Unexpected pool object chain.");
    const markets: Map<string, { base: string; quote: string } | undefined> = poolId
      ? new Map([[id.parse(poolId), undefined]])
      : await this.registeredPools(signal);
    const metadata = new Map<string, ReturnType<typeof this.rpc.core.getCoinMetadata>>();
    const coin = (coinType: string) => {
      const call = metadata.get(coinType) ?? this.rpc.core.getCoinMetadata({ coinType, signal }).catch(() => {
        throw new MarketDiscoveryError("coin_metadata_unavailable");
      });
      metadata.set(coinType, call);
      return call;
    };
    const allowed = baseTypes && new Set(baseTypes.map(type => normalizeStructTag(type)));
    const candidates = [...markets].filter(([, pair]) => !allowed || pair && allowed.has(pair.base));
    const rows = await Promise.allSettled(
      candidates.map(async ([address, registered]): Promise<DeepbookCandlePool | undefined> => {
        const { object } = await this.rpc.core.getObject({ objectId: address, signal });
        const tag = parseStructTag(object.type);
        if (
          tag.address + "::" + tag.module + "::" + tag.name !== poolType ||
          tag.typeParams.length !== 2 ||
          !object.owner.Shared
        ) {
          if (registered) throw new MarketDiscoveryError("pool_identity_mismatch");
          return;
        }
        const [base, quote] = tag.typeParams.map((param) => normalizeStructTag(param)) as [string, string];
        if (registered && (registered.base !== base || registered.quote !== quote))
          throw new MarketDiscoveryError("pool_identity_mismatch");
        if (quote !== canonicalUsdc) return;
        const [{ coinMetadata: b }, { coinMetadata: q }] = await Promise.all([coin(base), coin(quote)]);
        if (!b?.symbol || !q?.symbol) throw new MarketDiscoveryError("coin_metadata_unavailable");
        const active = checkRegistration
          ? (await this.currentPoolId(base, quote)) === address
          : registered
            ? true
            : undefined;
        signal.throwIfAborted();
        return {
          pool_id: address,
          pool_name: sdkNames.get(address) ?? b.symbol.toUpperCase() + "_USDC",
          initialSharedVersion: object.owner.Shared.initialSharedVersion,
          ...(active === undefined ? {} : { active }),
          base_asset_id: base,
          base_asset_symbol: b.symbol,
          base_asset_decimals: b.decimals,
          quote_asset_id: quote,
          quote_asset_symbol: q.symbol,
          quote_asset_decimals: q.decimals,
        };
      }),
    );
    signal.throwIfAborted();
    const pools: DeepbookCandlePool[] = [], unavailablePools = [];
    for (const [index,row] of rows.entries()) {
      if (row.status === "fulfilled") {
        if (row.value) pools.push(row.value);
      } else {
        const [address, pair] = candidates[index]!;
        if (!pair) throw row.reason;
        unavailablePools.push({
          poolId: address, baseCoinType: pair.base, quoteCoinType: pair.quote,
          unavailableReason: row.reason instanceof MarketDiscoveryError ? row.reason.reason : "pool_object_unavailable" as const
        });
      }
    }
    return {
      pools, ...(unavailablePools.length ? {unavailablePools} : {}),
      source: this.source("pool_registry", poolId ? this.grpcUrl : this.publicGraphqlUrl),
    };
  }

  async fetchCandles(query: DeepbookCandleQuery, caller?: AbortSignal, preview?: (value: ReadCandlePreview) => void) {
    const requestedAt = Date.now();
    const { market } = query;
    if (!market?.initialSharedVersion || market.pool_id !== query.poolId)
      throw new Error("A verified pool object is required.");
    const signal = caller ? AbortSignal.any([this.owner.signal, caller]) : this.owner.signal;
    if (!query.directId && market.active !== true)
      throw new DeepbookCandleSourceError("market_changed", "The selected market has changed.");
    const [limits, created] = await Promise.all([
      this.reader.range(signal),
      this.reader.query(
        `query($id:SuiAddress!,$version:UInt53!){object(address:$id,version:$version){previousTransaction{effects{checkpoint{sequenceNumber timestamp}}}}}`,
        { id: market.pool_id, version: Number(market.initialSharedVersion) },
        z.object({
          object: z.object({
            previousTransaction: z.object({
              effects: z.object({ checkpoint: z.object({ sequenceNumber:z.number().int().nonnegative().safe(), timestamp: z.iso.datetime() }) }),
            }),
          }),
        }),
        signal,
      ),
    ]);
    const { range, maxPageSize } = limits;
    const creation = created.object.previousTransaction.effects.checkpoint;
    const birth = Date.parse(creation.timestamp);
    const asOf = Date.parse(range.last.timestamp);
    const interval = query.interval;
    const window = resolveCandleWindow(query, birth, asOf, requestedAt);
    const { first, observedEnd, readUntil } = window;
    const endpoints = new Set<string>();
    const evidence = (from: number, until: number): DeepbookCandleSourceEvidence => ({
      ...this.source("order_fills", [...endpoints][0] ?? this.publicGraphqlUrl),
      readEndpoints: endpoints.size ? [...endpoints] : [this.publicGraphqlUrl], poolId: market.pool_id,
      poolName: market.pool_name, interval, startTimeMs: query.startTimeMs ?? window.start,
      endTimeMs: query.endTimeMs ?? window.end, limit: query.limit,
      coverage: window.coverage, coveredFrom: new Date(from).toISOString(), coveredUntil: new Date(until).toISOString(),
      indexedCheckpoint: range.last.sequenceNumber, indexedAt: range.last.timestamp
    });
    if (window.empty) return { candles: [], source: evidence(window.coveredFrom, window.coveredUntil) };
    const retained = Date.parse(range.first.timestamp);
    const pruned = range.first.sequenceNumber > creation.sequenceNumber && first <= retained;
    if (query.startTimeMs !== undefined && pruned)
      throw new DeepbookCandleSourceError("candle_coverage_incomplete", "Requested fills exceed indexed retention.");
    const [lo, hi] = await Promise.all([
      first === birth ? Math.max(creation.sequenceNumber, range.first.sequenceNumber) : this.reader.firstAtOrAfter(first, range.first, range.last, signal),
      this.reader.firstAtOrAfter(readUntil, range.first, range.last, signal),
    ]);
    const info = await this.rpc.ledgerService.getServiceInfo({}, { abort: signal }).response;
    if (
      info.chainId !== SUI_MAINNET_CHAIN_IDENTIFIER ||
      info.lowestAvailableCheckpoint === undefined ||
      info.checkpointHeight === undefined
    ) {
      throw new Error("The ledger did not provide its mainnet coverage.");
    }
    const grpcFrom = Number(info.lowestAvailableCheckpoint);
    const grpcEnd = Number(info.checkpointHeight) + 1;
    const reader = this.reader,
      rpc = this.rpc,
      graphqlUrl = this.publicGraphqlUrl,
      grpcUrl = this.grpcUrl;
    const id = market.pool_id;
    async function* archive(from: number, until: number, rangeSignal: AbortSignal) {
      if (from >= until) return;
      endpoints.add(graphqlUrl);
      const typedAvailable =
        !!limits.fills && from >= limits.fills.first.sequenceNumber && until - 1 <= limits.fills.last.sequenceNumber;
      yield* historicalPoolFills(reader, id, from, until, maxPageSize, rangeSignal, typedAvailable);
    }
    async function* fills(from: number, until: number, rangeSignal: AbortSignal) {
      yield* archive(Math.max(from, grpcEnd), until, rangeSignal);
      let remaining = Math.min(until, grpcEnd);
      let floor = grpcFrom;
      while (Math.max(from, floor) < remaining) {
        // A cursor is valid only while its lower bound is retained. Drain the
        // recent half first when the request straddles the moving retention floor.
        const lower = from > floor ? from : floor + Math.floor((remaining - floor) / 2);
        let height = remaining;
        let group: RawFill[] = [];
        try {
          for await (const fill of grpcPoolFills(rpc, id, lower, remaining, rangeSignal)) {
            if (fill.checkpoint.sequenceNumber !== height) {
              if (group.length) endpoints.add(grpcUrl);
              yield* group;
              height = fill.checkpoint.sequenceNumber;
              group = [];
            }
            group.push(fill);
          }
          endpoints.add(grpcUrl);
          yield* group;
          remaining = lower;
        } catch (error) {
          rangeSignal.throwIfAborted();
          if (!(
            error instanceof Error &&
            "code" in error &&
            (error.code === "OUT_OF_RANGE" || error.code === "UNIMPLEMENTED")
          ))
            throw error;
          remaining = Math.min(remaining, height + 1);
          if (error.code === "UNIMPLEMENTED") break;
          const update = await rpc.ledgerService.getServiceInfo({}, { abort: rangeSignal }).response;
          if (update.chainId !== SUI_MAINNET_CHAIN_IDENTIFIER) throw new Error("Ledger chain changed during the read.");
          const nextFloor = Number(update.lowestAvailableCheckpoint);
          if (!Number.isSafeInteger(nextFloor) || nextFloor <= floor) break;
          floor = nextFloor;
        }
      }
      yield* archive(from, remaining, rangeSignal);
    }
    const bars: RawCandle[] = [];
    let coveredFrom = pruned ? retained : window.coveredFrom;
    let before = hi;
    while (before > lo) {
      let from = lo;
      const width = deepbookCandleIntervalDurationMs(interval);
      const bucketSpan = candleBucketStart(observedEnd, interval) - candleBucketStart(first, interval);
      const limit = query.limit;
      const limitMayTruncate = limit !== undefined && bucketSpan >= limit * width;
      if (limitMayTruncate) {
        const latest = await reader.lastPoolUse(id, lo, before, signal);
        if (!latest) { endpoints.add(graphqlUrl); break; }
        before = latest.sequenceNumber + 1;
        const bucketsNeeded = limit - bars.length;
        const window =
          candleBucketStart(Date.parse(latest.timestamp), interval) -
          (bucketsNeeded - 1) * deepbookCandleIntervalDurationMs(interval);
        if (window > first) from = Math.max(lo, await reader.firstAtOrAfter(window, range.first, latest, signal));
      }
      const split = query.window !== "history" && !pruned && !limitMayTruncate && bucketSpan >= width &&
        from > grpcFrom && before <= grpcEnd && before - from >= 2;
      const scan = split
        ? scanSplitPoolBars(reader, fills, from, before, maxPageSize, signal, interval, asOf)
        : scanPoolBars(reader, fills(from, before, signal), from, before, maxPageSize, signal, interval);
      for await (const bar of scan) {
        if (pruned && bar.start <= retained)
          throw new DeepbookCandleSourceError("candle_coverage_incomplete", "Incomplete oldest candle.");
        bars.push(bar);
        if (preview && bar.start + width <= asOf + 1) {
          // The scan walks backwards. Skip any forming bucket at its head.
          // Joined cards materialize one snapshot per observed count, on demand.
          const firstClosed = bars.length - 1;
          const end = bar.start + width;
          let snapshot: ReturnType<ReadCandlePreview> | undefined;
          preview(() => {
            const count = bars.length - firstClosed;
            if (!snapshot || snapshot.candles.length !== count) {
              const start = bars[bars.length - 1]!.start;
              const candles = renderCandles(bars.slice(firstClosed).reverse(), interval, market.base_asset_decimals, market.quote_asset_decimals);
              snapshot = { candles, source: { ...evidence(Math.max(first, start), end),
                coverage: "complete", startTimeMs: start, endTimeMs: end, limit: count } };
            }
            return snapshot;
          });
          preview = undefined;
        }
        if (bars.length === query.limit) {
          if (query.window !== "history") coveredFrom = Math.max(coveredFrom, bar.start);
          break;
        }
      }
      if (bars.length === query.limit) break;
      before = from;
    }
    signal.throwIfAborted();
    if (pruned && coveredFrom <= retained)
      throw new DeepbookCandleSourceError("candle_coverage_incomplete", "Latest candles exceed indexed retention.");
    const candles = renderCandles(bars.toReversed(), interval, market.base_asset_decimals, market.quote_asset_decimals);
    return { candles, source: evidence(coveredFrom, window.coveredUntil) };
  }
}
