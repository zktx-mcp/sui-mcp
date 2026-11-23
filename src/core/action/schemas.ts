import { swapQuoteInputFlowSchema } from "./swapQuoteAmounts.js";
import { z } from "zod";
import { proposalReviewModelSchema } from "../proposal/schemas.js";
import { suiAddressStringSchema } from "../suiAddress.js";
import { makeRawU64StringSchema, makeSignedRawIntegerStringSchema } from "../numeric/rawU64.js";
import { normalizeCoinType } from "../read/coinMetadata.js";
import { BLOCKED_REASONS, REFRESH_REASONS, REVIEW_PREPARATION_STATUSES, REVIEW_MATERIAL_DERIVED_FIELDS } from "./types.js";
import { reviewSimulationProviderSchema, ptbVisualizationArtifactSchema, transactionReviewDataSchema } from "./signableAdapterContract.js";
export { transactionExecutionSummarySchema } from "../session/transactionRequest.js";

export const unknownRecordSchema = z.record(z.string(), z.unknown());

export const blockedReasonSchema = z.enum(BLOCKED_REASONS);
export const refreshReasonSchema = z.enum(REFRESH_REASONS);

export const reviewStatusSchema = z.enum([
  "ready_for_wallet_review",
  "refresh_required",
  "blocked"
]);

export const internalSessionStatusSchema = z.enum(REVIEW_PREPARATION_STATUSES);

export const executionPollingStatusSchema = z.enum([
  "proposed", "awaiting_wallet", "wallet_connected", "ready_for_wallet_review", "refresh_required", "blocked", "expired",
  "awaiting_signature", "submitting", "awaiting_chain_result", "stopped", "request_failed", "outcome_unknown", "completed"
]);

export const reviewCheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(["pass", "warning", "fail"]),
  message: z.string(),
  source: z.enum(["registry", "quote", "wallet", "simulation", "adapter", "network", "proposal"])
});

const adapterLifecycleStageIdSchema = z.string().min(1);
const HUMAN_READABLE_REVIEW_STAGE = "human_readable_review";
const REVIEW_TIME_SIMULATION_STAGE = "review_time_simulation";

export const adapterLifecycleSchema = z.object({
  stageCatalogId: z.string().min(1),
  adapterId: z.string(),
  protocol: z.string(),
  actionKind: z.string(),
  completedStages: z.array(adapterLifecycleStageIdSchema),
  missingStages: z.array(adapterLifecycleStageIdSchema)
}).strict().superRefine((lifecycle, ctx) => {
  const duplicateCompleted = findDuplicate(lifecycle.completedStages);
  if (duplicateCompleted) {
    ctx.addIssue({
      code: "custom",
      path: ["completedStages"],
      message: `completedStages contains duplicate stage '${duplicateCompleted}'`
    });
  }

  const duplicateMissing = findDuplicate(lifecycle.missingStages);
  if (duplicateMissing) {
    ctx.addIssue({
      code: "custom",
      path: ["missingStages"],
      message: `missingStages contains duplicate stage '${duplicateMissing}'`
    });
  }

  for (const stage of lifecycle.completedStages) {
    if (lifecycle.missingStages.includes(stage)) {
      ctx.addIssue({
        code: "custom",
        path: ["missingStages"],
        message: `stage '${stage}' cannot be both completed and missing`
      });
    }
  }
});

function findDuplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
  }
  return undefined;
}

export const assetAmountSchema = z.object({
  symbol: z.string(),
  amount: z.string(),
  coinType: z.string().optional(),
  approx: z.boolean().optional()
}).strict();

export const displayIntentAssetAmountSchema = assetAmountSchema.extend({
  amountKind: z.literal("display_intent").default("display_intent")
});

export const assetFlowPreviewSchema = z.object({
  outgoing: z.array(displayIntentAssetAmountSchema),
  expectedIncoming: z.array(displayIntentAssetAmountSchema),
  minimumIncoming: z.array(displayIntentAssetAmountSchema).optional(),
  fees: z.array(displayIntentAssetAmountSchema).optional()
});

