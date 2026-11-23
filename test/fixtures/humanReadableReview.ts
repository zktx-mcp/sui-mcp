import { transactionFundingSummary } from "../../src/core/action/transactionFunding.js";
import type { ActionPlan } from "../../src/core/action/types.js";
import {
  createSwapHumanReadableReviewEvidence
} from "../../src/core/action/swapHumanReadableReviewProjection.js";
import type { SwapQuotePolicyEvidence } from "../../src/core/action/swapQuotePolicyEvidence.js";
import type { TransactionObjectOwnershipEvidence } from "../../src/core/action/transactionObjectOwnershipEvidence.js";
import type {
  LocalTransactionMaterialDigestCommitment,
  LocalTransactionMaterialHandle
} from "../../src/core/session/transactionMaterialStore.js";

export function createTestSwapHumanReadableReviewEvidence(input: {
  plan: Pick<ActionPlan, "adapterId" | "actionKind" | "protocol" | "summary" | "title">;
  account: string;
  materialHandle: LocalTransactionMaterialHandle;
  digest: LocalTransactionMaterialDigestCommitment;
  swapQuotePolicy: SwapQuotePolicyEvidence;
  transactionObjectOwnership: TransactionObjectOwnershipEvidence;
  derivedAt: Date;
  displayAmount?: string | undefined;
}) {
  return createSwapHumanReadableReviewEvidence({
    transactionMaterial: input.materialHandle,
    transactionMaterialDigest: input.digest,
    swapQuotePolicy: input.swapQuotePolicy,
    transactionObjectOwnership: input.transactionObjectOwnership,
    adapterId: input.plan.adapterId,
    protocol: input.plan.protocol,
    actionKind: input.plan.actionKind,
    review: {
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
        outgoing: [{
          role: "input",
          symbol: input.swapQuotePolicy.sourceAmount.asset.symbol,
          coinType: input.swapQuotePolicy.sourceAmount.asset.coinType,
          decimals: input.swapQuotePolicy.sourceAmount.asset.decimals,
          rawAmount: input.swapQuotePolicy.sourceAmount.raw,
          rawAmountSource: "quote_policy_evidence",
          ...(input.displayAmount ? { displayAmount: input.displayAmount } : {}),
          ...(input.displayAmount ? { displayAmountSource: "user_display_intent_not_signing_input" as const } : {})
        }],
        expectedIncoming: [{
          role: "expected_output",
          symbol: input.swapQuotePolicy.expectedOutput.asset.symbol,
          coinType: input.swapQuotePolicy.expectedOutput.asset.coinType,
          decimals: input.swapQuotePolicy.expectedOutput.asset.decimals,
          rawAmount: input.swapQuotePolicy.expectedOutput.raw,
          rawAmountSource: "quote_policy_evidence"
        }],
        minimumIncoming: [{
          role: "minimum_output",
          symbol: input.swapQuotePolicy.minimumOutput.asset.symbol,
          coinType: input.swapQuotePolicy.minimumOutput.asset.coinType,
          decimals: input.swapQuotePolicy.minimumOutput.asset.decimals,
          rawAmount: input.swapQuotePolicy.minimumOutput.raw,
          rawAmountSource: "quote_policy_evidence"
        }],
        inputFlow: input.swapQuotePolicy.inputFlow,
        separateFeeBudgetRaw: input.swapQuotePolicy.separateFeeBudgetRaw,
        fees: input.swapQuotePolicy.inputFlow.fee.kind === "separate_coin" ? [{
          role: "fee",
          symbol: input.swapQuotePolicy.inputFlow.fee.amount.asset.symbol,
          coinType: input.swapQuotePolicy.inputFlow.fee.amount.asset.coinType,
          decimals: input.swapQuotePolicy.inputFlow.fee.amount.asset.decimals,
          rawAmount: input.swapQuotePolicy.inputFlow.fee.amount.raw,
          rawAmountSource: "quote_policy_evidence"
        }] : []
      },
      recipients: [
        { role: "connected_account", address: input.account },
        { role: "output_recipient", address: input.account }
      ],
      targets: [{
        kind: "swap_output_asset",
        symbol: input.swapQuotePolicy.expectedOutput.asset.symbol,
        coinType: input.swapQuotePolicy.expectedOutput.asset.coinType,
        protocol: input.plan.protocol,
        poolKey: input.swapQuotePolicy.quoteSource.poolKey,
        direction: input.swapQuotePolicy.quoteSource.direction
      }],
      evidenceUsed: [
        { id: "transaction_funding", label: "Transaction funding", source: "transaction_material", summary: transactionFundingSummary(input.transactionObjectOwnership.funding) },
        {
          id: "swap_quote_policy",
          label: "Swap quote policy",
          source: "quote",
          summary: "Quote policy evidence is bound to the local material."
        },
        {
          id: "transaction_material_digest",
          label: "Transaction material digest",
          source: "digest_commitment",
          summary: "Digest commitment evidence is kept private and bound to the stored local material."
        },
        {
          id: "transaction_object_ownership",
          label: "Object ownership",
          source: "wallet",
          summary: "Object ownership evidence is bound to the stored local material."
        }
      ],
      missingEvidence: [
        {
          id: "review_time_simulation",
          label: "Review-time simulation",
          reason: "Simulation is not produced yet."
        }
      ],
      requiredUserChoices: [
        {
          id: "wallet_authorization_later",
          label: "Wallet authorization",
          reason: "The user must approve any future wallet handoff."
        }
      ],
      unsupportedClaims: [
        {
          id: "no_signing_readiness",
          label: "No signing readiness",
          reason: "This evidence does not make the action ready to sign."
        },
        {
          id: "no_execution_readiness",
          label: "No execution readiness",
          reason: "Simulation, wallet handoff, signing, and execution receipt evidence are not complete."
        },
        {
          id: "no_route_recommendation",
          label: "No route recommendation",
          reason: "The review follows the explicit direct swap path and does not recommend a route."
        }
      ],
      freshness: {
        quotedAt: input.swapQuotePolicy.quoteSource.fetchedAt,
        status: "current",
        evaluatedAt: input.derivedAt.toISOString(),
        expiresAt: input.materialHandle.expiresAt,
        reason: "Evidence expires with the stored material."
      },
      blockingChecks: [
        {
          id: "test_swap_review_time_simulation_missing",
          label: "Review-time simulation",
          status: "fail",
          message: "Simulation is still required.",
          source: "simulation"
        }
      ]
    },
    derivedAt: input.derivedAt
  });
}
