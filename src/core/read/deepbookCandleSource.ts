import { z } from "zod";
import { normalizeCoinType } from "./coinMetadata.js";

export const DEFAULT_DEEPBOOK_CANDLE_FETCH_TIMEOUT_MS = 10_000;
export const DEEPBOOK_CANDLE_CANONICAL_USDC_COIN_TYPE =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
export const DEEPBOOK_CANDLE_PRICE_CONVENTION = "USDC_PER_BASE";
export const DEEPBOOK_CANDLE_SOURCE_STATEMENT =
  "Sui MCP aggregates DeepBook OrderFilled events from Sui mainnet for the identified pool.";
export const DEEPBOOK_REGISTRY_SOURCE_STATEMENT = "Sui mainnet supplied the DeepBook market information.";
export const DEEPBOOK_CANDLE_CANDLE_TIMESTAMP_BOUNDARY = "open" as const;
export const DEEPBOOK_CANDLE_INTERVALS = ["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"] as const;
// The 0.8.2 indexer's OHCLV_DEFAULT_WINDOW_MS was seven days. Its default
// window selected bucket starts, independently of the maximum number of rows.
export const DEFAULT_CHART_WINDOW_MS = 7 * 24 * 60 * 60_000;

export const DEFAULT_DEEPBOOK_CANDLE_INTERVAL = "15m" as const;

const SUI_OBJECT_ID_PATTERN = /^0x[0-9a-f]{64}$/i;
const DECIMAL_STRING_PATTERN = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

export type DeepbookCandleSourceErrorReason =
  | "candle_coverage_incomplete"
  | "market_changed"
  | "market_not_created"
  | "source_unavailable"
  | "source_timeout"
  | "source_http_error"
  | "invalid_payload";

