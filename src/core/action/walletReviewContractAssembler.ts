import { assertTransactionFundingMatches } from "./transactionFunding.js";
import {
  adapterEvidenceClaimSchema,
  adapterInputProvenanceSchema,
  adapterOutputBoundarySchema,
  adapterSimulationEvidenceSchema,
  adapterSourceOfTruthSchema,
  transactionReviewDataSchema,
  TRANSACTION_REVIEW_SCHEMA_VERSION,
  WALLET_REVIEW_REQUIRED_PROHIBITED_OUTPUTS,
  WALLET_REVIEW_REQUIRED_SIMULATION_FIELDS,
  WALLET_REVIEW_REQUIRED_HUMAN_FIELDS,
  adapterExpiryEvidenceSchema,
  adapterHumanReadableReviewSchema,
  adapterGasEvidenceSchema,
  SUI_GAS_COIN_TYPE,
  type AdapterEvidenceClaim,
  type AdapterGasObjectOwnershipLink,
  type AdapterObjectOwnershipEvidence,
  type AdapterRawQuantity,
  type AdapterSourceOfTruth
} from "./signableAdapterContract.js";
import type { z } from "zod";
import {
  parseReviewTimeSimulationEvidence,
  type ReviewTimeSimulationEvidence
} from "./reviewTimeSimulationEvidence.js";
import {
  parseHumanReadableReviewEvidence,
  type HumanReadableReviewEvidence
} from "./humanReadableReviewEvidence.js";

export type WalletReviewOutputBoundary = z.infer<typeof adapterOutputBoundarySchema>;
export type WalletReviewInputProvenance = z.infer<typeof adapterInputProvenanceSchema>;

export function buildWalletReviewOutputBoundary(): WalletReviewOutputBoundary {
  return adapterOutputBoundarySchema.parse({
    runtimeStatus: "emitted_pre_handoff",
    mcpAndReviewUiMayExpose: [
      "human_readable_review",
      "ptb_visualization_artifact",
      "diagnostics",
      "status_checks"
    ],
    prohibited: [...WALLET_REVIEW_REQUIRED_PROHIBITED_OUTPUTS]
  });
}

export function buildWalletReviewInputProvenance(input: {
  kind: WalletReviewInputProvenance["kind"];
  sourceId: string;
  capturedAt: string;
  userSelectionSource?: WalletReviewInputProvenance["userSelectionSource"];
}): WalletReviewInputProvenance {
  return adapterInputProvenanceSchema.parse({
    kind: input.kind,
    sourceId: input.sourceId,
    capturedAt: input.capturedAt,
    authority: "untrusted_until_review_regenerates_and_verifies",
    ...(input.userSelectionSource ? { userSelectionSource: input.userSelectionSource } : {})
  });
}
import {
  mapSwapQuotePolicyEvidenceToContractDraft,
  parseSwapQuotePolicyEvidence,
  type SwapQuotePolicyEvidence
} from "./swapQuotePolicyEvidence.js";
import {
  mapTransactionObjectOwnershipEvidenceToContractDraft,
  type TransactionObjectOwnershipEvidence
} from "./transactionObjectOwnershipEvidence.js";

export type WalletReviewContractAssemblyDecline = {
  status: "declined";
  reason: string;
};

export type WalletReviewContractEvidencePool = {
  status: "drafted";
  sourceReferences: AdapterSourceOfTruth[];
  evidenceClaims: AdapterEvidenceClaim[];
  rawQuantities: AdapterRawQuantity[];
  objectOwnership: AdapterObjectOwnershipEvidence;
  gasObjectOwnershipLinks: AdapterGasObjectOwnershipLink[];
};

export function draftWalletReviewContractEvidencePool(input: {
  quotePolicy: SwapQuotePolicyEvidence;
  objectOwnership: TransactionObjectOwnershipEvidence;
}): WalletReviewContractEvidencePool | WalletReviewContractAssemblyDecline {
  const quote = mapSwapQuotePolicyEvidenceToContractDraft(input.quotePolicy);
  if (quote.status === "unsupported") {
    return { status: "declined", reason: `quote policy draft unsupported: ${quote.reason}` };
  }

  const ownership = mapTransactionObjectOwnershipEvidenceToContractDraft(input.objectOwnership);
  if (ownership.status === "unsupported") {
    return { status: "declined", reason: `object ownership draft unsupported: ${ownership.reason}` };
  }

  const sourceReferences = [...quote.sourceReferences, ownership.sourceReferences];
  const sourceIds = new Set<string>();
  for (const record of sourceReferences) {
    if (sourceIds.has(record.id)) {
      return { status: "declined", reason: `duplicate sourceReferences id: ${record.id}` };
    }
    sourceIds.add(record.id);
  }

  const evidenceClaims: AdapterEvidenceClaim[] = [...quote.evidenceClaims, ...ownership.evidenceClaims];
  const claimIds = new Set<string>();
  for (const claim of evidenceClaims) {
    if (claimIds.has(claim.id)) {
      return { status: "declined", reason: `duplicate evidence claim id: ${claim.id}` };
    }
    claimIds.add(claim.id);
  }

  return {
    status: "drafted",
    sourceReferences,
    evidenceClaims,
    rawQuantities: quote.rawQuantities,
    objectOwnership: ownership.objectOwnership,
    gasObjectOwnershipLinks: ownership.gasObjectOwnershipLinks
  };
}

