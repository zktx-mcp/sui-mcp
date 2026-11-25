import { DeepbookChartIndexer } from "../src/core/read/deepbookChartIndexer.js";
import { projectReadCardResult } from "../src/core/read/readCardResult.js";
import { chartInputSchema, offeredChartMarket } from "../src/core/read/readCardInputs.js";
import { mainnetCoins } from "@mysten/deepbook-v3";
import { describe, expect, it, vi } from "vitest";
import {
  marketIdentity,
  DEEPBOOK_CANDLE_CANONICAL_USDC_COIN_TYPE,
  DEEPBOOK_CANDLE_SOURCE_STATEMENT,
  DEEPBOOK_REGISTRY_SOURCE_STATEMENT,
  DeepbookCandleSourceError,
  type DeepbookTradeCandle,
  type DeepbookCandleQuery,
  type DeepbookCandleSourceEvidence,
  type DeepbookCandlePool,
  type DeepbookCandleSourceClient
} from "../src/core/read/deepbookCandleSource.js";
import {
  createDeepbookUsdcChartService,
  prepareChartRead,
  type DeepbookUsdcChartResult,
  type DeepbookUsdcChartPoolsResponse,
  DEEPBOOK_USDC_CHART_DEFAULT_LIMIT
} from "../src/core/read/deepbookUsdcChartService.js";

const fetchedAt = "2026-06-27T00:00:00.000Z";
const baseUrl = "https://deepbook-indexer.mainnet.mystenlabs.com";
const suiPoolId = `0x${"1".repeat(64)}`;
const deepPoolId = `0x${"2".repeat(64)}`;
const nonUsdcPoolId = `0x${"3".repeat(64)}`;
const suiCoinType = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const deepCoinType = mainnetCoins.DEEP!.type;

// Admit the fixture requests after the last candle in this source.
function prepared(input: unknown) {
  return prepareChartRead(chartInputSchema.parse(input), new Date("2026-06-27T08:00:00Z"));
}