export class DeepbookCandleSourceError extends Error {
  constructor(
    readonly reason: DeepbookCandleSourceErrorReason,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

const timestampMsSchema = z.number().int().refine((value) => Number.isSafeInteger(value) && value >= 0, {
  message: "expected a finite non-negative integer millisecond timestamp"
});
const decimalStringSchema = z.string().regex(DECIMAL_STRING_PATTERN);
const isoDateStringSchema = z.string().refine((value) => {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}, "expected an ISO timestamp string");
const coinTypeSchema = z.string().min(1).refine((value) => {
  try {
    normalizeCoinType(value);
    return true;
  } catch {
    return false;
  }
}, "expected a valid Sui coin type");

export const deepbookCandleIntervalSchema = z.enum(DEEPBOOK_CANDLE_INTERVALS);
export type DeepbookCandleInterval = z.infer<typeof deepbookCandleIntervalSchema>;

export const deepbookCandlePoolSchema = z.object({
  pool_id: z.string().regex(SUI_OBJECT_ID_PATTERN),
  active: z.boolean().optional(),
  initialSharedVersion: z.string().regex(/^\d+$/).optional(),
  pool_name: z.string().min(1),
  base_asset_id: coinTypeSchema,
  base_asset_symbol: z.string().min(1),
  base_asset_decimals: z.number().int().min(0).max(255),
  quote_asset_id: coinTypeSchema,
  quote_asset_symbol: z.string().min(1),
  quote_asset_decimals: z.number().int().min(0).max(255)
});

export const deepbookCandlePoolsSchema = z.array(deepbookCandlePoolSchema).min(1);
export type DeepbookCandlePool = z.infer<typeof deepbookCandlePoolSchema>;

export const deepbookTradeCandleSchema = z.object({
  timestampMs: timestampMsSchema,
  start: isoDateStringSchema,
  end: isoDateStringSchema,
  open: decimalStringSchema,
  high: decimalStringSchema,
  low: decimalStringSchema,
  close: decimalStringSchema,
  volume: decimalStringSchema
}).strict().superRefine((candle, context) => {
  if (Date.parse(candle.end) <= Date.parse(candle.start)) {
    context.addIssue({ code: "custom", message: "candle end must be after start", path: ["end"] });
  }
});
export type DeepbookTradeCandle = z.infer<typeof deepbookTradeCandleSchema>;

export type DeepbookCandleSourceEvidence = {
  baseUrl: string;
  endpoint: "pool_registry" | "order_fills";
  poolId?: string | undefined;
  coverage?: "complete" | "partial_tail";
  readEndpoints?: string[]; coveredFrom?: string; coveredUntil?: string; indexedCheckpoint?: number; indexedAt?: string;
  url: string;
  fetchedAt: string;
  sourceStatement: typeof DEEPBOOK_CANDLE_SOURCE_STATEMENT | typeof DEEPBOOK_REGISTRY_SOURCE_STATEMENT;
  poolName?: string | undefined;
  interval?: DeepbookCandleInterval | undefined;
  startTimeMs?: number | undefined;
  endTimeMs?: number | undefined;
  limit?: number | undefined;
};

export type DeepbookCandleQuery = {
  market?: DeepbookCandlePool;
  poolId?: string | undefined;
  directId?: boolean;
  poolName: string;
  interval: DeepbookCandleInterval;
  limit?: number | undefined;
} & (
  | { window: "history"; startTimeMs: number; endTimeMs: number; endMode?: never }
  | { window?: "chart"; startTimeMs?: number | undefined; endTimeMs?: number | undefined; endMode?: "latest_indexed" | undefined }
);

export const marketReadFailureSchema = z.enum(["pool_object_unavailable", "coin_metadata_unavailable", "pool_identity_mismatch"]);
export const marketIdentitySchema = z.object({
  poolId: z.string(), baseCoinType: coinTypeSchema, quoteCoinType: coinTypeSchema,
  unavailableReason: marketReadFailureSchema.optional()
}).strict();
export type MarketIdentity = z.infer<typeof marketIdentitySchema>;
export function marketIdentity(pool: DeepbookCandlePool): MarketIdentity {
  return {poolId:pool.pool_id, baseCoinType:pool.base_asset_id, quoteCoinType:pool.quote_asset_id};
}
// Read the verified closed buckets accumulated by this scan without advancing it.
export type ReadCandlePreview = () => DeepbookCandleResult;
export type DeepbookCandlePoolsResult = {
  unavailablePools?: MarketIdentity[];
  source: DeepbookCandleSourceEvidence;
  pools: DeepbookCandlePool[];
};

export type DeepbookCandleResult = {
  source: DeepbookCandleSourceEvidence;
  candles: DeepbookTradeCandle[];
};

export type DeepbookCandleSourceClient = {
  currentPoolId?(base: string, quote: string): Promise<string>;
  fetchMenuPools?(): Promise<DeepbookCandlePoolsResult>;
  fetchPools(poolId?: string, signal?: AbortSignal, baseTypes?: readonly string[]): Promise<DeepbookCandlePoolsResult>;
  fetchCandles(input: DeepbookCandleQuery, signal?: AbortSignal, preview?: (value: ReadCandlePreview) => void, requestedAt?: number): Promise<DeepbookCandleResult>;
};

export function parseDeepbookCandleInterval(value: string): DeepbookCandleInterval {
  const parsed = deepbookCandleIntervalSchema.safeParse(value);
  if (!parsed.success) {
    throw new DeepbookCandleSourceError(
      "invalid_payload",
      "DeepBook supported UTC interval is not supported",
      { interval: value }
    );
  }
  return parsed.data;
}

export function deepbookCandleIntervalDurationMs(interval: DeepbookCandleInterval): number {
  switch (interval) {
    case "1m":
      return 60_000;
    case "5m":
      return 5 * 60_000;
    case "15m":
      return 15 * 60_000;
    case "30m":
      return 30 * 60_000;
    case "1h":
      return 60 * 60_000;
    case "4h":
      return 4 * 60 * 60_000;
    case "1d":
      return 24 * 60 * 60_000;
    case "1w":
      return 7 * 24 * 60 * 60_000;
  }
}

export function candleBucketStart(ms: number, interval: DeepbookCandleInterval) {
  const duration = deepbookCandleIntervalDurationMs(interval);
  const origin = interval === "1w" ? 4 * 86_400_000 : 0;
  return origin + Math.floor((ms - origin) / duration) * duration;
}

// Bucket selection belongs to the requested window. Retention and indexed
// coverage are separate facts supplied by the chain reader.
export function candleQueryWindow(query: DeepbookCandleQuery, defaultEnd: number) {
  const end = query.window === "history" ? query.endTimeMs - 1 : query.endTimeMs ?? defaultEnd;
  const start = query.startTimeMs ?? Math.max(0, end - DEFAULT_CHART_WINDOW_MS);
  const bucket = candleBucketStart(start, query.interval);
  const selectOpens = query.window === "history" || query.startTimeMs === undefined;
  const firstBucket = selectOpens && bucket < start ? bucket + deepbookCandleIntervalDurationMs(query.interval) : bucket;
  return { start, end, firstBucket, lastBucket: candleBucketStart(end, query.interval) };
}

export function validatePoolCandles(candles: DeepbookTradeCandle[], input: DeepbookCandleQuery) {
  const seen = new Set<number>();
  if (input.limit !== undefined && candles.length > input.limit) throw new DeepbookCandleSourceError("invalid_payload", "Market source exceeded the candle limit", {});
  const interval = parseDeepbookCandleInterval(input.interval);
  let phase: number | undefined;
  const width = deepbookCandleIntervalDurationMs(interval);
  for (const candle of candles) {
    const at = candle.timestampMs;
    phase ??= at % width;
    if (seen.has(at) || at % width !== phase || (interval === "1w" && at !== candleBucketStart(at, interval)) || Date.parse(candle.start) !== at ||
        Date.parse(candle.end) !== at + deepbookCandleIntervalDurationMs(interval) ||
        (input.startTimeMs !== undefined && at + width <= input.startTimeMs) || (input.endTimeMs !== undefined && at > input.endTimeMs)) {
      throw new DeepbookCandleSourceError("invalid_payload", "Candle conflicts with the requested time range or interval", {});
    }
    seen.add(at);
  }
}

// Name-based selectors require one market identity. Reject a name attached to
// multiple identities, even if a selector matched just one of those rows.
export function ambiguousMarketName(pools: DeepbookCandlePool[], name: string): boolean {
  const identities = new Set(pools.filter((pool) => pool.pool_name === name).map(candleMarketIdentityKey));
  return identities.size > 1;
}

export function candleMarketIdentityKey(pool: DeepbookCandlePool): string {
  return JSON.stringify([pool.pool_id, normalizeCoinType(pool.base_asset_id), normalizeCoinType(pool.quote_asset_id),
    pool.base_asset_decimals, pool.quote_asset_decimals]);
}

export function isDeepbookCandleCanonicalUsdcPool(pool: DeepbookCandlePool): boolean {
  return normalizeCoinType(pool.quote_asset_id) === normalizeCoinType(DEEPBOOK_CANDLE_CANONICAL_USDC_COIN_TYPE);
}

export function selectDeepbookCandleCanonicalUsdcPools(
  pools: DeepbookCandlePool[]
): DeepbookCandlePool[] {
  return pools.filter(isDeepbookCandleCanonicalUsdcPool);
}
