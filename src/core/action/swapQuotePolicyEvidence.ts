import { minimumSwapOutput, quotePolicyRawAmountSchema, swapQuoteInputFlowSchema } from "./swapQuoteAmounts.js";
import { z } from "zod";
import {
  minimumOutputEnforcementSchema,
  adapterEvidenceClaimSchema,
  adapterRawQuantitySchema,
  adapterSourceOfTruthSchema,
  type AdapterEvidenceClaim,
  type AdapterRawQuantity,
  type AdapterSourceOfTruth
} from "./signableAdapterContract.js";
import { makeRawU64StringSchema, parseRawU64 } from "../numeric/rawU64.js";
import type { LocalTransactionMaterialHandle } from "../session/transactionMaterialStore.js";
import { normalizedSuiAddressSchema } from "../suiAddress.js";
import {
  DEEPBOOK_SCALAR_UNIT_SOURCE,
  SUI_METADATA_UNIT_SOURCE
} from "../read/coinMetadata.js";

export const SWAP_QUOTE_POLICY_EVIDENCE_VERSION = "swap-quote-policy-v3";

const isoUtcStringSchema = z.string().refine((value) => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}, "Expected ISO 8601 UTC timestamp");

export const swapQuotePolicyEvidenceSchema = z.object({
  evidenceVersion: z.literal(SWAP_QUOTE_POLICY_EVIDENCE_VERSION),
  materialId: z.string().min(1),
  reviewSessionId: z.string().min(1),
  planId: z.string().min(1),
  account: normalizedSuiAddressSchema,
  kind: z.literal("swap_quote_policy"),
  adapterId: z.string().min(1).max(120),
  protocol: z.string().min(1).max(120),
  actionKind: z.string().min(1).max(120),
  network: z.literal("sui:mainnet"),
  quoteEvidenceId: z.string().min(1).max(120),
  quoteSource: z.object({
    provider: z.string().min(1).max(120),
    poolKey: z.string().min(1).max(120),
    direction: z.enum(["base_to_quote", "quote_to_base"]),
    fetchedAt: isoUtcStringSchema,
    sourceMoveFunction: z.string().min(1).max(160)
  }).strict(),
  policySource: z.literal("adapter_policy_from_quote_evidence"),
  maxSlippageSource: z.literal("action_request"),
  maxSlippageBps: z.number().int().min(1).max(10_000),
  staleAfterMs: z.number().int().min(1),
  sourceAmount: quotePolicyRawAmountSchema,
  expectedOutput: quotePolicyRawAmountSchema,
  minimumOutput: quotePolicyRawAmountSchema,
  enforcement: minimumOutputEnforcementSchema.optional(),
  inputFlow: swapQuoteInputFlowSchema,
  feeTargetRaw: makeRawU64StringSchema("fee target").optional(),
  separateFeeBudgetRaw: makeRawU64StringSchema("separate fee budget").nullable(),
  derivedAt: isoUtcStringSchema,
  expiresAt: isoUtcStringSchema
}).strict();

export type SwapQuotePolicyEvidence = z.infer<typeof swapQuotePolicyEvidenceSchema>;

export type VerifySwapMinimum = (data: import("@mysten/sui/transactions").TransactionData, quote: SwapQuotePolicyEvidence) => void;

export type CreateSwapQuotePolicyEvidenceInput = {
  materialHandle: LocalTransactionMaterialHandle;
  adapterId: string;
  protocol: string;
  actionKind: string;
  quoteEvidenceId: string;
  quoteSource: SwapQuotePolicyEvidence["quoteSource"];
  maxSlippageBps: number;
  staleAfterMs: number;
  sourceAmount: SwapQuotePolicyEvidence["sourceAmount"];
  expectedOutput: SwapQuotePolicyEvidence["expectedOutput"];
  minimumOutput: SwapQuotePolicyEvidence["minimumOutput"];
  inputFlow: SwapQuotePolicyEvidence["inputFlow"];
  feeTargetRaw?: string | undefined;
  separateFeeBudgetRaw: string | null;
  enforcement?: SwapQuotePolicyEvidence["enforcement"];
  derivedAt: Date;
};