describe("DeepBook USDC chart service", () => {
  it("uses the same indexer read for a named and menu chart while preserving exact-ID reads and market changes", async () => {
    const calls: URL[] = [];
    const pools = officialPools();
    const day = Date.parse("2026-06-27T00:00:00Z");
    const indexer = new DeepbookChartIndexer(() => new AbortController().signal, async input => {
      const url = new URL(String(input));
      calls.push(url);
      return Response.json(url.pathname === "/get_pools" ? pools : { candles: [[day, 2, 3, 1, 2.5, 17]] });
    });
    const api = createDeepbookUsdcChartService({ indexer, source: fakeSource(), now: () => new Date(day + 60000) });
    const selected = { poolId: suiPoolId, poolName: "SUI_USDC", baseAsset: { coinType: suiCoinType },
      quoteAsset: { coinType: DEEPBOOK_CANDLE_CANONICAL_USDC_COIN_TYPE } };
    const byName = prepared({ poolName: "SUI_USDC", interval: "1d" });
    const byId = prepared({ poolId: suiPoolId, interval: "1d" });
    const [named, chosen] = await Promise.all([api.readCandles(byName), api.readCandles(byId, selected)]);
    for (const result of [named, chosen]) {
      expect(result).toMatchObject({ status: "ok", candles: [{ start: fetchedAt, close: "2.5", volume: "17" }],
        source: { endpoint: "ohclv", catalogPoolId: suiPoolId }, quantitySemantics: { chainRecomputedBySuiMcp: false } });
      expect(projectReadCardResult("chart", { poolId: suiPoolId }, result).data).toBe(result);
    }
    expect(calls.map(u => u.pathname)).toEqual(["/get_pools", "/ohclv/SUI_USDC"]);
    expect(calls[1]!.searchParams.get("start_time")).toBe(String(Date.parse("2026-06-21T00:00:00Z")));
    expect(calls[1]!.searchParams.get("end_time")).toBe(String(Date.parse("2026-06-27T00:01:00Z")));
    expect(calls[1]!.searchParams.get("limit")).toBe("500");
    expect(await api.readCandles(prepared({ poolId: suiPoolId }))).toMatchObject({ source: { endpoint: "order_fills" } });

    pools[0] = { ...pools[0]!, pool_id: nonUsdcPoolId };
    expect(await api.readCandles(byId, selected)).toMatchObject({ reason: "selected_market_changed" });
    expect(calls.filter(u => u.pathname.startsWith("/ohclv"))).toHaveLength(1);
  });

  it("finishes overlapping named reads when independent catalog responses keep the selected market", async () => {
    const started = Promise.withResolvers<void>(), registry = Promise.withResolvers<void>(), candles = Promise.withResolvers<void>();
    const source = fakeSource();
    const pools = officialPools();
    let catalogs = 0, registryReads = 0, candleReads = 0;
    const indexer = new DeepbookChartIndexer(() => new AbortController().signal, async () => {
      catalogs++;
      // The selected SUI market is registry-only in both catalogs.
      return Response.json(catalogs === 1 ? [pools[1]] : [pools[1], pools[2]]);
    });
    const api = createDeepbookUsdcChartService({ indexer, source: {
      ...source, async fetchPools() {
        registryReads++; started.resolve(); await registry.promise;
        return source.fetchPools();
      }, async fetchCandles(query) {
        candleReads++; await candles.promise; return source.fetchCandles(query);
      }
    } });
    const query = prepared({ poolName: "SUI_USDC", interval: "15m" });
    const first = api.readCandles(query);
    await started.promise;
    const second = api.readCandles(query);
    // Drain the ready continuations before releasing each source, without a time threshold.
    await new Promise<void>(resolve => setImmediate(resolve));
    registry.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    candles.resolve();
    for (const result of await Promise.all([first, second])) {
      expect(result).toMatchObject({ status: "ok", pair: { poolId: suiPoolId }, candles: officialCandles() });
    }
    expect([catalogs, registryReads, candleReads]).toEqual([2, 1, 1]);
  });

  it.each(["listed", "replaced"] as const)("keeps the catalog and its revision together when a pool is %s before the first candle", async change => {
    const [original, deep] = officialPools() as [DeepbookCandlePool, DeepbookCandlePool];
    const replacement = { ...original, pool_id: "0x" + "4".repeat(64) };
    const extra = ["WAL", "NS", "IKA", "XBTC", "USDT"].map((symbol, i) => ({ ...original,
      pool_id: "0x" + (8 + i).toString(16).repeat(64), pool_name: symbol + "_USDC",
      base_asset_id: mainnetCoins[symbol]!.type, base_asset_symbol: symbol }));
    const registryStarted = Promise.withResolvers<void>(), releaseRegistry = Promise.withResolvers<void>();
    const newCatalogRead = Promise.withResolvers<void>();
    let waiting = false, refreshed = false, indexReads = 0, chainReads = 0;
    const current = () => change === "replaced" && refreshed ? replacement : original;
    const bar = officialCandles()[0]!;
    const indexer = new DeepbookChartIndexer(() => new AbortController().signal, async input => {
      if (new URL(String(input)).pathname === "/get_pools") {
        if (refreshed) {
          newCatalogRead.resolve();
          return Response.json([current(), deep, ...extra]);
        }
        return Response.json(change === "listed" ? [deep, ...extra] : [original, deep]);
      }
      indexReads++;
      return Response.json({ candles: [[bar.timestampMs, 1, 2, 1, 2, 8]] });
    });
    const source = fakeSource({ onFetchCandles: () => { chainReads++; } });
    const api = createDeepbookUsdcChartService({ indexer, source: { ...source,
      async fetchPools() {
        if (waiting) { registryStarted.resolve(); await releaseRegistry.promise; }
        return { ...await source.fetchPools(), pools: [deep, current()] };
      }
    } });
    const range = { interval: "15m", startTimeMs: bar.timestampMs, endTimeMs: bar.timestampMs + 30 * 60_000 };
    const menuInput = chartInputSchema.parse({ ...range, poolId: original.pool_id });
    const offer = offeredChartMarket(menuInput, await api.getPools())!;
    const nameInput = prepared({ ...range, poolName: original.pool_name });
    waiting = true;
    const named = api.readCandles(nameInput);
    await registryStarted.promise;
    refreshed = true;
    const selected = api.readCandles(prepared(menuInput), offer);
    try {
      await newCatalogRead.promise;
      // Let the index publish its observation while both selections await the registry.
      await new Promise<void>(resolve => setImmediate(resolve));
    } finally { releaseRegistry.resolve(); }
    const results = await Promise.all([named, selected]);
    if (change === "listed") {
      expect(results[0]).toMatchObject({ status: "ok", pair: { poolId: original.pool_id }, source: { endpoint: "ohclv" } });
      expect(results[1]).toMatchObject({ status: "ok", pair: { poolId: original.pool_id }, source: { endpoint: "order_fills" } });
      expect([indexReads, chainReads]).toEqual([1, 1]);
    } else {
      for (const result of results) expect(result).toMatchObject({ reason: "selected_market_changed" });
      expect([indexReads, chainReads]).toEqual([0, 0]);
      expect(await api.readCandles(nameInput)).toMatchObject({ status: "ok", pair: { poolId: replacement.pool_id } });
    }
  });

  it.each(["coin_metadata_unavailable", "conflicting_name"] as const)(
    "closes only the affected name-bound chart on %s while the same exact-pool read continues", async (observation) => {
      const source = fakeSource();
      const [sui, deep] = officialPools() as [DeepbookCandlePool, DeepbookCandlePool];
      const unread = { ...marketIdentity(sui), unavailableReason: "coin_metadata_unavailable" as const };
      const gate = Promise.withResolvers<void>();
      const preview = Promise.withResolvers<() => DeepbookUsdcChartResult>();
      const exactPreview = Promise.withResolvers<() => DeepbookUsdcChartResult>();
      let refreshed = false, candleReads = 0;
      const api = createDeepbookUsdcChartService({
        indexer: new DeepbookChartIndexer(() => new AbortController().signal, async () => Response.json([deep])),
        source: { ...source,
          async fetchPools(poolId) {
            const catalog = await source.fetchPools();
            if (poolId || !refreshed) return catalog;
            if (observation === "coin_metadata_unavailable") return { ...catalog, pools: [deep], unavailablePools: [unread] };
            return { ...catalog, pools: [sui, { ...deep, pool_name: sui.pool_name }] };
          },
          async fetchCandles(query, signal, onPreview) {
            candleReads++;
            const result = await source.fetchCandles(query, signal);
            onPreview?.(() => ({ ...result, source: { ...result.source, indexedAt: result.candles[1]!.end } }));
            await gate.promise;
            return result;
          }
        }
      });
      const range = { interval: "15m", startTimeMs: 1782541800000, endTimeMs: 1782544500000 };
      const named = api.readCandles(prepared({ ...range, poolName: sui.pool_name }), undefined, preview.resolve);
      try {
        const readNamedPreview = await preview.promise;
        expect(readNamedPreview()).toMatchObject({ status: "preview", pair: { poolId: suiPoolId } });
        const exact = api.readCandles(prepared({ ...range, poolId: suiPoolId }), undefined, exactPreview.resolve);
        const readExactPreview = await exactPreview.promise;
        refreshed = true;
        await api.getPools();
        const expected = observation === "coin_metadata_unavailable"
          ? { status: "source_unavailable", reason: "pool_list_incomplete", candidates: [unread] }
          : { status: "unsupported_pool", reason: "ambiguous_pool_name" };
        expect(await named).toMatchObject(expected);
        expect(readNamedPreview()).toMatchObject(expected);
        expect(readExactPreview()).toMatchObject({ status: "preview", pair: { poolId: suiPoolId } });
        gate.resolve();
        expect(await exact).toMatchObject({ status: "ok", candles: officialCandles() });
        expect(candleReads).toBe(1);
      } finally { gate.resolve(); }
    }
  );

  it.each(["listed", "replaced"] as const)("applies a %s registration to charts already reading the same pool", async change => {
    const source = fakeSource();
    const [sui, deep] = officialPools() as [DeepbookCandlePool, DeepbookCandlePool];
    let changed = false, reads = 0;
    const gate = Promise.withResolvers<void>();
    const indexer = new DeepbookChartIndexer(() => new AbortController().signal, async () => change === "replaced"
      ? new Response(null, { status: 503 }) : Response.json(changed ? [sui, deep] : [deep]));
    const api = createDeepbookUsdcChartService({ indexer, source: { ...source,
      currentPoolId: async () => change === "replaced" && changed ? "0x" + "4".repeat(64) : suiPoolId,
      fetchMenuPools: () => source.fetchPools(),
      async fetchCandles(query, signal, preview) {
        reads++;
        const result = await source.fetchCandles(query, signal);
        preview?.(() => ({ ...result, source: { ...result.source, indexedAt: result.candles[1]!.end } }));
        await gate.promise;
        return result;
      }
    } });
    const range = { interval: "15m", startTimeMs: 1782541800000, endTimeMs: 1782544500000 };
    const input = chartInputSchema.parse({ poolId: suiPoolId, ...range });
    const offer = offeredChartMarket(input, await api.getPools())!;
    const preview = Promise.withResolvers<() => DeepbookUsdcChartResult>();
    const menu = api.readCandles(prepared(input), offer, preview.resolve);
    try {
      const menuSnapshot = await preview.promise;
      expect(menuSnapshot()).toMatchObject({ status: "preview" });
      const joined = Promise.withResolvers<() => DeepbookUsdcChartResult>();
      const other = change === "listed"
        ? api.readCandles(prepared({ poolName: sui.pool_name, ...range }), undefined, joined.resolve)
        : api.readCandles(prepared(input), undefined, joined.resolve);
      const otherSnapshot = await joined.promise;
      changed = true;
      if (change === "listed") {
        await api.getPools();
        expect(menuSnapshot()).toMatchObject({ status: "preview" });
        expect(otherSnapshot()).toMatchObject({ status: "preview" });
      } else {
        expect(await api.readCandles(prepared(input), offer)).toMatchObject({ reason: "selected_market_changed" });
        expect(await menu).toMatchObject({ reason: "selected_market_changed" });
        expect(otherSnapshot()).toMatchObject({ status: "preview" });
      }
      gate.resolve();
      if (change === "listed") expect(await menu).toMatchObject({ status: "ok", source: { endpoint: "order_fills" } });
      expect(await other).toMatchObject({ status: "ok", candles: officialCandles(), pair: { poolId: suiPoolId } });
      expect(reads).toBe(1);
    } finally { gate.resolve(); }
  });

  it("rejects a conflicting name across both catalogs and recovers after their identities agree", async () => {
    const registry = officialPools();
    let indexedId = suiPoolId, candleReads = 0;
    const extraMarkets: DeepbookCandlePool[] = [];
    const indexer = new DeepbookChartIndexer(() => new AbortController().signal, async input => {
      if (new URL(String(input)).pathname === "/get_pools") return Response.json([{ ...registry[0], pool_id: indexedId }, ...extraMarkets]);
      candleReads++;
      return Response.json({ candles: [] });
    });
    const source = fakeSource({ onFetchCandles: () => { candleReads++; } });
    const api = createDeepbookUsdcChartService({ indexer, source: { ...source, async fetchPools() {
      return { ...await source.fetchPools(), unavailablePools: [{ poolId: "0x" + "f".repeat(64),
        baseCoinType: mainnetCoins.WAL!.type, quoteCoinType: registry[0]!.quote_asset_id,
        unavailableReason: "coin_metadata_unavailable" as const }] };
    } } });
    const byName = prepared({ poolName: "SUI_USDC" }), byId = chartInputSchema.parse({ poolId: suiPoolId });
    const before = offeredChartMarket(byId, await api.getPools())!;
    indexedId = nonUsdcPoolId;
    const menu = await api.getPools();
    expect(menu).toMatchObject({ status: "ok", unavailablePools: expect.arrayContaining([
      expect.objectContaining({ poolId: suiPoolId, poolName: "SUI_USDC" }),
      expect.objectContaining({ poolId: indexedId, poolName: "SUI_USDC" })
    ]) });
    expect(offeredChartMarket(byId, menu)).toBeUndefined();
    expect(await api.readCandles(byName)).toMatchObject({ status: "unsupported_pool", reason: "ambiguous_pool_name" });
    expect(await api.readCandles(prepared(byId), before)).toMatchObject({ status: "unsupported_pool", reason: "selected_market_changed" });
    expect(candleReads).toBe(0);
    // Filling the other menu slots does not resolve this market's two IDs.
    for (const [i, symbol] of ["DEEP", "WAL", "NS", "IKA", "XBTC", "USDT"].entries()) {
      extraMarkets.push({ ...registry[0]!, pool_name: symbol + "_USDC", pool_id: "0x" + (i + 8).toString(16).repeat(64),
        base_asset_id: mainnetCoins[symbol]!.type, base_asset_symbol: symbol });
    }
    expect(await api.readCandles(byName)).toMatchObject({ reason: "ambiguous_pool_name" });
    expect(candleReads).toBe(0);
    indexedId = suiPoolId;
    const restored = offeredChartMarket(byId, await api.getPools())!;
    for (const result of await Promise.all([api.readCandles(byName), api.readCandles(prepared(byId), restored)])) {
      expect(result).toMatchObject({ status: "empty_result", source: { endpoint: "ohclv", catalogPoolId: suiPoolId } });
    }
    expect(candleReads).toBe(1);
  });

  it("compares registered types from an outage menu when the indexer returns", async () => {
    const pairs = ["SUI", "DEEP", "WAL", "NS", "IKA", "XBTC", "USDT"].map((symbol, i) => ({
      ...officialPools()[0]!, pool_id: "0x" + String(i + 1).repeat(64), pool_name: symbol + "_USDC",
      base_asset_id: mainnetCoins[symbol]!.type, base_asset_symbol: symbol
    }));
    const unavailable = { poolId: suiPoolId, baseCoinType: deepCoinType,
      quoteCoinType: DEEPBOOK_CANDLE_CANONICAL_USDC_COIN_TYPE, unavailableReason: "coin_metadata_unavailable" as const };
    const registry = { source: sourceMetadata("pool_registry", baseUrl), pools: [pairs[1]!], unavailablePools: [unavailable] };
    let offline = true;
    const indexer = new DeepbookChartIndexer(() => new AbortController().signal, async input => {
      expect(new URL(String(input)).pathname).toBe("/get_pools");
      return offline ? new Response(null, { status: 503 }) : Response.json(pairs);
    });
    const api = createDeepbookUsdcChartService({ indexer, source: {
      ...fakeSource(), fetchMenuPools: async () => registry, fetchPools: async () => registry
    } });
    expect(await api.getPools()).toMatchObject({ unavailablePools: [unavailable] });
    offline = false;
    expect(await api.readCandles(prepared({ poolName: "SUI_USDC" }))).toMatchObject({ reason: "ambiguous_pool_name" });
    const menu = await api.getPools();
    expect(offeredChartMarket(chartInputSchema.parse({ poolId: suiPoolId }), menu)).toBeUndefined();
    expect(offeredChartMarket(chartInputSchema.parse({ poolId: deepPoolId }), menu)?.poolName).toBe("DEEP_USDC");
  });

  it("pins a recent one-minute window across the minute boundary and keeps distinct in-flight windows separate", async () => {
    const ends: string[] = [];
    const gate = Promise.withResolvers<void>();
    const firstRequest = Promise.withResolvers<void>();
    const booking = "2026-11-25T13:27:59.752Z";
    let clock = Date.parse(booking);
    const indexer = new DeepbookChartIndexer(() => new AbortController().signal, async input => {
      const url = new URL(String(input));
      if (url.pathname === "/get_pools") return Response.json(officialPools());
      const end = url.searchParams.get("end_time");
      ends.push(end!);
      firstRequest.resolve();
      await gate.promise;
      const open = Number(end) >= Date.parse("2026-11-25T13:28:00Z") ? "13:28" : "13:27";
      return Response.json({ candles: [[Date.parse("2026-11-25T" + open + ":00Z"), 1, 1, 1, 1, 9]] });
    });
    const api = createDeepbookUsdcChartService({ indexer, source: fakeSource(), now: () => new Date(clock) });
    const read = () => api.readCandles(prepared({ poolName: "SUI_USDC", interval: "1m", limit: 1 }));
    const previous = read(); await firstRequest.promise;
    clock = Date.parse("2026-11-25T13:28:07.002Z");
    const next = read();
    try {
      await vi.waitFor(() => expect(ends).toHaveLength(2));
    } finally { gate.resolve(); }
    expect(ends).toEqual([String(Date.parse(booking)), String(clock)]);
    for (const [result, start] of [[await previous, "13:27"], [await next, "13:28"]] as const) {
      expect(result).toMatchObject({ status: "ok", candleCount: 1, candles: [{ start: "2026-11-25T" + start + ":00.000Z" }] });
    }
  });

  it("aggregates the selected hour to its close while retaining the viewport and the in-flight forming snapshot", async () => {
    const hour = Date.parse("2026-06-26T01:00:00Z");
    const minute = 60_000;
    const rows = [[hour, 4, 2], [hour + 17 * minute, 2, 3], [hour + 59 * minute, 5, 7],
      [hour + 60 * minute, 9, 19]] as const;
    let clock = hour + 30 * minute;
    const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
    const indexer = new DeepbookChartIndexer(() => new AbortController().signal, async input => {
      const url = new URL(String(input));
      if (url.pathname === "/get_pools") return Response.json(officialPools());
      const through = Number(url.searchParams.get("end_time"));
      const included = rows.filter(([at]) => Number(url.searchParams.get("start_time")) <= at && at <= through);
      const prices = included.map(([, price]) => price);
      started.resolve();
      await finish.promise;
      return Response.json({ candles: [[hour, prices[0], Math.max(...prices), Math.min(...prices), prices.at(-1),
        included.reduce((sum, row) => sum + row[2], 0)]] });
    });
    const api = createDeepbookUsdcChartService({ indexer, source: fakeSource(), now: () => new Date(clock) });
    const range = { startTimeMs: hour + 17 * minute, endTimeMs: hour + 18 * minute };
    const query = prepared({ poolName: "SUI_USDC", interval: "1h", ...range });
    const forming = api.readCandles(query);
    await started.promise;
    clock = hour + 60 * minute;
    const closed = api.readCandles(query);
    await new Promise<void>(resolve => setImmediate(resolve));
    finish.resolve();
    expect(await forming).toMatchObject({ status: "ok", query: range, source: { requestedAt: "2026-06-26T01:30:00.000Z" },
      candles: [{ open: "4", high: "4", low: "2", close: "2", volume: "5" }] });
    expect(await closed).toMatchObject({ status: "ok", query: range,
      candles: [{ open: "4", high: "5", low: "2", close: "5", volume: "12", end: "2026-06-26T02:00:00.000Z" }] });
  });

  it("keeps unlisted markets onchain and an unavailable indexed candle request retryable at its own source", async () => {
    let fail = true;
    const requests: URL[] = [];
    const indexer = new DeepbookChartIndexer(() => new AbortController().signal, async input => {
      const url = new URL(String(input)); requests.push(url);
      if (url.pathname === "/get_pools") return Response.json([officialPools()[0]]);
      if (fail) return new Response(null, { status: 503 });
      return Response.json({ candles: [] });
    });
    const chainReads: DeepbookCandleQuery[] = [];
    const api = createDeepbookUsdcChartService({ indexer, source: fakeSource({ onFetchCandles: q => chainReads.push(q) }) });
    const named = prepared({ poolName: "SUI_USDC", interval: "1h",
      startTimeMs: Date.parse("2026-06-26T01:17:00Z"), endTimeMs: Date.parse("2026-06-26T01:18:00Z") });
    expect(await api.readCandles(named)).toMatchObject({ status: "source_unavailable", reason: "source_http_error" });
    expect(chainReads).toHaveLength(0);
    fail = false;
    expect(await api.readCandles(named)).toMatchObject({ status: "empty_result", source: { endpoint: "ohclv" } });
    const url = requests.at(-1)!;
    expect(url.searchParams.get("start_time")).toBe(String(Date.parse("2026-06-26T01:00:00Z")));
    expect(url.searchParams.get("end_time")).toBe(String(Date.parse("2026-06-26T01:59:59.999Z")));
    expect(await api.readCandles(prepared({ poolName: "DEEP_USDC" }))).toMatchObject({
      status: "ok", source: { endpoint: "order_fills", poolId: deepPoolId }
    });
    expect(chainReads.map(q => q.poolId)).toEqual([deepPoolId]);
  });

  it("retains the offered market source through an indexer catalog outage and recovery", async () => {
    let outage = false, catalogReads = 0;
    const indexer = new DeepbookChartIndexer(() => new AbortController().signal, async input => {
      if (new URL(String(input)).pathname !== "/get_pools") return Response.json({ candles: [] });
      catalogReads++;
      return outage ? new Response(null, { status: 503 }) : Response.json([officialPools()[0]]);
    });
    const api = createDeepbookUsdcChartService({ indexer, source: fakeSource() });
    const sui = chartInputSchema.parse({ poolId: suiPoolId });
    const deep = chartInputSchema.parse({ poolId: deepPoolId });
    const deepName = prepared({ poolName: "DEEP_USDC" });
    const mixed = await api.getPools();
    const indexedOffer = offeredChartMarket(sui, mixed)!;
    expect(indexedOffer.catalogEndpoint).toBe("get_pools");
    expect(offeredChartMarket(deep, mixed)?.catalogEndpoint).toBe("pool_registry");
    expect(await api.readCandles(deepName)).toMatchObject({ source: { endpoint: "order_fills" } });

    outage = true;
    const registryMenu = await api.getPools();
    const registryOffer = offeredChartMarket(sui, registryMenu)!;
    expect(registryOffer.catalogEndpoint).toBe("pool_registry");
    const before = catalogReads;
    expect(await api.readCandles(prepared(sui), registryOffer)).toMatchObject({
      status: "ok", source: { endpoint: "order_fills", poolId: suiPoolId }
    });
    expect(catalogReads).toBe(before);
    expect(await api.readCandles(prepared(sui), indexedOffer)).toMatchObject({ status: "source_unavailable" });
    expect(await api.readCandles(deepName)).toMatchObject({ source: { endpoint: "order_fills", poolId: deepPoolId } });
    expect(await api.readCandles(prepared({ poolName: "SUI_USDC" }))).toMatchObject({ status: "source_unavailable" });
    api.clearCache();
    expect(await api.readCandles(deepName)).toMatchObject({ status: "source_unavailable" });

    outage = false;
    const refreshed = offeredChartMarket(sui, await api.getPools())!;
    expect(await api.readCandles(prepared(sui), refreshed)).toMatchObject({ source: { endpoint: "ohclv" } });
  });

  it("describes the available markets without claiming to have read candles", async () => {
    const api = createDeepbookUsdcChartService({ source: fakeSource(), now: () => new Date(fetchedAt) });

    const result = await api.getPools();
    expect(result).toMatchObject({
      status: "ok",
      poolCount: 2,
      responseSummary: {
        evidenceKind: "market_list",
        sourceStatement: "Only market choices were retrieved.",
        usdcDisclaimer: expect.stringContaining("not fiat USD")
      },
      unsupportedClaims: expect.arrayContaining(["fiat_usd_cash_out", "profit_or_pnl", "signing_readiness"]),
      source: {
        endpoint: "pool_registry",
        url: `${baseUrl}/get_pools`
      }
    });
    expect(result).not.toHaveProperty("quantitySemantics");
    if (result.status !== "ok") {
      throw new Error("expected pools ok");
    }
    const body = result as Extract<DeepbookUsdcChartPoolsResponse, { status: "ok" }>;
    expect(body.pools.map((pool) => pool.poolName)).toEqual(["SUI_USDC", "DEEP_USDC"]);
    expect(body.pools[0]).toMatchObject({
      poolName: "SUI_USDC",
      poolId: suiPoolId,
      baseAsset: { symbol: "SUI", coinType: suiCoinType, decimals: 9 },
      quoteAsset: {
        symbol: "USDC",
        coinType: DEEPBOOK_CANDLE_CANONICAL_USDC_COIN_TYPE,
        decimals: 6
      },
      priceConvention: "USDC_PER_BASE"
    });
  });

  it("passes the default interval and row cap to the source without caller-supplied dates", async () => {
    const calls: DeepbookCandleQuery[] = [];
    const api = createDeepbookUsdcChartService({
      source: fakeSource({ onFetchCandles: (input) => calls.push(input) })
    });

    const result = await api.readCandles(prepared({ poolName: "SUI_USDC" }));
    expect(result).toMatchObject({
      status: "ok",
      query: {
        poolName: "SUI_USDC",
        interval: "15m",
        limit: DEEPBOOK_USDC_CHART_DEFAULT_LIMIT
      },
      pair: {
        poolName: "SUI_USDC",
        priceConvention: "USDC_PER_BASE"
      },
      candleCount: 2,
      source: {
        endpoint: "order_fills",
        poolName: "SUI_USDC",
        interval: "15m",
        limit: DEEPBOOK_USDC_CHART_DEFAULT_LIMIT
      }
    });
    expect(calls).toEqual([{ poolId: suiPoolId, market: officialPools()[0], directId: false, poolName: "SUI_USDC", interval: "15m", limit: 500 }]);
  });

  it("shares a pending market and candle read across three independent requests", async () => {
    const source = fakeSource();
    let release!: () => void, poolReads = 0, candleReads = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const service = createDeepbookUsdcChartService({ source: {
      ...source, async fetchPools() { poolReads++; await gate; return source.fetchPools(); },
      async fetchCandles(input) { candleReads++; return source.fetchCandles(input); }
    } });
    const results = [0, 1, 2].map(() => service.readCandles(prepared({ poolName: "SUI_USDC" })));
    release();
    expect((await Promise.all(results)).map(r => r.status)).toEqual(["ok", "ok", "ok"]);
    expect([poolReads, candleReads]).toEqual([1, 1]);
  });

  it("shows growing closed-candle previews to joined cards from the same selected market scan", async () => {
    const source = fakeSource();
    const gate = Promise.withResolvers<void>();
    const first = Promise.withResolvers<() => DeepbookUsdcChartResult>();
    const replay = Promise.withResolvers<() => DeepbookUsdcChartResult>();
    let loaded = 1;
    let reads = 0;
    const api = createDeepbookUsdcChartService({source:{...source, async fetchCandles(input, signal, preview) {
      reads++;
      const result = await source.fetchCandles(input, signal);
      preview?.(() => ({candles: result.candles.slice(-loaded), source: {...result.source, indexedAt: result.candles.at(-1)!.end}}));
      await gate.promise;
      return result;
    }}});
    const query = chartInputSchema.parse({poolId:suiPoolId, interval:"15m"});
    const selected = {poolId:suiPoolId, baseAsset:{coinType:suiCoinType},
      quoteAsset:{coinType:DEEPBOOK_CANDLE_CANONICAL_USDC_COIN_TYPE}};
    const pending = api.readCandles(prepareChartRead(query, new Date(fetchedAt)), selected, first.resolve);
    try {
      const read = await first.promise;
      expect(read()).toMatchObject({status:"preview", candleCount:1, candles:[{start:"2026-06-27T06:45:00.000Z"}],pair:{poolId:suiPoolId}});
      const joined = api.readCandles(prepareChartRead(query, new Date(fetchedAt)), undefined, replay.resolve);
      const namedPreview = Promise.withResolvers<() => DeepbookUsdcChartResult>();
      const byName = api.readCandles(prepared({poolName:"SUI_USDC",interval:"15m"}), undefined, namedPreview.resolve);
      const [readJoined] = await Promise.all([replay.promise, namedPreview.promise]);
      loaded = 2;
      expect(read()).toMatchObject({status:"preview", candleCount:2, candles:[{close:"0.71404"},{start:"2026-06-27T06:45:00.000Z"}]});
      expect(readJoined()).toEqual(read());
      gate.resolve();
      expect(await joined).toEqual(await pending);
      expect(await pending).toMatchObject({status:"ok",candleCount:2});
      expect(await byName).toMatchObject({status:"ok",pair:{poolId:suiPoolId},candleCount:2});
      expect(reads).toBe(1);
    } finally { gate.resolve(); }
  });

  it("passes a timestamp window through to the official source", async () => {
    const calls: DeepbookCandleQuery[] = [];
    const api = createDeepbookUsdcChartService({
      now: () => new Date("2026-06-27T08:00:00Z"),
      source: fakeSource({ onFetchCandles: (input) => calls.push(input), candles: [{
        ...officialCandles()[0]!, timestampMs: Date.parse("2026-06-27T07:00:00Z"),
        start: "2026-06-27T07:00:00.000Z", end: "2026-06-27T08:00:00.000Z"
      }] })
    });

    const result = await api.readCandles(prepared({ poolName: "SUI_USDC", interval: "1h", startTimeMs: 1782541800000, endTimeMs: 1782545400000, limit: 3 }));
    expect(result.status).toBe("ok");
    expect(calls).toEqual([
      {
        poolId: suiPoolId, market: officialPools()[0], directId: false, poolName: "SUI_USDC",
        interval: "1h",
        startTimeMs: 1_782_541_800_000,
        endTimeMs: 1_782_545_400_000,
        limit: 3
      }
    ]);
  });

  it("rejects unsupported options at the structured card admission boundary", () => {
    for (const fields of [
      { shortcut: "Latest 500" }, { poolName: ["SUI_USDC", "DEEP_USDC"] }, { interval: "not-an-interval" },
      { startTimeMs: 200, endTimeMs: 100 }, { limit: 10001 }, { limit: 0 }
    ]) {
      expect(chartInputSchema.safeParse({ poolName: "SUI_USDC", ...fields }).success).toBe(false);
    }
  });

  it("returns unsupported pool responses without fetching candles", async () => {
    let candleFetches = 0;
    const api = createDeepbookUsdcChartService({
      source: fakeSource({ onFetchCandles: () => { candleFetches += 1; } })
    });

    const result = await api.readCandles(prepared({ poolName: "NS_SUI" }));
    expect(result).toMatchObject({
      status: "unsupported_pool",
      reason: "pool_not_in_mainnet_usdc_markets",
      availablePoolNames: ["SUI_USDC", "DEEP_USDC"]
    });
    expect(candleFetches).toBe(0);
  });

  it("returns empty-result responses without synthesizing candles", async () => {
    const api = createDeepbookUsdcChartService({ source: fakeSource({ candles: [] }) });

    const result = await api.readCandles(prepared({ poolName: "SUI_USDC" }));
    expect(result).toMatchObject({
      status: "empty_result",
      candleCount: 0,
      candles: []
    });
  });

  it("distinguishes a future request from missing coverage of elapsed time", async () => {
    const now = new Date("2026-06-27T07:12:34.567Z");
    let poolReads = 0, candleReads = 0;
    const source = fakeSource({ onFetchPools: () => { poolReads++; } });
    const api = createDeepbookUsdcChartService({ now: () => now, source: { ...source, async fetchCandles() {
      candleReads++;
      throw new DeepbookCandleSourceError("source_unavailable", "The checkpoint does not cover this interval yet.");
    } } });
    const query = chartInputSchema.parse({ poolName: "SUI_USDC" });
    for (const field of ["startTimeMs", "endTimeMs"] as const) {
      expect(await api.readCandles(prepareChartRead({ ...query, [field]: now.getTime() + 1 }, now))).toMatchObject({
        status: "unsupported_input", reason: "invalid_timestamp", field
      });
    }
    expect([poolReads, candleReads]).toEqual([0, 0]);
    expect(await api.readCandles(prepareChartRead({ ...query, endTimeMs: now.getTime() }, now))).toMatchObject({
      status: "source_unavailable", reason: "source_unavailable"
    });
    expect([poolReads, candleReads]).toEqual([1, 1]);
  });

  it("maps source errors to visible source-unavailable responses", async () => {
    const poolFailure = createDeepbookUsdcChartService({
      source: fakeSource({
        fetchPoolsError: new DeepbookCandleSourceError("invalid_payload", "bad pools")
      })
    });
    await expectStatus(await poolFailure.getPools(), {
      status: "source_unavailable",
      reason: "invalid_chain_candle_evidence"
    });

    const candleFailure = createDeepbookUsdcChartService({
      source: fakeSource({
        fetchCandlesError: new DeepbookCandleSourceError("source_timeout", "slow candles")
      })
    });
    await expectStatus(candleFailure.readCandles(prepared({ poolName: "SUI_USDC" })), {
      status: "source_unavailable",
      reason: "source_timeout",
      query: {
        poolName: "SUI_USDC",
        interval: "15m",
        limit: 500
      }
    });
  });

  it("rejects a replaced market from an open selection before reading candles and still allows a direct lookup", async () => {
    let candleReads = 0;
    const upstream = fakeSource({ onFetchCandles: () => { candleReads++; } });
    const replacementId = "0x" + "4".repeat(64);
    let replaced = false;
    const api = createDeepbookUsdcChartService({ cacheTtlMs: 0, source: { ...upstream, async fetchPools() {
      const page = await upstream.fetchPools();
      if (replaced) page.pools = page.pools.map(row => row.pool_name === "SUI_USDC" ? { ...row, pool_id: replacementId } : row);
      return page;
    } } });
    const offered = await api.getPools();
    if (offered.status !== "ok" || !("pools" in offered)) throw Error("Market listing unavailable");
    const selected = offered.pools.find(row => row.poolName === "SUI_USDC")!;
    replaced = true;
    const query = chartInputSchema.parse({ poolName: selected.poolName });
    expect(await api.readCandles(prepareChartRead(query, new Date(fetchedAt)), selected)).toMatchObject({ status: "unsupported_pool", reason: "selected_market_changed" });
    expect(candleReads).toBe(0);
    expect(await api.readCandles(prepareChartRead(query, new Date(fetchedAt)))).toMatchObject({ status: "ok", pair: { poolId: replacementId } });
    expect(candleReads).toBe(1);
  });

  it("reuses current market metadata and reads candles anew after completion", async () => {
    let current = new Date("2026-06-27T00:00:00.000Z");
    let poolFetches = 0;
    let candleFetches = 0;
    const api = createDeepbookUsdcChartService({
      source: fakeSource({
        onFetchPools: () => { poolFetches += 1; },
        onFetchCandles: () => { candleFetches += 1; }
      }),
      now: () => current,
      cacheTtlMs: 60_000
    });

    await api.getPools();
    await api.getPools();
    await api.readCandles(prepared({ poolName: "SUI_USDC", limit: 2 }));
    await api.readCandles(prepared({ poolName: "SUI_USDC", limit: 2 }));
    expect(poolFetches).toBe(1);
    expect(candleFetches).toBe(2);

    current = new Date("2026-06-27T00:02:00.000Z");
    await api.getPools();
    await api.readCandles(prepared({ poolName: "SUI_USDC", limit: 2 }));
    expect(poolFetches).toBe(2);
    expect(candleFetches).toBe(3);
  });
});

