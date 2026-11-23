import { randomUUID } from "node:crypto";
import { Transaction } from "@mysten/sui/transactions";
import { z } from "zod";
import type { UnknownRecord } from "../action/types.js";
import {
  normalizedSuiAddressSchema,
  parseSuiAddress,
  suiTransactionDigestSchema
} from "../suiAddress.js";

export const LOCAL_TRANSACTION_MATERIAL_KINDS = [
  "deepbook_swap_transaction_data"
] as const;

export const LOCAL_TRANSACTION_MATERIAL_SOURCES = [
  "sui_mcp_built",
  "sui_mcp_verified"
] as const;

export type LocalTransactionMaterialKind = (typeof LOCAL_TRANSACTION_MATERIAL_KINDS)[number];
export type LocalTransactionMaterialSource = (typeof LOCAL_TRANSACTION_MATERIAL_SOURCES)[number];

export type LocalTransactionMaterialHandle = {
  materialId: string;
  reviewSessionId: string;
  planId: string;
  account: string;
  kind: LocalTransactionMaterialKind;
  source: LocalTransactionMaterialSource;
  createdAt: string;
  expiresAt: string;
};

export type LocalTransactionMaterialDigestCommitment = {
  materialId: string;
  reviewSessionId: string;
  planId: string;
  account: string;
  kind: LocalTransactionMaterialKind;
  source: LocalTransactionMaterialSource;
  digestKind: "sui_transaction_digest";
  transactionDigest: string;
  computedAt: string;
  expiresAt: string;
};

export type LocalTransactionMaterialRecord = LocalTransactionMaterialHandle & {
  transactionBytes: Uint8Array;
  redactedDiagnostics?: UnknownRecord | undefined;
};

const localTransactionMaterialKindSchema = z.enum(LOCAL_TRANSACTION_MATERIAL_KINDS);
const localTransactionMaterialSourceSchema = z.enum(LOCAL_TRANSACTION_MATERIAL_SOURCES);
const isoUtcStringSchema = z.string().refine((value) => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}, "Expected ISO 8601 UTC timestamp");

export const localTransactionMaterialHandleSchema = z.object({
  materialId: z.string().min(1),
  reviewSessionId: z.string().min(1),
  planId: z.string().min(1),
  account: normalizedSuiAddressSchema,
  kind: localTransactionMaterialKindSchema,
  source: localTransactionMaterialSourceSchema,
  createdAt: isoUtcStringSchema,
  expiresAt: isoUtcStringSchema
}).superRefine((value, ctx) => {
  if (Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) {
    ctx.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "expiresAt must be after createdAt"
    });
  }
});

export const localTransactionMaterialDigestCommitmentSchema = z.object({
  materialId: z.string().min(1),
  reviewSessionId: z.string().min(1),
  planId: z.string().min(1),
  account: normalizedSuiAddressSchema,
  kind: localTransactionMaterialKindSchema,
  source: localTransactionMaterialSourceSchema,
  digestKind: z.literal("sui_transaction_digest"),
  transactionDigest: suiTransactionDigestSchema,
  computedAt: isoUtcStringSchema,
  expiresAt: isoUtcStringSchema
});

export function parseLocalTransactionMaterialHandle(
  value: LocalTransactionMaterialHandle
): LocalTransactionMaterialHandle {
  return localTransactionMaterialHandleSchema.parse(value);
}

export function parseLocalTransactionMaterialDigestCommitment(
  value: LocalTransactionMaterialDigestCommitment
): LocalTransactionMaterialDigestCommitment {
  return localTransactionMaterialDigestCommitmentSchema.parse(value);
}

