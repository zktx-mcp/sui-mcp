import { z } from "zod";
import { makeSignedRawIntegerStringSchema, parseSignedRawInteger } from "../numeric/rawU64.js";
import { normalizeCoinType } from "../read/coinMetadata.js";
import { suiAddressStringSchema, suiTransactionDigestSchema } from "../suiAddress.js";

export const SUI_CHAIN_RECEIPT_REQUIRED_INCLUDE = [
  "transaction",
  "effects",
  "balanceChanges",
  "objectTypes"
] as const;

export type SuiChainReceiptIncludeField = (typeof SUI_CHAIN_RECEIPT_REQUIRED_INCLUDE)[number];

const isoUtcStringSchema = z.string().refine((value) => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}, "Expected ISO 8601 UTC timestamp");

const suiChainReceiptIncludeFieldSchema = z.enum(SUI_CHAIN_RECEIPT_REQUIRED_INCLUDE);

const suiChainReceiptIncludeSchema = z.array(suiChainReceiptIncludeFieldSchema)
  .length(SUI_CHAIN_RECEIPT_REQUIRED_INCLUDE.length)
  .superRefine((include, ctx) => {
    for (const field of SUI_CHAIN_RECEIPT_REQUIRED_INCLUDE) {
      if (!include.includes(field)) {
        ctx.addIssue({
          code: "custom",
          path: [],
          message: `chain receipt include is missing '${field}'`
        });
      }
    }
    if (new Set(include).size !== include.length) {
      ctx.addIssue({
        code: "custom",
        path: [],
        message: "chain receipt include fields must not be duplicated"
      });
    }
  });

const coinTypeSchema = z.string().min(1).max(512).refine((value) => {
  try {
    normalizeCoinType(value);
    return true;
  } catch {
    return false;
  }
}, "Expected a Sui struct tag coin type");

const suiChainReceiptPackageCallSchema = z.object({
  commandIndex: z.number().int().nonnegative(),
  packageId: suiAddressStringSchema,
  module: z.string().min(1).max(128),
  function: z.string().min(1).max(128),
  target: z.string().min(1).max(512)
}).strict().superRefine((call, ctx) => {
  const expectedTarget = `${call.packageId}::${call.module}::${call.function}`;
  if (call.target !== expectedTarget) {
    ctx.addIssue({
      code: "custom",
      path: ["target"],
      message: "package call target must match packageId::module::function"
    });
  }
});

const suiChainReceiptAccountBalanceChangeSchema = z.object({
  index: z.number().int().nonnegative(),
  coinType: coinTypeSchema,
  amountRaw: makeSignedRawIntegerStringSchema("accountBalanceChanges[].amountRaw"),
  direction: z.enum(["increase", "decrease", "zero"])
}).strict().superRefine((change, ctx) => {
  const amount = parseSignedRawInteger(change.amountRaw, "accountBalanceChanges[].amountRaw");
  const direction =
    amount > 0n ? "increase" :
    amount < 0n ? "decrease" :
    "zero";
  if (change.direction !== direction) {
    ctx.addIssue({
      code: "custom",
      path: ["direction"],
      message: "balance change direction must match amountRaw sign"
    });
  }
});

export const suiChainReceiptEffectsStatusSchema = z.discriminatedUnion("success", [
  z.object({
    success: z.literal(true),
    errorKind: z.never().optional(),
    errorMessage: z.never().optional()
  }).strict(),
  z.object({
    success: z.literal(false),
    errorKind: z.string().min(1).max(200).optional(),
    failedCommand: z.number().int().nonnegative().optional(),
    minimumReceiveFailure: z.literal(true).optional(),
    errorMessage: z.string().min(1).max(2000).optional()
  }).strict()
]);

const fullReceipt = z.object({
  kind: z.literal("sui_chain_receipt_v1"),
  source: z.object({
    method: z.literal("client.core.getTransaction"),
    network: z.literal("sui:mainnet"),
    chainIdentifier: z.string().min(1),
    fetchedAt: isoUtcStringSchema,
    include: suiChainReceiptIncludeSchema
  }).strict(),
  txDigest: suiTransactionDigestSchema,
  sender: suiAddressStringSchema,
  effectsStatus: suiChainReceiptEffectsStatusSchema,
  packageCalls: z.array(suiChainReceiptPackageCallSchema),
  accountBalanceChanges: z.array(suiChainReceiptAccountBalanceChangeSchema),
  objectTypes: z.record(suiAddressStringSchema, z.string().min(1).max(512))
}).strict();

export const receiptDetailSchemas = fullReceipt.shape;

// Existing public receipts keep the full v1 contract. A verified outcome can
// also be recorded when optional on-chain detail was absent or malformed.
export const suiChainReceiptEvidenceSchema = z.discriminatedUnion("kind", [
  fullReceipt,
  fullReceipt.extend({ kind: z.literal("sui_chain_receipt_outcome_v2"),
    packageCalls: fullReceipt.shape.packageCalls.optional(),
    accountBalanceChanges: fullReceipt.shape.accountBalanceChanges.optional(),
    objectTypes: fullReceipt.shape.objectTypes.optional(),
    detailStatus: z.literal("incomplete")
  })
]);

export type SuiChainReceiptEvidence = z.infer<typeof suiChainReceiptEvidenceSchema>;
export type SuiChainReceiptSource = SuiChainReceiptEvidence["source"];
export type SuiChainReceiptEffectsStatus = SuiChainReceiptEvidence["effectsStatus"];
export type SuiChainReceiptPackageCall = z.infer<typeof suiChainReceiptPackageCallSchema>;
export type SuiChainReceiptAccountBalanceChange = z.infer<typeof suiChainReceiptAccountBalanceChangeSchema>;
