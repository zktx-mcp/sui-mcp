import { z } from "zod";
import { normalizeCoinType } from "../read/coinMetadata.js";
import { SUI_TYPE_ARG } from "@mysten/sui/utils";
import { makeCanonicalRawU64StringSchema } from "../numeric/rawU64.js";
import { suiAddressStringSchema, suiTransactionDigestSchema } from "../suiAddress.js";

export const REVIEW_TIME_SIMULATION_PROVIDER = "client.transactionExecutionService.simulateTransaction" as const;
// Stored public history may retain the previous provider; new review evidence uses the provider above.
export const reviewSimulationProviderSchema = z.enum(["client.core.simulateTransaction", REVIEW_TIME_SIMULATION_PROVIDER]);

export const TRANSACTION_REVIEW_SCHEMA_VERSION =
  1;
export const PTB_VISUALIZATION_CONTRACT_VERSION =
  "ptb-visualization-contract-alpha-2026-05-25";

export const WALLET_REVIEW_REQUIRED_HUMAN_FIELDS = [
  "proposedAction",
  "assetFlow",
  "recipients",
  "targets",
  "evidenceUsed",
  "missingEvidence",
  "requiredUserChoices",
  "unsupportedClaims",
  "freshness",
  "blockingChecks"
] as const;

export const WALLET_REVIEW_REQUIRED_SIMULATION_FIELDS = [
  "effects",
  "balanceChanges",
  "objectTypes",
  "transaction"
] as const;

export const WALLET_REVIEW_REQUIRED_PROHIBITED_OUTPUTS = [
  "transaction_bytes",
  "serialized_transaction",
  "wallet_signature_request",
  "private_key_material",
  "wallet_authorization",
  "signing_data",
  "signing_readiness",
  "payment_execution_readiness"
] as const;

export const PTB_VISUALIZATION_REQUIRED_UNSUPPORTED_USES = [
  "transaction_building_input",
  "wallet_authorization",
  "signing_data",
  "signing_readiness",
  "payment_execution_readiness",
  "route_recommendation"
] as const;

// The generic review contract must not load a protocol registry to name Sui gas.
export const SUI_GAS_COIN_TYPE = SUI_TYPE_ARG;
export const SUI_GAS_RAW_UNIT = "MIST";

const EXPIRY_TIMESTAMP_SOURCE_FIELDS = ["checkedAt", "expiresAt"] as const;
const EXPIRY_UNAVAILABLE_SOURCE_FIELDS = ["checkedAt", "expiryStatus"] as const;
const RAW_AMOUNT_SOURCE_FIELDS = ["rawAmount", "asset", "amountRole"] as const;
const MIN_OUT_AMOUNT_SOURCE_FIELDS = ["minOutRaw", "asset", "amountRole"] as const;
const GAS_BUDGET_AMOUNT_SOURCE_FIELDS = ["gasBudgetRaw", "asset", "amountRole"] as const;
const GAS_USED_AMOUNT_SOURCE_FIELDS = ["gasUsedRaw", "asset", "amountRole"] as const;
const GAS_UNRESOLVED_SOURCE_FIELDS = ["checkedAt", "gasResolutionStatus", "unresolvedReason"] as const;
const BALANCE_DELTA_AMOUNT_SOURCE_FIELDS = ["balanceChanges", "asset", "amountRole"] as const;
const UNIT_SOURCE_FIELDS = ["coinType", "decimals"] as const;
const QUOTE_MIN_OUT_SOURCE_FIELDS = ["quoteEvidenceId", "minOutRaw"] as const;
const USER_SLIPPAGE_POLICY_SOURCE_FIELDS = ["maxSlippageBps", "userSelection"] as const;
const ADAPTER_SLIPPAGE_POLICY_SOURCE_FIELDS = ["maxSlippageBps", "minOutRaw"] as const;
const OBJECT_OWNERSHIP_SOURCE_FIELDS = ["ownerAccount", "objects"] as const;

const ADAPTER_SOURCE_OF_TRUTH_KINDS = [
  "pinned_sdk_registry",
  "verified_mainnet_onchain_metadata",
  "wallet_account_read",
  "quote_evidence",
  "review_time_simulation",
  "validated_request_fact",
  "user_explicit_choice"
] as const;

const RAW_QUANTITY_ROLES = [
  "input",
  "expected_output",
  "minimum_output",
  "gas_budget",
  "gas_used",
  "fee",
  "balance_delta"
] as const;

const SAFETY_CRITICAL_FACT_KINDS = [
  "raw_quantity_amount",
  "unit_metadata",
  "gas_unresolved_status",
  "expiry_status",
  "quote_min_out",
  "slippage_policy",
  "object_ownership",
  "simulation_result"
] as const;

type AdapterSourceOfTruthKind = (typeof ADAPTER_SOURCE_OF_TRUTH_KINDS)[number];
type RawQuantityRole = (typeof RAW_QUANTITY_ROLES)[number];
type SafetyCriticalFactKind = (typeof SAFETY_CRITICAL_FACT_KINDS)[number];

type SourceEvidenceRequirement = {
  kinds: readonly AdapterSourceOfTruthKind[];
  fields: readonly string[];
};

const RAW_QUANTITY_AMOUNT_EVIDENCE_BY_ROLE: Record<RawQuantityRole, SourceEvidenceRequirement> = {
  input: {
    kinds: ["validated_request_fact", "wallet_account_read", "user_explicit_choice"],
    fields: RAW_AMOUNT_SOURCE_FIELDS
  },
  expected_output: {
    kinds: ["quote_evidence", "review_time_simulation"],
    fields: RAW_AMOUNT_SOURCE_FIELDS
  },
  minimum_output: {
    kinds: ["quote_evidence"],
    fields: MIN_OUT_AMOUNT_SOURCE_FIELDS
  },
  gas_budget: {
    kinds: ["review_time_simulation"],
    fields: GAS_BUDGET_AMOUNT_SOURCE_FIELDS
  },
  gas_used: {
    kinds: ["review_time_simulation"],
    fields: GAS_USED_AMOUNT_SOURCE_FIELDS
  },
  fee: {
    kinds: ["review_time_simulation"],
    fields: RAW_AMOUNT_SOURCE_FIELDS
  },
  balance_delta: {
    kinds: ["review_time_simulation"],
    fields: BALANCE_DELTA_AMOUNT_SOURCE_FIELDS
  }
} as const;

const UNIT_EVIDENCE_BY_SOURCE = {
  pinned_sdk_metadata: {
    kinds: ["pinned_sdk_registry"],
    fields: UNIT_SOURCE_FIELDS
  },
  verified_mainnet_onchain_metadata: {
    kinds: ["verified_mainnet_onchain_metadata"],
    fields: UNIT_SOURCE_FIELDS
  }
} as const satisfies Record<string, SourceEvidenceRequirement>;

const SLIPPAGE_POLICY_EVIDENCE_BY_SOURCE = {
  user_explicit: {
    kinds: ["user_explicit_choice"],
    fields: USER_SLIPPAGE_POLICY_SOURCE_FIELDS
  },
  adapter_policy_from_quote_evidence: {
    kinds: ["quote_evidence"],
    fields: ADAPTER_SLIPPAGE_POLICY_SOURCE_FIELDS
  }
} as const satisfies Record<string, SourceEvidenceRequirement>;