function parseLocalTransactionMaterialArtifacts(
  value: {
    transactionMaterial: LocalTransactionMaterialHandle;
    transactionMaterialDigest: LocalTransactionMaterialDigestCommitment;
  },
  now = new Date()
): {
  transactionMaterial: LocalTransactionMaterialHandle;
  transactionMaterialDigest: LocalTransactionMaterialDigestCommitment;
} {
  const transactionMaterial = parseLocalTransactionMaterialHandle(value.transactionMaterial);
  const transactionMaterialDigest = parseLocalTransactionMaterialDigestCommitment(value.transactionMaterialDigest);
  const materialCreatedAtMs = Date.parse(transactionMaterial.createdAt);
  const materialExpiresAtMs = Date.parse(transactionMaterial.expiresAt);
  const digestComputedAtMs = Date.parse(transactionMaterialDigest.computedAt);
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new LocalTransactionMaterialStoreError("now must be a valid Date");
  }
  if (materialCreatedAtMs > nowMs) {
    throw new LocalTransactionMaterialStoreError("transaction material createdAt must not be in the future");
  }
  if (materialExpiresAtMs <= nowMs) {
    throw new LocalTransactionMaterialStoreError("transaction material must not be expired");
  }
  if (digestComputedAtMs < materialCreatedAtMs || digestComputedAtMs > nowMs) {
    throw new LocalTransactionMaterialStoreError("transaction material digest computedAt must be between createdAt and now");
  }
  if (digestComputedAtMs >= materialExpiresAtMs) {
    throw new LocalTransactionMaterialStoreError("transaction material digest must be computed before material expiry");
  }
  if (
    transactionMaterialDigest.materialId !== transactionMaterial.materialId ||
    transactionMaterialDigest.reviewSessionId !== transactionMaterial.reviewSessionId ||
    transactionMaterialDigest.planId !== transactionMaterial.planId ||
    transactionMaterialDigest.account !== transactionMaterial.account ||
    transactionMaterialDigest.kind !== transactionMaterial.kind ||
    transactionMaterialDigest.source !== transactionMaterial.source ||
    transactionMaterialDigest.expiresAt !== transactionMaterial.expiresAt
  ) {
    throw new LocalTransactionMaterialStoreError("transaction material digest must match the material handle");
  }
  return { transactionMaterial, transactionMaterialDigest };
}

export async function verifyLocalTransactionMaterialArtifacts(
  value: {
    materialStore: Pick<LocalTransactionMaterialStore, "getTransactionMaterial">;
    transactionMaterial: LocalTransactionMaterialHandle;
    transactionMaterialDigest: LocalTransactionMaterialDigestCommitment;
    now?: Date | undefined;
  }
): Promise<{
  transactionMaterial: LocalTransactionMaterialHandle;
  transactionMaterialDigest: LocalTransactionMaterialDigestCommitment;
  transactionBytes: Uint8Array;
  transactionData: ReturnType<Transaction["getData"]>;
}> {
  const now = value.now ?? new Date();
  const parsed = parseLocalTransactionMaterialArtifacts(
    {
      transactionMaterial: value.transactionMaterial,
      transactionMaterialDigest: value.transactionMaterialDigest
    },
    now
  );
  const material = value.materialStore.getTransactionMaterial(parsed.transactionMaterial, now);
  if (!material) {
    throw new LocalTransactionMaterialStoreError("transaction material is unavailable");
  }

  let transactionDigest: string, transaction: Transaction;
  try {
    transaction = Transaction.from(material.transactionBytes);
    transactionDigest = await transaction.getDigest();
  } catch {
    throw new LocalTransactionMaterialStoreError("transaction material bytes cannot produce a Sui transaction digest");
  }
  const parsedDigest = suiTransactionDigestSchema.safeParse(transactionDigest);
  if (!parsedDigest.success) {
    throw new LocalTransactionMaterialStoreError("computed transaction digest is invalid");
  }
  if (parsedDigest.data !== parsed.transactionMaterialDigest.transactionDigest) {
    throw new LocalTransactionMaterialStoreError("transaction material digest does not match stored transaction bytes");
  }

  return { ...parsed, transactionData: transaction.getData(), transactionBytes: new Uint8Array(material.transactionBytes) };
}

export type StoreLocalTransactionMaterialInput = {
  preparationId?: string | undefined;
  reviewSessionId: string;
  planId: string;
  account: string;
  kind: LocalTransactionMaterialKind;
  source: LocalTransactionMaterialSource;
  transactionBytes: Uint8Array;
  expiresAt: Date;
  redactedDiagnostics?: UnknownRecord | undefined;
};

export interface LocalTransactionMaterialStore {
  recordTransactionMaterial(
    input: StoreLocalTransactionMaterialInput,
    now?: Date
  ): LocalTransactionMaterialHandle;
  getTransactionMaterial(
    handle: LocalTransactionMaterialHandle,
    now?: Date
  ): LocalTransactionMaterialRecord | undefined;
  deleteTransactionMaterial(handle: LocalTransactionMaterialHandle): void;
  deleteReviewSessionTransactionMaterials(reviewSessionId: string): void;
}

export class LocalTransactionMaterialStoreError extends Error {
  constructor(message: string) {
    super(message);
  }
}

