import { deepbookMinimumAbort } from "./deepbookSwapCommands.js";
import { simulationWithinSwapLimits } from "../../core/action/swapSimulationLimits.js";
import { isDeepStrictEqual } from "node:util";
import { deepbookMinimumBaseRaw, deepbookMinimumInputRaw, deepbookQuoteGetters, deepbookQuoteInputFlow, parseQuoteDisplayAmount } from "../../core/read/deepbookReadHelpers.js";
import { parseRawU64 } from "../../core/numeric/rawU64.js";
import { deepbookSwapActionPlanDataSchema } from "./deepbookSwapIntent.js";
import type {
  DeepbookSwapActionPlanIdentity,
  DeepbookSwapRequestedIntent
} from "./deepbookSwapIntent.js";
import {
  deepbookFeeBudget,
  deriveDeepbookSwapQuotePolicy,
  type DeepbookSwapQuotePolicyOk
} from "./deepbookQuotePolicy.js";
import {
  deepbookSwapReviewLifecycleStageLabel,
  newDeepbookSwapReviewLifecycle,
  type DeepbookSwapReviewLifecycle,
  type DeepbookSwapReviewLifecycleStage
} from "./deepbookReviewLifecycle.js";
import type {
  DeepbookSwapTransactionMaterialDigestProducer,
  DeepbookSwapTransactionMaterialProducer
} from "./deepbookTransactionMaterialProducer.js";
import type {
  DeepbookSwapHumanReadableReviewProducer
} from "./deepbookHumanReviewProducer.js";
import type {
  TransactionObjectOwnershipProducer
} from "../../core/action/transactionObjectOwnershipProducer.js";
import type {
  ActionPlan,
  BlockedReason,
  HumanReadableReviewSummary,
  RefreshReason,
  ReviewCheck,
  SuccessfulTransactionSimulationSummary
} from "../../core/action/types.js";
import {
  createSwapQuotePolicyEvidence
} from "../../core/action/swapQuotePolicyEvidence.js";
import {
  publicHumanReadableReviewFromEvidence
} from "../../core/action/humanReadableReviewEvidence.js";
import {
  publicTransactionSimulationSummaryFromEvidence,
  type ReviewTimeSimulationProducer
} from "../../core/action/reviewTimeSimulationEvidence.js";
import {
  ReadServiceInputError,
  type DeepbookDisplayQuoteSummary
} from "../../core/read/readServiceTypes.js";
import { DEEPBOOK_SCALAR_UNIT_SOURCE, formatRawAmount } from "../../core/read/coinMetadata.js";
import { deepbookQuoteAssets, resolveDeepbookPoolForSymbols } from "../../core/read/deepbookRegistry.js";
import {
  blockedAdapterLifecycleReviewResult,
  failReviewCheck,
  passReviewCheck,
  producerStageMissingReviewResult,
  refreshRequiredAdapterLifecycleReviewResult,
  walletReviewContractEmitMissingResult,
  walletReviewContractEmittedResult,
  type ReviewComputationResult
} from "../../core/review/reviewComputationResult.js";
import {
  assembleTransactionReviewData
} from "../../core/action/walletReviewContractAssembler.js";
import type { PtbVisualizationOutcome } from "../../core/action/ptbVisualizationProducer.js";
import type { PtbVisualizationArtifact } from "../../core/action/signableAdapterContract.js";
import type { PrivateReviewArtifacts } from "../../core/session/privateReviewArtifacts.js";
import type {
  LocalTransactionMaterialDigestCommitment,
  LocalTransactionMaterialHandle
} from "../../core/session/transactionMaterialStore.js";

export type DeepbookSwapReviewQuoteSource = {
  quoteDeepbookDisplayAmount(input: {
    poolKey: string;
    direction: "base_to_quote" | "quote_to_base";
    amountDisplay: string;
    simulationSender: string;
    feeMode?: "deep" | "input_coin" | undefined;
  }): Promise<DeepbookDisplayQuoteSummary>;
};

export type DeepbookDeepBalanceSource = (account: string) => Promise<string>;

export type DeepbookSwapReviewEvidenceInput = {
  preparationId?: string | undefined;
  reviewSessionId: string;
  plan: DeepbookSwapActionPlanIdentity;
  account: string;
  now?: Date | undefined;
  clock?: (() => Date) | undefined;
  quoteSource: DeepbookSwapReviewQuoteSource;
  deepBalanceSource?: DeepbookDeepBalanceSource | undefined;
  gasFeePolicySource?: ((poolKey: string) => Promise<{ enabled: boolean; additionalTakerFeeRaw: string }>) | undefined;
  transactionMaterialProducer?: DeepbookSwapTransactionMaterialProducer | undefined;
  transactionMaterialDigestProducer?: DeepbookSwapTransactionMaterialDigestProducer | undefined;
  transactionObjectOwnershipProducer?: TransactionObjectOwnershipProducer | undefined;
  humanReadableReviewProducer?: DeepbookSwapHumanReadableReviewProducer | undefined;
  reviewTimeSimulationProducer?: ReviewTimeSimulationProducer | undefined;
  ptbVisualizationProducer?: DeepbookPtbVisualizationProducer | undefined;
};

export type DeepbookPtbVisualizationProducer = (input: {
  transactionMaterial: LocalTransactionMaterialHandle;
  transactionMaterialDigest: LocalTransactionMaterialDigestCommitment;
  adapterId: string;
  planId: string;
  now: Date;
}) => Promise<PtbVisualizationOutcome>;

