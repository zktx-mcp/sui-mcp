import { transactionFundingEvidenceSchema } from "../action/transactionFunding.js";
import type {
  LocalTransactionMaterialDigestCommitment,
  LocalTransactionMaterialHandle
} from "./transactionMaterialStore.js";
import type {
  TransactionObjectOwnershipEvidence
} from "../action/transactionObjectOwnershipEvidence.js";
import type {
  SwapQuotePolicyEvidence
} from "../action/swapQuotePolicyEvidence.js";
import {
  parseHumanReadableReviewEvidence,
  type HumanReadableReviewEvidence
} from "../action/humanReadableReviewEvidence.js";
import {
  parseReviewTimeSimulationEvidence,
  type ReviewTimeSimulationEvidence
} from "../action/reviewTimeSimulationEvidence.js";

export type PrivateReviewArtifacts = {
  transactionMaterial?: LocalTransactionMaterialHandle;
  transactionMaterialDigest?: LocalTransactionMaterialDigestCommitment;
  swapQuotePolicy?: SwapQuotePolicyEvidence;
  transactionObjectOwnership?: TransactionObjectOwnershipEvidence;
  humanReadableReview?: HumanReadableReviewEvidence;
  reviewTimeSimulation?: ReviewTimeSimulationEvidence;
};

export function clonePrivateReviewArtifacts(
  artifacts: PrivateReviewArtifacts
): PrivateReviewArtifacts {
  return {
    ...(artifacts.transactionMaterial
      ? { transactionMaterial: { ...artifacts.transactionMaterial } }
      : {}),
    ...(artifacts.transactionMaterialDigest
      ? { transactionMaterialDigest: { ...artifacts.transactionMaterialDigest } }
      : {}),
    ...(artifacts.swapQuotePolicy
      ? { swapQuotePolicy: structuredClone(artifacts.swapQuotePolicy) }
      : {}),
    ...(artifacts.transactionObjectOwnership
      ? {
          transactionObjectOwnership: {
            ...artifacts.transactionObjectOwnership,
            funding: transactionFundingEvidenceSchema.parse(structuredClone(artifacts.transactionObjectOwnership.funding)),
            objects: artifacts.transactionObjectOwnership.objects.map((object) => ({
              ...object,
              roles: [...object.roles]
            }))
          }
        }
      : {}),
    ...(artifacts.humanReadableReview
      ? {
          humanReadableReview: parseHumanReadableReviewEvidence(structuredClone(artifacts.humanReadableReview))
        }
      : {}),
    ...(artifacts.reviewTimeSimulation
      ? {
          reviewTimeSimulation: parseReviewTimeSimulationEvidence(structuredClone(artifacts.reviewTimeSimulation))
        }
      : {})
  };
}

// Persistence seam for private review artifacts. The in-memory and SQLite session
// stores share all orchestration; only this storage backend differs.
export interface PrivateReviewArtifactStore {
  get(reviewSessionId: string): PrivateReviewArtifacts | undefined;
  set(reviewSessionId: string, artifacts: PrivateReviewArtifacts): void;
  delete(reviewSessionId: string): void;
  clear(): void;
}

export class InMemoryPrivateReviewArtifactStore implements PrivateReviewArtifactStore {
  private readonly artifacts = new Map<string, PrivateReviewArtifacts>();

  get(reviewSessionId: string): PrivateReviewArtifacts | undefined {
    const artifacts = this.artifacts.get(reviewSessionId);
    return artifacts ? clonePrivateReviewArtifacts(artifacts) : undefined;
  }

  set(reviewSessionId: string, artifacts: PrivateReviewArtifacts): void {
    this.artifacts.set(reviewSessionId, clonePrivateReviewArtifacts(artifacts));
  }

  delete(reviewSessionId: string): void {
    this.artifacts.delete(reviewSessionId);
  }

  clear(): void {
    this.artifacts.clear();
  }
}