export type WalletReviewSimulationEvidence = z.infer<typeof adapterSimulationEvidenceSchema>;

export type ReviewTimeSimulationContractMapping = {
  status: "mapped";
  sourceReferences: AdapterSourceOfTruth;
  evidenceClaim: Extract<AdapterEvidenceClaim, { factKind: "simulation_result" }>;
  simulation: WalletReviewSimulationEvidence;
};

export function mapReviewTimeSimulationEvidenceToContractDraft(
  evidenceInput: ReviewTimeSimulationEvidence
): ReviewTimeSimulationContractMapping {
  const evidence = parseReviewTimeSimulationEvidence(evidenceInput);
  const sourceId = "review_time_simulation_source";
  const claimId = "review_time_simulation_claim";
  const sourceReferences = adapterSourceOfTruthSchema.parse({
    id: sourceId,
    kind: "review_time_simulation",
    network: "sui:mainnet",
    source: "Sui gRPC simulation with validation enabled; returned transaction bytes and effects matched the stored transaction",
    verifiedAt: evidence.simulatedAt,
    fields: [...WALLET_REVIEW_REQUIRED_SIMULATION_FIELDS]
  }) as AdapterSourceOfTruth;
  const evidenceClaim = adapterEvidenceClaimSchema.parse({
    id: claimId,
    factKind: "simulation_result",
    sourceEvidenceId: sourceId,
    provider: evidence.provider,
    checksEnabled: evidence.checksEnabled,
    simulatedAt: evidence.simulatedAt,
    status: evidence.status,
    requiredFields: [...evidence.requiredFields],
    missingFields: [...evidence.missingFields]
  }) as Extract<AdapterEvidenceClaim, { factKind: "simulation_result" }>;
  const simulation = adapterSimulationEvidenceSchema.parse({
    evidenceClaimId: claimId,
    transactionDigest: evidence.transactionDigest,
    provider: evidence.provider,
    checksEnabled: evidence.checksEnabled,
    simulatedAt: evidence.simulatedAt,
    status: evidence.status,
    requiredFields: [...evidence.requiredFields],
    missingFields: [...evidence.missingFields]
  });
  return { status: "mapped", sourceReferences, evidenceClaim, simulation };
}

export type WalletReviewGasEvidence = z.infer<typeof adapterGasEvidenceSchema>;

export type ReviewTimeSimulationGasContractMapping =
  | {
      status: "mapped";
      sourceReferences: AdapterSourceOfTruth[];
      evidenceClaims: Array<Extract<AdapterEvidenceClaim, { factKind: "raw_quantity_amount" }>>;
      gas: WalletReviewGasEvidence;
    }
  | { status: "unsupported"; reason: string };