const GAS_UNRESOLVED_EVIDENCE_REQUIREMENT = {
  kinds: ["review_time_simulation"],
  fields: GAS_UNRESOLVED_SOURCE_FIELDS
} as const satisfies SourceEvidenceRequirement;

const QUOTE_MIN_OUT_EVIDENCE_REQUIREMENT = {
  kinds: ["quote_evidence"],
  fields: QUOTE_MIN_OUT_SOURCE_FIELDS
} as const satisfies SourceEvidenceRequirement;

const EXPIRY_EVIDENCE_REQUIREMENT = {
  kinds: ["validated_request_fact"],
  fields: EXPIRY_TIMESTAMP_SOURCE_FIELDS
} as const satisfies SourceEvidenceRequirement;

const EXPIRY_UNAVAILABLE_EVIDENCE_REQUIREMENT = {
  kinds: ["validated_request_fact"],
  fields: EXPIRY_UNAVAILABLE_SOURCE_FIELDS
} as const satisfies SourceEvidenceRequirement;

const OBJECT_OWNERSHIP_EVIDENCE_REQUIREMENT = {
  kinds: ["wallet_account_read"],
  fields: OBJECT_OWNERSHIP_SOURCE_FIELDS
} as const satisfies SourceEvidenceRequirement;

const SIMULATION_RESULT_EVIDENCE_REQUIREMENT = {
  kinds: ["review_time_simulation"],
  fields: WALLET_REVIEW_REQUIRED_SIMULATION_FIELDS
} as const satisfies SourceEvidenceRequirement;

export const SAFETY_CRITICAL_FACT_MATRIX = {
  raw_quantity_amount: {
    byRole: RAW_QUANTITY_AMOUNT_EVIDENCE_BY_ROLE
  },
  unit_metadata: {
    bySource: UNIT_EVIDENCE_BY_SOURCE
  },
  gas_unresolved_status: GAS_UNRESOLVED_EVIDENCE_REQUIREMENT,
  expiry_status: {
    current: EXPIRY_EVIDENCE_REQUIREMENT,
    expired: EXPIRY_EVIDENCE_REQUIREMENT,
    not_provided: EXPIRY_UNAVAILABLE_EVIDENCE_REQUIREMENT,
    not_applicable: EXPIRY_UNAVAILABLE_EVIDENCE_REQUIREMENT
  },
  quote_min_out: QUOTE_MIN_OUT_EVIDENCE_REQUIREMENT,
  slippage_policy: {
    bySource: SLIPPAGE_POLICY_EVIDENCE_BY_SOURCE
  },
  object_ownership: OBJECT_OWNERSHIP_EVIDENCE_REQUIREMENT,
  simulation_result: SIMULATION_RESULT_EVIDENCE_REQUIREMENT
} as const satisfies Record<SafetyCriticalFactKind, unknown>;

export const CONSUMER_INVARIANT_MATRIX = {
  gasBudgetClaimId: {
    factKind: "raw_quantity_amount",
    role: "gas_budget",
    assetCoinType: SUI_GAS_COIN_TYPE,
    rawUnit: SUI_GAS_RAW_UNIT
  },
  gasUsedClaimId: {
    factKind: "raw_quantity_amount",
    role: "gas_used",
    assetCoinType: SUI_GAS_COIN_TYPE,
    rawUnit: SUI_GAS_RAW_UNIT
  },
  gasObjectOwnershipClaimId: {
    factKind: "object_ownership",
    ownership: "owned_by_account"
  }
} as const;

const isoUtcStringSchema = z.string().refine((value) => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}, "Expected ISO 8601 UTC timestamp");

const unsignedIntegerStringSchema = makeCanonicalRawU64StringSchema("unsigned integer");

const suiObjectIdSchema = z.string().regex(/^0x[0-9a-fA-F]{1,64}$/, {
  message: "Expected a Sui object id"
});

const coinTypeSchema = z.string().min(1).max(512).refine((value) => {
  try {
    return normalizeCoinType(value) === value;
  } catch {
    return false;
  }
}, "Expected a normalized Sui struct tag coin type");
const evidenceIdSchema = z.string().min(1).max(120);

const resolvedAssetReferenceSchema = z.object({
  symbol: z.string().min(1).max(64).optional(),
  coinType: coinTypeSchema
}).strict();

const EXECUTABLE_MATERIAL_TEXT_PATTERN =
  /transaction\s*bytes?|tx\s*bytes?|serialized\s*transaction|serializedTransaction|signed\s*transaction|signing\s*request|signingRequest|wallet\s*authorization|walletAuthorization|private\s*key|privateKey|secret\s*key|secretKey|seed\s*phrase|mnemonic|suiprivkey|signature|bcs\s*transaction/i;
const LONG_HEX_OR_BASE64LIKE_PAYLOAD_PATTERN = /(?:0x[0-9a-fA-F]{160,}|[A-Za-z0-9+/_=-]{160,})/;

function displayTextWithoutExecutableMaterial(maxLength: number, fieldName: string) {
  return z.string().min(1).max(maxLength).superRefine((value, ctx) => {
    if (
      EXECUTABLE_MATERIAL_TEXT_PATTERN.test(value) ||
      LONG_HEX_OR_BASE64LIKE_PAYLOAD_PATTERN.test(value)
    ) {
      ctx.addIssue({
        code: "custom",
        message: `${fieldName} must not contain executable transaction, signing, private-key, mnemonic, or long encoded material`
      });
    }
  });
}

function missingRequiredValues(values: readonly string[], required: readonly string[]): string[] {
  const present = new Set(values);
  return required.filter((value) => !present.has(value));
}

function addMissingRequiredValuesIssue(
  ctx: z.RefinementCtx,
  values: readonly string[],
  required: readonly string[],
  path: Array<string | number>,
  label: string
): void {
  const missing = missingRequiredValues(values, required);
  if (missing.length === 0) {
    return;
  }
  ctx.addIssue({
    code: "custom",
    path,
    message: `${label} must include ${missing.join(", ")}`
  });
}

function requireAllValues(
  ctx: z.RefinementCtx,
  values: readonly string[],
  required: readonly string[],
  path: Array<string | number>,
  label: string
): void {
  addMissingRequiredValuesIssue(ctx, values, required, path, label);
}

function addMismatchIssue(
  ctx: z.RefinementCtx,
  path: Array<string | number>,
  label: string
): void {
  ctx.addIssue({
    code: "custom",
    path,
    message: `${label} must match referenced evidence claim`
  });
}

function requireEqual(
  ctx: z.RefinementCtx,
  actual: unknown,
  expected: unknown,
  path: Array<string | number>,
  label: string
): void {
  if (actual !== expected) {
    addMismatchIssue(ctx, path, label);
  }
}

function requireSameStringSet(
  ctx: z.RefinementCtx,
  actual: readonly string[],
  expected: readonly string[],
  path: Array<string | number>,
  label: string
): void {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  if (actualSet.size !== expectedSet.size) {
    addMismatchIssue(ctx, path, label);
    return;
  }
  for (const value of actualSet) {
    if (!expectedSet.has(value)) {
      addMismatchIssue(ctx, path, label);
      return;
    }
  }
}