export type DeepbookSwapReviewEvidenceResult = {
  result: ReviewComputationResult;
  privateArtifacts?: PrivateReviewArtifacts;
};

export async function computeDeepbookSwapReviewEvidence(
  input: DeepbookSwapReviewEvidenceInput
): Promise<DeepbookSwapReviewEvidenceResult> {
  const lifecycle = newDeepbookSwapReviewLifecycle(input.plan);
  const checks: ReviewCheck[] = [];
  const clock = input.clock ?? (() => input.now ?? new Date());

  const intentStage = await runDeepbookReviewStage({
    lifecycle,
    checks,
    stage: "intent_normalized",
    run: () => normalizeIntentStage(input.plan)
  });
  if (!intentStage.ok) {
    return { result: intentStage.result };
  }
  const requestedIntent = intentStage.evidence;

  const poolStage = await runDeepbookReviewStage({
    lifecycle,
    checks,
    stage: "pool_resolved",
    run: () => resolvePoolStage(requestedIntent)
  });
  if (!poolStage.ok) {
    return { result: poolStage.result };
  }
  const poolResolution = poolStage.evidence;

  const quoteStage = await runDeepbookReviewStage({
    lifecycle,
    checks,
    stage: "quote_evidence_fetched",
    run: () => quoteEvidenceStage(input, requestedIntent, poolResolution)
  });
  if (!quoteStage.ok) {
    return { result: quoteStage.result };
  }
  const { quote, feeMode, feeBudgetRaw, feeTargetRaw } = quoteStage.evidence;

  const policyStage = await runDeepbookReviewStage({
    lifecycle,
    checks,
    stage: "quote_policy_derived",
    run: () => quotePolicyStage(requestedIntent, quote, feeMode, clock())
  });
  if (!policyStage.ok) {
    return { result: policyStage.result };
  }
  const quotePolicy = { ...policyStage.evidence, feeBudgetRaw, feeTargetRaw };

  const prepared = await prepareQuotedSwap(input, requestedIntent, poolResolution, quote, quotePolicy, lifecycle, checks, clock);
  if (clock().getTime() >= Date.parse(quotePolicy.expiresAt)) {
    checks.push(failReviewCheck("deepbook_quote_expired_during_review", "Quote expired",
      "The quote expired during preparation. Refresh to obtain current amounts.", "quote"));
    return { result: refreshRequiredAdapterLifecycleReviewResult("quote_stale", checks, lifecycle.snapshot()) };
  }
  return prepared;
}