export function createSwapQuotePolicyEvidence(
  input: CreateSwapQuotePolicyEvidenceInput
): SwapQuotePolicyEvidence {
  return verifySwapQuotePolicyEvidence({
    transactionMaterial: input.materialHandle,
    evidence: {
      evidenceVersion: SWAP_QUOTE_POLICY_EVIDENCE_VERSION,
      materialId: input.materialHandle.materialId,
      reviewSessionId: input.materialHandle.reviewSessionId,
      planId: input.materialHandle.planId,
      account: input.materialHandle.account,
      kind: "swap_quote_policy",
      adapterId: input.adapterId,
      protocol: input.protocol,
      actionKind: input.actionKind,
      network: "sui:mainnet",
      quoteEvidenceId: input.quoteEvidenceId,
      quoteSource: input.quoteSource,
      maxSlippageSource: "action_request",
      policySource: "adapter_policy_from_quote_evidence",
      maxSlippageBps: input.maxSlippageBps,
      staleAfterMs: input.staleAfterMs,
      sourceAmount: input.sourceAmount,
      expectedOutput: input.expectedOutput,
      minimumOutput: input.minimumOutput,
      ...(input.enforcement ? { enforcement: input.enforcement } : {}),
      inputFlow: input.inputFlow,
      ...(input.feeTargetRaw === undefined ? {} : { feeTargetRaw: input.feeTargetRaw }),
      separateFeeBudgetRaw: input.separateFeeBudgetRaw,
      derivedAt: input.derivedAt.toISOString(),
      expiresAt: input.materialHandle.expiresAt
    },
    now: input.derivedAt
  });
}

export function parseSwapQuotePolicyEvidence(
  value: SwapQuotePolicyEvidence
): SwapQuotePolicyEvidence {
  return swapQuotePolicyEvidenceSchema.parse(value);
}

export function verifySwapQuotePolicyEvidence(input: {
  transactionMaterial: LocalTransactionMaterialHandle;
  evidence: SwapQuotePolicyEvidence;
  now?: Date | undefined;
}): SwapQuotePolicyEvidence {
  const evidence = parseSwapQuotePolicyEvidence(input.evidence);
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new Error("now must be a valid Date");
  }

  if (
    evidence.materialId !== input.transactionMaterial.materialId ||
    evidence.reviewSessionId !== input.transactionMaterial.reviewSessionId ||
    evidence.planId !== input.transactionMaterial.planId ||
    evidence.account !== input.transactionMaterial.account ||
    evidence.expiresAt !== input.transactionMaterial.expiresAt
  ) {
    throw new Error("swap quote policy evidence must match material identity");
  }

  const fetchedAtMs = Date.parse(evidence.quoteSource.fetchedAt);
  const derivedAtMs = Date.parse(evidence.derivedAt);
  const expiresAtMs = Date.parse(evidence.expiresAt);
  if (fetchedAtMs > derivedAtMs) {
    throw new Error("swap quote policy evidence fetchedAt must not be after derivedAt");
  }
  if (Date.parse(evidence.quoteSource.fetchedAt) + evidence.staleAfterMs !== expiresAtMs) {
    throw new Error("swap quote policy evidence expiresAt must equal fetchedAt plus staleAfterMs");
  }
  if (derivedAtMs > nowMs) {
    throw new Error("swap quote policy evidence derivedAt must not be in the future");
  }
  if (expiresAtMs <= derivedAtMs || expiresAtMs <= nowMs) {
    throw new Error("swap quote policy evidence must not be expired");
  }

  const expectedOutput = parseRawU64(evidence.expectedOutput.raw, "expectedOutput.raw", { positive: true });
  const minimumOutput = parseRawU64(evidence.minimumOutput.raw, "minimumOutput.raw", { positive: true });
  const principal = parseRawU64(evidence.sourceAmount.raw, "sourceAmount.raw", { positive: true });
  if (BigInt(evidence.inputFlow.expectedSpendRaw) + BigInt(evidence.inputFlow.expectedReturnRaw) !== principal) {
    throw new Error("swap quote expected input spend and return must sum to the requested principal");
  }
  if (evidence.feeTargetRaw !== undefined && (evidence.separateFeeBudgetRaw === null ||
      BigInt(evidence.feeTargetRaw) < BigInt(evidence.separateFeeBudgetRaw))) throw new Error("Invalid fee allocation target");
  const fee = evidence.inputFlow.fee;
  if (fee.kind === "separate_coin"
    ? evidence.separateFeeBudgetRaw === null || BigInt(evidence.separateFeeBudgetRaw) < BigInt(fee.amount.raw)
    : evidence.separateFeeBudgetRaw !== null) {
    throw new Error("swap quote fee budget must cover the itemized fee and apply only to a separate fee coin");
  }
  const computedMinimum =
    minimumSwapOutput(expectedOutput, evidence.maxSlippageBps);
  if (minimumOutput !== computedMinimum) {
    throw new Error("swap quote policy minimumOutput.raw must match expectedOutput.raw and maxSlippageBps");
  }
  if (!sameAsset(evidence.expectedOutput.asset, evidence.minimumOutput.asset)) {
    throw new Error("swap quote policy minimum output asset must match expected output asset");
  }

  if (evidence.enforcement && (evidence.enforcement.recipient !== evidence.account ||
      evidence.enforcement.raw !== evidence.minimumOutput.raw || evidence.enforcement.coinType !== evidence.minimumOutput.asset.coinType)) {
    throw new Error("Output enforcement must bind the reviewed minimum, recipient and asset.");
  }
  const contractMapping = mapSwapQuotePolicyEvidenceToContractDraft(evidence);
  if (contractMapping.status === "unsupported") {
    throw new Error(`swap quote policy evidence is not contract-mappable: ${contractMapping.reason}`);
  }

  return evidence;
}