export const assetFlowSchema = z.object({
  outgoing: z.array(assetAmountSchema),
  expectedIncoming: z.array(assetAmountSchema),
  minimumIncoming: z.array(assetAmountSchema).optional(),
  fees: z.array(assetAmountSchema).optional()
});

export const balanceChangeSchema = z.object({
  before: z.array(assetAmountSchema),
  after: z.array(assetAmountSchema),
  delta: z.array(assetAmountSchema)
});

export const transactionSimulationGasCostSummarySchema = z.object({
  computationCostRaw: makeRawU64StringSchema("computationCostRaw"),
  storageCostRaw: makeRawU64StringSchema("storageCostRaw"),
  storageRebateRaw: makeRawU64StringSchema("storageRebateRaw"),
  nonRefundableStorageFeeRaw: makeRawU64StringSchema("nonRefundableStorageFeeRaw")
}).strict();

export const transactionSimulationBalanceChangeSchema = z.object({
  address: suiAddressStringSchema,
  coinType: z.string().min(1).max(512).refine((value) => {
    try {
      return normalizeCoinType(value) === value;
    } catch {
      return false;
    }
  }, "Expected a normalized Sui struct tag coin type"),
  amount: makeSignedRawIntegerStringSchema("balanceChanges[].amount")
}).strict();

export const transactionSimulationObjectChangeSchema = z.object({
  objectId: suiAddressStringSchema,
  objectType: z.string().min(1).max(512).optional(),
  inputState: z.string().min(1).max(80),
  outputState: z.string().min(1).max(80),
  idOperation: z.string().min(1).max(80)
}).strict();

const transactionSimulationSummaryBaseSchema = z.object({
  provider: reviewSimulationProviderSchema,
  checksEnabled: z.boolean(),
  success: z.boolean(),
  gasCostSummary: transactionSimulationGasCostSummarySchema.optional(),
  balanceChanges: z.array(transactionSimulationBalanceChangeSchema).optional(),
  objectChanges: z.array(transactionSimulationObjectChangeSchema).optional(),
  error: z.string().optional()
});

export const transactionSimulationSummarySchema = transactionSimulationSummaryBaseSchema;

export const successfulTransactionSimulationSummarySchema = transactionSimulationSummaryBaseSchema.extend({
  checksEnabled: z.literal(true),
  success: z.literal(true),
  gasCostSummary: transactionSimulationGasCostSummarySchema,
  balanceChanges: z.array(transactionSimulationBalanceChangeSchema),
  objectChanges: z.array(transactionSimulationObjectChangeSchema),
  error: z.never().optional()
}).strict();

const swapHumanReadableReviewAmountSchema = z.object({
  role: z.enum(["input", "expected_output", "minimum_output", "fee"]),
  symbol: z.string(),
  coinType: z.string().min(1).max(512).refine((value) => {
    try {
      normalizeCoinType(value);
      return true;
    } catch {
      return false;
    }
  }, "Expected a Sui struct tag coin type"),
  decimals: z.number().int().min(0).max(255),
  rawAmount: makeRawU64StringSchema("rawAmount"),
  rawAmountSource: z.literal("quote_policy_evidence"),
  displayAmount: z.string().optional(),
  displayAmountSource: z.literal("user_display_intent_not_signing_input").optional()
}).strict().superRefine((amount, ctx) => {
  if (amount.displayAmount !== undefined && amount.displayAmountSource === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["displayAmountSource"],
      message: "displayAmountSource is required when displayAmount is present"
    });
  }
  if (amount.displayAmount === undefined && amount.displayAmountSource !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["displayAmount"],
      message: "displayAmount is required when displayAmountSource is present"
    });
  }
});

const humanReadableReviewPartySchema = z.object({
  role: z.enum(["connected_account", "output_recipient"]),
  address: suiAddressStringSchema
}).strict();