async function prepareQuotedSwap(
  input: DeepbookSwapReviewEvidenceInput,
  requestedIntent: DeepbookSwapRequestedIntent,
  poolResolution: DeepbookPoolResolution,
  quote: DeepbookDisplayQuoteSummary,
  quotePolicy: DeepbookSwapQuotePolicyOk & { feeBudgetRaw: string; feeTargetRaw?: string | undefined },
  lifecycle: DeepbookReviewLifecycleController,
  checks: ReviewCheck[],
  clock: () => Date
): Promise<DeepbookSwapReviewEvidenceResult> {
  if (!input.transactionMaterialProducer) {
    return {
      result: missingProducerStageBlockedResult(lifecycle.snapshot(), checks)
    };
  }

  const materialStage = await runDeepbookReviewStage({
    lifecycle,
    checks,
    stage: "transaction_material_build_or_verify",
    run: async () => {
      const built = await input.transactionMaterialProducer!({
      preparationId: input.preparationId,
      reviewSessionId: input.reviewSessionId,
      plan: input.plan,
      account: input.account,
      requestedIntent,
      poolResolution,
      quote,
      quotePolicy,
      now: clock(),
      clock
    });
      return built.status === "completed"
        ? { ...built, evidence: { handle: built.evidence, guardCommand: built.guardCommand } }
        : built;
    }
  });
  if (!materialStage.ok) {
    return { result: materialStage.result };
  }

  if (!input.transactionMaterialDigestProducer) {
    return {
      result: missingProducerStageBlockedResult(lifecycle.snapshot(), checks)
    };
  }

  const digestStage = await runDeepbookReviewStage({
    lifecycle,
    checks,
    stage: "digest_commitment",
    run: () => input.transactionMaterialDigestProducer!({
      materialHandle: materialStage.evidence.handle,
      now: clock()
    })
  });
  if (!digestStage.ok) {
    return { result: digestStage.result };
  }

  let swapQuotePolicy;
  try {
    swapQuotePolicy = createSwapQuotePolicyEvidence({
      materialHandle: materialStage.evidence.handle,
      adapterId: input.plan.adapterId,
      protocol: input.plan.protocol,
      actionKind: input.plan.actionKind,
      quoteEvidenceId: `deepbook_raw_quote:${input.plan.id}`,
      quoteSource: {
        provider: input.plan.protocol,
        poolKey: poolResolution.poolKey,
        direction: quotePolicy.direction,
        fetchedAt: quotePolicy.fetchedAt,
        sourceMoveFunction: quote.rawQuote.sourceMoveFunction
      },
      maxSlippageBps: quotePolicy.maxSlippageBps,
      staleAfterMs: quotePolicy.staleAfterMs,
      sourceAmount: quotePolicyAmount(quote.rawQuote.inputAmount),
      expectedOutput: quotePolicyAmount(quote.rawQuote.directionalOutput),
      minimumOutput: {
        raw: quotePolicy.minOutRaw,
        asset: quotePolicyAmount(quote.rawQuote.directionalOutput).asset
      },
      ...(materialStage.evidence.guardCommand !== undefined ? { enforcement: {
        protocolAbort: deepbookMinimumAbort(materialStage.evidence.guardCommand),
        method: "split_and_rejoin_swap_output" as const, commandFailure: "InsufficientCoinBalance" as const, commandIndex: materialStage.evidence.guardCommand,
        transactionDigest: digestStage.evidence.transactionDigest, recipient: input.account,
        coinType: quote.rawQuote.directionalOutput.coinType, raw: quotePolicy.minOutRaw
      } } : {}),
      inputFlow: quote.inputFlow,
      feeTargetRaw: quotePolicy.feeTargetRaw,
      separateFeeBudgetRaw: quotePolicy.feeMode === "deep" ? quotePolicy.feeBudgetRaw : null,
      derivedAt: clock()
    });
  } catch (error) {
    checks.push(
      failReviewCheck(
        "deepbook_quote_policy_material_binding_failed",
        "Quote policy material binding",
        error instanceof Error ? error.message : "DeepBook quote policy evidence did not match the stored transaction material.",
        "quote"
      )
    );
    return {
      result: blockedAdapterLifecycleReviewResult("amount_mismatch", checks, lifecycle.snapshot())
    };
  }

  const privateArtifacts: PrivateReviewArtifacts = {
    transactionMaterial: materialStage.evidence.handle,
    transactionMaterialDigest: digestStage.evidence,
    swapQuotePolicy
  };

  // Render the PTB visualization as soon as material and digest exist, so the
  // review page can draw the transaction even when a later stage stops the
  // review. The artifact is commitment-bound at production and carries no
  // digest or bytes.
  let ptbVisualization: PtbVisualizationArtifact | undefined;
  if (input.ptbVisualizationProducer) {
    const rendered = await input.ptbVisualizationProducer({
      transactionMaterial: materialStage.evidence.handle,
      transactionMaterialDigest: digestStage.evidence,
      adapterId: input.plan.adapterId,
      planId: input.plan.id,
      now: clock()
    });
    if (rendered.status === "rendered") {
      ptbVisualization = rendered.artifact;
      checks.push(ptbVisualizationRenderedCheck());
    } else {
      checks.push(ptbVisualizationUnavailableCheck(rendered.reason));
    }
  }
  const withPtb = (result: ReviewComputationResult): ReviewComputationResult =>
    ptbVisualization ? { ...result, ptbVisualization } : result;

  if (!input.transactionObjectOwnershipProducer) {
    return {
      result: withPtb(missingProducerStageBlockedResult(lifecycle.snapshot(), checks)),
      privateArtifacts
    };
  }

  const ownershipStage = await runDeepbookReviewStage({
    lifecycle,
    checks,
    stage: "object_ownership",
    run: () => input.transactionObjectOwnershipProducer!({
      materialHandle: materialStage.evidence.handle,
      materialDigest: digestStage.evidence,
      now: clock()
    })
  });
  if (!ownershipStage.ok) {
    return {
      result: withPtb(ownershipStage.result),
      ...(ownershipStage.result.status === "refresh_required" ? {} : { privateArtifacts })
    };
  }
  privateArtifacts.transactionObjectOwnership = ownershipStage.evidence;

  if (!input.humanReadableReviewProducer) {
    return {
      result: withPtb(missingProducerStageBlockedResult(lifecycle.snapshot(), checks)),
      privateArtifacts
    };
  }

  const humanReviewStage = await runDeepbookReviewStage({
    lifecycle,
    checks,
    stage: "human_readable_review",
    run: () => input.humanReadableReviewProducer!({
      plan: input.plan,
      account: input.account,
      requestedIntent,
      poolResolution,
      quotePolicy,
      transactionMaterial: materialStage.evidence.handle,
      transactionMaterialDigest: digestStage.evidence,
      swapQuotePolicy,
      transactionObjectOwnership: ownershipStage.evidence,
      now: clock()
    })
  });
  if (!humanReviewStage.ok) {
    return {
      result: withPtb(humanReviewStage.result),
      privateArtifacts
    };
  }
  privateArtifacts.humanReadableReview = humanReviewStage.evidence;

  if (!input.reviewTimeSimulationProducer) {
    return {
      result: withPtb(
        missingProducerStageBlockedResult(lifecycle.snapshot(), checks, {
          humanReadableReview: publicHumanReadableReviewFromEvidence(humanReviewStage.evidence)
        })
      ),
      privateArtifacts
    };
  }

  const simulationStage = await runDeepbookReviewStage({
    lifecycle,
    checks,
    stage: "review_time_simulation",
    run: () => input.reviewTimeSimulationProducer!({
      minimumOutputGuard: swapQuotePolicy.enforcement, clock,
      transactionMaterial: materialStage.evidence.handle,
      transactionMaterialDigest: digestStage.evidence,
      now: clock()
    })
  });
  if (!simulationStage.ok) {
    return {
      // Keep the public projection paired with the stored private evidence:
      // the human-readable review stays visible while simulation asks for a
      // refresh, and the store's projection binding stays satisfied.
      result: withPtb({
        ...simulationStage.result,
        humanReadableReview: publicHumanReadableReviewFromEvidence(humanReviewStage.evidence)
      }),
      privateArtifacts
    };
  }
  if (swapQuotePolicy.enforcement && !simulationWithinSwapLimits(simulationStage.evidence, swapQuotePolicy)) {
    checks.push(failReviewCheck("deepbook_simulation_limits", "Simulated swap amounts",
      "The account balance changes do not establish the reviewed spending limits and minimum receipt.", "simulation"));
    return { result: withPtb({ ...blockedAdapterLifecycleReviewResult("amount_mismatch", checks, lifecycle.snapshot()),
      humanReadableReview: publicHumanReadableReviewFromEvidence(humanReviewStage.evidence) }), privateArtifacts };
  }
  privateArtifacts.reviewTimeSimulation = simulationStage.evidence;

  if (!swapQuotePolicy.enforcement) {
    checks.push(failReviewCheck("swap_output_guard_missing", "Minimum receive enforcement",
      "The final transaction has no verified output guard.", "adapter"));
    return { result: withPtb({ ...blockedAdapterLifecycleReviewResult("amount_mismatch", checks, lifecycle.snapshot()),
      humanReadableReview: publicHumanReadableReviewFromEvidence(humanReviewStage.evidence),
      simulation: publicTransactionSimulationSummaryFromEvidence(simulationStage.evidence) }), privateArtifacts };
  }

  const assembly = assembleTransactionReviewData({
    adapterId: input.plan.adapterId,
    protocol: input.plan.protocol,
    actionKind: input.plan.actionKind,
    provenance: {
      kind: "mcp_action_request",
      sourceId: input.plan.id,
      capturedAt: input.plan.createdAt
    },
    quotePolicy: swapQuotePolicy,
    objectOwnership: ownershipStage.evidence,
    humanReadableReview: humanReviewStage.evidence,
    reviewTimeSimulation: simulationStage.evidence,
    reviewedTransactionDigest: digestStage.evidence.transactionDigest,
    now: clock()
  });

  if (assembly.status === "emitted") {
    checks.push(contractEmittedCheck());
    return {
      result: walletReviewContractEmittedResult(
        checks,
        lifecycle.snapshot(),
        publicHumanReadableReviewFromEvidence(humanReviewStage.evidence),
        publicTransactionSimulationSummaryFromEvidence(simulationStage.evidence),
        assembly.contract,
        ptbVisualization
      ),
      privateArtifacts
    };
  }

  checks.push(contractEmitDeclinedCheck(assembly.reason));

  return {
    result: walletReviewContractEmitMissingResult(
      checks,
      lifecycle.snapshot(),
      publicHumanReadableReviewFromEvidence(humanReviewStage.evidence),
      publicTransactionSimulationSummaryFromEvidence(simulationStage.evidence)
    ),
    privateArtifacts
  };
}

