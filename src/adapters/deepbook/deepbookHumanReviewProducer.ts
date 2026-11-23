import { transactionFundingSummary } from "../../core/action/transactionFunding.js";
import type {
  DeepbookSwapActionPlanIdentity,
  DeepbookSwapRequestedIntent
} from "./deepbookSwapIntent.js";
import type { DeepbookSwapQuotePolicyOk } from "./deepbookQuotePolicy.js";
import type { DeepbookSwapPoolResolution } from "./deepbookTransactionMaterialProducer.js";
import type {
  HumanReadableReviewEvidence
} from "../../core/action/humanReadableReviewEvidence.js";
import {
  createSwapHumanReadableReviewEvidence
} from "../../core/action/swapHumanReadableReviewProjection.js";
import type {
  BlockedReason,
  HumanReadableReviewSummary,
  ReviewCheck,
  SwapHumanReadableReviewAmount
} from "../../core/action/types.js";
import type { SwapQuotePolicyEvidence } from "../../core/action/swapQuotePolicyEvidence.js";
import type { TransactionObjectOwnershipEvidence } from "../../core/action/transactionObjectOwnershipEvidence.js";
import type {
  LocalTransactionMaterialDigestCommitment,
  LocalTransactionMaterialHandle
} from "../../core/session/transactionMaterialStore.js";
import {
  failReviewCheck,
  passReviewCheck
} from "../../core/review/reviewComputationResult.js";

export type DeepbookSwapHumanReadableReviewProducerInput = {
  plan: DeepbookSwapActionPlanIdentity;
  account: string;
  requestedIntent: DeepbookSwapRequestedIntent;
  poolResolution: DeepbookSwapPoolResolution;
  quotePolicy: DeepbookSwapQuotePolicyOk;
  transactionMaterial: LocalTransactionMaterialHandle;
  transactionMaterialDigest: LocalTransactionMaterialDigestCommitment;
  swapQuotePolicy: SwapQuotePolicyEvidence;
  transactionObjectOwnership: TransactionObjectOwnershipEvidence;
  now: Date;
};

export type DeepbookSwapHumanReadableReviewProducerOutcome =
  | {
      status: "completed";
      evidence: HumanReadableReviewEvidence;
      checks: ReviewCheck[];
    }
  | {
      status: "blocked";
      blockedReason: BlockedReason;
      checks: [ReviewCheck, ...ReviewCheck[]];
    };

export type DeepbookSwapHumanReadableReviewProducer = (
  input: DeepbookSwapHumanReadableReviewProducerInput
) => DeepbookSwapHumanReadableReviewProducerOutcome | Promise<DeepbookSwapHumanReadableReviewProducerOutcome>;

export function createDeepbookSwapHumanReadableReviewProducer(): DeepbookSwapHumanReadableReviewProducer {
  return (input) => {
    try {
      assertDeepbookHumanReviewSources(input);
      const review = buildDeepbookHumanReadableReview(input);
      const evidence = createSwapHumanReadableReviewEvidence({
        transactionMaterial: input.transactionMaterial,
        transactionMaterialDigest: input.transactionMaterialDigest,
        swapQuotePolicy: input.swapQuotePolicy,
        transactionObjectOwnership: input.transactionObjectOwnership,
        adapterId: input.plan.adapterId,
        protocol: input.plan.protocol,
        actionKind: input.plan.actionKind,
        review,
        derivedAt: input.now
      });
      return {
        status: "completed",
        evidence,
        checks: [
          passReviewCheck(
            "deepbook_human_readable_review_evidence",
            "Readable transaction details",
            "Prepared the amounts and transaction details for this account from the verified quote, transaction and object owners. These details do not authorize wallet approval or guarantee execution.",
            "adapter"
          )
        ]
      };
    } catch (error) {
      return {
        status: "blocked",
        blockedReason: classifyHumanReviewFailure(error),
        checks: [
          failReviewCheck(
            "deepbook_human_readable_review_failed",
            "Readable transaction details",
            error instanceof Error ? error.message : "The transaction details could not be prepared for this account.",
            "adapter"
          )
        ]
      };
    }
  };
}

