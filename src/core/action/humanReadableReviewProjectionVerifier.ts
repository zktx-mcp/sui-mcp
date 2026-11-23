import type { HumanReadableReviewEvidence } from "./humanReadableReviewEvidence.js";
import {
  verifySwapHumanReadableReviewEvidence
} from "./swapHumanReadableReviewProjection.js";
import type { SwapQuotePolicyEvidence } from "./swapQuotePolicyEvidence.js";
import type { TransactionObjectOwnershipEvidence } from "./transactionObjectOwnershipEvidence.js";
import type {
  LocalTransactionMaterialDigestCommitment,
  LocalTransactionMaterialHandle
} from "../session/transactionMaterialStore.js";

export function verifySupportedHumanReadableReviewEvidence(input: {
  transactionMaterial: LocalTransactionMaterialHandle;
  transactionMaterialDigest: LocalTransactionMaterialDigestCommitment;
  swapQuotePolicy?: SwapQuotePolicyEvidence | undefined;
  transactionObjectOwnership?: TransactionObjectOwnershipEvidence | undefined;
  evidence: HumanReadableReviewEvidence;
  now?: Date | undefined;
}): HumanReadableReviewEvidence {
  const evidence = input.evidence;
  switch (evidence.review.kind) {
    case "swap_human_readable_review":
      return verifySwapHumanReadableReviewEvidence({
        transactionMaterial: input.transactionMaterial,
        transactionMaterialDigest: input.transactionMaterialDigest,
        swapQuotePolicy: requireProjectionArtifact(
          input.swapQuotePolicy,
          "swap human-readable review evidence requires swap quote policy evidence"
        ),
        transactionObjectOwnership: requireProjectionArtifact(
          input.transactionObjectOwnership,
          "swap human-readable review evidence requires transaction object ownership evidence"
        ),
        evidence,
        now: input.now
      });
  }

  const unsupportedKind: never = evidence.review.kind;
  throw new Error(`unsupported human-readable review projection kind: ${String(unsupportedKind)}`);
}

function requireProjectionArtifact<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}
