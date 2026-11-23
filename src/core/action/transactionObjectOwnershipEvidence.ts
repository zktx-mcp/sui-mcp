import type { verifyLocalTransactionMaterialArtifacts } from "../session/transactionMaterialStore.js";
import { Transaction } from "@mysten/sui/transactions";
import { transactionFundingEvidenceSchema, describeTransactionFunding, assertTransactionFundingMatches } from "./transactionFunding.js";
import { z } from "zod";
import { isValidStructTag, normalizeStructTag } from "@mysten/sui/utils";
import {
  adapterEvidenceClaimSchema,
  adapterGasObjectOwnershipLinkSchema,
  adapterObjectOwnershipEvidenceSchema,
  adapterSourceOfTruthSchema,
  SUI_GAS_COIN_TYPE,
  type AdapterEvidenceClaim,
  type AdapterGasObjectOwnershipLink,
  type AdapterObjectOwnershipEvidence,
  type AdapterSourceOfTruth
} from "./signableAdapterContract.js";
import {
  normalizedSuiAddressSchema,
  suiTransactionDigestSchema
} from "../suiAddress.js";
import type {
  LocalTransactionMaterialDigestCommitment,
  LocalTransactionMaterialHandle
} from "../session/transactionMaterialStore.js";

export const TRANSACTION_OBJECT_OWNERSHIP_EVIDENCE_VERSION =
  "transaction-object-ownership-v2";

export const TRANSACTION_OBJECT_ROLES = [
  "gas_object",
  "imm_or_owned_object",
  "shared_object",
  "receiving_object"
] as const;

export const TRANSACTION_OBJECT_OWNERSHIP_STATUSES = [
  "owned_by_account",
  "not_owned_by_account",
  "shared_object",
  "immutable_object",
  "object_owner",
  "consensus_address_owner",
  "unknown_owner"
] as const;

export type TransactionObjectRole = (typeof TRANSACTION_OBJECT_ROLES)[number];
export type TransactionObjectOwnership = (typeof TRANSACTION_OBJECT_OWNERSHIP_STATUSES)[number];

const isoUtcStringSchema = z.string().refine((value) => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}, "Expected ISO 8601 UTC timestamp");

const moveStructTagSchema = z.string().min(1).max(512).refine(
  (value) => isValidStructTag(value),
  "Expected valid Move struct tag"
).transform((value) => normalizeStructTag(value));

export const transactionObjectOwnershipFactSchema = z.object({
  objectId: normalizedSuiAddressSchema,
  roles: z.array(z.enum(TRANSACTION_OBJECT_ROLES)).min(1),
  ownership: z.enum(TRANSACTION_OBJECT_OWNERSHIP_STATUSES),
  ownerKind: z.string().min(1).max(80),
  ownerAccount: normalizedSuiAddressSchema.optional(),
  objectType: moveStructTagSchema,
  source: z.literal("stored_transaction_data_and_mainnet_object_read")
}).strict().superRefine((value, ctx) => {
  if (new Set(value.roles).size !== value.roles.length) {
    ctx.addIssue({
      code: "custom",
      path: ["roles"],
      message: "roles must be unique"
    });
  }
});

export type TransactionObjectOwnershipFact = z.infer<typeof transactionObjectOwnershipFactSchema>;

export const transactionObjectOwnershipEvidenceSchema = z.object({
  evidenceVersion: z.literal(TRANSACTION_OBJECT_OWNERSHIP_EVIDENCE_VERSION),
  materialId: z.string().min(1),
  reviewSessionId: z.string().min(1),
  planId: z.string().min(1),
  account: normalizedSuiAddressSchema,
  transactionDigest: suiTransactionDigestSchema,
  funding: transactionFundingEvidenceSchema,
  objectCount: z.number().int().min(1),
  objects: z.array(transactionObjectOwnershipFactSchema).min(1),
  verifiedAt: isoUtcStringSchema,
  expiresAt: isoUtcStringSchema
}).strict().superRefine((value, ctx) => {
  if (value.account !== value.funding.sender) {
    ctx.addIssue({ code: "custom", path: ["funding", "sender"], message: "Funding must match the ownership account" });
  }
  if (value.objectCount !== value.objects.length) {
    ctx.addIssue({
      code: "custom",
      path: ["objectCount"],
      message: "objectCount must equal objects.length"
    });
  }
  if (new Set(value.objects.map((object) => object.objectId)).size !== value.objects.length) {
    ctx.addIssue({
      code: "custom",
      path: ["objects"],
      message: "objects must have unique objectId values"
    });
  }
  const verifiedAtMs = Date.parse(value.verifiedAt);
  const expiresAtMs = Date.parse(value.expiresAt);
  if (expiresAtMs <= verifiedAtMs) {
    ctx.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "expiresAt must be after verifiedAt"
    });
  }
});

export type TransactionObjectOwnershipEvidence = z.infer<typeof transactionObjectOwnershipEvidenceSchema>;