function requireSameAsset(
  ctx: z.RefinementCtx,
  actual: z.infer<typeof resolvedAssetReferenceSchema>,
  expected: z.infer<typeof resolvedAssetReferenceSchema>,
  path: Array<string | number>,
  label: string
): void {
  if (actual.symbol !== expected.symbol || actual.coinType !== expected.coinType) {
    addMismatchIssue(ctx, path, label);
  }
}

function requireGasAsset(
  ctx: z.RefinementCtx,
  asset: z.infer<typeof resolvedAssetReferenceSchema>,
  expectedCoinType: string,
  path: Array<string | number>,
  label: string
): void {
  try {
    if (normalizeCoinType(asset.coinType) !== expectedCoinType) {
      addMismatchIssue(ctx, path, label);
    }
  } catch {
    addMismatchIssue(ctx, path, label);
  }
}

export const adapterInputProvenanceSchema = z.object({
  kind: z.enum(["natural_language_intent", "external_proposal", "mcp_action_request", "local_review_request"]),
  sourceId: z.string().min(1).max(160),
  capturedAt: isoUtcStringSchema,
  authority: z.literal("untrusted_until_review_regenerates_and_verifies"),
  userSelectionSource: z.enum(["user_explicit", "prior_user_explicit_context"]).optional()
}).strict();

export const adapterSourceOfTruthSchema = z.object({
  id: evidenceIdSchema,
  kind: z.enum(ADAPTER_SOURCE_OF_TRUTH_KINDS),
  network: z.literal("sui:mainnet"),
  source: z.string().min(1).max(240),
  verifiedAt: isoUtcStringSchema,
  fields: z.array(z.string().min(1).max(120)).min(1)
}).strict();

const rawQuantityAmountClaimSchema = z.object({
  id: evidenceIdSchema,
  factKind: z.literal("raw_quantity_amount"),
  sourceEvidenceId: evidenceIdSchema,
  role: z.enum(RAW_QUANTITY_ROLES),
  asset: resolvedAssetReferenceSchema,
  rawAmount: unsignedIntegerStringSchema
}).strict();

const unitMetadataClaimSchema = z.object({
  id: evidenceIdSchema,
  factKind: z.literal("unit_metadata"),
  sourceEvidenceId: evidenceIdSchema,
  source: z.enum(["pinned_sdk_metadata", "verified_mainnet_onchain_metadata"]),
  coinType: coinTypeSchema,
  decimals: z.number().int().min(0).max(255)
}).strict();

const gasUnresolvedStatusClaimSchema = z.object({
  id: evidenceIdSchema,
  factKind: z.literal("gas_unresolved_status"),
  sourceEvidenceId: evidenceIdSchema,
  checkedAt: isoUtcStringSchema,
  status: z.literal("unresolved"),
  reason: z.string().min(1).max(240)
}).strict();

const expiryStatusClaimSchema = z.object({
  id: evidenceIdSchema,
  factKind: z.literal("expiry_status"),
  sourceEvidenceId: evidenceIdSchema,
  checkedAt: isoUtcStringSchema,
  status: z.enum(["current", "expired", "not_provided", "not_applicable"]),
  expiresAt: isoUtcStringSchema.optional(),
  reason: z.string().min(1).max(240).optional()
}).strict();

const quoteMinOutClaimSchema = z.object({
  id: evidenceIdSchema,
  factKind: z.literal("quote_min_out"),
  sourceEvidenceId: evidenceIdSchema,
  quoteEvidenceId: z.string().min(1).max(120),
  minOutRaw: unsignedIntegerStringSchema
}).strict();

const slippagePolicyClaimSchema = z.object({
  id: evidenceIdSchema,
  factKind: z.literal("slippage_policy"),
  sourceEvidenceId: evidenceIdSchema,
  maxSlippageSource: z.literal("action_request").optional(),
  policySource: z.enum(["user_explicit", "adapter_policy_from_quote_evidence"]),
  maxSlippageBps: z.number().int().min(0).max(10_000),
  minOutRaw: unsignedIntegerStringSchema.optional()
}).strict();

const objectOwnershipClaimSchema = z.object({
  id: evidenceIdSchema,
  factKind: z.literal("object_ownership"),
  sourceEvidenceId: evidenceIdSchema,
  objectId: suiObjectIdSchema,
  ownerAccount: suiAddressStringSchema,
  ownership: z.enum(["owned_by_account", "shared_object", "immutable_or_package", "not_owned_by_account"])
}).strict();

const simulationResultClaimSchema = z.object({
  id: evidenceIdSchema,
  factKind: z.literal("simulation_result"),
  sourceEvidenceId: evidenceIdSchema,
  provider: reviewSimulationProviderSchema,
  checksEnabled: z.literal(true),
  simulatedAt: isoUtcStringSchema,
  status: z.enum(["success", "failed", "unavailable"]),
  requiredFields: z.array(z.enum(WALLET_REVIEW_REQUIRED_SIMULATION_FIELDS)).min(WALLET_REVIEW_REQUIRED_SIMULATION_FIELDS.length),
  missingFields: z.array(z.enum(WALLET_REVIEW_REQUIRED_SIMULATION_FIELDS)).default([]),
  failureReason: z.string().min(1).max(240).optional()
}).strict();

export const adapterEvidenceClaimSchema = z.discriminatedUnion("factKind", [
  rawQuantityAmountClaimSchema,
  unitMetadataClaimSchema,
  gasUnresolvedStatusClaimSchema,
  expiryStatusClaimSchema,
  quoteMinOutClaimSchema,
  slippagePolicyClaimSchema,
  objectOwnershipClaimSchema,
  simulationResultClaimSchema
]);

export const adapterRawQuantitySchema = z.object({
  id: evidenceIdSchema,
  role: z.enum(RAW_QUANTITY_ROLES),
  asset: resolvedAssetReferenceSchema,
  rawAmount: unsignedIntegerStringSchema,
  unit: z.object({
    decimals: z.number().int().min(0).max(255),
    source: z.enum(["pinned_sdk_metadata", "verified_mainnet_onchain_metadata"]),
    sourceField: z.string().min(1).max(160),
    unitClaimId: evidenceIdSchema
  }).strict(),
  amountClaimId: evidenceIdSchema,
  displayOnly: z.object({
    amountDisplay: z.string().min(1).max(120),
    reason: z.literal("presentation_only_not_signing_input")
  }).strict().optional()
}).strict();

export const adapterGasObjectOwnershipLinkSchema = z.object({
  objectId: suiObjectIdSchema,
  ownerAccount: suiAddressStringSchema,
  ownershipClaimId: evidenceIdSchema
}).strict();

export type AdapterGasObjectOwnershipLink = z.infer<typeof adapterGasObjectOwnershipLinkSchema>;