async function expectStatus(
  resultOrPromise: Promise<DeepbookUsdcChartResult> | DeepbookUsdcChartResult,
  body: Record<string, unknown>
) {
  const result = await resultOrPromise;
  expect(result).toMatchObject(body);
}

function fakeSource(options: {
  candles?: DeepbookTradeCandle[] | undefined;
  fetchPoolsError?: Error | undefined;
  fetchCandlesError?: Error | undefined;
  onFetchPools?: (() => void) | undefined;
  onFetchCandles?: ((input: DeepbookCandleQuery) => void) | undefined;
} = {}): DeepbookCandleSourceClient {
  return {
    async fetchPools() {
      options.onFetchPools?.();
      if (options.fetchPoolsError) {
        throw options.fetchPoolsError;
      }
      return {
        source: sourceMetadata("pool_registry", `${baseUrl}/get_pools`),
        pools: officialPools()
      };
    },
    async fetchCandles(input) {
      options.onFetchCandles?.(input);
      if (options.fetchCandlesError) {
        throw options.fetchCandlesError;
      }
      return {
        source: sourceMetadata(
          "order_fills",
          `${baseUrl}/ohclv/${input.poolName}?interval=${input.interval}`,
          input
        ),
        candles: options.candles ?? officialCandles()
      };
    }
  };
}

