import { matchesMinimumAbort, type ReviewedOutputGuard } from "./suiChainReceiptMapping.js";
import { GrpcTypes } from "@mysten/sui/grpc";
import { describeTransactionFunding, assertTransactionFundingMatches, transactionFundingDescriptionSchema } from "./transactionFunding.js";
import type { SuiClientTypes } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { z } from "zod";
import { assertNoForbiddenMcpFields } from "./forbiddenFields.js";
import {
  REVIEW_TIME_SIMULATION_PROVIDER,
  WALLET_REVIEW_REQUIRED_SIMULATION_FIELDS
} from "./signableAdapterContract.js";
import type {
  BlockedReason,
  ReviewCheck,
  SuccessfulTransactionSimulationSummary
} from "./types.js";
import {
  failReviewCheck,
  passReviewCheck
} from "./reviewCheckResults.js";
import {
  makeRawU64StringSchema,
  makeSignedRawIntegerStringSchema,
  parseRawU64
} from "../numeric/rawU64.js";
import {
  normalizedSuiAddressSchema,
  parseSuiAddress,
  suiTransactionDigestSchema
} from "../suiAddress.js";
import { normalizeCoinType } from "../read/coinMetadata.js";
import type {
  LocalTransactionMaterialDigestCommitment,
  LocalTransactionMaterialHandle,
  LocalTransactionMaterialStore
} from "../session/transactionMaterialStore.js";
import {
  LocalTransactionMaterialStoreError,
  verifyLocalTransactionMaterialArtifacts
} from "../session/transactionMaterialStore.js";

export const REVIEW_TIME_SIMULATION_EVIDENCE_VERSION =
  "review-time-simulation-v2";

const INVALID_SIMULATION_EVIDENCE_MESSAGE =
  "Review-time simulation returned incomplete or unverifiable evidence. Nothing was signed or submitted.";

const isoUtcStringSchema = z.string().refine((value) => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}, "Expected ISO 8601 UTC timestamp");

const simulationRequiredFieldSchema = z.enum(WALLET_REVIEW_REQUIRED_SIMULATION_FIELDS);

const simulationBalanceChangeSchema = z.object({
  address: normalizedSuiAddressSchema,
  coinType: z.string().min(1).max(512).refine((value) => {
    try {
      return normalizeCoinType(value) === value;
    } catch {
      return false;
    }
  }, "Expected a normalized Sui struct tag coin type"),
  amount: makeSignedRawIntegerStringSchema("balanceChanges[].amount")
}).strict();

const simulationObjectChangeSchema = z.object({
  objectId: normalizedSuiAddressSchema,
  objectType: z.string().min(1).max(512).optional(),
  inputState: z.string().min(1).max(80),
  outputState: z.string().min(1).max(80),
  idOperation: z.string().min(1).max(80)
}).strict();

const simulationTransactionSummarySchema = z.object({
  sender: normalizedSuiAddressSchema,
  funding: transactionFundingDescriptionSchema,
  gasPaymentCount: z.number().int().min(0),
  inputCount: z.number().int().min(0),
  commandCount: z.number().int().min(0),
  gasBudgetRaw: makeRawU64StringSchema("gasBudgetRaw").optional(),
  gasPriceRaw: makeRawU64StringSchema("gasPriceRaw").optional()
}).strict().superRefine((value, ctx) => {
  if (value.sender !== value.funding.sender || value.gasPaymentCount !== value.funding.gasPayments.length ||
      value.gasBudgetRaw !== value.funding.gasBudgetRaw || value.gasPriceRaw !== value.funding.gasPriceRaw ||
      (value.gasPaymentCount === 0) !== (value.funding.gasMode === "address_balance")) {
    ctx.addIssue({ code: "custom", message: "Simulation summary must match transaction funding" });
  }
});

const simulationGasCostSummarySchema = z.object({
  computationCostRaw: makeRawU64StringSchema("computationCostRaw"),
  storageCostRaw: makeRawU64StringSchema("storageCostRaw"),
  storageRebateRaw: makeRawU64StringSchema("storageRebateRaw"),
  nonRefundableStorageFeeRaw: makeRawU64StringSchema("nonRefundableStorageFeeRaw")
}).strict();