export const adapterGasEvidenceSchema = z.object({
  source: z.literal("review_time_simulation"),
  checkedAt: isoUtcStringSchema,
  gasBudgetRaw: unsignedIntegerStringSchema.optional(),
  gasBudgetClaimId: evidenceIdSchema.optional(),
  gasUsedRaw: unsignedIntegerStringSchema.optional(),
  gasUsedClaimId: evidenceIdSchema.optional(),
  gasObjects: z.array(adapterGasObjectOwnershipLinkSchema).optional(),
  unresolvedReason: z.string().min(1).max(240).optional(),
  unresolvedClaimId: evidenceIdSchema.optional()
}).strict().superRefine((value, ctx) => {
  const hasRawGas = value.gasBudgetRaw !== undefined || value.gasUsedRaw !== undefined;
  if (!hasRawGas && value.unresolvedReason === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "Expected gas evidence or unresolvedReason"
    });
  }
  if (hasRawGas && value.unresolvedReason !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["unresolvedReason"],
      message: "Resolved gas quantities must not include unresolvedReason"
    });
  }
  if (value.gasBudgetRaw !== undefined && value.gasBudgetClaimId === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["gasBudgetClaimId"],
      message: "gasBudgetRaw requires gasBudgetClaimId"
    });
  }
  if (value.gasBudgetRaw === undefined && value.gasBudgetClaimId !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["gasBudgetClaimId"],
      message: "gasBudgetClaimId requires gasBudgetRaw"
    });
  }
  if (value.gasUsedRaw !== undefined && value.gasUsedClaimId === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["gasUsedClaimId"],
      message: "gasUsedRaw requires gasUsedClaimId"
    });
  }
  if (value.gasUsedRaw === undefined && value.gasUsedClaimId !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["gasUsedClaimId"],
      message: "gasUsedClaimId requires gasUsedRaw"
    });
  }
  if (value.unresolvedReason !== undefined && value.unresolvedClaimId === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["unresolvedClaimId"],
      message: "unresolvedReason requires unresolvedClaimId"
    });
  }
  if (value.unresolvedReason === undefined && value.unresolvedClaimId !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["unresolvedClaimId"],
      message: "unresolvedClaimId requires unresolvedReason"
    });
  }
});

export const adapterExpiryEvidenceSchema = z.discriminatedUnion("status", [
  z.object({
    checkedAt: isoUtcStringSchema,
    status: z.literal("current"),
    expiresAt: isoUtcStringSchema,
    evidenceClaimId: evidenceIdSchema
  }).strict(),
  z.object({
    checkedAt: isoUtcStringSchema,
    status: z.literal("expired"),
    expiresAt: isoUtcStringSchema,
    evidenceClaimId: evidenceIdSchema
  }).strict(),
  z.object({
    checkedAt: isoUtcStringSchema,
    status: z.literal("not_provided"),
    evidenceClaimId: evidenceIdSchema,
    reason: z.string().min(1).max(240),
    expiresAt: z.never().optional()
  }).strict(),
  z.object({
    checkedAt: isoUtcStringSchema,
    status: z.literal("not_applicable"),
    evidenceClaimId: evidenceIdSchema,
    reason: z.string().min(1).max(240),
    expiresAt: z.never().optional()
  }).strict()
]).superRefine((value, ctx) => {
  if (value.status === "current" && Date.parse(value.expiresAt) <= Date.parse(value.checkedAt)) {
    ctx.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "Current expiry evidence requires expiresAt after checkedAt"
    });
  }

  if (value.status === "expired" && Date.parse(value.expiresAt) > Date.parse(value.checkedAt)) {
    ctx.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "Expired expiry evidence requires expiresAt at or before checkedAt"
    });
  }
});

export const minimumOutputEnforcementSchema = z.object({
  commandFailure: z.literal("InsufficientCoinBalance").optional(),
  method: z.string().min(1).max(120),
  protocolAbort: z.object({
    commandIndex: z.number().int().nonnegative(),
    packageId: suiObjectIdSchema,
    moduleOrigin: suiObjectIdSchema,
    module: z.string().min(1).max(128),
    code: unsignedIntegerStringSchema
  }).strict().optional(),
  transactionDigest: z.string().min(1),
  commandIndex: z.number().int().nonnegative(),
  coinType: z.string().min(1), recipient: z.string().min(1), raw: unsignedIntegerStringSchema
}).strict();

export const adapterSlippageOrMinOutEvidenceSchema = z.object({
  status: z.enum(["required_and_verified", "not_required_for_action", "missing", "stale"]),
  quoteEvidenceId: z.string().min(1).max(120).optional(),
  quoteEvidenceClaimId: evidenceIdSchema.optional(),
  maxSlippageBps: z.number().int().min(0).max(10_000).optional(),
  minOutRaw: unsignedIntegerStringSchema.optional(),
  enforcement: minimumOutputEnforcementSchema.optional(),
  maxSlippageSource: z.literal("action_request").optional(),
  policySource: z.enum(["user_explicit", "adapter_policy_from_quote_evidence"]).optional(),
  policyEvidenceClaimId: evidenceIdSchema.optional()
}).strict().superRefine((value, ctx) => {
  if (
    value.status === "required_and_verified" &&
    (value.quoteEvidenceId === undefined ||
      value.quoteEvidenceClaimId === undefined ||
      value.maxSlippageBps === undefined ||
      value.minOutRaw === undefined ||
      value.policySource === undefined ||
      value.policyEvidenceClaimId === undefined)
  ) {
    ctx.addIssue({
      code: "custom",
      message: "Verified min-out evidence requires quoteEvidenceId, quoteEvidenceClaimId, maxSlippageBps, minOutRaw, policySource, and policyEvidenceClaimId"
    });
  }
  if (value.quoteEvidenceId !== undefined && value.quoteEvidenceClaimId === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["quoteEvidenceClaimId"],
      message: "quoteEvidenceId requires quoteEvidenceClaimId"
    });
  }
  if (value.quoteEvidenceId === undefined && value.quoteEvidenceClaimId !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["quoteEvidenceClaimId"],
      message: "quoteEvidenceClaimId requires quoteEvidenceId"
    });
  }
  if (value.minOutRaw !== undefined && value.quoteEvidenceClaimId === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["quoteEvidenceClaimId"],
      message: "minOutRaw requires quoteEvidenceClaimId"
    });
  }
  if (value.maxSlippageBps !== undefined && value.policySource === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["policySource"],
      message: "maxSlippageBps requires policySource"
    });
  }
  if (value.policySource !== undefined && value.policyEvidenceClaimId === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["policyEvidenceClaimId"],
      message: "policySource requires policyEvidenceClaimId"
    });
  }
  if (value.policySource === undefined && value.policyEvidenceClaimId !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["policyEvidenceClaimId"],
      message: "policyEvidenceClaimId requires policySource"
    });
  }
});

export const adapterObjectOwnershipEvidenceSchema = z.object({
  checkedAt: isoUtcStringSchema,
  ownerAccount: suiAddressStringSchema,
  objects: z.array(z.object({
    objectId: suiObjectIdSchema,
    role: z.enum(["input_coin", "gas_coin", "protocol_object", "shared_object", "receiving_object"]),
    ownership: z.enum(["owned_by_account", "shared_object", "immutable_or_package", "not_owned_by_account"]),
    evidenceClaimId: evidenceIdSchema
  }).strict()).min(1)
}).strict();

