import { z } from "zod";
import { makeRawU64StringSchema } from "../numeric/rawU64.js";
import { DEEPBOOK_SCALAR_UNIT_SOURCE, SUI_METADATA_UNIT_SOURCE, normalizeCoinType } from "../read/coinMetadata.js";

const coinTypeSchema = z.string().min(1).max(512).refine((value) => {
  try {
    return normalizeCoinType(value) === value;
  } catch {
    return false;
  }
}, "Expected a normalized Sui struct tag coin type");

const quotePolicyAssetSchema = z.object({
  symbol: z.string().min(1).max(64),
  coinType: coinTypeSchema,
  decimals: z.number().int().min(0).max(255),
  unitSource: z.enum([DEEPBOOK_SCALAR_UNIT_SOURCE, SUI_METADATA_UNIT_SOURCE])
}).strict();

export const quotePolicyRawAmountSchema = z.object({
  raw: makeRawU64StringSchema("quoted amount"),
  asset: quotePolicyAssetSchema
}).strict();

// Both input quantities use the requested input asset and its raw units.
export const swapQuoteInputFlowSchema = z.object({
  expectedSpendRaw: makeRawU64StringSchema("expected input spend"),
  expectedReturnRaw: makeRawU64StringSchema("expected input return"),
  fee: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("base_fee_waived"), quotedRaw: z.literal("0"), source: z.literal("pool_whitelist_and_zero_taker_rate") }).strict(),
    z.object({ kind: z.literal("separate_coin"), amount: quotePolicyRawAmountSchema }).strict(),
    z.object({ kind: z.literal("included_in_input"), amountUnavailableReason: z.literal("not_itemized_by_quote") }).strict()
  ])
}).strict();

export type SwapQuoteInputFlow = z.infer<typeof swapQuoteInputFlowSchema>;

export function minimumSwapOutput(expected: bigint, maxSlippageBps: number): bigint {
  return expected - expected * BigInt(maxSlippageBps) / 10_000n;
}