export type SuiCoinObjectTypeParse =
  | {
      status: "coin";
      objectType: string;
      coinType: string;
    }
  | {
      status: "not_coin";
    };

export function parseSuiCoinObjectType(objectType: string): SuiCoinObjectTypeParse {
  if (!isValidStructTag(objectType)) {
    return { status: "not_coin" };
  }
  const normalized = normalizeStructTag(objectType);
  const coinPrefix = `${normalizeStructTag("0x2::coin::Coin<0x2::sui::SUI>").split("<")[0]}<`;
  if (!normalized.startsWith(coinPrefix) || !normalized.endsWith(">")) {
    return { status: "not_coin" };
  }
  const coinType = normalized.slice(coinPrefix.length, -1);
  if (!isValidStructTag(coinType)) {
    return { status: "not_coin" };
  }
  return {
    status: "coin",
    objectType: normalized,
    coinType: normalizeStructTag(coinType)
  };
}

export function parseTransactionObjectOwnershipEvidence(
  value: TransactionObjectOwnershipEvidence
): TransactionObjectOwnershipEvidence {
  return transactionObjectOwnershipEvidenceSchema.parse(value);
}

export function verifyTransactionObjectOwnershipEvidence(input: {
  transactionMaterial: LocalTransactionMaterialHandle;
  transactionMaterialDigest: LocalTransactionMaterialDigestCommitment;
  evidence: TransactionObjectOwnershipEvidence;
  now?: Date | undefined;
} & ({ transactionBytes: Uint8Array } | { verifiedMaterial: Awaited<ReturnType<typeof verifyLocalTransactionMaterialArtifacts>> })): TransactionObjectOwnershipEvidence {
  const evidence = parseTransactionObjectOwnershipEvidence(input.evidence);
  assertTransactionFundingMatches(describeTransactionFunding("verifiedMaterial" in input ? input.verifiedMaterial.transactionData : Transaction.from(input.transactionBytes).getData(), input.transactionMaterial.account, evidence.funding.chainIdentifier), evidence.funding);
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
    throw new Error("transaction object ownership evidence must match material and digest identity");
  }

  if (
    input.transactionMaterialDigest.materialId !== input.transactionMaterial.materialId ||
    input.transactionMaterialDigest.reviewSessionId !== input.transactionMaterial.reviewSessionId ||
    input.transactionMaterialDigest.planId !== input.transactionMaterial.planId ||
    input.transactionMaterialDigest.account !== input.transactionMaterial.account ||
    input.transactionMaterialDigest.expiresAt !== input.transactionMaterial.expiresAt
  ) {
    throw new Error("transaction material digest must match material identity before ownership evidence is accepted");
  }

  const materialCreatedAtMs = Date.parse(input.transactionMaterial.createdAt);
  const verifiedAtMs = Date.parse(evidence.verifiedAt);
  const expiresAtMs = Date.parse(evidence.expiresAt);
  if (verifiedAtMs < materialCreatedAtMs || verifiedAtMs > nowMs || verifiedAtMs >= expiresAtMs) {
    throw new Error("transaction object ownership verifiedAt must be between material creation, now, and material expiry");
  }
  if (expiresAtMs <= nowMs) {
    throw new Error("transaction object ownership evidence must not be expired");
  }
  const contractMapping = mapTransactionObjectOwnershipEvidenceToContractDraft(evidence);
  if (contractMapping.status === "unsupported") {
    throw new Error(`transaction object ownership evidence is not contract-mappable: ${contractMapping.reason}`);
  }

  return evidence;
}

export type ObjectOwnershipContractMapping =
  | {
      status: "mapped";
      sourceReferences: AdapterSourceOfTruth;
      evidenceClaims: Array<Extract<AdapterEvidenceClaim, { factKind: "object_ownership" }>>;
      objectOwnership: AdapterObjectOwnershipEvidence;
      gasObjectOwnershipLinks: AdapterGasObjectOwnershipLink[];
    }
  | {
      status: "unsupported";
      reason: string;
      objectId: string;
      roles: TransactionObjectRole[];
      ownership: TransactionObjectOwnership;
    };