export const adapterSimulationEvidenceSchema = z.object({
  evidenceClaimId: evidenceIdSchema,
  transactionDigest: suiTransactionDigestSchema,
  provider: reviewSimulationProviderSchema,
  checksEnabled: z.literal(true),
  simulatedAt: isoUtcStringSchema,
  status: z.enum(["success", "failed", "unavailable"]),
  requiredFields: z.array(z.enum(WALLET_REVIEW_REQUIRED_SIMULATION_FIELDS)).min(WALLET_REVIEW_REQUIRED_SIMULATION_FIELDS.length),
  missingFields: z.array(z.enum(WALLET_REVIEW_REQUIRED_SIMULATION_FIELDS)).default([]),
  failureReason: z.string().min(1).max(240).optional()
}).strict().refine(
  (value) => value.status !== "success" || value.missingFields.length === 0,
  {
    message: "Successful simulation evidence must not have missing required fields"
  }
).refine(
  (value) => WALLET_REVIEW_REQUIRED_SIMULATION_FIELDS.every((field) => value.requiredFields.includes(field)),
  {
    message: "Simulation evidence must include every required simulation field"
  }
).refine(
  (value) => value.status === "success" || value.failureReason !== undefined,
  {
    message: "Failed or unavailable simulation evidence requires failureReason"
  }
).refine(
  (value) => value.status !== "success" || value.failureReason === undefined,
  {
    message: "Successful simulation evidence must not include failureReason"
  }
);

export const adapterHumanReadableReviewSchema = z.object({
  fields: z.array(z.enum(WALLET_REVIEW_REQUIRED_HUMAN_FIELDS)).min(WALLET_REVIEW_REQUIRED_HUMAN_FIELDS.length),
  transactionDigest: suiTransactionDigestSchema,
  source: z.literal("review_model_or_adapter_equivalent"),
  purpose: z.literal("human_review_before_wallet_authorization")
}).strict().refine(
  (value) => WALLET_REVIEW_REQUIRED_HUMAN_FIELDS.every((field) => value.fields.includes(field)),
  {
    message: "Human-readable review fields must include every required review field"
  }
);

export const adapterOutputBoundarySchema = z.object({
  runtimeStatus: z.literal("emitted_pre_handoff"),
  mcpAndReviewUiMayExpose: z.array(z.enum([
    "human_readable_review",
    "ptb_visualization_artifact",
    "diagnostics",
    "status_checks"
  ])).min(1),
  prohibited: z.array(z.enum(WALLET_REVIEW_REQUIRED_PROHIBITED_OUTPUTS)).min(1)
}).strict().superRefine((value, ctx) => {
  requireAllValues(
    ctx,
    value.prohibited,
    WALLET_REVIEW_REQUIRED_PROHIBITED_OUTPUTS,
    ["prohibited"],
    "prohibited"
  );
});

