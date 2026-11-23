import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { parseSuiAddress, normalizedSuiAddressSchema, suiAddressStringSchema, suiTransactionDigestSchema } from "../suiAddress.js";
import { DEEPBOOK_CANDLE_INTERVALS, DEFAULT_DEEPBOOK_CANDLE_INTERVAL } from "./deepbookCandleSource.js";
import { DEEPBOOK_USDC_CHART_DEFAULT_LIMIT, DEEPBOOK_USDC_CHART_MAX_CANDLES } from "./deepbookUsdcChartService.js";
import type { CardKind } from "../session/cardSession.js";
export const accountInputSchema = z.object({ account: suiAddressStringSchema }).strict();
export const receiptInputSchema = z.object({ digest: suiTransactionDigestSchema }).strict();
const chartInputBaseSchema = z.object({
  poolName: z.string().min(1).optional(), poolId: suiAddressStringSchema.optional(),
  interval: z.enum(DEEPBOOK_CANDLE_INTERVALS).default(DEFAULT_DEEPBOOK_CANDLE_INTERVAL),
  startTimeMs: z.number().int().nonnegative().optional(),
  endMode: z.literal("latest_indexed").optional(),
  endTimeMs: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(DEEPBOOK_USDC_CHART_MAX_CANDLES).default(DEEPBOOK_USDC_CHART_DEFAULT_LIMIT)
}).strict();
const validWindow = (value: { startTimeMs?: number | undefined; endTimeMs?: number | undefined; endMode?: string | undefined }) =>
  (!value.endMode || value.endTimeMs !== undefined) && (value.startTimeMs === undefined || value.endTimeMs === undefined || value.startTimeMs < value.endTimeMs);
export const chartInputSchema = chartInputBaseSchema.extend({ poolId: normalizedSuiAddressSchema.optional() })
  .refine(v => !!v.poolId || !!v.poolName, "A market is required.").refine(validWindow, "Start must precede end.");
export const chartOpenInputSchema = chartInputBaseSchema.omit({endMode:true}).partial().refine(validWindow, "Start must precede end.");
export type ChartCardInput = z.output<typeof chartInputSchema>;
const admittedAccount = accountInputSchema.extend({ account: normalizedSuiAddressSchema });
const marketOffer = z.object({
  poolName: z.string(), poolId: normalizedSuiAddressSchema,
  baseAsset: z.object({ coinType: z.string() }), quoteAsset: z.object({ coinType: z.string() })
});
export type OfferedChartMarket = z.output<typeof marketOffer>;
const chartMenu = z.object({ pools: z.array(marketOffer) });

export function offeredChartMarket(input: ChartCardInput, saved: unknown): OfferedChartMarket | undefined {
  const menu = chartMenu.safeParse(saved);
  if (!menu.success) throw new Error("Saved chart choices are unavailable.");
  return menu.data.pools.find(pool => pool.poolId === input.poolId &&
    (input.poolName === undefined || input.poolName === pool.poolName));
}

export function parseCardInput(kind: CardKind, input: unknown) {
  switch (kind) {
    case "account": return { kind, input: admittedAccount.parse(input) };
    case "receipt": return { kind, input: receiptInputSchema.parse(input) };
    case "chart": return { kind, input: chartInputSchema.parse(input) };
    default: throw new Error("This card does not accept a read selection.");
  }
}
export type ReadCardSelection = ReturnType<typeof parseCardInput>;

export function matchesAcceptedRead(selection: ReadCardSelection, accepted: Record<string, unknown>) {
  // Stored selections from before normalization still identify the original card.
  const key = selection.kind === "account" ? "account" : selection.kind === "chart" ? "poolId" : undefined;
  const input: Record<string, unknown> = selection.input;
  if (key && typeof accepted[key] === "string" && accepted[key] !== input[key]) {
    const canonical = parseSuiAddress(accepted[key]);
    if (!canonical || canonical !== input[key]) return false;
    return isDeepStrictEqual({ ...accepted, [key]: canonical }, input);
  }
  return isDeepStrictEqual(accepted, input);
}