export type SwapQuotePolicyContractMapping =
  | {
      status: "mapped";
      sourceReferences: AdapterSourceOfTruth[];
      evidenceClaims: Array<
        Extract<
          AdapterEvidenceClaim,
          { factKind: "raw_quantity_amount" | "unit_metadata" | "quote_min_out" | "slippage_policy" }
        >
      >;
      rawQuantities: AdapterRawQuantity[];
    }
  | {
      status: "unsupported";
      reason: string;
    };

export function mapSwapQuotePolicyEvidenceToContractDraft(
  evidenceInput: SwapQuotePolicyEvidence
): SwapQuotePolicyContractMapping {
  const evidence = parseSwapQuotePolicyEvidence(evidenceInput);
  const outputUnitSource = mapUnitSource(evidence.expectedOutput.asset.unitSource);
  if (!outputUnitSource) {
    return { status: "unsupported", reason: "unsupported output unit source" };
  }

  const quoteSourceId = "swap_quote_policy";
  const outputUnitSourceId = "swap_quote_output_unit";
  const outputUnitClaimId = "swap_quote_output_unit_claim";
  const expectedAmountClaimId = "swap_quote_expected_output_claim";
  const minimumAmountClaimId = "swap_quote_minimum_output_claim";
  const quoteMinOutClaimId = "swap_quote_min_out_claim";
  const slippagePolicyClaimId = "swap_quote_slippage_policy_claim";
  const outputAsset = {
    symbol: evidence.expectedOutput.asset.symbol,
    coinType: evidence.expectedOutput.asset.coinType
  };
  const sourceReferences = [
    adapterSourceOfTruthSchema.parse({
      id: quoteSourceId,
      kind: "quote_evidence",
      network: "sui:mainnet",
      source: `${evidence.protocol} quote and slippage rules (adapter: ${evidence.adapterId})`,
      verifiedAt: evidence.derivedAt,
      fields: ["quoteEvidenceId", "rawAmount", "minOutRaw", "asset", "amountRole", "maxSlippageBps"]
    }) as AdapterSourceOfTruth,
    adapterSourceOfTruthSchema.parse({
      id: outputUnitSourceId,
      kind: outputUnitSource.sourceReferencesKind,
      network: "sui:mainnet",
      source: outputUnitSource.sourceDescription,
      verifiedAt: evidence.derivedAt,
      fields: ["coinType", "decimals"]
    }) as AdapterSourceOfTruth
  ];
  const evidenceClaims: Array<
    Extract<
      AdapterEvidenceClaim,
      { factKind: "raw_quantity_amount" | "unit_metadata" | "quote_min_out" | "slippage_policy" }
    >
  > = [
    adapterEvidenceClaimSchema.parse({
      id: expectedAmountClaimId,
      factKind: "raw_quantity_amount",
      sourceEvidenceId: quoteSourceId,
      role: "expected_output",
      asset: outputAsset,
      rawAmount: evidence.expectedOutput.raw
    }),
    adapterEvidenceClaimSchema.parse({
      id: minimumAmountClaimId,
      factKind: "raw_quantity_amount",
      sourceEvidenceId: quoteSourceId,
      role: "minimum_output",
      asset: outputAsset,
      rawAmount: evidence.minimumOutput.raw
    }),
    adapterEvidenceClaimSchema.parse({
      id: outputUnitClaimId,
      factKind: "unit_metadata",
      sourceEvidenceId: outputUnitSourceId,
      source: outputUnitSource.unitClaimSource,
      coinType: outputAsset.coinType,
      decimals: evidence.expectedOutput.asset.decimals
    }),
    adapterEvidenceClaimSchema.parse({
      id: quoteMinOutClaimId,
      factKind: "quote_min_out",
      sourceEvidenceId: quoteSourceId,
      quoteEvidenceId: evidence.quoteEvidenceId,
      minOutRaw: evidence.minimumOutput.raw
    }),
    adapterEvidenceClaimSchema.parse({
      id: slippagePolicyClaimId,
      factKind: "slippage_policy",
      sourceEvidenceId: quoteSourceId,
      maxSlippageSource: "action_request",
      policySource: "adapter_policy_from_quote_evidence",
      maxSlippageBps: evidence.maxSlippageBps,
      minOutRaw: evidence.minimumOutput.raw
    })
  ] as Array<
    Extract<
      AdapterEvidenceClaim,
      { factKind: "raw_quantity_amount" | "unit_metadata" | "quote_min_out" | "slippage_policy" }
    >
  >;
  const rawQuantities = [
    adapterRawQuantitySchema.parse({
      id: "swap_quote_expected_output",
      role: "expected_output",
      asset: outputAsset,
      rawAmount: evidence.expectedOutput.raw,
      unit: {
        decimals: evidence.expectedOutput.asset.decimals,
        source: outputUnitSource.unitClaimSource,
        sourceField: "expectedOutput.asset.decimals",
        unitClaimId: outputUnitClaimId
      },
      amountClaimId: expectedAmountClaimId
    }) as AdapterRawQuantity,
    adapterRawQuantitySchema.parse({
      id: "swap_quote_minimum_output",
      role: "minimum_output",
      asset: outputAsset,
      rawAmount: evidence.minimumOutput.raw,
      unit: {
        decimals: evidence.expectedOutput.asset.decimals,
        source: outputUnitSource.unitClaimSource,
        sourceField: "minimumOutput.asset.decimals",
        unitClaimId: outputUnitClaimId
      },
      amountClaimId: minimumAmountClaimId
    }) as AdapterRawQuantity
  ];

  return {
    status: "mapped",
    sourceReferences,
    evidenceClaims,
    rawQuantities
  };
}

