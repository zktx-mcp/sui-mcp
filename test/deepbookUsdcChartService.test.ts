import { chartInputSchema } from "../src/core/read/readCardInputs.js";
import { mainnetCoins } from "@mysten/deepbook-v3";
import { describe, expect, it } from "vitest";
import {
  DEEPBOOK_CANDLE_CANONICAL_USDC_COIN_TYPE,
  DEEPBOOK_CANDLE_SOURCE_STATEMENT,
  DeepbookCandleSourceError,
  type DeepbookTradeCandle,
  type DeepbookCandleQuery,
  type DeepbookCandleSourceEvidence,
  type DeepbookCandlePool,
  type DeepbookCandleSourceClient
} from "../src/core/read/deepbookCandleSource.js";
import { DEEPBOOK_CANDLE_SOURCE_BASE } from "../src/core/read/deepbookSourceOwners.js";
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
  it("lists official USDC-quoted pools with source metadata and disclaimers", async () => {
    const api = createDeepbookUsdcChartService({ source: fakeSource(), now: () => new Date(fetchedAt) });

    const result = await api.getPools();
    expect(result).toMatchObject({
      status: "ok",
      poolCount: 2,
      responseSummary: {
        sourceStatement: DEEPBOOK_CANDLE_SOURCE_STATEMENT,
        usdcDisclaimer: expect.stringContaining("not fiat USD")
      },
      quantitySemantics: {
        source: DEEPBOOK_CANDLE_SOURCE_BASE.kind,
        usdcIsFiatUsd: false,
        chainRecomputedBySuiMcp: true
      },
      unsupportedClaims: expect.arrayContaining(["fiat_usd_cash_out", "profit_or_pnl", "signing_readiness"]),
      source: {
        endpoint: "pool_registry",
        url: `${baseUrl}/get_pools`
      }
    });
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
      const byName = api.readCandles(prepared({poolName:"SUI_USDC",interval:"15m"}));
      const readJoined = await replay.promise;
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
    let replaced = false;
    const api = createDeepbookUsdcChartService({ cacheTtlMs: 0, source: { ...upstream, async fetchPools() {
      const page = await upstream.fetchPools();
      if (replaced) page.pools = page.pools.map(row => row.pool_name === "SUI_USDC" ? { ...row, pool_id: nonUsdcPoolId } : row);
      return page;
    } } });
    const offered = await api.getPools();
    if (offered.status !== "ok" || !("pools" in offered)) throw Error("Market listing unavailable");
    const selected = offered.pools.find(row => row.poolName === "SUI_USDC")!;
    replaced = true;
    const query = chartInputSchema.parse({ poolName: selected.poolName });
    expect(await api.readCandles(prepareChartRead(query, new Date(fetchedAt)), selected)).toMatchObject({ status: "unsupported_pool", reason: "selected_market_changed" });
    expect(candleReads).toBe(0);
    expect(await api.readCandles(prepareChartRead(query, new Date(fetchedAt)))).toMatchObject({ status: "ok", pair: { poolId: nonUsdcPoolId } });
    expect(candleReads).toBe(1);
  });

  it("caches schema-validated pool and candle source results within the process TTL", async () => {
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
    expect(candleFetches).toBe(1);

    current = new Date("2026-06-27T00:02:00.000Z");
    await api.getPools();
    await api.readCandles(prepared({ poolName: "SUI_USDC", limit: 2 }));
    expect(poolFetches).toBe(2);
    expect(candleFetches).toBe(2);
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
    sourceStatement: DEEPBOOK_CANDLE_SOURCE_STATEMENT,
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