export const transactionReviewDataSchema = z.object({
  schemaVersion: z.literal(TRANSACTION_REVIEW_SCHEMA_VERSION),
  adapterId: z.string().min(1).max(120),
  protocol: z.string().min(1).max(120),
  actionKind: z.string().min(1).max(120),
  network: z.literal("sui:mainnet"),
  inputProvenance: adapterInputProvenanceSchema,
  sourceReferences: z.array(adapterSourceOfTruthSchema).min(1),
  evidenceClaims: z.array(adapterEvidenceClaimSchema).min(1),
  rawQuantities: z.array(adapterRawQuantitySchema).min(1),
  gas: adapterGasEvidenceSchema,
  expiry: adapterExpiryEvidenceSchema,
  slippageOrMinOut: adapterSlippageOrMinOutEvidenceSchema,
  objectOwnership: adapterObjectOwnershipEvidenceSchema,
  simulation: adapterSimulationEvidenceSchema,
  humanReadableReview: adapterHumanReadableReviewSchema,
  outputBoundary: adapterOutputBoundarySchema,
  reviewedTransactionDigest: suiTransactionDigestSchema
}).strict().superRefine((value, ctx) => {
  const sourceIds = new Set<string>();
  const sourceById = new Map<string, (typeof value.sourceReferences)[number]>();
  const sourceIndexById = new Map<string, number>();
  value.sourceReferences.forEach((source, index) => {
    if (sourceIds.has(source.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["sourceReferences", index, "id"],
        message: `sourceReferences id must be unique: ${source.id}`
      });
    }
    sourceIds.add(source.id);
    if (!sourceById.has(source.id)) {
      sourceById.set(source.id, source);
      sourceIndexById.set(source.id, index);
    }
  });

  const claimIds = new Set<string>();
  const claimById = new Map<string, (typeof value.evidenceClaims)[number]>();
  const claimIndexById = new Map<string, number>();
  value.evidenceClaims.forEach((claim, index) => {
    if (claimIds.has(claim.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["evidenceClaims", index, "id"],
        message: `evidenceClaims id must be unique: ${claim.id}`
      });
    }
    claimIds.add(claim.id);
    if (!claimById.has(claim.id)) {
      claimById.set(claim.id, claim);
      claimIndexById.set(claim.id, index);
    }
  });

  const requireSourceId = (
    sourceEvidenceId: string | undefined,
    path: Array<string | number>
  ): (typeof value.sourceReferences)[number] | undefined => {
    if (sourceEvidenceId === undefined) {
      return undefined;
    }
    const source = sourceById.get(sourceEvidenceId);
    if (source !== undefined) {
      return source;
    }
    ctx.addIssue({
      code: "custom",
      path,
      message: `source evidence id must reference sourceReferences[].id: ${sourceEvidenceId}`
    });
    return undefined;
  };

  const requireSourceEvidence = (
    sourceEvidenceId: string | undefined,
    requirement: SourceEvidenceRequirement,
    path: Array<string | number>,
    label: string
  ): void => {
    if (sourceEvidenceId === undefined) {
      return;
    }
    const source = requireSourceId(sourceEvidenceId, path);
    if (source === undefined) {
      return;
    }
    const sourceIndex = sourceIndexById.get(sourceEvidenceId);
    const sourcePath = sourceIndex === undefined ? path : ["sourceReferences", sourceIndex];
    if (!requirement.kinds.includes(source.kind)) {
      ctx.addIssue({
        code: "custom",
        path: [...sourcePath, "kind"],
        message: `${label} source kind must be one of ${requirement.kinds.join(", ")}`
      });
    }
    addMissingRequiredValuesIssue(
      ctx,
      source.fields,
      requirement.fields,
      [...sourcePath, "fields"],
      `${label} sourceReferences fields`
    );
  };

  const requireClaim = (
    claimId: string | undefined,
    factKind: SafetyCriticalFactKind,
    path: Array<string | number>,
    label: string
  ): (typeof value.evidenceClaims)[number] | undefined => {
    if (claimId === undefined) {
      ctx.addIssue({
        code: "custom",
        path,
        message: `${label} must reference evidenceClaims[].id`
      });
      return undefined;
    }
    const claim = claimById.get(claimId);
    if (claim === undefined) {
      ctx.addIssue({
        code: "custom",
        path,
        message: `${label} must reference evidenceClaims[].id: ${claimId}`
      });
      return undefined;
    }
    if (claim.factKind !== factKind) {
      const claimIndex = claimIndexById.get(claimId);
      const claimPath = claimIndex === undefined ? path : ["evidenceClaims", claimIndex, "factKind"];
      ctx.addIssue({
        code: "custom",
        path: claimPath,
        message: `${label} evidence claim factKind must be ${factKind}`
      });
    }
    return claim;
  };

  value.evidenceClaims.forEach((claim, index) => {
    if (claim.factKind === "raw_quantity_amount") {
      requireSourceEvidence(
        claim.sourceEvidenceId,
        SAFETY_CRITICAL_FACT_MATRIX.raw_quantity_amount.byRole[claim.role],
        ["evidenceClaims", index, "sourceEvidenceId"],
        `evidenceClaims[${index}].raw_quantity_amount`
      );
    }
    if (claim.factKind === "unit_metadata") {
      requireSourceEvidence(
        claim.sourceEvidenceId,
        SAFETY_CRITICAL_FACT_MATRIX.unit_metadata.bySource[claim.source],
        ["evidenceClaims", index, "sourceEvidenceId"],
        `evidenceClaims[${index}].unit_metadata`
      );
    }
    if (claim.factKind === "gas_unresolved_status") {
      requireSourceEvidence(
        claim.sourceEvidenceId,
        SAFETY_CRITICAL_FACT_MATRIX.gas_unresolved_status,
        ["evidenceClaims", index, "sourceEvidenceId"],
        `evidenceClaims[${index}].gas_unresolved_status`
      );
    }
    if (claim.factKind === "expiry_status") {
      requireSourceEvidence(
        claim.sourceEvidenceId,
        SAFETY_CRITICAL_FACT_MATRIX.expiry_status[claim.status],
        ["evidenceClaims", index, "sourceEvidenceId"],
        `evidenceClaims[${index}].expiry_status`
      );
      if ((claim.status === "current" || claim.status === "expired") && claim.expiresAt === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["evidenceClaims", index, "expiresAt"],
          message: "Current or expired expiry claim requires expiresAt"
        });
      }
      if ((claim.status === "not_provided" || claim.status === "not_applicable") && claim.reason === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["evidenceClaims", index, "reason"],
          message: "Unavailable expiry claim requires reason"
        });
      }
      if ((claim.status === "not_provided" || claim.status === "not_applicable") && claim.expiresAt !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["evidenceClaims", index, "expiresAt"],
          message: "Unavailable expiry claim must not include expiresAt"
        });
      }
      if (
        claim.status === "current" &&
        claim.expiresAt !== undefined &&
        Date.parse(claim.expiresAt) <= Date.parse(claim.checkedAt)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["evidenceClaims", index, "expiresAt"],
          message: "Current expiry claim requires expiresAt after checkedAt"
        });
      }
      if (
        claim.status === "expired" &&
        claim.expiresAt !== undefined &&
        Date.parse(claim.expiresAt) > Date.parse(claim.checkedAt)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["evidenceClaims", index, "expiresAt"],
          message: "Expired expiry claim requires expiresAt at or before checkedAt"
        });
      }
    }
    if (claim.factKind === "quote_min_out") {
      requireSourceEvidence(
        claim.sourceEvidenceId,
        SAFETY_CRITICAL_FACT_MATRIX.quote_min_out,
        ["evidenceClaims", index, "sourceEvidenceId"],
        `evidenceClaims[${index}].quote_min_out`
      );
    }
    if (claim.factKind === "slippage_policy") {
      requireSourceEvidence(
        claim.sourceEvidenceId,
        SAFETY_CRITICAL_FACT_MATRIX.slippage_policy.bySource[claim.policySource],
        ["evidenceClaims", index, "sourceEvidenceId"],
        `evidenceClaims[${index}].slippage_policy`
      );
      if (claim.policySource === "adapter_policy_from_quote_evidence" && claim.minOutRaw === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["evidenceClaims", index, "minOutRaw"],
          message: "Adapter-derived slippage policy claim requires minOutRaw"
        });
      }
    }
    if (claim.factKind === "object_ownership") {
      requireSourceEvidence(
        claim.sourceEvidenceId,
        SAFETY_CRITICAL_FACT_MATRIX.object_ownership,
        ["evidenceClaims", index, "sourceEvidenceId"],
        `evidenceClaims[${index}].object_ownership`
      );
    }
    if (claim.factKind === "simulation_result") {
      requireSourceEvidence(
        claim.sourceEvidenceId,
        SAFETY_CRITICAL_FACT_MATRIX.simulation_result,
        ["evidenceClaims", index, "sourceEvidenceId"],
        `evidenceClaims[${index}].simulation_result`
      );
      if (claim.status === "success" && claim.missingFields.length !== 0) {
        ctx.addIssue({
          code: "custom",
          path: ["evidenceClaims", index, "missingFields"],
          message: "Successful simulation claim must not have missing required fields"
        });
      }
      if (!WALLET_REVIEW_REQUIRED_SIMULATION_FIELDS.every((field) => claim.requiredFields.includes(field))) {
        ctx.addIssue({
          code: "custom",
          path: ["evidenceClaims", index, "requiredFields"],
          message: "Simulation claim must include every required simulation field"
        });
      }
      if (claim.status !== "success" && claim.failureReason === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["evidenceClaims", index, "failureReason"],
          message: "Failed or unavailable simulation claim requires failureReason"
        });
      }
      if (claim.status === "success" && claim.failureReason !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["evidenceClaims", index, "failureReason"],
          message: "Successful simulation claim must not include failureReason"
        });
      }
    }
  });

  value.rawQuantities.forEach((quantity, index) => {
    const amountClaim = requireClaim(
      quantity.amountClaimId,
      "raw_quantity_amount",
      ["rawQuantities", index, "amountClaimId"],
      `rawQuantities[${index}].amountClaimId`
    );
    if (amountClaim?.factKind === "raw_quantity_amount") {
      requireEqual(ctx, quantity.role, amountClaim.role, ["rawQuantities", index, "role"], `rawQuantities[${index}].role`);
      requireEqual(ctx, quantity.rawAmount, amountClaim.rawAmount, ["rawQuantities", index, "rawAmount"], `rawQuantities[${index}].rawAmount`);
      requireSameAsset(ctx, quantity.asset, amountClaim.asset, ["rawQuantities", index, "asset"], `rawQuantities[${index}].asset`);
    }

    const unitClaim = requireClaim(
      quantity.unit.unitClaimId,
      "unit_metadata",
      ["rawQuantities", index, "unit", "unitClaimId"],
      `rawQuantities[${index}].unit.unitClaimId`
    );
    if (unitClaim?.factKind === "unit_metadata") {
      requireEqual(ctx, quantity.unit.source, unitClaim.source, ["rawQuantities", index, "unit", "source"], `rawQuantities[${index}].unit.source`);
      requireEqual(ctx, quantity.unit.decimals, unitClaim.decimals, ["rawQuantities", index, "unit", "decimals"], `rawQuantities[${index}].unit.decimals`);
      if (quantity.asset.coinType !== undefined) {
        requireEqual(ctx, quantity.asset.coinType, unitClaim.coinType, ["rawQuantities", index, "asset", "coinType"], `rawQuantities[${index}].asset.coinType`);
      }
    }
  });

  if (value.gas.gasBudgetRaw !== undefined) {
    const gasBudgetClaim = requireClaim(
      value.gas.gasBudgetClaimId,
      "raw_quantity_amount",
      ["gas", "gasBudgetClaimId"],
      "gas.gasBudgetClaimId"
    );
    if (gasBudgetClaim?.factKind === "raw_quantity_amount") {
      requireEqual(
        ctx,
        gasBudgetClaim.role,
        CONSUMER_INVARIANT_MATRIX.gasBudgetClaimId.role,
        ["gas", "gasBudgetClaimId"],
        "gas.gasBudgetClaimId role"
      );
      requireGasAsset(
        ctx,
        gasBudgetClaim.asset,
        CONSUMER_INVARIANT_MATRIX.gasBudgetClaimId.assetCoinType,
        ["gas", "gasBudgetClaimId"],
        "gas.gasBudgetClaimId asset"
      );
      requireEqual(ctx, value.gas.gasBudgetRaw, gasBudgetClaim.rawAmount, ["gas", "gasBudgetRaw"], "gas.gasBudgetRaw");
    }
  }

  if (value.gas.gasUsedRaw !== undefined) {
    const gasUsedClaim = requireClaim(
      value.gas.gasUsedClaimId,
      "raw_quantity_amount",
      ["gas", "gasUsedClaimId"],
      "gas.gasUsedClaimId"
    );
    if (gasUsedClaim?.factKind === "raw_quantity_amount") {
      requireEqual(
        ctx,
        gasUsedClaim.role,
        CONSUMER_INVARIANT_MATRIX.gasUsedClaimId.role,
        ["gas", "gasUsedClaimId"],
        "gas.gasUsedClaimId role"
      );
      requireGasAsset(
        ctx,
        gasUsedClaim.asset,
        CONSUMER_INVARIANT_MATRIX.gasUsedClaimId.assetCoinType,
        ["gas", "gasUsedClaimId"],
        "gas.gasUsedClaimId asset"
      );
      requireEqual(ctx, value.gas.gasUsedRaw, gasUsedClaim.rawAmount, ["gas", "gasUsedRaw"], "gas.gasUsedRaw");
    }
  }

  if (value.gas.unresolvedReason !== undefined) {
    const unresolvedClaim = requireClaim(
      value.gas.unresolvedClaimId,
      "gas_unresolved_status",
      ["gas", "unresolvedClaimId"],
      "gas.unresolvedClaimId"
    );
    if (unresolvedClaim?.factKind === "gas_unresolved_status") {
      requireEqual(ctx, unresolvedClaim.status, "unresolved", ["gas", "unresolvedClaimId"], "gas.unresolvedClaimId status");
      requireEqual(ctx, value.gas.checkedAt, unresolvedClaim.checkedAt, ["gas", "checkedAt"], "gas.checkedAt");
      requireEqual(ctx, value.gas.unresolvedReason, unresolvedClaim.reason, ["gas", "unresolvedReason"], "gas.unresolvedReason");
    }
  }

  value.gas.gasObjects?.forEach((gasObject, index) => {
    const ownershipClaim = requireClaim(
      gasObject.ownershipClaimId,
      "object_ownership",
      ["gas", "gasObjects", index, "ownershipClaimId"],
      `gas.gasObjects[${index}].ownershipClaimId`
    );
    if (ownershipClaim?.factKind === "object_ownership") {
      requireEqual(ctx, gasObject.objectId, ownershipClaim.objectId, ["gas", "gasObjects", index, "objectId"], `gas.gasObjects[${index}].objectId`);
      requireEqual(ctx, gasObject.ownerAccount, ownershipClaim.ownerAccount, ["gas", "gasObjects", index, "ownerAccount"], `gas.gasObjects[${index}].ownerAccount`);
      requireEqual(
        ctx,
        ownershipClaim.ownership,
        CONSUMER_INVARIANT_MATRIX.gasObjectOwnershipClaimId.ownership,
        ["gas", "gasObjects", index, "ownershipClaimId"],
        `gas.gasObjects[${index}].ownershipClaimId ownership`
      );
    }
  });

  const expiryClaim = requireClaim(
    value.expiry.evidenceClaimId,
    "expiry_status",
    ["expiry", "evidenceClaimId"],
    "expiry.evidenceClaimId"
  );
  if (expiryClaim?.factKind === "expiry_status") {
    requireEqual(ctx, value.expiry.status, expiryClaim.status, ["expiry", "status"], "expiry.status");
    requireEqual(ctx, value.expiry.checkedAt, expiryClaim.checkedAt, ["expiry", "checkedAt"], "expiry.checkedAt");
    if (value.expiry.status === "current" || value.expiry.status === "expired") {
      requireEqual(ctx, value.expiry.expiresAt, expiryClaim.expiresAt, ["expiry", "expiresAt"], "expiry.expiresAt");
    } else {
      requireEqual(ctx, value.expiry.reason, expiryClaim.reason, ["expiry", "reason"], "expiry.reason");
    }
  }

  const enforcement = value.slippageOrMinOut.enforcement;
  if (enforcement && (enforcement.transactionDigest !== value.reviewedTransactionDigest ||
      enforcement.raw !== value.slippageOrMinOut.minOutRaw ||
      !value.rawQuantities.some((quantity) => quantity.role === "minimum_output" &&
        quantity.asset.coinType === enforcement.coinType && quantity.rawAmount === enforcement.raw))) {
    ctx.addIssue({ code: "custom", path: ["slippageOrMinOut", "enforcement"],
      message: "Output enforcement must match the reviewed transaction digest, asset and minimum." });
  }
  if (value.slippageOrMinOut.quoteEvidenceClaimId !== undefined) {
    const quoteClaim = requireClaim(
      value.slippageOrMinOut.quoteEvidenceClaimId,
      "quote_min_out",
      ["slippageOrMinOut", "quoteEvidenceClaimId"],
      "slippageOrMinOut.quoteEvidenceClaimId"
    );
    if (quoteClaim?.factKind === "quote_min_out") {
      requireEqual(ctx, value.slippageOrMinOut.quoteEvidenceId, quoteClaim.quoteEvidenceId, ["slippageOrMinOut", "quoteEvidenceId"], "slippageOrMinOut.quoteEvidenceId");
      requireEqual(ctx, value.slippageOrMinOut.minOutRaw, quoteClaim.minOutRaw, ["slippageOrMinOut", "minOutRaw"], "slippageOrMinOut.minOutRaw");
    }
  }

  if (value.slippageOrMinOut.minOutRaw !== undefined) {
    const matchingMinOutQuantity = value.rawQuantities.some(
      (quantity) =>
        quantity.role === "minimum_output" &&
        quantity.rawAmount === value.slippageOrMinOut.minOutRaw
    );
    if (!matchingMinOutQuantity) {
      ctx.addIssue({
        code: "custom",
        path: ["slippageOrMinOut", "minOutRaw"],
        message: "slippageOrMinOut.minOutRaw must match a minimum_output rawQuantities entry"
      });
    }
  }

  if (value.slippageOrMinOut.policyEvidenceClaimId !== undefined) {
    const policyClaim = requireClaim(
      value.slippageOrMinOut.policyEvidenceClaimId,
      "slippage_policy",
      ["slippageOrMinOut", "policyEvidenceClaimId"],
      "slippageOrMinOut.policyEvidenceClaimId"
    );
    if (policyClaim?.factKind === "slippage_policy") {
      requireEqual(ctx, value.slippageOrMinOut.maxSlippageSource, policyClaim.maxSlippageSource, ["slippageOrMinOut", "maxSlippageSource"], "slippageOrMinOut.maxSlippageSource");
      requireEqual(ctx, value.slippageOrMinOut.policySource, policyClaim.policySource, ["slippageOrMinOut", "policySource"], "slippageOrMinOut.policySource");
      requireEqual(ctx, value.slippageOrMinOut.maxSlippageBps, policyClaim.maxSlippageBps, ["slippageOrMinOut", "maxSlippageBps"], "slippageOrMinOut.maxSlippageBps");
      if (policyClaim.policySource === "adapter_policy_from_quote_evidence") {
        requireEqual(ctx, value.slippageOrMinOut.minOutRaw, policyClaim.minOutRaw, ["slippageOrMinOut", "minOutRaw"], "slippageOrMinOut.minOutRaw");
      }
    }
  }

  value.objectOwnership.objects.forEach((object, index) => {
    const ownershipClaim = requireClaim(
      object.evidenceClaimId,
      "object_ownership",
      ["objectOwnership", "objects", index, "evidenceClaimId"],
      `objectOwnership.objects[${index}].evidenceClaimId`
    );
    if (ownershipClaim?.factKind === "object_ownership") {
      requireEqual(ctx, object.objectId, ownershipClaim.objectId, ["objectOwnership", "objects", index, "objectId"], `objectOwnership.objects[${index}].objectId`);
      requireEqual(ctx, value.objectOwnership.ownerAccount, ownershipClaim.ownerAccount, ["objectOwnership", "ownerAccount"], "objectOwnership.ownerAccount");
      requireEqual(ctx, object.ownership, ownershipClaim.ownership, ["objectOwnership", "objects", index, "ownership"], `objectOwnership.objects[${index}].ownership`);
    }
  });

  const simulationClaim = requireClaim(
    value.simulation.evidenceClaimId,
    "simulation_result",
    ["simulation", "evidenceClaimId"],
    "simulation.evidenceClaimId"
  );
  if (simulationClaim?.factKind === "simulation_result") {
    requireEqual(ctx, value.simulation.provider, simulationClaim.provider, ["simulation", "provider"], "simulation.provider");
    requireEqual(ctx, value.simulation.checksEnabled, simulationClaim.checksEnabled, ["simulation", "checksEnabled"], "simulation.checksEnabled");
    requireEqual(ctx, value.simulation.simulatedAt, simulationClaim.simulatedAt, ["simulation", "simulatedAt"], "simulation.simulatedAt");
    requireEqual(ctx, value.simulation.status, simulationClaim.status, ["simulation", "status"], "simulation.status");
    requireSameStringSet(ctx, value.simulation.requiredFields, simulationClaim.requiredFields, ["simulation", "requiredFields"], "simulation.requiredFields");
    requireSameStringSet(ctx, value.simulation.missingFields, simulationClaim.missingFields, ["simulation", "missingFields"], "simulation.missingFields");
    requireEqual(ctx, value.simulation.failureReason, simulationClaim.failureReason, ["simulation", "failureReason"], "simulation.failureReason");
  }
}).superRefine((value, ctx) => {
  // Contract invariant: human review, review-time simulation, and transaction
  // material commitment must all reference the same Sui transaction digest.
  // Reuse requireEqual so commitment checks match the evidence-claim bindings.
  const handoffDigest = value.reviewedTransactionDigest;
  requireEqual(
    ctx,
    value.humanReadableReview.transactionDigest,
    handoffDigest,
    ["humanReadableReview", "transactionDigest"],
    "humanReadableReview.transactionDigest"
  );
  requireEqual(
    ctx,
    value.simulation.transactionDigest,
    handoffDigest,
    ["simulation", "transactionDigest"],
    "simulation.transactionDigest"
  );
});