type DeepbookReviewLifecycleController = ReturnType<typeof newDeepbookSwapReviewLifecycle>;
type NonEmptyReviewChecks = [ReviewCheck, ...ReviewCheck[]];
type DeepbookReviewPublicEvidenceFields = {
  humanReadableReview?: HumanReadableReviewSummary;
  simulation?: SuccessfulTransactionSimulationSummary;
};
type DeepbookStageOutcome<TEvidence> =
  | { status: "completed"; evidence: TEvidence; checks: ReviewCheck[] }
  | { status: "blocked"; blockedReason: BlockedReason; checks: NonEmptyReviewChecks }
  | { status: "refresh_required"; refreshReason: RefreshReason; checks: NonEmptyReviewChecks };

type DeepbookStageRunResult<TEvidence> =
  | { ok: true; evidence: TEvidence }
  | { ok: false; result: ReviewComputationResult };

async function runDeepbookReviewStage<TEvidence>(input: {
  lifecycle: DeepbookReviewLifecycleController;
  checks: ReviewCheck[];
  stage: DeepbookSwapReviewLifecycleStage;
  run: () => DeepbookStageOutcome<TEvidence> | Promise<DeepbookStageOutcome<TEvidence>>;
}): Promise<DeepbookStageRunResult<TEvidence>> {
  const outcome = await input.run();
  input.checks.push(...outcome.checks);
  if (outcome.status === "completed") {
    input.lifecycle.complete(input.stage);
    return { ok: true, evidence: outcome.evidence };
  }

  const adapterLifecycle = input.lifecycle.snapshot();
  if (outcome.status === "blocked") {
    return {
      ok: false,
      result: blockedAdapterLifecycleReviewResult(outcome.blockedReason, input.checks, adapterLifecycle)
    };
  }

  return {
    ok: false,
    result: refreshRequiredAdapterLifecycleReviewResult(outcome.refreshReason, input.checks, adapterLifecycle)
  };
}