const swapHumanReadableReviewTargetSchema = z.object({
  kind: z.literal("swap_output_asset"),
  symbol: z.string(),
  coinType: z.string().min(1).max(512).refine((value) => {
    try {
      normalizeCoinType(value);
      return true;
    } catch {
      return false;
    }
  }, "Expected a Sui struct tag coin type"),
  protocol: z.string(),
  poolKey: z.string(),
  direction: z.enum(["base_to_quote", "quote_to_base"])
}).strict();

const humanReadableReviewFactSchema = z.object({
  id: z.string(),
  label: z.string(),
  source: z.union([
    z.enum(["registry", "quote", "wallet", "simulation", "adapter", "network", "proposal"]),
    z.enum(["transaction_material", "digest_commitment"])
  ]),
  summary: z.string()
}).strict();

const humanReadableReviewGapSchema = z.object({
  id: z.string(),
  label: z.string(),
  reason: z.string()
}).strict();

export const humanReadableReviewEnvelopeSchema = z.object({
  proposedAction: z.object({
    title: z.string(),
    summary: z.string(),
    actionKind: z.string(),
    adapterId: z.string(),
    protocol: z.string(),
    network: z.literal("sui:mainnet")
  }).strict(),
  recipients: z.array(humanReadableReviewPartySchema),
  evidenceUsed: z.array(humanReadableReviewFactSchema),
  missingEvidence: z.array(humanReadableReviewGapSchema),
  requiredUserChoices: z.array(humanReadableReviewGapSchema),
  unsupportedClaims: z.array(humanReadableReviewGapSchema),
  freshness: z.object({
    status: z.literal("current"),
    quotedAt: z.iso.datetime().optional(),
    evaluatedAt: z.string(),
    expiresAt: z.string(),
    reason: z.string()
  }).strict(),
  blockingChecks: z.array(reviewCheckSchema)
}).strict();

export const swapHumanReadableReviewProjectionSchema = z.object({
  assetFlow: z.object({
    outgoing: z.array(swapHumanReadableReviewAmountSchema),
    expectedIncoming: z.array(swapHumanReadableReviewAmountSchema),
    minimumIncoming: z.array(swapHumanReadableReviewAmountSchema),
    inputFlow: swapQuoteInputFlowSchema.optional(),
    feeTargetRaw: makeRawU64StringSchema("fee target").optional(),
    separateFeeBudgetRaw: makeRawU64StringSchema("separateFeeBudgetRaw").nullable().optional(),
    fees: z.array(swapHumanReadableReviewAmountSchema)
  }).strict(),
  targets: z.array(swapHumanReadableReviewTargetSchema)
}).strict();

export const swapHumanReadableReviewSummarySchema = humanReadableReviewEnvelopeSchema
  .extend({ kind: z.literal("swap_human_readable_review") })
  .merge(swapHumanReadableReviewProjectionSchema);

export const humanReadableReviewSummarySchema = z.discriminatedUnion("kind", [
  swapHumanReadableReviewSummarySchema
]);

export const actionPlanSchema = z.object({
  id: z.string(),
  actionKind: z.string(),
  adapterId: z.string(),
  protocol: z.string(),
  title: z.string(),
  summary: z.string(),
  assetFlowPreview: assetFlowPreviewSchema,
  reviewModel: proposalReviewModelSchema.optional(),
  adapterData: unknownRecordSchema,
  createdAt: z.string(),
  expiresAt: z.string().optional(),
  registryVersion: z.string().optional(),
  preliminaryChecks: z.array(reviewCheckSchema).optional()
});

const reviewStateBaseSchema = z.object({
  planId: z.string(),
  reviewSessionId: z.string(),
  account: suiAddressStringSchema,
  checks: z.array(reviewCheckSchema),
  assetFlowActual: assetFlowSchema.optional(),
  beforeAfterBalance: balanceChangeSchema.optional(),
  simulation: transactionSimulationSummarySchema.optional(),
  humanReadableReview: humanReadableReviewSummarySchema.optional(),
  transactionReviewData: transactionReviewDataSchema.optional(),
  ptbVisualization: ptbVisualizationArtifactSchema.optional(),
  adapterLifecycle: adapterLifecycleSchema.optional(),
  updatedAt: z.string()
});