function sourceMetadata(
  endpoint: DeepbookCandleSourceEvidence["endpoint"],
  url: string,
  input: Partial<Pick<DeepbookCandleQuery, "poolName" | "poolId" | "interval" | "limit" | "startTimeMs" | "endTimeMs">> = {}
): DeepbookCandleSourceEvidence {
  return {
    baseUrl,
    endpoint,
    poolId: input.poolId,
    url,
    fetchedAt,
    sourceStatement: endpoint === "pool_registry" ? DEEPBOOK_REGISTRY_SOURCE_STATEMENT : DEEPBOOK_CANDLE_SOURCE_STATEMENT,
    ...input
  };
}

function officialPools(): DeepbookCandlePool[] {
  return [
    {
      pool_id: suiPoolId,
      pool_name: "SUI_USDC",
      base_asset_id: suiCoinType,
      base_asset_symbol: "SUI",
      base_asset_decimals: 9,
      quote_asset_id: DEEPBOOK_CANDLE_CANONICAL_USDC_COIN_TYPE,
      quote_asset_symbol: "USDC",
      quote_asset_decimals: 6
    },
    {
      pool_id: deepPoolId,
      pool_name: "DEEP_USDC",
      base_asset_id: deepCoinType,
      base_asset_symbol: "DEEP",
      base_asset_decimals: 6,
      quote_asset_id: DEEPBOOK_CANDLE_CANONICAL_USDC_COIN_TYPE,
      quote_asset_symbol: "USDC",
      quote_asset_decimals: 6
    },
    {
      pool_id: nonUsdcPoolId,
      pool_name: "NS_SUI",
      base_asset_id: `0x${"5".repeat(64)}::ns::NS`,
      base_asset_symbol: "NS",
      base_asset_decimals: 6,
      quote_asset_id: suiCoinType,
      quote_asset_symbol: "SUI",
      quote_asset_decimals: 9
    }
  ];
}

function officialCandles(): DeepbookTradeCandle[] {
  return [
    {
      timestampMs: 1_782_541_800_000,
      start: "2026-06-27T06:30:00.000Z",
      end: "2026-06-27T06:45:00.000Z",
      open: "0.71174",
      high: "0.71427",
      low: "0.71158",
      close: "0.71404",
      volume: "59357.2"
    },
    {
      timestampMs: 1_782_542_700_000,
      start: "2026-06-27T06:45:00.000Z",
      end: "2026-06-27T07:00:00.000Z",
      open: "0.71404",
      high: "0.71412",
      low: "0.71291",
      close: "0.713",
      volume: "22650.5"
    }
  ];
}