function normalizeIntentStage(plan: ActionPlan): DeepbookStageOutcome<DeepbookSwapRequestedIntent> {
  const parsedData = deepbookSwapActionPlanDataSchema.safeParse(plan.adapterData);
  if (!parsedData.success) {
    return {
      status: "blocked",
      blockedReason: "unsupported_action",
      checks: [
        failReviewCheck(
          "deepbook_requested_intent_invalid",
          "Requested DeepBook intent",
          "The action plan does not contain a valid DeepBook swap display intent.",
          "adapter"
        )
      ]
    };
  }

  const requestedIntent = parsedData.data.requestedIntent;
  return {
    status: "completed",
    evidence: requestedIntent,
    checks: [
      passReviewCheck(
        "deepbook_display_intent",
        "Display intent",
        `Requested display intent is ${requestedIntent.from.amountDisplay} ${requestedIntent.from.symbol} to ${requestedIntent.to.symbol} with max slippage ${requestedIntent.maxSlippageBps} bps. This display amount is not signing input.`,
        "adapter"
      )
    ]
  };
}

type DeepbookPoolResolution = ReturnType<typeof resolveDeepbookPoolForSymbols>;

function resolvePoolStage(
  requestedIntent: DeepbookSwapRequestedIntent
): DeepbookStageOutcome<DeepbookPoolResolution> {
  try {
    const poolResolution = resolveDeepbookPoolForSymbols({
      sourceSymbol: requestedIntent.from.symbol,
      targetSymbol: requestedIntent.to.symbol
    });
    return {
      status: "completed",
      evidence: poolResolution,
      checks: [
        passReviewCheck(
          "deepbook_pool_resolution",
          "DeepBook pool",
          `Resolved direct DeepBook pool ${poolResolution.poolKey} for ${poolResolution.sourceSymbol} to ${poolResolution.targetSymbol}; direction is ${poolResolution.direction}.`,
          "registry"
        )
      ]
    };
  } catch (error) {
    return {
      status: "blocked",
      blockedReason: "asset_mismatch",
      checks: [
        failReviewCheck(
          "deepbook_pool_resolution_failed",
          "DeepBook pool",
          error instanceof Error ? error.message : "DeepBook pool resolution failed.",
          "registry"
        )
      ]
    };
  }
}

export type DeepbookQuoteStageEvidence = {
  quote: DeepbookDisplayQuoteSummary;
  feeMode: "deep" | "input_coin";
  feeBudgetRaw: string;
  feeTargetRaw?: string | undefined;
};

