import { z } from "zod";
import { withRpcDeadline } from "../suiEndpoint.js";
import {
  candleBucketStart, deepbookCandleIntervalDurationMs, deepbookCandlePoolsSchema,
  DEFAULT_DEEPBOOK_CANDLE_FETCH_TIMEOUT_MS, candleQueryWindow, DeepbookCandleSourceError,
  validatePoolCandles, type DeepbookCandleQuery, type DeepbookTradeCandle
} from "./deepbookCandleSource.js";

const origin = "https://deepbook-indexer.mainnet.mystenlabs.com";
const number = z.number().finite().nonnegative();
const responseSchema = z.object({
  candles: z.array(z.tuple([z.number().int().nonnegative().safe(), number, number, number, number, number]))
});
export const INDEXER_SOURCE_STATEMENT = "DeepBook Indexer supplied the candle result for this market name.";
// A JSON number is already a double. Expand its shortest decimal representation for display.
const decimalFormat = new Intl.NumberFormat("en-US", { useGrouping: false, maximumSignificantDigits: 21 });

// The viewport selects bucket opens. The indexer's end_time is an inclusive
// cutoff on the source rows used to build those buckets.
export function indexedChartWindow(query: DeepbookCandleQuery, requestedAt: number) {
  const window = candleQueryWindow(query, requestedAt);
  const width = deepbookCandleIntervalDurationMs(query.interval);
  const nextBucket = window.lastBucket + width;
  const bucketCount = (nextBucket - window.firstBucket) / width;
  const requestLimit = Math.min(query.limit ?? bucketCount, bucketCount);
  return { ...window, requestedAt, requestLimit, lastBucketClosed: nextBucket <= requestedAt,
    aggregateThrough: Math.min(requestedAt, nextBucket - 1) };
}

export class DeepbookChartIndexer {
  constructor(private readonly lifetime: () => AbortSignal, private readonly fetchImpl: typeof fetch = fetch) {}

  private async json(url: URL): Promise<unknown> {
    try {
      return await withRpcDeadline(DEFAULT_DEEPBOOK_CANDLE_FETCH_TIMEOUT_MS, async signal => {
        const response = await this.fetchImpl(url, { signal, headers: { accept: "application/json" } });
        if (!response.ok) throw new DeepbookCandleSourceError("source_http_error", "DeepBook Indexer could not serve the chart.");
        try {
          return await response.json();
        } catch (error) {
          if (error instanceof SyntaxError) throw new DeepbookCandleSourceError("invalid_payload", "Invalid chart JSON.");
          throw error;
        }
      }, this.lifetime());
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new DeepbookCandleSourceError("source_timeout", "DeepBook Indexer did not respond in time.");
      }
      throw error;
    }
  }

  async fetchPools() {
    const url = new URL("/get_pools", origin);
    const result = deepbookCandlePoolsSchema.safeParse(await this.json(url));
    if (!result.success) throw new DeepbookCandleSourceError("invalid_payload", "Invalid indexed market list.");
    return { pools: result.data.map(pool => ({ ...pool, pool_id: pool.pool_id.toLowerCase() })), source: {
      endpoint: "get_pools" as const, url: url.href, baseUrl: origin, fetchedAt: new Date().toISOString(),
      sourceStatement: "DeepBook Indexer supplied the market list."
    } };
  }

  async fetchCandles(query: DeepbookCandleQuery, catalogPoolId: string, window: ReturnType<typeof indexedChartWindow>) {
    const { interval, poolName } = query;
    const { start: startTimeMs, end: endTimeMs, firstBucket: first } = window;
    const width = deepbookCandleIntervalDurationMs(interval);
    const url = new URL("/ohclv/" + encodeURIComponent(poolName), origin);
    url.searchParams.set("interval", interval);
    url.searchParams.set("start_time", String(Math.max(0, first)));
    url.searchParams.set("end_time", String(window.aggregateThrough));
    const candles: DeepbookTradeCandle[] = [];
    if (window.requestLimit > 0) {
      url.searchParams.set("limit", String(window.requestLimit));
      const parsed = responseSchema.safeParse(await this.json(url));
      if (!parsed.success) throw new DeepbookCandleSourceError("invalid_payload", "Invalid indexed candle data.");
      if (parsed.data.candles.length > window.requestLimit) {
        throw new DeepbookCandleSourceError("invalid_payload", "Indexed candles exceed the requested limit.");
      }
      for (const [timestampMs, open, high, low, close, volume] of parsed.data.candles) {
        if (timestampMs < first || timestampMs > endTimeMs || candleBucketStart(timestampMs, interval) !== timestampMs ||
            high < Math.max(open, close, low) || low > Math.min(open, close)) {
          throw new DeepbookCandleSourceError("invalid_payload", "Indexed candle conflicts with the requested market window.");
        }
        candles.push({ timestampMs, start: new Date(timestampMs).toISOString(), end: new Date(timestampMs + width).toISOString(),
          open: decimalFormat.format(open), high: decimalFormat.format(high), low: decimalFormat.format(low),
          close: decimalFormat.format(close), volume: decimalFormat.format(volume) });
      }
      candles.sort((left, right) => left.timestampMs - right.timestampMs);
      validatePoolCandles(candles, query);
    }
    return { candles, source: {
      endpoint: "ohclv" as const, url: url.href, baseUrl: origin, poolName, catalogPoolId, interval,
      startTimeMs, endTimeMs, requestedAt: new Date(window.requestedAt).toISOString(), fetchedAt: new Date().toISOString(), sourceStatement: INDEXER_SOURCE_STATEMENT
    } };
  }
}

export type IndexedChartCatalog = Awaited<ReturnType<DeepbookChartIndexer["fetchPools"]>>;
export type IndexedChartResult = Awaited<ReturnType<DeepbookChartIndexer["fetchCandles"]>>;