// Validate the store input and build the stored record (with cloned bytes). Shared
// by every LocalTransactionMaterialStore implementation so validation never drifts
// between the in-memory and SQLite backends.
export function buildTransactionMaterialRecord(
  input: StoreLocalTransactionMaterialInput,
  now: Date = new Date()
): LocalTransactionMaterialRecord {
  const account = parseSuiAddress(input.account);
  if (!account) {
    throw new LocalTransactionMaterialStoreError("Invalid transaction material account");
  }
  if (!input.reviewSessionId) {
    throw new LocalTransactionMaterialStoreError("reviewSessionId is required");
  }
  if (!input.planId) {
    throw new LocalTransactionMaterialStoreError("planId is required");
  }
  if (!LOCAL_TRANSACTION_MATERIAL_KINDS.includes(input.kind)) {
    throw new LocalTransactionMaterialStoreError("Invalid transaction material kind");
  }
  if (!LOCAL_TRANSACTION_MATERIAL_SOURCES.includes(input.source)) {
    throw new LocalTransactionMaterialStoreError("Invalid transaction material source");
  }
  if (input.transactionBytes.byteLength === 0) {
    throw new LocalTransactionMaterialStoreError("transactionBytes must not be empty");
  }
  const createdAt = now.toISOString();
  const expiresAt = input.expiresAt.toISOString();
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
    throw new LocalTransactionMaterialStoreError("expiresAt must be after createdAt");
  }
  return {
    materialId: `txmat_${randomUUID()}`,
    reviewSessionId: input.reviewSessionId,
    planId: input.planId,
    account,
    kind: input.kind,
    source: input.source,
    createdAt,
    expiresAt,
    transactionBytes: cloneBytes(input.transactionBytes),
    ...(input.redactedDiagnostics === undefined
      ? {}
      : { redactedDiagnostics: structuredClone(input.redactedDiagnostics) })
  };
}

// Project the public (redacted) handle out of a stored record.
export function toMaterialHandle(
  record: LocalTransactionMaterialRecord
): LocalTransactionMaterialHandle {
  return {
    materialId: record.materialId,
    reviewSessionId: record.reviewSessionId,
    planId: record.planId,
    account: record.account,
    kind: record.kind,
    source: record.source,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt
  };
}

export class InMemoryLocalTransactionMaterialStore implements LocalTransactionMaterialStore {
  private readonly records = new Map<string, LocalTransactionMaterialRecord>();

  recordTransactionMaterial(
    input: StoreLocalTransactionMaterialInput,
    now = new Date()
  ): LocalTransactionMaterialHandle {
    const record = buildTransactionMaterialRecord(input, now);
    this.records.set(record.materialId, record);
    return toMaterialHandle(record);
  }

  getTransactionMaterial(
    handle: LocalTransactionMaterialHandle,
    now = new Date()
  ): LocalTransactionMaterialRecord | undefined {
    const record = this.records.get(handle.materialId);
    if (!record) {
      return undefined;
    }
    if (Date.parse(record.expiresAt) <= now.getTime()) {
      this.records.delete(handle.materialId);
      return undefined;
    }
    if (!sameHandle(record, handle)) {
      return undefined;
    }
    return {
      ...record,
      transactionBytes: cloneBytes(record.transactionBytes),
      ...(record.redactedDiagnostics === undefined
        ? {}
        : { redactedDiagnostics: structuredClone(record.redactedDiagnostics) })
    };
  }

  deleteTransactionMaterial(handle: LocalTransactionMaterialHandle): void {
    const stored = this.records.get(handle.materialId);
    if (stored && sameHandle(stored, handle)) this.records.delete(handle.materialId);
  }
  deleteReviewSessionTransactionMaterials(reviewSessionId: string): void {
    for (const [materialId, record] of this.records) {
      if (record.reviewSessionId === reviewSessionId) {
        this.records.delete(materialId);
      }
    }
  }
}

export function sameHandle(
  record: LocalTransactionMaterialHandle,
  handle: LocalTransactionMaterialHandle
): boolean {
  return record.materialId === handle.materialId &&
    record.reviewSessionId === handle.reviewSessionId &&
    record.planId === handle.planId &&
    record.account === handle.account &&
    record.kind === handle.kind &&
    record.source === handle.source &&
    record.createdAt === handle.createdAt &&
    record.expiresAt === handle.expiresAt;
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}