async function quoteEvidenceStage(
  input: DeepbookSwapReviewEvidenceInput,
  requestedIntent: DeepbookSwapRequestedIntent,
  poolResolution: DeepbookPoolResolution
): Promise<DeepbookStageOutcome<DeepbookQuoteStageEvidence>> {
  try {
    const assets = deepbookQuoteAssets(poolResolution.poolKey);
    const sellBase = poolResolution.direction === "base_to_quote";
    const sourceAsset = sellBase ? assets.base : assets.quote;
    const principal = parseQuoteDisplayAmount(requestedIntent.from.amountDisplay, sourceAsset.decimals);
    const fetchQuote = async (feeMode: "deep" | "input_coin") => {
      const quote = await input.quoteSource.quoteDeepbookDisplayAmount({
        poolKey: poolResolution.poolKey, direction: poolResolution.direction,
        amountDisplay: requestedIntent.from.amountDisplay, simulationSender: input.account, feeMode
      });
      const raw = quote.rawQuote;
      const getter = deepbookQuoteGetters[poolResolution.direction][feeMode];
      const output = sellBase ? raw.quoteOut : raw.baseOut;
      const matchesAmount = (amount: typeof output, asset: typeof sourceAsset, expectedRaw: string) =>
        isDeepStrictEqual(amount, { ...asset, raw: expectedRaw });
      if (quote.pool.poolKey !== poolResolution.poolKey || quote.direction !== poolResolution.direction ||
          raw.sourceMoveFunction !== getter.move || quote.source.method !== getter.method ||
          raw.returnValueSourceMoveFunction !== (feeMode === "deep" ? "pool::get_quantity_out" : "pool::get_quantity_out_input_fee") ||
          !matchesAmount(raw.inputAmount, sourceAsset, principal) ||
          !matchesAmount(raw.baseOut, assets.base, raw.baseOut.raw) || !matchesAmount(raw.quoteOut, assets.quote, raw.quoteOut.raw) ||
          !matchesAmount(raw.deepRequired, assets.deep, raw.deepRequired.raw) || !isDeepStrictEqual(raw.directionalOutput, output) ||
          !isDeepStrictEqual(quote.inputFlow, deepbookQuoteInputFlow(raw))) {
        throw new ReadServiceInputError("input_invalid", "The quote amounts, assets or fee source do not match the requested swap.", { poolKey: poolResolution.poolKey, feeMode });
      }
      return quote;
    };

    const outputIsDeep = (sellBase ? assets.quote : assets.base).coinType === assets.deep.coinType;
    let feeMode: "deep" | "input_coin" = outputIsDeep ? "input_coin" : "deep";
    let quote = await fetchQuote(feeMode);
    const feePolicyFor = async (snapshot: DeepbookDisplayQuoteSummary) => {
      const observed = snapshot.rawQuote.poolTerms?.gasFeePolicy;
      if (observed?.status === "unavailable") return undefined;
      if (observed) return { enabled: observed.status === "enabled", additionalTakerFeeRaw: observed.additionalTakerFeeRaw };
      return input.gasFeePolicySource?.(poolResolution.poolKey);
    };
    let gasPolicy = await feePolicyFor(quote);
    const required = BigInt(quote.rawQuote.deepRequired.raw);
    let feeModeMessage = outputIsDeep ? "The input-fee quote keeps the DEEP output separate from fee refunds." : "The quoted fee is denominated in DEEP.";
    let available: bigint | undefined;
    if (!gasPolicy || !quote.rawQuote.poolTerms) throw new ReadServiceInputError("quote_unavailable", "The pool fee policy could not be verified.", {});
    if (required > 0n) {
      if (!input.deepBalanceSource) throw new ReadServiceInputError("quote_unavailable", "Available DEEP could not be verified.", {});
      const balance = parseRawU64(await input.deepBalanceSource(input.account), "account DEEP balance");
      const reserved = sourceAsset.coinType === assets.deep.coinType ? BigInt(principal) : 0n;
      available = balance > reserved ? balance - reserved : 0n;
      feeModeMessage = `After reserving the input principal, ${available} raw DEEP is available for the quoted ${required} raw DEEP fee.`;
    }
    // A zero DEEP coin selects the input-fee branch of the actual swap.
    // The pool withdraws base/quote before DEEP. An unused fee can otherwise
    // be mixed into a DEEP output, so the output floor would count a refund.
    if (BigInt(quote.rawQuote.directionalOutput.raw) === 0n) {
      const terms = quote.rawQuote.poolTerms;
      const lower = deepbookMinimumInputRaw(quote.rawQuote);
      const fmt = (raw: bigint, asset: typeof sourceAsset) =>
        `${formatRawAmount(raw.toString(), asset.decimals)} ${asset.symbol} (${raw} raw, ${asset.coinType})`;
      const minimumBase = fmt(deepbookMinimumBaseRaw(terms), assets.base);
      const message = `Minimum base order: ${minimumBase}. Base lot: ${fmt(BigInt(terms.lotSizeRaw), assets.base)}.`;
      if (sellBase && BigInt(principal) < deepbookMinimumBaseRaw(terms)) {
        const withInputFee = deepbookMinimumInputRaw({ ...quote.rawQuote, sourceMoveFunction: "pool::get_quote_quantity_out_input_fee" })!;
        return { status: "blocked", blockedReason: "below_minimum_order", checks: [
          failReviewCheck("deepbook_below_minimum_order", "Order below minimum",
            `${message} Minimum input with DEEP fees: ${fmt(deepbookMinimumBaseRaw(terms), sourceAsset)}. With input fees: ${fmt(withInputFee, sourceAsset)}. Request a new amount.`, "quote")
        ] };
      }
      if (!sellBase && lower !== undefined && BigInt(principal) < lower) {
        let guidance = `${feeMode === "deep" ? "DEEP fees" : "Input fees"}: ${fmt(lower, sourceAsset)} at ${quote.fetchedAt}.`;
        if (feeMode === "deep") {
          const other = await fetchQuote("input_coin");
          const amount = deepbookMinimumInputRaw(other.rawQuote);
          guidance += amount === undefined ? " The input-fee minimum could not be verified." :
            ` Input fees: ${fmt(amount, sourceAsset)} at ${other.fetchedAt}.`;
        }
        return { status: "refresh_required", refreshReason: "quote_unavailable", checks: [
          failReviewCheck("deepbook_market_minimum", "Amount below the current market minimum", `${message} ${guidance} Refresh as prices change or request a different amount.`, "quote")
        ] };
      }
    }
    if (feeMode === "deep" && (required === 0n || (available !== undefined && available < required))) {
      feeMode = "input_coin";
      quote = await fetchQuote(feeMode);
      if (quote.rawQuote.poolTerms?.gasFeePolicy) gasPolicy = await feePolicyFor(quote);
      if (!gasPolicy) throw new ReadServiceInputError("quote_unavailable", "The selected quote has no verified pool fee policy. Refresh the quote.", {});
      const reason = required === 0n ? "The DEEP quote requires zero DEEP."
        : `Available DEEP after reserving principal (${available} raw) is below the quoted fee (${required} raw).`;
      feeModeMessage = `${reason} The input-fee quote includes trading fees in expected input spend and does not itemize them.`;
    }
    if (quote.inputFlow.fee.kind === "base_fee_waived") feeModeMessage = "The pool is whitelisted and its quoted base taker fee is zero.";
    feeModeMessage += gasPolicy.enabled
      ? ` The quoted base taker rate is ${quote.rawQuote.poolTerms!.takerFeeRaw} per billion. A gas-price trigger can add ${gasPolicy.additionalTakerFeeRaw} per billion to the taker rate at execution.`
      : " The pool gas-price fee surcharge was disabled when checked.";
    const minimumInput = deepbookMinimumInputRaw(quote.rawQuote);
    if (!sellBase && minimumInput !== undefined && BigInt(principal) < minimumInput) {
      return { status: "refresh_required", refreshReason: "quote_unavailable", checks: [
        failReviewCheck("deepbook_market_minimum", "Amount below the current market minimum",
          `At ${quote.fetchedAt}, this fee mode needs ${formatRawAmount(minimumInput.toString(), sourceAsset.decimals)} ${sourceAsset.symbol} (${minimumInput} raw, ${sourceAsset.coinType}). Refresh as prices change or request a different amount.`, "quote")
      ] };
    }
    if (minimumInput !== undefined && BigInt(principal) < minimumInput) {
      if (BigInt(principal) >= deepbookMinimumBaseRaw(quote.rawQuote.poolTerms!)) {
        return { status: "refresh_required", refreshReason: "quote_unavailable", checks: [
          failReviewCheck("deepbook_market_minimum", "Amount below the current fee-mode minimum",
            `At ${quote.fetchedAt}, this fee mode needs at least ${formatRawAmount(minimumInput.toString(), sourceAsset.decimals)} ${sourceAsset.symbol} (${minimumInput} raw). Refresh after the fee conditions or available balance change, or request a different amount.`, "quote")
        ] };
      }
      return { status: "blocked", blockedReason: "below_minimum_order", checks: [
        failReviewCheck("deepbook_below_minimum_order", "Order below minimum",
          `At ${quote.fetchedAt}, this fee mode needs at least ${formatRawAmount(minimumInput.toString(), sourceAsset.decimals)} ${sourceAsset.symbol} (${minimumInput} raw, ${sourceAsset.coinType}). Request a new amount in chat.`, "quote")
      ] };
    }
    let feeBudgetRaw = "0";
    let feeTargetRaw: string | undefined;
    if (required > 0n && feeMode === "deep") {
      if (available === undefined) throw new Error("Missing DEEP allocation balance.");
      const budget = deepbookFeeBudget(quote.rawQuote, available);
      feeBudgetRaw = budget.raw;
      feeTargetRaw = budget.targetRaw;
      feeModeMessage += ` Fee allocation: ${budget.raw} raw DEEP. Calculation: ${budget.basis}, limited by available funds. Larger fills or a changed rate or conversion price can exhaust this budget.`;
    }
    if (quote.quoteOutcome === "empty_opposite_book" || quote.quoteOutcome === "insufficient_depth_for_minimum") {
      const reason = quote.quoteOutcome === "empty_opposite_book" ? "The opposite order book has no live orders." :
        "The available depth cannot fill the minimum base order.";
      return { status: "refresh_required", refreshReason: "quote_unavailable", checks: [
        failReviewCheck("deepbook_quote_depth", "Order book", reason + " Refresh when market conditions change.", "quote")
      ] };
    }
    if (quote.quoteOutcome === "no_output") {
      const terms = quote.rawQuote.poolTerms!;
      return { status: "refresh_required", refreshReason: "quote_unavailable", checks: [
        failReviewCheck("deepbook_quote_no_output", "No executable output",
          `The quote returned no output. Minimum base order ${formatRawAmount(terms.minBaseRaw, assets.base.decimals)} ${assets.base.symbol} (${terms.minBaseRaw} raw), lot ${terms.lotSizeRaw} raw, ${assets.base.coinType}. An exact input threshold could not be verified in this market state. Refresh the quote.`, "quote")
      ] };
    }
    return {
      status: "completed",
      evidence: { quote, feeMode, feeBudgetRaw, feeTargetRaw },
      checks: [
        passReviewCheck(
          "deepbook_raw_quote_evidence",
          "Quote amounts (raw units)",
          `DeepBook quote retrieved at ${quote.fetchedAt} from ${quote.rawQuote.sourceMoveFunction}: expected receive amount before slippage ${quote.rawQuote.directionalOutput.raw} ${quote.rawQuote.directionalOutput.symbol} raw units; expected input spend ${quote.inputFlow.expectedSpendRaw} and return ${quote.inputFlow.expectedReturnRaw} raw ${quote.rawQuote.inputAmount.symbol}.`,
          "quote"
        ),
        passReviewCheck("deepbook_fee_mode", "Trading fee token", feeModeMessage, "quote")
      ]
    };
  } catch (error) {
    return quoteSourceFailureOutcome(error);
  }
}