export const reviewStateStructuralInvariantSchema = z.discriminatedUnion("status", [
  reviewStateBaseSchema.extend({
    status: z.literal("ready_for_wallet_review"),
    evidenceValidity: z.never().optional(),
    blockedReason: z.never().optional(),
    refreshReason: z.never().optional()
  }),
  reviewStateBaseSchema.extend({
    status: z.literal("refresh_required"),
    evidenceValidity: z.literal("invalidated").optional(),
    refreshReason: refreshReasonSchema,
    blockedReason: z.never().optional()
  }),
  reviewStateBaseSchema.extend({
    status: z.literal("blocked"),
    evidenceValidity: z.literal("invalidated").optional(),
    blockedReason: blockedReasonSchema,
    refreshReason: z.never().optional()
  })
]).superRefine((state, ctx) => {
  if (state.evidenceValidity === "invalidated") {
    for (const field of REVIEW_MATERIAL_DERIVED_FIELDS) if (state[field] !== undefined) {
      ctx.addIssue({ code: "custom", path: [field], message: "Invalidated review evidence cannot carry current material-derived facts" });
    }
  }
  const lifecycle = state.adapterLifecycle;
  if (lifecycle !== undefined) {
    validatePublicEvidenceStageBinding(state, ctx);
  }

  if (state.humanReadableReview !== undefined && lifecycle === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["humanReadableReview"],
      message: "humanReadableReview requires adapterLifecycle evidence stage provenance"
    });
  }

  if (state.simulation !== undefined && lifecycle === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["simulation"],
      message: "simulation requires adapterLifecycle evidence stage provenance"
    });
  }

  if (state.ptbVisualization !== undefined) {
    const stages = lifecycle?.completedStages ?? [];
    const hasMaterialBinding =
      stages.includes("transaction_material_build_or_verify") && stages.includes("digest_commitment");
    if (!hasMaterialBinding) {
      ctx.addIssue({
        code: "custom",
        path: ["ptbVisualization"],
        message:
          "ptbVisualization requires completed transaction material and digest commitment lifecycle stages"
      });
    }
  }

  const contractCarryingState = state.status === "ready_for_wallet_review";
  if (state.transactionReviewData !== undefined && !contractCarryingState) {
    ctx.addIssue({
      code: "custom",
      path: ["transactionReviewData"],
      message:
        "transactionReviewData is only valid on ready_for_wallet_review"
    });
  }
  if (state.status === "ready_for_wallet_review" && lifecycle !== undefined) {
    if (state.transactionReviewData === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["transactionReviewData"],
        message: "ready_for_wallet_review requires an emitted wallet review contract"
      });
    }
    if (lifecycle === undefined || lifecycle.missingStages.length !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["adapterLifecycle"],
        message: "ready_for_wallet_review requires a completed adapterLifecycle with no missing stages"
      });
    }
    if (state.humanReadableReview === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["humanReadableReview"],
        message: "ready_for_wallet_review requires humanReadableReview public evidence"
      });
    }
    if (state.simulation === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["simulation"],
        message: "ready_for_wallet_review requires successful simulation public evidence"
      });
    }
  }

  if (state.status !== "blocked") {
    return;
  }


  if (
    state.blockedReason === "producer_stage_missing" &&
    lifecycle === undefined
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["adapterLifecycle"],
      message: "producer_stage_missing requires adapterLifecycle with at least one missing stage"
    });
  }
  if (
    state.blockedReason === "producer_stage_missing" &&
    lifecycle !== undefined &&
    lifecycle.missingStages.length === 0
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["blockedReason"],
      message: "producer_stage_missing requires at least one adapterLifecycle.missingStages entry"
    });
  }
  if (
    state.blockedReason === "wallet_review_contract_emit_missing" &&
    state.transactionReviewData !== undefined
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["transactionReviewData"],
      message: "wallet_review_contract_emit_missing requires the wallet review contract to be absent"
    });
  }
  if (
    state.blockedReason === "wallet_review_contract_emit_missing" &&
    lifecycle === undefined
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["adapterLifecycle"],
      message: "wallet_review_contract_emit_missing requires adapterLifecycle"
    });
  }
  if (
    state.blockedReason === "wallet_review_contract_emit_missing" &&
    lifecycle !== undefined &&
    lifecycle.missingStages.length !== 0
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["blockedReason"],
      message: "wallet_review_contract_emit_missing requires a completed adapterLifecycle with no missing stages"
    });
  }
  if (
    state.blockedReason === "wallet_review_contract_emit_missing" &&
    state.evidenceValidity !== "invalidated" &&
    state.humanReadableReview === undefined
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["humanReadableReview"],
      message: "wallet_review_contract_emit_missing requires humanReadableReview public evidence"
    });
  }
  if (
    state.blockedReason === "wallet_review_contract_emit_missing" &&
    state.evidenceValidity !== "invalidated" &&
    state.simulation === undefined
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["simulation"],
      message: "wallet_review_contract_emit_missing requires simulation public evidence"
    });
  }
});