function buildDeepbookHumanReadableReview(
  input: DeepbookSwapHumanReadableReviewProducerInput
): HumanReadableReviewSummary {
  const sourceAmount = amountFromQuotePolicy("input", input.swapQuotePolicy.sourceAmount, {
    displayAmount: input.requestedIntent.from.amountDisplay,
    displayAmountSource: "user_display_intent_not_signing_input"
  });
  const expectedOutput = amountFromQuotePolicy("expected_output", input.swapQuotePolicy.expectedOutput);
  const minimumOutput = amountFromQuotePolicy("minimum_output", input.swapQuotePolicy.minimumOutput);
  const { inputFlow } = input.swapQuotePolicy;
  return {
    kind: "swap_human_readable_review",
    proposedAction: {
      title: input.plan.title,
      summary: input.plan.summary,
      actionKind: input.plan.actionKind,
      adapterId: input.plan.adapterId,
      protocol: input.plan.protocol,
      network: "sui:mainnet"
    },
    assetFlow: {
      outgoing: [sourceAmount],
      expectedIncoming: [expectedOutput],
      minimumIncoming: [minimumOutput],
      inputFlow,
      ...(input.swapQuotePolicy.feeTargetRaw === undefined ? {} : { feeTargetRaw: input.swapQuotePolicy.feeTargetRaw }),
      separateFeeBudgetRaw: input.swapQuotePolicy.separateFeeBudgetRaw,
      fees: inputFlow.fee.kind === "separate_coin" ? [amountFromQuotePolicy("fee", inputFlow.fee.amount)] : []
    },
    recipients: [
      { role: "connected_account", address: input.account },
      { role: "output_recipient", address: input.account }
    ],
    targets: [
      {
        kind: "swap_output_asset",
        symbol: input.swapQuotePolicy.expectedOutput.asset.symbol,
        coinType: input.swapQuotePolicy.expectedOutput.asset.coinType,
        protocol: input.plan.protocol,
        poolKey: input.swapQuotePolicy.quoteSource.poolKey,
        direction: input.swapQuotePolicy.quoteSource.direction
      }
    ],
    evidenceUsed: [
      { id: "transaction_funding", label: "Transaction funding", source: "transaction_material",
        summary: transactionFundingSummary(input.transactionObjectOwnership.funding) },
      {
        id: "deepbook_quote_policy",
        label: "Quote and slippage rules",
        source: "quote",
        summary: "The quote and its rules supply the send amount, expected and minimum receive amounts, trading fee, and slippage limit shown here. They do not choose a route or establish permission to sign."
      },
      {
        id: "transaction_material_digest",
        label: "Transaction identity (digest)",
        source: "digest_commitment",
        summary: "This review is tied to the exact unsigned transaction stored by Sui MCP through its verification digest. The private transaction bytes are not included in the card."
      },
      {
        id: "transaction_object_ownership",
        label: "Object ownership",
        source: "wallet",
        summary: "The transaction objects and their owners were checked using the stored transaction and Sui mainnet data."
      }
    ],
    missingEvidence: [
      {
        id: "review_time_simulation",
        label: "Review-time simulation",
        reason: "At this step, the stored transaction has not yet been simulated to check its effects, balance changes, object types, and transaction details."
      }
    ],
    requiredUserChoices: [
      {
        id: "wallet_authorization_later",
        label: "Wallet approval required",
        reason: "The backend requests a signature only after your explicit Review card action; nothing is signed without your approval in the wallet."
      }
    ],
    unsupportedClaims: [
      {
        id: "no_signing_readiness",
        label: "Wallet approval not established",
        reason: "These review details alone do not establish permission to request a wallet signature."
      },
      {
        id: "no_execution_readiness",
        label: "Execution not confirmed",
        reason: "At this step, simulation, wallet approval, signing, and confirmation of the transaction result are not complete."
      },
      {
        id: "no_route_recommendation",
        label: "No route recommendation",
        reason: "The account-bound swap review uses an explicit direct pool path and does not rank venues or recommend routes."
      }
    ],
    freshness: {
      quotedAt: input.swapQuotePolicy.quoteSource.fetchedAt,
      status: "current",
      evaluatedAt: input.now.toISOString(),
      expiresAt: input.transactionMaterial.expiresAt,
      reason: "These details expire with the transaction and quote used to prepare them."
    },
    blockingChecks: [
      failReviewCheck(
        "deepbook_review_time_simulation_missing",
        "Review-time simulation",
        "Review-time simulation evidence is still required before any wallet handoff, signing, or execution.",
        "simulation"
      )
    ]
  };
}

function assertDeepbookHumanReviewSources(
  input: DeepbookSwapHumanReadableReviewProducerInput
): void {
  if (
    input.swapQuotePolicy.adapterId !== input.plan.adapterId ||
    input.swapQuotePolicy.protocol !== input.plan.protocol ||
    input.swapQuotePolicy.actionKind !== input.plan.actionKind
  ) {
    throw new Error("human-readable review quote policy identity must match the action plan");
  }
  if (input.swapQuotePolicy.quoteSource.poolKey !== input.poolResolution.poolKey) {
    throw new Error("human-readable review pool target must match swap quote policy poolKey");
  }
  if (input.swapQuotePolicy.quoteSource.direction !== input.quotePolicy.direction) {
    throw new Error("human-readable review target direction must match swap quote policy direction");
  }
}

function classifyHumanReviewFailure(error: unknown): BlockedReason {
  const message = error instanceof Error ? error.message : "";
  if (/object ownership/i.test(message)) {
    return "object_resolution_failed";
  }
  if (/asset|target|pool|direction|protocol|adapter/i.test(message)) {
    return "asset_mismatch";
  }
  if (/amount|quote|slippage|min/i.test(message)) {
    return "amount_mismatch";
  }
  return "unsupported_action";
}

function amountFromQuotePolicy(
  role: SwapHumanReadableReviewAmount["role"],
  amount: SwapQuotePolicyEvidence["sourceAmount"],
  display?: Pick<SwapHumanReadableReviewAmount, "displayAmount" | "displayAmountSource">
): SwapHumanReadableReviewAmount {
  return {
    role,
    symbol: amount.asset.symbol,
    coinType: amount.asset.coinType,
    decimals: amount.asset.decimals,
    rawAmount: amount.raw,
    rawAmountSource: "quote_policy_evidence",
    ...(display?.displayAmount ? { displayAmount: display.displayAmount } : {}),
    ...(display?.displayAmountSource ? { displayAmountSource: display.displayAmountSource } : {})
  };
}