function quotePolicyStage(
  requestedIntent: DeepbookSwapRequestedIntent,
  quote: DeepbookDisplayQuoteSummary,
  feeMode: "deep" | "input_coin",
  now: Date
): DeepbookStageOutcome<DeepbookSwapQuotePolicyOk> {
  let policy;
  try {
    policy = deriveDeepbookSwapQuotePolicy({
      rawQuote: quote.rawQuote,
      fetchedAt: quote.fetchedAt,
      maxSlippageBps: requestedIntent.maxSlippageBps,
      feeMode,
      now
    });
  } catch (error) {
    return {
      status: "blocked",
      blockedReason: "amount_mismatch",
      checks: [
        failReviewCheck(
          "deepbook_quote_policy_invalid",
          "Quote and slippage rules",
          error instanceof Error ? error.message : "DeepBook quote policy could not be derived.",
          "quote"
        )
      ]
    };
  }

  if (policy.status === "refresh_required") {
    return {
      status: "refresh_required",
      refreshReason: policy.refreshReason,
      checks: [
        failReviewCheck(
          "deepbook_quote_policy_refresh_required",
          "Quote and slippage rules",
          `The quote needs updating. Reported reason: “${policy.reason}”. Quote age: ${policy.quoteAgeMs} ms; validity limit: ${policy.staleAfterMs} ms.`,
          "quote"
        )
      ]
    };
  }

  return {
    status: "completed",
    evidence: policy,
    checks: [
      passReviewCheck(
        "deepbook_quote_policy",
        "Quote and slippage rules",
        `Quote fee option: ${policy.feeMode}. Amounts from the quote and slippage rules (raw units): send ${policy.sourceAmountRaw}, expected receive ${policy.expectedOutRaw}, review minimum receive ${policy.minOutRaw}, ${feeMode === "deep" ? `quoted DEEP fee ${policy.quotedDeepRequiredRaw}` : "fee included in input spend"}; quote age: ${policy.quoteAgeMs} ms. These amounts are for review, not signing input or permission to sign.`,
        "quote"
      )
    ]
  };
}

