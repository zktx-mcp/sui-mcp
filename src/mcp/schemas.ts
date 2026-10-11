import { z, type ZodRawShape } from "zod";

// The shared schema accepts direct undefined input as well as the empty object
// supplied by the SDK for calls that omit arguments.
export const noParamsInputSchema = z.object({}).optional();

export function successOutputSchema<DataShape extends ZodRawShape>(dataShape: DataShape) {
  return z.object({
    ok: z.literal(true),
    data: z.object(dataShape)
  });
}