export function mapReviewTimeSimulationGasToContractDraft(
  evidenceInput: ReviewTimeSimulationEvidence,
  gasObjects: AdapterGasObjectOwnershipLink[]
): ReviewTimeSimulationGasContractMapping {
  const evidence = parseReviewTimeSimulationEvidence(evidenceInput);
  const summary = evidence.effects.gasCostSummary;
  const gasUsed =
    BigInt(summary.computationCostRaw) +
    BigInt(summary.storageCostRaw) -
    BigInt(summary.storageRebateRaw);

  const sourceReferences: AdapterSourceOfTruth[] = [];
  const evidenceClaims: Array<Extract<AdapterEvidenceClaim, { factKind: "raw_quantity_amount" }>> = [];
  const gasAsset = { coinType: SUI_GAS_COIN_TYPE };

  const gasUsedSourceId = "review_time_simulation_gas_used_source";
  const gasUsedClaimId = "review_time_simulation_gas_used_claim";
  // A storage rebate can make net gas negative. Keep the verified budget and
  // simulation components; do not invent an unsigned zero or a spending claim.
  if (gasUsed >= 0n) {
    sourceReferences.push(adapterSourceOfTruthSchema.parse({
      id: gasUsedSourceId,
      kind: "review_time_simulation",
      network: "sui:mainnet",
      source: "Network fee components estimated by simulation of the stored transaction with validation enabled",
      verifiedAt: evidence.simulatedAt,
      fields: ["gasUsedRaw", "asset", "amountRole"]
    }) as AdapterSourceOfTruth);
    evidenceClaims.push(adapterEvidenceClaimSchema.parse({
      id: gasUsedClaimId,
      factKind: "raw_quantity_amount",
      sourceEvidenceId: gasUsedSourceId,
      role: "gas_used",
      asset: gasAsset,
      rawAmount: gasUsed.toString()
    }) as Extract<AdapterEvidenceClaim, { factKind: "raw_quantity_amount" }>);
  }

  const gasBudgetRaw = evidence.transaction.gasBudgetRaw;
  let gasBudgetClaimId: string | undefined;
  if (gasBudgetRaw !== undefined) {
    const gasBudgetSourceId = "review_time_simulation_gas_budget_source";
    gasBudgetClaimId = "review_time_simulation_gas_budget_claim";
    sourceReferences.push(adapterSourceOfTruthSchema.parse({
      id: gasBudgetSourceId,
      kind: "review_time_simulation",
      network: "sui:mainnet",
      source: "Network fee limit (gas budget) recorded in the transaction used for simulation",
      verifiedAt: evidence.simulatedAt,
      fields: ["gasBudgetRaw", "asset", "amountRole"]
    }) as AdapterSourceOfTruth);
    evidenceClaims.push(adapterEvidenceClaimSchema.parse({
      id: gasBudgetClaimId,
      factKind: "raw_quantity_amount",
      sourceEvidenceId: gasBudgetSourceId,
      role: "gas_budget",
      asset: gasAsset,
      rawAmount: gasBudgetRaw
    }) as Extract<AdapterEvidenceClaim, { factKind: "raw_quantity_amount" }>);
  }

  const gas = adapterGasEvidenceSchema.parse({
    source: "review_time_simulation",
    checkedAt: evidence.simulatedAt,
    ...(gasUsed >= 0n ? { gasUsedRaw: gasUsed.toString(), gasUsedClaimId } : {}),
    ...(gasBudgetRaw !== undefined && gasBudgetClaimId
      ? { gasBudgetRaw, gasBudgetClaimId }
      : {}),
    ...(gasObjects.length > 0 ? { gasObjects } : {})
  });

  return { status: "mapped", sourceReferences, evidenceClaims, gas };
}

export type WalletReviewExpiryEvidence = z.infer<typeof adapterExpiryEvidenceSchema>;

export type SwapQuotePolicyExpiryContractMapping = {
  status: "mapped";
  sourceReferences: AdapterSourceOfTruth;
  evidenceClaim: Extract<AdapterEvidenceClaim, { factKind: "expiry_status" }>;
  expiry: WalletReviewExpiryEvidence;
};

export function mapSwapQuotePolicyExpiryToContractDraft(
  evidenceInput: SwapQuotePolicyEvidence,
  now: Date
): SwapQuotePolicyExpiryContractMapping {
  const evidence = parseSwapQuotePolicyEvidence(evidenceInput);
  const checkedAt = now.toISOString();
  const status = Date.parse(evidence.expiresAt) > now.getTime() ? "current" : "expired";
  const sourceId = "swap_quote_policy_expiry_source";
  const claimId = "swap_quote_policy_expiry_claim";
  const sourceReferences = adapterSourceOfTruthSchema.parse({
    id: sourceId,
    kind: "validated_request_fact",
    network: "sui:mainnet",
    source: "Quote validity period (retrieval time plus validity duration), checked when the review was prepared",
    verifiedAt: checkedAt,
    fields: ["checkedAt", "expiresAt"]
  }) as AdapterSourceOfTruth;
  const evidenceClaim = adapterEvidenceClaimSchema.parse({
    id: claimId,
    factKind: "expiry_status",
    sourceEvidenceId: sourceId,
    checkedAt,
    status,
    expiresAt: evidence.expiresAt
  }) as Extract<AdapterEvidenceClaim, { factKind: "expiry_status" }>;
  const expiry = adapterExpiryEvidenceSchema.parse({
    checkedAt,
    status,
    expiresAt: evidence.expiresAt,
    evidenceClaimId: claimId
  });
  return { status: "mapped", sourceReferences, evidenceClaim, expiry };
}

export type WalletReviewHumanReadableReview = z.infer<typeof adapterHumanReadableReviewSchema>;

export function mapHumanReadableReviewEvidenceToContractDraft(
  evidenceInput: HumanReadableReviewEvidence
): { status: "mapped"; humanReadableReview: WalletReviewHumanReadableReview } {
  const evidence = parseHumanReadableReviewEvidence(evidenceInput);
  const humanReadableReview = adapterHumanReadableReviewSchema.parse({
    fields: [...WALLET_REVIEW_REQUIRED_HUMAN_FIELDS],
    transactionDigest: evidence.transactionDigest,
    source: "review_model_or_adapter_equivalent",
    purpose: "human_review_before_wallet_authorization"
  });
  return { status: "mapped", humanReadableReview };
}