export const ptbVisualizationArtifactSchema = z.object({
  contractVersion: z.literal(PTB_VISUALIZATION_CONTRACT_VERSION),
  artifactKind: z.literal("ptb_visualization"),
  generatedAt: isoUtcStringSchema,
  source: z.object({
    adapterId: z.string().min(1).max(120),
    planId: z.string().min(1).max(120).optional(),
    sourceKind: z.enum(["review_time_generated_transaction_kind", "review_time_ir", "renderer_model"]),
    authority: z.literal("visualization_only_not_wallet_authorization"),
    renderer: z.object({
      name: z.string().min(1).max(120),
      packageName: z.string().min(1).max(120).optional(),
      version: z.string().min(1).max(80).optional()
    }).strict().optional()
  }).strict(),
  mermaid: z.object({
    diagramType: z.literal("flowchart"),
    text: displayTextWithoutExecutableMaterial(20_000, "mermaid.text"),
    namedText: displayTextWithoutExecutableMaterial(20_000, "mermaid.namedText")
  }).strict(),
  diagnostics: z.array(z.object({
    severity: z.enum(["info", "warning", "error"]),
    code: z.string().min(1).max(120),
    message: displayTextWithoutExecutableMaterial(512, "diagnostics.message"),
    source: z.enum(["adapter", "renderer", "schema", "simulation"])
  }).strict()).default([]),
  unsupportedUse: z.array(z.enum(PTB_VISUALIZATION_REQUIRED_UNSUPPORTED_USES)).min(1),
  executableMaterial: z.object({
    included: z.literal(false),
    policy: z.literal("mcp_and_review_ui_outputs_must_not_include_executable_transaction_material")
  }).strict()
}).strict().superRefine((value, ctx) => {
  requireAllValues(
    ctx,
    value.unsupportedUse,
    PTB_VISUALIZATION_REQUIRED_UNSUPPORTED_USES,
    ["unsupportedUse"],
    "unsupportedUse"
  );
});

export type AdapterInputProvenance = z.infer<typeof adapterInputProvenanceSchema>;
export type AdapterSourceOfTruth = z.infer<typeof adapterSourceOfTruthSchema>;
export type AdapterEvidenceClaim = z.infer<typeof adapterEvidenceClaimSchema>;
export type AdapterObjectOwnershipEvidence = z.infer<typeof adapterObjectOwnershipEvidenceSchema>;
export type AdapterRawQuantity = z.infer<typeof adapterRawQuantitySchema>;
export type TransactionReviewData = z.infer<typeof transactionReviewDataSchema>;
export type PtbVisualizationArtifact = z.infer<typeof ptbVisualizationArtifactSchema>;