export const reviewTimeSimulationEvidenceSchema = z.object({
  evidenceVersion: z.literal(REVIEW_TIME_SIMULATION_EVIDENCE_VERSION),
  materialId: z.string().min(1),
  reviewSessionId: z.string().min(1),
  planId: z.string().min(1),
  account: normalizedSuiAddressSchema,
  transactionDigest: suiTransactionDigestSchema,
  kind: z.literal("review_time_simulation"),
  provider: z.literal(REVIEW_TIME_SIMULATION_PROVIDER),
  network: z.literal("sui:mainnet"),
  checksEnabled: z.literal(true),
  requiredFields: z.array(simulationRequiredFieldSchema).min(WALLET_REVIEW_REQUIRED_SIMULATION_FIELDS.length),
  missingFields: z.array(simulationRequiredFieldSchema).default([]),
  status: z.literal("success"),
  simulatedAt: isoUtcStringSchema,
  expiresAt: isoUtcStringSchema,
  effects: z.object({
    transactionDigest: suiTransactionDigestSchema,
    gasCostSummary: simulationGasCostSummarySchema,
    changedObjectCount: z.number().int().min(0)
  }).strict(),
  balanceChanges: z.array(simulationBalanceChangeSchema),
  objectChanges: z.array(simulationObjectChangeSchema),
  transaction: simulationTransactionSummarySchema
}).strict().superRefine((value, ctx) => {
  if (!WALLET_REVIEW_REQUIRED_SIMULATION_FIELDS.every((field) => value.requiredFields.includes(field))) {
    ctx.addIssue({
      code: "custom",
      path: ["requiredFields"],
      message: "review-time simulation evidence must include every required simulation field"
    });
  }
  if (value.missingFields.length !== 0) {
    ctx.addIssue({
      code: "custom",
      path: ["missingFields"],
      message: "successful review-time simulation evidence must not have missing fields"
    });
  }
  if (value.effects.transactionDigest !== value.transactionDigest) {
    ctx.addIssue({
      code: "custom",
      path: ["effects", "transactionDigest"],
      message: "simulation effects transaction digest must match evidence transactionDigest"
    });
  }
  if (value.effects.changedObjectCount !== value.objectChanges.length) {
    ctx.addIssue({
      code: "custom",
      path: ["effects", "changedObjectCount"],
      message: "simulation changedObjectCount must match objectChanges length"
    });
  }
});

export type ReviewTimeSimulationEvidence = z.infer<typeof reviewTimeSimulationEvidenceSchema>;

export type ReviewTimeSimulationClient = {
  transactionExecutionService: {
    simulateTransaction(input: GrpcTypes.SimulateTransactionRequest): PromiseLike<{ response: GrpcTypes.SimulateTransactionResponse }>;
  };
};

export type ReviewTimeSimulationProducerInput = {
  minimumOutputGuard?: ReviewedOutputGuard | undefined;
  transactionMaterial: LocalTransactionMaterialHandle;
  transactionMaterialDigest: LocalTransactionMaterialDigestCommitment;
  now: Date;
  clock?: () => Date;
};

export type ReviewTimeSimulationProducerOutcome =
  | {
      status: "completed";
      evidence: ReviewTimeSimulationEvidence;
      checks: ReviewCheck[];
    }
  | {
      status: "blocked";
      blockedReason: BlockedReason;
      checks: [ReviewCheck, ...ReviewCheck[]];
    }
  | {
      status: "refresh_required";
      refreshReason: "quote_stale" | "quote_unavailable" | "simulation_transient_failure";
      checks: [ReviewCheck, ...ReviewCheck[]];
    };

export type ReviewTimeSimulationProducer = (
  input: ReviewTimeSimulationProducerInput
) => ReviewTimeSimulationProducerOutcome | Promise<ReviewTimeSimulationProducerOutcome>;

export type ReviewTimeSimulationProducerOptions = {
  client: ReviewTimeSimulationClient;
  materialStore: Pick<LocalTransactionMaterialStore, "getTransactionMaterial">;
  network: "mainnet";
  chainIdentifier: string;
  expectedChainIdentifier: string;
};