export const reviewStateOutputSchema = reviewStateStructuralInvariantSchema;

type ReviewStateSchemaValue = z.infer<typeof reviewStateBaseSchema> & {
  status: "ready_for_wallet_review" | "refresh_required" | "blocked";
};

function validatePublicEvidenceStageBinding(
  state: ReviewStateSchemaValue,
  ctx: z.RefinementCtx
): void {
  const lifecycle = state.adapterLifecycle;
  if (!lifecycle) {
    return;
  }

  if (state.humanReadableReview !== undefined) {
    requireLifecycleStageCompleted(ctx, lifecycle, HUMAN_READABLE_REVIEW_STAGE, ["humanReadableReview"]);
  }

  if (state.simulation !== undefined) {
    requireLifecycleStageCompleted(ctx, lifecycle, REVIEW_TIME_SIMULATION_STAGE, ["simulation"]);
    requireLifecycleStageCompleted(ctx, lifecycle, HUMAN_READABLE_REVIEW_STAGE, ["simulation"]);
    requireSuccessfulSimulationProjection(ctx, state.simulation, ["simulation"]);
  }

  if (
    lifecycle.missingStages.includes(REVIEW_TIME_SIMULATION_STAGE) &&
    state.simulation !== undefined
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["simulation"],
      message: "simulation public evidence cannot be present while review_time_simulation is missing"
    });
  }

  if (
    lifecycle.missingStages.includes(HUMAN_READABLE_REVIEW_STAGE) &&
    state.humanReadableReview !== undefined
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["humanReadableReview"],
      message: "humanReadableReview public evidence cannot be present while human_readable_review is missing"
    });
  }
}

function requireLifecycleStageCompleted(
  ctx: z.RefinementCtx,
  lifecycle: NonNullable<ReviewStateSchemaValue["adapterLifecycle"]>,
  stage: string,
  path: (string | number)[]
): void {
  if (!lifecycle.completedStages.includes(stage)) {
    ctx.addIssue({
      code: "custom",
      path,
      message: `${path.join(".")} requires completed adapterLifecycle stage '${stage}'`
    });
  }
  if (lifecycle.missingStages.includes(stage)) {
    ctx.addIssue({
      code: "custom",
      path,
      message: `${path.join(".")} cannot be present while adapterLifecycle stage '${stage}' is missing`
    });
  }
}

function requireSuccessfulSimulationProjection(
  ctx: z.RefinementCtx,
  simulation: unknown,
  path: (string | number)[]
): void {
  const parsed = successfulTransactionSimulationSummarySchema.safeParse(simulation);
  if (!parsed.success) {
    ctx.addIssue({
      code: "custom",
      path,
      message: "simulation public evidence requires a successful checks-enabled review-time simulation projection"
    });
  }
}
