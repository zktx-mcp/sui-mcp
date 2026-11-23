import { verifyDeepbookMinimum } from "./deepbook/deepbookSwapCommands.js";
import type { VerifySwapMinimum } from "../core/action/swapQuotePolicyEvidence.js";
import {
  computeDeepbookSwapReviewEvidence,
  type DeepbookPtbVisualizationProducer,
  type DeepbookSwapReviewQuoteSource
} from "./deepbook/deepbookReviewEvidence.js";
import {
  DEEPBOOK_SWAP_ACTION_KIND,
  DEEPBOOK_SWAP_ADAPTER_ID,
  DEEPBOOK_SWAP_PROTOCOL,
  isDeepbookSwapActionPlanIdentity
} from "./deepbook/deepbookSwapIntent.js";
import { DEEPBOOK_SWAP_REVIEW_LIFECYCLE_STAGE_CATALOG_ID } from "./deepbook/deepbookReviewLifecycle.js";
import type {
  DeepbookSwapTransactionMaterialDigestProducer,
  DeepbookSwapTransactionMaterialProducer
} from "./deepbook/deepbookTransactionMaterialProducer.js";
import type {
  DeepbookSwapHumanReadableReviewProducer
} from "./deepbook/deepbookHumanReviewProducer.js";
import type { ReviewTimeSimulationProducer } from "../core/action/reviewTimeSimulationEvidence.js";
import type { TransactionObjectOwnershipProducer } from "../core/action/transactionObjectOwnershipProducer.js";
import {
  unsupportedDeepbookSwapPlanIdentityCheck
} from "../core/review/reviewChecks.js";
import { blockedReviewResult } from "../core/review/reviewComputationResult.js";
import type {
  ReviewAdapterEvidenceComputer,
  ReviewAdapterMap
} from "../core/review/reviewComputation.js";

export type DeepbookReviewAdapterWiring = {
  deepbookQuoteSource: DeepbookSwapReviewQuoteSource;
  gasFeePolicySource?: import("./deepbook/deepbookReviewEvidence.js").DeepbookSwapReviewEvidenceInput["gasFeePolicySource"];
  deepbookDeepBalanceSource?: ((account: string) => Promise<string>) | undefined;
  deepbookTransactionMaterialProducer?: DeepbookSwapTransactionMaterialProducer | undefined;
  deepbookTransactionMaterialDigestProducer?: DeepbookSwapTransactionMaterialDigestProducer | undefined;
  transactionObjectOwnershipProducer?: TransactionObjectOwnershipProducer | undefined;
  deepbookHumanReadableReviewProducer?: DeepbookSwapHumanReadableReviewProducer | undefined;
  reviewTimeSimulationProducer?: ReviewTimeSimulationProducer | undefined;
  ptbVisualizationProducer?: DeepbookPtbVisualizationProducer | undefined;
};

/**
 * Named wiring for installed adapters. The platform dispatches only registered
 * descriptors and reports unsupported_action for other plans.
 */
export type SupportedReviewAdapterWiring = {
  deepbook: DeepbookReviewAdapterWiring;
};

/**
 * One registered review adapter. The platform owns the safety gates (typed
 * evidence claims, commitment equality, digest-gated handoff); a descriptor
 * supplies only protocol-specific plan creation and evidence computation.
 */
const deepbookIdentity = {
  adapterId: DEEPBOOK_SWAP_ADAPTER_ID, protocol: DEEPBOOK_SWAP_PROTOCOL,
  actionKind: DEEPBOOK_SWAP_ACTION_KIND, stageCatalogId: DEEPBOOK_SWAP_REVIEW_LIFECYCLE_STAGE_CATALOG_ID,
  verifyMinimum: verifyDeepbookMinimum
};

const installedSwapIdentities = [deepbookIdentity] as const;

export const verifyInstalledMinimum: VerifySwapMinimum = (data, quote) => {
  const adapter = installedSwapIdentities.find(item => item.adapterId === quote.adapterId && item.protocol === quote.protocol && item.actionKind === quote.actionKind);
  if (!adapter) throw Error("No registered verifier for this transaction minimum");
  adapter.verifyMinimum(data, quote);
};

export type ReviewAdapterDescriptor = {
  verifyMinimum: VerifySwapMinimum;
  adapterId: string;
  protocol: string;
  actionKind: string;
  stageCatalogId: string;
  computeReview: ReviewAdapterEvidenceComputer;
};

export function buildSupportedReviewAdapterDescriptors(
  wiring: SupportedReviewAdapterWiring
): ReviewAdapterDescriptor[] {
  const descriptors: ReviewAdapterDescriptor[] = [
    {
      ...deepbookIdentity,
      computeReview: deepbookSwapEvidenceComputer(wiring.deepbook)
    }
  ];
  return descriptors;
}

function deepbookSwapEvidenceComputer(wiring: DeepbookReviewAdapterWiring): ReviewAdapterEvidenceComputer {
  return async (input) => {
    if (!isDeepbookSwapActionPlanIdentity(input.plan)) {
      return {
        result: blockedReviewResult("unsupported_action", [unsupportedDeepbookSwapPlanIdentityCheck()])
      };
    }
    return computeDeepbookSwapReviewEvidence({
      preparationId: input.preparationId,
      reviewSessionId: input.reviewSessionId,
      plan: input.plan,
      account: input.account,
      now: input.now,
      clock: input.clock,
      quoteSource: wiring.deepbookQuoteSource,
      deepBalanceSource: wiring.deepbookDeepBalanceSource,
      gasFeePolicySource: wiring.gasFeePolicySource,
      transactionMaterialProducer: wiring.deepbookTransactionMaterialProducer,
      transactionMaterialDigestProducer: wiring.deepbookTransactionMaterialDigestProducer,
      transactionObjectOwnershipProducer: wiring.transactionObjectOwnershipProducer,
      humanReadableReviewProducer: wiring.deepbookHumanReadableReviewProducer,
      reviewTimeSimulationProducer: wiring.reviewTimeSimulationProducer,
      ptbVisualizationProducer: wiring.ptbVisualizationProducer
    });
  };
}

export function buildSupportedReviewAdapters(wiring: SupportedReviewAdapterWiring): ReviewAdapterMap {
  const adapters: Record<string, ReviewAdapterEvidenceComputer> = {};
  for (const descriptor of buildSupportedReviewAdapterDescriptors(wiring)) {
    adapters[descriptor.adapterId] = descriptor.computeReview;
  }
  return adapters;
}