export function parseReviewTimeSimulationEvidence(
  value: ReviewTimeSimulationEvidence
): ReviewTimeSimulationEvidence {
  return reviewTimeSimulationEvidenceSchema.parse(value);
}

export function verifyReviewTimeSimulationEvidence(input: {
  transactionMaterial: LocalTransactionMaterialHandle;
  transactionMaterialDigest: LocalTransactionMaterialDigestCommitment;
  evidence: ReviewTimeSimulationEvidence;
  now?: Date | undefined;
} & ({ transactionBytes: Uint8Array } | { verifiedMaterial: Awaited<ReturnType<typeof verifyLocalTransactionMaterialArtifacts>> })): ReviewTimeSimulationEvidence {
  const evidence = parseReviewTimeSimulationEvidence(input.evidence);
  assertTransactionFundingMatches(describeTransactionFunding("verifiedMaterial" in input ? input.verifiedMaterial.transactionData : Transaction.from(input.transactionBytes).getData(), input.transactionMaterial.account, evidence.transaction.funding.chainIdentifier), evidence.transaction.funding);
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new Error("now must be a valid Date");
  }

  if (
    evidence.materialId !== input.transactionMaterial.materialId ||
    evidence.reviewSessionId !== input.transactionMaterial.reviewSessionId ||
    evidence.planId !== input.transactionMaterial.planId ||
    evidence.account !== input.transactionMaterial.account ||
    evidence.expiresAt !== input.transactionMaterial.expiresAt ||
    evidence.transactionDigest !== input.transactionMaterialDigest.transactionDigest
  ) {
    throw new Error("review-time simulation evidence must match material and digest identity");
  }

  if (
    input.transactionMaterialDigest.materialId !== input.transactionMaterial.materialId ||
    input.transactionMaterialDigest.reviewSessionId !== input.transactionMaterial.reviewSessionId ||
    input.transactionMaterialDigest.planId !== input.transactionMaterial.planId ||
    input.transactionMaterialDigest.account !== input.transactionMaterial.account ||
    input.transactionMaterialDigest.expiresAt !== input.transactionMaterial.expiresAt
  ) {
    throw new Error("transaction material digest must match material identity before review-time simulation evidence is accepted");
  }

  const materialCreatedAtMs = Date.parse(input.transactionMaterial.createdAt);
  const simulatedAtMs = Date.parse(evidence.simulatedAt);
  const expiresAtMs = Date.parse(evidence.expiresAt);
  if (simulatedAtMs < materialCreatedAtMs || simulatedAtMs > nowMs || simulatedAtMs >= expiresAtMs) {
    throw new Error("review-time simulation simulatedAt must be between material creation, now, and material expiry");
  }
  if (expiresAtMs <= nowMs) {
    throw new Error("review-time simulation evidence must not be expired");
  }
  if (evidence.transaction.sender !== evidence.account) {
    throw new Error("review-time simulation transaction sender must match reviewed account");
  }

  assertNoForbiddenMcpFields(evidence);
  return evidence;
}

export function publicTransactionSimulationSummaryFromEvidence(
  evidenceInput: ReviewTimeSimulationEvidence
): SuccessfulTransactionSimulationSummary {
  const evidence = parseReviewTimeSimulationEvidence(evidenceInput);
  const summary: SuccessfulTransactionSimulationSummary = {
    provider: evidence.provider,
    checksEnabled: evidence.checksEnabled,
    success: true,
    gasCostSummary: { ...evidence.effects.gasCostSummary },
    balanceChanges: evidence.balanceChanges.map((change) => ({ ...change })),
    objectChanges: evidence.objectChanges.map((change) => ({ ...change }))
  };
  assertNoForbiddenMcpFields(summary);
  return summary;
}

