import { isDeepStrictEqual } from "node:util";
import { transactionFundingSummary } from "./transactionFunding.js";
import type {
  SwapHumanReadableReviewAmount
} from "./types.js";
import {
  assertPreSimulationHumanReadableReviewBoundaryClaims,
  createHumanReadableReviewEvidence,
  type HumanReadableReviewEvidence,
  verifyHumanReadableReviewEvidence
} from "./humanReadableReviewEvidence.js";
import type { SwapQuotePolicyEvidence } from "./swapQuotePolicyEvidence.js";
import type { TransactionObjectOwnershipEvidence } from "./transactionObjectOwnershipEvidence.js";
import { parseSuiAddress } from "../suiAddress.js";
import type {
  LocalTransactionMaterialDigestCommitment,
  LocalTransactionMaterialHandle
} from "../session/transactionMaterialStore.js";

export function createSwapHumanReadableReviewEvidence(input: {
  transactionMaterial: LocalTransactionMaterialHandle;
  transactionMaterialDigest: LocalTransactionMaterialDigestCommitment;
  swapQuotePolicy: SwapQuotePolicyEvidence;
  transactionObjectOwnership: TransactionObjectOwnershipEvidence;
  adapterId: string;
  protocol: string;
  actionKind: string;
  review: HumanReadableReviewEvidence["review"];
  derivedAt: Date;
}): HumanReadableReviewEvidence {
  return verifySwapHumanReadableReviewEvidence({
    transactionMaterial: input.transactionMaterial,
    transactionMaterialDigest: input.transactionMaterialDigest,
    swapQuotePolicy: input.swapQuotePolicy,
    transactionObjectOwnership: input.transactionObjectOwnership,
    evidence: createHumanReadableReviewEvidence({
      transactionMaterial: input.transactionMaterial,
      transactionMaterialDigest: input.transactionMaterialDigest,
      adapterId: input.adapterId,
      protocol: input.protocol,
      actionKind: input.actionKind,
      review: input.review,
      derivedAt: input.derivedAt
    }),
    now: input.derivedAt
  });
}

export function verifySwapHumanReadableReviewEvidence(input: {
  transactionMaterial: LocalTransactionMaterialHandle;
  transactionMaterialDigest: LocalTransactionMaterialDigestCommitment;
  swapQuotePolicy: SwapQuotePolicyEvidence;
  transactionObjectOwnership: TransactionObjectOwnershipEvidence;
  evidence: HumanReadableReviewEvidence;
  now?: Date | undefined;
}): HumanReadableReviewEvidence {
  const evidence = verifyHumanReadableReviewEvidence({
    transactionMaterial: input.transactionMaterial,
    transactionMaterialDigest: input.transactionMaterialDigest,
    evidence: input.evidence,
    now: input.now
  });

  if (evidence.review.kind !== "swap_human_readable_review") {
    throw new Error("swap human-readable review evidence requires a swap_human_readable_review projection");
  }
  if (
    input.swapQuotePolicy.adapterId !== evidence.adapterId ||
    input.swapQuotePolicy.protocol !== evidence.protocol ||
    input.swapQuotePolicy.actionKind !== evidence.actionKind
  ) {
    throw new Error("swap human-readable review evidence must match swap quote policy adapter identity");
  }

  for (const artifact of [input.swapQuotePolicy, input.transactionObjectOwnership]) {
    if (
      artifact.materialId !== input.transactionMaterial.materialId ||
      artifact.reviewSessionId !== input.transactionMaterial.reviewSessionId ||
      artifact.planId !== input.transactionMaterial.planId ||
      artifact.account !== input.transactionMaterial.account ||
      artifact.expiresAt !== input.transactionMaterial.expiresAt
    ) {
      throw new Error("swap human-readable review evidence requires quote policy and object ownership artifacts for the same material");
    }
  }
  if (input.transactionObjectOwnership.transactionDigest !== input.transactionMaterialDigest.transactionDigest) {
    throw new Error("swap human-readable review evidence requires object ownership bound to the same transaction digest");
  }

  const fundingFacts = evidence.review.evidenceUsed.filter((fact) => fact.id === "transaction_funding");
  if (fundingFacts.length !== 1 || fundingFacts[0]?.source !== "transaction_material" ||
    fundingFacts[0]?.summary !== transactionFundingSummary(input.transactionObjectOwnership.funding)) {
    throw new Error("swap human-readable review must describe the verified transaction funding");
  }
  assertSwapHumanReadableReviewProjectsQuotePolicy(evidence, input.swapQuotePolicy);
  assertSwapHumanReadableReviewParties(evidence);
  assertSwapHumanReadableReviewEvidenceSources(evidence);
  assertSwapHumanReadableReviewBoundaryClaims(evidence);
  assertPreSimulationHumanReadableReviewBoundaryClaims(evidence);
  return evidence;
}

