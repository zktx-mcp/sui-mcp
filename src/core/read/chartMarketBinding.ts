import { z } from "zod";

export const chartMarketBindingSchema = z.object({
  pair: z.object({ poolId: z.string(), poolName: z.string().optional() }),
  source: z.discriminatedUnion("endpoint", [
    z.object({ endpoint: z.literal("order_fills"), poolId: z.string() }),
    z.object({ endpoint: z.literal("ohclv"), poolName: z.string(), catalogPoolId: z.string() })
  ])
}).refine(({ pair, source }) => source.endpoint === "order_fills"
  ? source.poolId === pair.poolId
  : source.catalogPoolId === pair.poolId && source.poolName === pair.poolName, "Chart market identity mismatch.");