export function mapTransactionObjectOwnershipEvidenceToContractDraft(
  evidenceInput: TransactionObjectOwnershipEvidence
): ObjectOwnershipContractMapping {
  const evidence = parseTransactionObjectOwnershipEvidence(evidenceInput);
  const sourceEvidenceId = "tx_object_ownership_source";
  const claims: Array<Extract<AdapterEvidenceClaim, { factKind: "object_ownership" }>> = [];
  const objects: AdapterObjectOwnershipEvidence["objects"] = [];
  const gasObjectOwnershipLinks: AdapterGasObjectOwnershipLink[] = [];

  for (const [index, object] of evidence.objects.entries()) {
    const mapped = mapOwnershipFactForContract(object);
    if (mapped.status === "unsupported") {
      return {
        ...mapped,
        objectId: object.objectId,
        roles: object.roles,
        ownership: object.ownership
      };
    }
    const evidenceClaimId = `tx_object_ownership:${index}`;
    claims.push(adapterEvidenceClaimSchema.parse({
      id: evidenceClaimId,
      factKind: "object_ownership",
      sourceEvidenceId,
      objectId: object.objectId,
      ownerAccount: evidence.account,
      ownership: mapped.ownership
    }) as Extract<AdapterEvidenceClaim, { factKind: "object_ownership" }>);
    objects.push({
      objectId: object.objectId,
      role: mapped.role,
      ownership: mapped.ownership,
      evidenceClaimId
    });
    if (mapped.role === "gas_coin" && mapped.ownership === "owned_by_account") {
      gasObjectOwnershipLinks.push(adapterGasObjectOwnershipLinkSchema.parse({
        objectId: object.objectId,
        ownerAccount: evidence.account,
        ownershipClaimId: evidenceClaimId
      }));
    }
  }

  if (gasObjectOwnershipLinks.length !== evidence.funding.gasObjectIds.length ||
      gasObjectOwnershipLinks.some((link) => !evidence.funding.gasObjectIds.includes(link.objectId)) ||
      (gasObjectOwnershipLinks.length === 0 && evidence.funding.gasMode === "coin_objects")) {
    return {
      status: "unsupported",
      reason: "contract gas ownership links must cover exactly the real gas objects in the verified funding evidence",
      objectId: evidence.objects[0]?.objectId ?? "unknown",
      roles: evidence.objects[0]?.roles ?? [],
      ownership: evidence.objects[0]?.ownership ?? "unknown_owner"
    };
  }

  if (!objects.some((object) => object.role !== "gas_coin")) {
    return {
      status: "unsupported",
      reason: "contract mapping requires the full transaction object set, not gas-only ownership evidence",
      objectId: evidence.objects[0]?.objectId ?? "unknown",
      roles: evidence.objects[0]?.roles ?? [],
      ownership: evidence.objects[0]?.ownership ?? "unknown_owner"
    };
  }

  return {
    status: "mapped",
    sourceReferences: adapterSourceOfTruthSchema.parse({
      id: sourceEvidenceId,
      kind: "wallet_account_read",
      network: "sui:mainnet",
      source: "Stored local transaction data object refs plus Sui mainnet object owner reads",
      verifiedAt: evidence.verifiedAt,
      fields: ["ownerAccount", "objects"]
    }) as AdapterSourceOfTruth,
    evidenceClaims: claims,
    objectOwnership: adapterObjectOwnershipEvidenceSchema.parse({
      checkedAt: evidence.verifiedAt,
      ownerAccount: evidence.account,
      objects
    }),
    gasObjectOwnershipLinks
  };
}

function mapOwnershipFactForContract(
  fact: TransactionObjectOwnershipFact
):
  | {
      status: "mapped";
      role: AdapterObjectOwnershipEvidence["objects"][number]["role"];
      ownership: AdapterObjectOwnershipEvidence["objects"][number]["ownership"];
    }
  | {
      status: "unsupported";
      reason: string;
    } {
  if (fact.roles.includes("gas_object")) {
    const coinObject = parseSuiCoinObjectType(fact.objectType);
    return fact.ownership === "owned_by_account" &&
      coinObject.status === "coin" &&
      coinObject.coinType === SUI_GAS_COIN_TYPE
      ? { status: "mapped", role: "gas_coin", ownership: "owned_by_account" }
      : { status: "unsupported", reason: "gas objects must be owned by the connected account and be Coin<SUI> objects" };
  }
  if (fact.roles.includes("shared_object")) {
    return fact.ownership === "shared_object"
      ? { status: "mapped", role: "shared_object", ownership: "shared_object" }
      : { status: "unsupported", reason: "shared object refs must have shared ownership facts" };
  }
  if (fact.roles.includes("receiving_object")) {
    return fact.ownership === "owned_by_account"
      ? { status: "mapped", role: "receiving_object", ownership: "owned_by_account" }
      : { status: "unsupported", reason: "receiving object refs must be owned by the connected account" };
  }
  if (fact.roles.includes("imm_or_owned_object")) {
    if (fact.ownership === "immutable_object") {
      return { status: "mapped", role: "protocol_object", ownership: "immutable_or_package" };
    }
    const coinObject = parseSuiCoinObjectType(fact.objectType);
    if (fact.ownership === "owned_by_account" && coinObject.status === "coin") {
      return { status: "mapped", role: "input_coin", ownership: "owned_by_account" };
    }
    return {
      status: "unsupported",
      reason: "owned ImmOrOwnedObject refs must be Coin<T> objects before contract mapping can call them input coins"
    };
  }
  return { status: "unsupported", reason: "object ownership role is not contract-mappable" };
}