function assertSwapHumanReadableReviewProjectsQuotePolicy(
  evidence: HumanReadableReviewEvidence,
  swapQuotePolicy: SwapQuotePolicyEvidence
): void {
  assertSingleAmountProjection(
    "outgoing",
    evidence.review.assetFlow.outgoing,
    "input",
    swapQuotePolicy.sourceAmount
  );
  assertSingleAmountProjection(
    "expected incoming",
    evidence.review.assetFlow.expectedIncoming,
    "expected_output",
    swapQuotePolicy.expectedOutput
  );
  assertSingleAmountProjection(
    "minimum incoming",
    evidence.review.assetFlow.minimumIncoming,
    "minimum_output",
    swapQuotePolicy.minimumOutput
  );
  const { inputFlow, fees } = evidence.review.assetFlow;
  if (!isDeepStrictEqual(inputFlow, swapQuotePolicy.inputFlow) ||
      evidence.review.assetFlow.feeTargetRaw !== swapQuotePolicy.feeTargetRaw ||
      evidence.review.assetFlow.separateFeeBudgetRaw !== swapQuotePolicy.separateFeeBudgetRaw ||
      evidence.review.freshness.quotedAt !== swapQuotePolicy.quoteSource.fetchedAt) {
    throw new Error("swap human-readable review input flow must match swap quote policy evidence");
  }
  const fee = swapQuotePolicy.inputFlow.fee;
  if (fee.kind === "separate_coin") {
    assertSingleAmountProjection("fee", fees, "fee", fee.amount);
  } else if (fees.length !== 0) {
    throw new Error("an input-inclusive quote cannot itemize an additional fee");
  }

  if (evidence.review.targets.length !== 1) {
    throw new Error("swap human-readable review targets must contain exactly one swap output asset target");
  }
  const target = evidence.review.targets[0]!;
  if (
    target.kind !== "swap_output_asset" ||
    target.symbol !== swapQuotePolicy.expectedOutput.asset.symbol ||
    target.coinType !== swapQuotePolicy.expectedOutput.asset.coinType ||
    target.protocol !== swapQuotePolicy.protocol ||
    target.poolKey !== swapQuotePolicy.quoteSource.poolKey ||
    target.direction !== swapQuotePolicy.quoteSource.direction
  ) {
    throw new Error("swap human-readable review target must match swap quote policy output asset and quote source");
  }
}

function assertSwapHumanReadableReviewParties(
  evidence: HumanReadableReviewEvidence
): void {
  const recipientsByRole = new Map<string, string>();
  for (const recipient of evidence.review.recipients) {
    if (recipientsByRole.has(recipient.role)) {
      throw new Error(`swap human-readable review recipients contains duplicate role '${recipient.role}'`);
    }
    const normalizedAddress = parseSuiAddress(recipient.address);
    if (!normalizedAddress) {
      throw new Error("swap human-readable review recipients must contain valid Sui addresses");
    }
    recipientsByRole.set(recipient.role, normalizedAddress);
  }
  if (recipientsByRole.size !== 2) {
    throw new Error("swap human-readable review recipients must contain exactly the connected account and output recipient");
  }
  if (
    recipientsByRole.get("connected_account") !== evidence.account ||
    recipientsByRole.get("output_recipient") !== evidence.account
  ) {
    throw new Error("swap human-readable review recipients must match the reviewed account");
  }
}

function assertSwapHumanReadableReviewEvidenceSources(
  evidence: HumanReadableReviewEvidence
): void {
  for (const source of ["quote", "wallet"]) {
    requireFactSource(evidence.review.evidenceUsed, source);
  }
}

function assertSwapHumanReadableReviewBoundaryClaims(
  evidence: HumanReadableReviewEvidence
): void {
  requireGapId("unsupportedClaims", evidence.review.unsupportedClaims, "no_route_recommendation");
}

function assertSingleAmountProjection(
  label: string,
  amounts: readonly SwapHumanReadableReviewAmount[],
  role: SwapHumanReadableReviewAmount["role"],
  expected: SwapQuotePolicyEvidence["sourceAmount"]
): void {
  if (amounts.length !== 1) {
    throw new Error(`swap human-readable review ${label} must contain exactly one amount`);
  }
  const amount = amounts[0]!;
  if (
    amount.role !== role ||
    amount.rawAmount !== expected.raw ||
    amount.rawAmountSource !== "quote_policy_evidence" ||
    amount.symbol !== expected.asset.symbol ||
    amount.coinType !== expected.asset.coinType ||
    amount.decimals !== expected.asset.decimals
  ) {
    throw new Error(`swap human-readable review ${label} amount must match swap quote policy evidence`);
  }
}

function requireFactSource(
  facts: readonly { source: string }[],
  source: string
): void {
  if (!facts.some((fact) => fact.source === source)) {
    throw new Error(`swap human-readable review evidenceUsed must include source '${source}'`);
  }
}

function requireGapId(
  label: string,
  gaps: readonly { id: string }[],
  id: string
): void {
  if (!gaps.some((gap) => gap.id === id)) {
    throw new Error(`swap human-readable review ${label} must include '${id}'`);
  }
}
