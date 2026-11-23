import { rejectAdapterLifecycle, type AdapterLifecycleValidator } from "../action/adapterLifecycleValidation.js";
import type { ActionPlan, ReviewState } from "../action/types.js";
import type { PrivateReviewArtifacts } from "../session/privateReviewArtifacts.js";
import { adapterNotImplementedCheck, externalProposalReviewOnlyCheck } from "./reviewChecks.js";
import {
  blockedReviewResult,
  mapReviewComputationResultToState,
  type ReviewComputationResult
} from "./reviewComputationResult.js";

export type ReviewComputationInput = {
  preparationId?: string;
  reviewSessionId: string;
  plan: ActionPlan;
  account: string;
  now?: Date;
  clock?: () => Date;
};

export type ReviewComputationOutput = {
  result: ReviewComputationResult;
  privateArtifacts?: PrivateReviewArtifacts;
};

export type ReviewAdapterEvidenceComputer = (
  input: ReviewComputationInput
) => ReviewComputationOutput | Promise<ReviewComputationOutput>;

export type ReviewAdapterMap = Readonly<Record<string, ReviewAdapterEvidenceComputer | undefined>>;

export type ReviewComputationDeps = {
  adapters?: ReviewAdapterMap | undefined;
  validateAdapterLifecycle?: AdapterLifecycleValidator | undefined;
};

export type ComputedReviewState = {
  state: ReviewState;
  privateArtifacts?: PrivateReviewArtifacts;
};

export async function computeReviewState(
  input: ReviewComputationInput,
  deps: ReviewComputationDeps = {}
): Promise<ReviewState> {
  const computed = await computeReviewStateWithPrivateArtifacts(input, deps);
  return computed.state;
}

export async function computeReviewStateWithPrivateArtifacts(
  input: ReviewComputationInput,
  deps: ReviewComputationDeps = {}
): Promise<ComputedReviewState> {
  const computed = await computeReviewOutput(input, deps);
  const state = mapReviewComputationResultToState(
    {
      reviewSessionId: input.reviewSessionId,
      planId: input.plan.id,
      account: input.account,
      now: input.clock?.() ?? input.now
    },
    computed.result,
    deps.validateAdapterLifecycle ?? rejectAdapterLifecycle
  );
  return {
    state,
    ...(computed.privateArtifacts ? { privateArtifacts: computed.privateArtifacts } : {})
  };
}

export async function computeReviewResult(
  input: ReviewComputationInput,
  deps: ReviewComputationDeps = {}
): Promise<ReviewComputationResult> {
  return (await computeReviewOutput(input, deps)).result;
}

async function computeReviewOutput(
  input: ReviewComputationInput,
  deps: ReviewComputationDeps = {}
): Promise<ReviewComputationOutput> {
  if (input.plan.adapterId === "external-proposal-review") {
    return {
      result: blockedReviewResult(
        "proposal_review_only",
        input.plan.reviewModel?.blockingChecks ?? [externalProposalReviewOnlyCheck()]
      )
    };
  }

  const computeAdapterEvidence = deps.adapters?.[input.plan.adapterId];
  if (computeAdapterEvidence) {
    return computeAdapterEvidence(input);
  }

  return {
    result: blockedReviewResult("adapter_not_implemented", [adapterNotImplementedCheck()])
  };
}

export { adapterNotImplementedCheck, externalProposalReviewOnlyCheck };