function quotePolicyAmount(
  amount: DeepbookDisplayQuoteSummary["rawQuote"]["inputAmount"]
): {
  raw: string;
  asset: {
    symbol: string;
    coinType: string;
    decimals: number;
    unitSource: typeof DEEPBOOK_SCALAR_UNIT_SOURCE;
  };
} {
  return {
    raw: amount.raw,
    asset: {
      symbol: amount.symbol,
      coinType: amount.coinType,
      decimals: amount.decimals,
      unitSource: amount.unitSource
    }
  };
}

function quoteSourceFailureCheck(error: unknown): ReviewCheck {
  if (error instanceof ReadServiceInputError) {
    return failReviewCheck("deepbook_quote_source_failed", "Quote source", error.message, "quote");
  }
  return failReviewCheck(
    "deepbook_quote_source_failed",
    "Quote source",
    error instanceof Error ? error.message : "DeepBook quote source failed.",
    "quote"
  );
}

function quoteSourceFailureOutcome(error: unknown): DeepbookStageOutcome<never> {
  const checks: NonEmptyReviewChecks = [quoteSourceFailureCheck(error)];
  if (error instanceof ReadServiceInputError) {
    if (error.kind === "input_invalid") {
      return { status: "blocked", blockedReason: "amount_mismatch", checks };
    }
    if (error.kind === "registry_miss") {
      return { status: "blocked", blockedReason: "asset_mismatch", checks };
    }
    if (error.kind === "quote_unavailable") {
      return { status: "refresh_required", refreshReason: "quote_unavailable", checks };
    }
  }
  return { status: "blocked", blockedReason: "object_resolution_failed", checks };
}

function missingProducerStageCheck(adapterLifecycle: DeepbookSwapReviewLifecycle): ReviewCheck {
  const nextMissing = adapterLifecycle.missingStages[0];
  if (nextMissing === undefined) {
    return contractEmitMissingCheck();
  }
  const nextMissingLabel = nextMissing ? deepbookSwapReviewLifecycleStageLabel(nextMissing) : undefined;
  return {
    id: `deepbook_${nextMissing}_missing`,
    label: nextMissingLabel ?? "Review check",
    status: "fail",
    message: `This account review has not completed the required check: ${nextMissingLabel}. Wallet approval and transaction submission are unavailable.`,
    source: "adapter"
  };
}

function missingProducerStageBlockedResult(
  adapterLifecycle: DeepbookSwapReviewLifecycle,
  checks: ReviewCheck[],
  fields: DeepbookReviewPublicEvidenceFields = {}
): ReviewComputationResult {
  const nextMissing = adapterLifecycle.missingStages[0];
  if (nextMissing === undefined) {
    if (!fields.humanReadableReview || !fields.simulation) {
      throw new Error(
        "wallet_review_contract_emit_missing requires human-readable review and simulation public evidence"
      );
    }
    return walletReviewContractEmitMissingResult(
      [...checks, contractEmitMissingCheck()],
      adapterLifecycle,
      fields.humanReadableReview,
      fields.simulation
    );
  }
  return producerStageMissingReviewResult(
    [...checks, missingProducerStageCheck(adapterLifecycle)],
    adapterLifecycle,
    fields.humanReadableReview ? { humanReadableReview: fields.humanReadableReview } : {}
  );
}

function ptbVisualizationRenderedCheck(): ReviewCheck {
  return {
    id: "deepbook_ptb_visualization",
    label: "PTB visualization",
    status: "pass",
    message: "The transaction diagram (PTB) was created from the transaction prepared for this review. It is for inspection, not wallet approval, signing input or proof that execution will succeed.",
    source: "adapter"
  };
}

function ptbVisualizationUnavailableCheck(reason: string): ReviewCheck {
  return {
    id: "deepbook_ptb_visualization_unavailable",
    label: "PTB visualization",
    status: "warning",
    message: `The transaction diagram (PTB) is unavailable. Reported reason: “${reason}”. The other verified review details are still available; this diagram is optional.`,
    source: "adapter"
  };
}

function contractEmittedCheck(): ReviewCheck {
  return {
    id: "deepbook_wallet_review_contract_emitted",
    label: "Transaction approval details",
    status: "pass",
    message: "The approval details for this exact transaction were prepared from the verified review and checked for the required format. Only your request in a Review card that allows actions can start wallet approval. Submission also requires approval in your wallet; an ordinary AI tool response cannot authorize it.",
    source: "adapter"
  };
}

function contractEmitDeclinedCheck(reason: string): ReviewCheck {
  return {
    id: "deepbook_wallet_review_contract_emit_missing",
    label: "Transaction approval details",
    status: "fail",
    message: `The approval details could not be prepared from this review. Reported reason: “${reason}”. Wallet approval is unavailable.`,
    source: "adapter"
  };
}

function contractEmitMissingCheck(): ReviewCheck {
  return {
    id: "deepbook_wallet_review_contract_emit_missing",
    label: "Transaction approval details",
    status: "fail",
    message: "Simulation completed, but the required transaction approval details could not be prepared. Wallet approval is unavailable for this review.",
    source: "adapter"
  };
}