export function createReviewTimeSimulationProducer(
  options: ReviewTimeSimulationProducerOptions
): ReviewTimeSimulationProducer {
  return async (input) => {
    if (options.network !== "mainnet" || options.chainIdentifier !== options.expectedChainIdentifier) {
      return {
        status: "blocked",
        blockedReason: "network_mismatch",
        checks: [
          failReviewCheck(
            "review_time_simulation_network_mismatch",
            "Review-time simulation network",
            "Review-time simulation requires a verified Sui mainnet gRPC endpoint and matching mainnet chain identifier.",
            "network"
          )
        ]
      };
    }

    let parsed;
    try {
      parsed = await verifyLocalTransactionMaterialArtifacts({
        materialStore: options.materialStore,
        transactionMaterial: input.transactionMaterial,
        transactionMaterialDigest: input.transactionMaterialDigest,
        now: input.now
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Stored transaction material could not be verified.";
      const check = failReviewCheck(
        "review_time_simulation_material_unavailable",
        "Review-time simulation material",
        message,
        "adapter"
      );
      if (error instanceof LocalTransactionMaterialStoreError && /expired|unavailable/i.test(message)) {
        return { status: "refresh_required", refreshReason: "quote_stale", checks: [check] };
      }
      return { status: "blocked", blockedReason: "object_resolution_failed", checks: [check] };
    }

    const material = options.materialStore.getTransactionMaterial(parsed.transactionMaterial, input.clock?.() ?? input.now);
    if (!material || !Buffer.from(parsed.transactionBytes).equals(material.transactionBytes)) {
      return {
        status: "refresh_required",
        refreshReason: "quote_stale",
        checks: [
          failReviewCheck(
            "review_time_simulation_material_unavailable",
            "Review-time simulation material",
            "Review-time simulation could not run because the stored local transaction material is unavailable or expired.",
            "adapter"
          )
        ]
      };
    }

    let simulationResult;
    try {
      const result = await options.client.transactionExecutionService.simulateTransaction({
        transaction: { bcs: { value: material.transactionBytes } },
        checks: GrpcTypes.SimulateTransactionRequest_TransactionChecks.ENABLED,
        // With false, the node may inject mock gas for empty payments. A fully
        // specified BCS transaction stays immutable: verify returned bytes below.
        doGasSelection: true,
        readMask: { paths: ["transaction.transaction.bcs", "transaction.effects", "transaction.balance_changes",
          "transaction.objects.objects.object_id", "transaction.objects.objects.object_type"] }
      });
      simulationResult = result.response.transaction;
    } catch (error) {
      const classification = classifySimulationException(error);
      if (classification.status === "refresh_required") {
        return {
          status: "refresh_required",
          refreshReason: "simulation_transient_failure",
          checks: [
            failReviewCheck(
              "review_time_simulation_transient_failure",
              "Review-time simulation",
              "Sui simulation did not return a result because the connection failed or timed out.",
              "simulation"
            )
          ]
        };
      }
      return {
        status: "blocked",
        blockedReason: classification.blockedReason,
        checks: [
          failReviewCheck(
            "review_time_simulation_exception_blocked",
            "Review-time simulation",
            "Simulation could not be completed. This error was not classified as a temporary connection problem. The transaction, simulation request or adapter needs to be checked before wallet approval can be offered.",
            "simulation"
          )
        ]
      };
    }

    const observedAt = input.clock?.() ?? input.now;
    if (observedAt.getTime() >= Date.parse(material.expiresAt)) {
      return { status: "refresh_required", refreshReason: "quote_stale", checks: [
        failReviewCheck("review_time_simulation_quote_expired", "Quote expired", "The quote expired while awaiting simulation.", "quote")
      ] };
    }
    const simulatedTransaction = simulationResult;
    if (!simulatedTransaction?.effects?.status || typeof simulatedTransaction.effects.status.success !== "boolean") {
      return {
        status: "blocked",
        blockedReason: "object_resolution_failed",
        checks: [failReviewCheck(
          "review_time_simulation_result_invalid",
          "Review-time simulation",
          INVALID_SIMULATION_EVIDENCE_MESSAGE,
          "simulation"
        )]
      };
    }
    if (simulatedTransaction.effects.status.success === false) {
      const failureKind = simulatedTransaction.effects.status.error?.kind;
      const failedCommand = simulatedTransaction.effects.status.error?.command;
      const guard = input.minimumOutputGuard;
      const detail = simulatedTransaction.effects.status.error?.errorDetails;
      const abort = detail?.oneofKind === "abort" ? detail.abort : undefined;
      const digest = input.transactionMaterialDigest.transactionDigest;
      const returnedBytes = simulatedTransaction.transaction?.bcs?.value;
      if (simulatedTransaction.effects.transactionDigest === digest && returnedBytes instanceof Uint8Array &&
          Buffer.from(material.transactionBytes).equals(returnedBytes) && failedCommand !== undefined && guard?.transactionDigest === digest && (
          (guard.commandFailure === "InsufficientCoinBalance" && Number(failedCommand) === guard.commandIndex && failureKind === GrpcTypes.ExecutionError_ExecutionErrorKind.INSUFFICIENT_COIN_BALANCE) ||
          (failureKind === GrpcTypes.ExecutionError_ExecutionErrorKind.MOVE_ABORT && matchesMinimumAbort(guard, digest,
            Number(failedCommand), abort?.location?.package, abort?.location?.module, abort?.abortCode?.toString())))) {
        return { status: "refresh_required", refreshReason: "quote_unavailable", checks: [
          failReviewCheck("minimum_output_not_met", "Minimum receive amount not reached",
            "The checked transaction received less than the reviewed minimum. Refresh to obtain a new quote.", "simulation")
        ] };
      }
      const failureReason = failureKind === GrpcTypes.ExecutionError_ExecutionErrorKind.INSUFFICIENT_GAS
        ? "The checked simulation reported insufficient gas."
        : failureKind === GrpcTypes.ExecutionError_ExecutionErrorKind.INSUFFICIENT_COIN_BALANCE
          ? "The checked simulation reported insufficient coin balance."
          : "The checked simulation rejected the transaction. No transaction was signed or submitted.";
      const checks: [ReviewCheck, ...ReviewCheck[]] = [
        failReviewCheck(
          "review_time_simulation_result_failed",
          "Review-time simulation",
          `Review-time simulation did not succeed: ${failureReason}`,
          "simulation"
        )
      ];
      return {
        status: "blocked",
        blockedReason: blockedReasonForSimulationFailure(failureKind),
        checks
      };
    }

    let evidence;
    try {
      evidence = createReviewTimeSimulationEvidenceFromTransaction({
        transactionMaterial: parsed.transactionMaterial,
        transactionMaterialDigest: parsed.transactionMaterialDigest,
        recomputedTransactionDigest: parsed.transactionMaterialDigest.transactionDigest,
        verifiedData: parsed.transactionData,
        chainIdentifier: options.chainIdentifier,
        transaction: simulatedTransaction,
        submittedBytes: material.transactionBytes,
        simulatedAt: observedAt
      });
      verifyReviewTimeSimulationEvidence({
        transactionMaterial: parsed.transactionMaterial,
        transactionMaterialDigest: parsed.transactionMaterialDigest,
        evidence,
        verifiedMaterial: parsed,
        now: observedAt
      });
    } catch {
      return {
        status: "blocked",
        blockedReason: "object_resolution_failed",
        checks: [
          failReviewCheck(
            "review_time_simulation_result_invalid",
            "Review-time simulation",
            INVALID_SIMULATION_EVIDENCE_MESSAGE,
            "simulation"
          )
        ]
      };
    }

    return {
      status: "completed",
      evidence,
      checks: [
        passReviewCheck(
          "review_time_simulation_evidence",
          "Review-time simulation",
          "Simulated this exact stored transaction with validation checks enabled. The effects, balance changes and objects describe that simulation, not an actual transaction result. They do not authorize wallet approval or guarantee execution.",
          "simulation"
        )
      ]
    };
  };
}

function createReviewTimeSimulationEvidenceFromTransaction(input: {
  transactionMaterial: LocalTransactionMaterialHandle;
  transactionMaterialDigest: LocalTransactionMaterialDigestCommitment;
  recomputedTransactionDigest: string;
  verifiedData: ReturnType<Transaction["getData"]>;
  chainIdentifier: string;
  submittedBytes: Uint8Array;
  transaction: GrpcTypes.ExecutedTransaction;
  simulatedAt: Date;
}): ReviewTimeSimulationEvidence {
  const tx = input.transaction;
  if (input.recomputedTransactionDigest !== input.transactionMaterialDigest.transactionDigest ||
      (tx.digest !== undefined && tx.digest !== input.recomputedTransactionDigest)) {
    throw new Error("simulation transaction digest must match stored material");
  }
  const returnedBytes = tx.transaction?.bcs?.value;
  if (!(returnedBytes instanceof Uint8Array) || !Buffer.from(input.submittedBytes).equals(returnedBytes)) {
    throw new Error("simulation must return exactly the submitted transaction bytes");
  }
  if (!tx.effects || tx.effects.transactionDigest !== input.recomputedTransactionDigest) {
    throw new Error("simulated effects digest must match the stored material digest");
  }
  if (!Array.isArray(tx.balanceChanges) || !tx.objects || !Array.isArray(tx.objects.objects)) {
    throw new Error("simulation is missing balance changes or object type evidence");
  }
  const objectTypes = new Map(tx.objects.objects.map((object) => {
    if (typeof object.objectType !== "string" || !object.objectType) throw new Error("simulation object type is missing");
    return [normalizeSimulationAddress(object.objectId!, "object type id"), object.objectType];
  }));
  const gas = tx.effects.gasUsed;
  const objectChanges = tx.effects.changedObjects.map((change) => ({
    objectId: normalizeSimulationAddress(change.objectId!, "object change id"),
    ...(objectTypes.has(change.objectId!) ? { objectType: objectTypes.get(change.objectId!)! } : {}),
    inputState: simulationEnum(GrpcTypes.ChangedObject_InputObjectState, change.inputState),
    outputState: simulationEnum(GrpcTypes.ChangedObject_OutputObjectState, change.outputState),
    idOperation: simulationEnum(GrpcTypes.ChangedObject_IdOperation, change.idOperation)
  }));
  return reviewTimeSimulationEvidenceSchema.parse({
    evidenceVersion: REVIEW_TIME_SIMULATION_EVIDENCE_VERSION,
    materialId: input.transactionMaterial.materialId, reviewSessionId: input.transactionMaterial.reviewSessionId,
    planId: input.transactionMaterial.planId, account: input.transactionMaterial.account,
    transactionDigest: input.recomputedTransactionDigest, kind: "review_time_simulation",
    provider: REVIEW_TIME_SIMULATION_PROVIDER, network: "sui:mainnet", checksEnabled: true,
    requiredFields: [...WALLET_REVIEW_REQUIRED_SIMULATION_FIELDS], missingFields: [], status: "success",
    simulatedAt: input.simulatedAt.toISOString(), expiresAt: input.transactionMaterial.expiresAt,
    effects: { transactionDigest: tx.effects.transactionDigest, gasCostSummary: summarizeGasCost({
      computationCost: gas?.computationCost?.toString()!, storageCost: gas?.storageCost?.toString()!,
      storageRebate: gas?.storageRebate?.toString()!, nonRefundableStorageFee: gas?.nonRefundableStorageFee?.toString()!
    }), changedObjectCount: objectChanges.length },
    balanceChanges: tx.balanceChanges.map((change) => ({ address: normalizeSimulationAddress(change.address!, "balance change address"),
      coinType: normalizeCoinType(change.coinType!), amount: change.amount })), objectChanges,
    transaction: summarizeSimulatedTransaction(input.verifiedData, input.transactionMaterial.account, input.chainIdentifier)
  });
}

// Preserve the established simulation labels while reading the SDK's public
// protobuf enums. Missing state is malformed evidence, not a guessed state.
function simulationEnum(values: Record<number, string>, value: number | undefined): string {
  if (value === undefined || values[value] === undefined) throw new Error("simulation object state is missing");
  const name = values[value]!;
  if (name === "ACCUMULATOR_WRITE") return "AccumulatorWriteV1";
  if (name === "ID_OPERATION_UNKNOWN") return "None";
  return name.split("_").map((word) => word[0] + word.slice(1).toLowerCase()).join("");
}

function summarizeGasCost(gasUsed: SuiClientTypes.GasCostSummary): ReviewTimeSimulationEvidence["effects"]["gasCostSummary"] {
  const computationCost = parseRawU64(gasUsed.computationCost, "computationCost");
  const storageCost = parseRawU64(gasUsed.storageCost, "storageCost");
  const storageRebate = parseRawU64(gasUsed.storageRebate, "storageRebate");
  const nonRefundableStorageFee = parseRawU64(gasUsed.nonRefundableStorageFee, "nonRefundableStorageFee");
  return {
    computationCostRaw: computationCost.toString(),
    storageCostRaw: storageCost.toString(),
    storageRebateRaw: storageRebate.toString(),
    nonRefundableStorageFeeRaw: nonRefundableStorageFee.toString()
  };
}

function summarizeSimulatedTransaction(
  transaction: SuiClientTypes.TransactionData, account: string, chainIdentifier: string
): ReviewTimeSimulationEvidence["transaction"] {
  if (transaction.sender === null || transaction.sender === undefined) {
    throw new Error("simulation transaction sender is missing");
  }
  const sender = normalizeSimulationAddress(transaction.sender, "transaction sender");
  const gasData = transaction.gasData as {
    payment?: unknown[] | null;
    budget?: string | number | null;
    price?: string | number | null;
  };
  return {
    sender,
    funding: describeTransactionFunding(transaction, account, chainIdentifier),
    gasPaymentCount: Array.isArray(gasData.payment) ? gasData.payment.length : 0,
    inputCount: transaction.inputs.length,
    commandCount: transaction.commands.length,
    ...(gasData.budget === null || gasData.budget === undefined
      ? {}
      : { gasBudgetRaw: parseRawU64(String(gasData.budget), "gasBudgetRaw").toString() }),
    ...(gasData.price === null || gasData.price === undefined
      ? {}
      : { gasPriceRaw: parseRawU64(String(gasData.price), "gasPriceRaw").toString() })
  };
}

function normalizeSimulationAddress(value: string, label: string): string {
  const normalized = parseSuiAddress(value);
  if (!normalized) {
    throw new Error(`simulation ${label} must be a valid Sui address`);
  }
  return normalized;
}

function blockedReasonForSimulationFailure(kind: GrpcTypes.ExecutionError_ExecutionErrorKind | undefined): BlockedReason {
  if (kind === GrpcTypes.ExecutionError_ExecutionErrorKind.INSUFFICIENT_GAS) {
    return "insufficient_gas";
  }
  if (kind === GrpcTypes.ExecutionError_ExecutionErrorKind.INSUFFICIENT_COIN_BALANCE) {
    return "insufficient_balance";
  }
  return "object_resolution_failed";
}

type SimulationExceptionClassification =
  | { status: "refresh_required" }
  | { status: "blocked"; blockedReason: BlockedReason };

function classifySimulationException(error: unknown): SimulationExceptionClassification {
  if (isTransientSimulationException(error)) {
    return { status: "refresh_required" };
  }
  return { status: "blocked", blockedReason: "object_resolution_failed" };
}

function isTransientSimulationException(error: unknown): boolean {
  const code = errorCode(error);
  if (
    code === "UNAVAILABLE" ||
    code === "DEADLINE_EXCEEDED" ||
    code === "RESOURCE_EXHAUSTED" ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === 4 ||
    code === 8 ||
    code === 14
  ) {
    return true;
  }

  const message = errorMessage(error).toLowerCase();
  if (message.length === 0) {
    return false;
  }

  return [
    /\b(grpc|rpc|transport|network|endpoint|connection|connect|socket|fetch)\b[\s\S]{0,80}\b(unavailable|timeout|timed out|deadline|reset|refused|failed|hang up|exhausted)\b/,
    /\b(unavailable|timeout|timed out|deadline exceeded|temporarily unavailable|service unavailable|gateway timeout|too many requests)\b[\s\S]{0,80}\b(grpc|rpc|transport|network|endpoint|connection|connect|socket|fetch)\b/,
    /\b(econnreset|econnrefused|etimedout|enotfound|eai_again|socket hang up|fetch failed|network error|deadline exceeded|request timeout|service unavailable|gateway timeout|too many requests)\b/
  ].some((pattern) => pattern.test(message));
}

function errorCode(error: unknown): string | number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const value = (error as { code?: unknown; status?: unknown }).code ??
    (error as { status?: unknown }).status;
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return "";
}
