import { z } from "zod";
import { DEEPBOOK_MID_PRICE_PRECISION } from "../../../core/read/readService.js";

export const fetchedAtSchema = z.string().refine((value) => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}, "Expected ISO 8601 UTC timestamp");

// Normalize only caller-supplied read filters. Evidence and output stay strict.
export const utcTimestampInputSchema = z.string()
  .overwrite((value) => value.replace(/(?:\.(\d{1,3}))?Z$/, (_match, fraction: string | undefined) =>
    `.${(fraction ?? "").padEnd(3, "0")}Z`))
  .refine((value) => fetchedAtSchema.safeParse(value).success,
    "Expected a valid ISO 8601 UTC timestamp ending in Z, with seconds and at most 3 fractional digits")
  .describe("UTC timestamp ending in Z, with seconds and optional 1-3 fractional digits; normalized to milliseconds.");

export const readSourceSchema = z.object({
  sdk: z.string(),
  transport: z.literal("grpc"),
  simulation: z.literal("client.core.simulateTransaction").optional(),
  method: z.string().optional(),
  methods: z.array(z.string()).optional(),
  returnValueEncoding: z.string().optional(),
  precision: z.literal(DEEPBOOK_MID_PRICE_PRECISION).optional()
});

export const reviewActivityAccountSourceSchema = z.enum(["active_account_context", "explicit_filter"]);

export const reviewActivityDataScopeSchema = z.object({
  account: z.string(),
  from: fetchedAtSchema.optional(),
  to: fetchedAtSchema.optional(),
  recordCount: z.number().int().nonnegative()
});

export const reviewActivityInputSchema = {
  account: z.string().min(1).optional(),
  from: utcTimestampInputSchema.optional(),
  to: utcTimestampInputSchema.optional()
};

export const userAnswerUseSchema = z.object({
  canAnswer: z.array(z.string()),
  cannotAnswer: z.array(z.string()),
  answerFields: z.array(z.string()),
  preconditionFields: z.array(z.string()).optional(),
  conclusionRuleFields: z.array(z.string()).optional(),
  diagnosticOnlyFields: z.array(z.string()).optional(),
  followUp: z
    .object({
      tool: z.string(),
      inputFields: z.array(z.string()).optional(),
      answerFields: z.array(z.string()),
      reason: z.string()
    })
    .optional()
}).strict();