function sameAsset(
  left: SwapQuotePolicyEvidence["expectedOutput"]["asset"],
  right: SwapQuotePolicyEvidence["expectedOutput"]["asset"]
): boolean {
  return (
    left.symbol === right.symbol &&
    left.coinType === right.coinType &&
    left.decimals === right.decimals &&
    left.unitSource === right.unitSource
  );
}

function mapUnitSource(
  unitSource: SwapQuotePolicyEvidence["expectedOutput"]["asset"]["unitSource"]
): {
  sourceReferencesKind: "pinned_sdk_registry" | "verified_mainnet_onchain_metadata";
  unitClaimSource: "pinned_sdk_metadata" | "verified_mainnet_onchain_metadata";
  sourceDescription: string;
} | undefined {
  if (unitSource === DEEPBOOK_SCALAR_UNIT_SOURCE) {
    return {
      sourceReferencesKind: "pinned_sdk_registry",
      unitClaimSource: "pinned_sdk_metadata",
      sourceDescription: "Token decimals from the pinned DeepBook mainnet metadata, used to interpret raw quote amounts"
    };
  }
  if (unitSource === SUI_METADATA_UNIT_SOURCE) {
    return {
      sourceReferencesKind: "verified_mainnet_onchain_metadata",
      unitClaimSource: "verified_mainnet_onchain_metadata",
      sourceDescription: "Token decimals read from Sui mainnet, used to interpret raw quote amounts"
    };
  }
  return undefined;
}