export type TransactionReviewData = z.infer<typeof transactionReviewDataSchema>;

export type WalletReviewContractAssemblyInput = {
  adapterId: string;
  protocol: string;
  actionKind: string;
  provenance: Parameters<typeof buildWalletReviewInputProvenance>[0];
  quotePolicy: SwapQuotePolicyEvidence;
  objectOwnership: TransactionObjectOwnershipEvidence;
  humanReadableReview: HumanReadableReviewEvidence;
  reviewTimeSimulation: ReviewTimeSimulationEvidence;
  reviewedTransactionDigest: string;
  now: Date;
};

export type WalletReviewContractAssemblyOutcome =
  | { status: "emitted"; contract: TransactionReviewData }
  | WalletReviewContractAssemblyDecline;

export function assembleTransactionReviewData(
  input: WalletReviewContractAssemblyInput
): WalletReviewContractAssemblyOutcome {
  const pool = draftWalletReviewContractEvidencePool({
    quotePolicy: input.quotePolicy,
    objectOwnership: input.objectOwnership
  });
  if (pool.status === "declined") {
    return pool;
  }

  try { assertTransactionFundingMatches(input.reviewTimeSimulation.transaction.funding, input.objectOwnership.funding); }
  catch { return { status: "declined", reason: "simulation and ownership funding evidence differ" }; }

  const simulation = mapReviewTimeSimulationEvidenceToContractDraft(input.reviewTimeSimulation);
  const gas = mapReviewTimeSimulationGasToContractDraft(
    input.reviewTimeSimulation,
    pool.gasObjectOwnershipLinks
  );
  if (gas.status === "unsupported") {
    return { status: "declined", reason: `gas evidence unsupported: ${gas.reason}` };
  }
  const expiry = mapSwapQuotePolicyExpiryToContractDraft(input.quotePolicy, input.now);
  const human = mapHumanReadableReviewEvidenceToContractDraft(input.humanReadableReview);

  const sourceReferences = [
    ...pool.sourceReferences,
    simulation.sourceReferences,
    ...gas.sourceReferences,
    expiry.sourceReferences
  ];
  const sourceIds = new Set<string>();
  for (const record of sourceReferences) {
    if (sourceIds.has(record.id)) {
      return { status: "declined", reason: `duplicate sourceReferences id: ${record.id}` };
    }
    sourceIds.add(record.id);
  }

  const evidenceClaims: AdapterEvidenceClaim[] = [
    ...pool.evidenceClaims,
    simulation.evidenceClaim,
    ...gas.evidenceClaims,
    expiry.evidenceClaim
  ];
  const claimIds = new Set<string>();
  for (const claim of evidenceClaims) {
    if (claimIds.has(claim.id)) {
      return { status: "declined", reason: `duplicate evidence claim id: ${claim.id}` };
    }
    claimIds.add(claim.id);
  }

  const quote = parseSwapQuotePolicyEvidence(input.quotePolicy);
  const candidate = {
    schemaVersion: TRANSACTION_REVIEW_SCHEMA_VERSION,
    adapterId: input.adapterId,
    protocol: input.protocol,
    actionKind: input.actionKind,
    network: "sui:mainnet",
    inputProvenance: buildWalletReviewInputProvenance(input.provenance),
    sourceReferences,
    evidenceClaims,
    rawQuantities: pool.rawQuantities,
    gas: gas.gas,
    expiry: expiry.expiry,
    slippageOrMinOut: {
      ...(quote.enforcement ? { enforcement: quote.enforcement } : {}),
      status: "required_and_verified",
      quoteEvidenceId: quote.quoteEvidenceId,
      quoteEvidenceClaimId: "swap_quote_min_out_claim",
      maxSlippageSource: quote.maxSlippageSource,
      maxSlippageBps: quote.maxSlippageBps,
      minOutRaw: quote.minimumOutput.raw,
      policySource: "adapter_policy_from_quote_evidence",
      policyEvidenceClaimId: "swap_quote_slippage_policy_claim"
    },
    objectOwnership: pool.objectOwnership,
    simulation: simulation.simulation,
    humanReadableReview: human.humanReadableReview,
    outputBoundary: buildWalletReviewOutputBoundary(),
    reviewedTransactionDigest: input.reviewedTransactionDigest
  };

  const parsed = transactionReviewDataSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") ?? "";
    return {
      status: "declined",
      reason: `contract schema rejected: ${path ? `${path}: ` : ""}${issue?.message ?? "unknown issue"}`
    };
  }
  return { status: "emitted", contract: parsed.data };
}
