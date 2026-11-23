import { activityPackageFamilies } from "./transactionActivityLineages.js";
import { z } from "zod";
import { parseSuiAddress } from "../suiAddress.js";
import type { ExternalActivityTransactionDetail } from "./transactionActivityDetails.js";
import {
  SUI_DEFI_ACTIVITY_PROTOCOL_RULES,
  protocolActivityPrimaryActions,
  type ProtocolActivityPrimaryAction,
  type ProtocolPackageRule,
  type ProtocolRule
} from "./transactionActivityProtocolRules.js";

export const SUI_DEFI_ACTIVITY_CLASSIFIER_VERSION = "sui_defi_activity_v0_6" as const;

const protocolActivityPrimaryActionSchema = z.enum(protocolActivityPrimaryActions);

const protocolMatchBasisSchema = z.enum([
  "direct_move_call",
  "event_type",
  "object_type",
  "shared_object"
]);

const declaredActionPriority: Record<ProtocolActivityPrimaryAction, number> = {
  order: 0,
  swap: 0,
  liquidity: 0,
  lending: 0,
  fee_or_reward: 1,
  admin_or_versioning: 2,
  unknown: 3
};

export const protocolActivityClassifierMatchSchema = z.object({
  classifierVersion: z.literal(SUI_DEFI_ACTIVITY_CLASSIFIER_VERSION),
  protocolId: z.string(),
  displayName: z.string(),
  activityCategory: z.string(),
  declaredAction: protocolActivityPrimaryActionSchema,
  transactionStatus: z.enum(["success", "failure", "unknown"]),
  matchBasis: protocolMatchBasisSchema,
  evidence: z.array(z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("moveCall"),
      package: z.string(),
      packageSource: z.string().optional(),
      mvrName: z.string().optional(),
      module: z.string(),
      function: z.string(),
      commandIndex: z.number().int().nonnegative()
    }).strict(),
    z.object({
      kind: z.literal("eventType"),
      package: z.string().optional(),
      packageSource: z.string().optional(),
      mvrName: z.string().optional(),
      eventType: z.string(),
      sequenceNumber: z.string().optional()
    }).strict(),
    z.object({
      kind: z.literal("objectType"),
      objectId: z.string(),
      changeKind: z.string(),
      package: z.string().optional(),
      packageSource: z.string().optional(),
      mvrName: z.string().optional(),
      type: z.string()
    }).strict(),
    z.object({
      kind: z.literal("sharedObject"),
      objectId: z.string(),
      label: z.string()
    }).strict()
  ])).min(1),
  relatedProtocols: z.array(z.object({
    protocolId: z.string(),
    reason: z.string()
  }).strict()),
  limitations: z.array(z.string())
}).strict();

export type ProtocolActivityClassifierMatch = z.infer<typeof protocolActivityClassifierMatchSchema>;
type ProtocolMatchBasis = z.infer<typeof protocolMatchBasisSchema>;
type ProtocolActivityEvidence = ProtocolActivityClassifierMatch["evidence"][number];
type PackageEvidenceFields = {
  packageSource: string;
  mvrName?: string | undefined;
};

export function classifySuiDeFiActivity(
  details: ExternalActivityTransactionDetail,
  transactionStatus: ProtocolActivityClassifierMatch["transactionStatus"] = "unknown"
): ProtocolActivityClassifierMatch[] {
  const matches = SUI_DEFI_ACTIVITY_PROTOCOL_RULES.flatMap((rule) => matchProtocol(rule, details, transactionStatus));
  const deepTradeDirect = matches.some((match) =>
    match.protocolId === "deeptrade-core" && match.evidence.some(item => item.kind === "moveCall")
  );
  const deepBookMatch = matches.find((match) => match.protocolId === "deepbook-v3");

  const resolved = matches
    .filter((match) => !(deepTradeDirect && match.protocolId === "deepbook-v3"))
    .map((match) => {
      if (match.protocolId === "deeptrade-core" && deepTradeDirect && deepBookMatch) {
        return {
          ...match,
          relatedProtocols: [
            ...match.relatedProtocols,
            {
              protocolId: "deepbook-v3",
              reason: "deeptrade_wrapper_touched_deepbook_evidence"
            }
          ]
        };
      }
      return match;
    });

  return resolved.sort((a, b) => {
    const priority = matchBasisPriority(a.matchBasis) - matchBasisPriority(b.matchBasis);
    if (priority !== 0) {
      return priority;
    }
    return compareAscii(a.protocolId, b.protocolId);
  });
}

function typeEvidence(rule: ProtocolRule, type: string | undefined) {
  if (!type) return;
  const outer = type.split("<", 1)[0]!;
  const parts = outer.split("::");
  if (parts.length !== 3) return;
  const [address, module, name] = parts, id = parseSuiAddress(address!);
  const family = activityPackageFamilies[rule.protocolId];
  if (!id || !family?.types[id]?.includes(`${module}::${name}`)) return;
  return { id, evidence: { source: `mainnet_type_origin_v${family.versions.indexOf(id) + 1}` } };
}

function directPackage(rule: ProtocolRule, id: string | undefined): ProtocolPackageRule | undefined {
  if (!id) return;
  if (rule.typeOnlyPackages?.includes(id)) return;
  const mvrName = rule.namedPackages?.[id];
  const family = activityPackageFamilies[rule.protocolId];
  const version = family?.versions.indexOf(id) ?? -1;
  if (version < 0 || !rule.actionForMoveCall) return;
  return { source: `mainnet_direct_call_v${version + 1}`, ...(mvrName ? { mvrName } : {}) };
}

function matchProtocol(
  rule: ProtocolRule,
  details: ExternalActivityTransactionDetail,
  transactionStatus: ProtocolActivityClassifierMatch["transactionStatus"]
): ProtocolActivityClassifierMatch[] {
  const evidence: ProtocolActivityEvidence[] = [];
  const limitationSet = new Set<string>();
  let matchBasis: ProtocolMatchBasis | undefined;
  let declaredAction: ProtocolActivityPrimaryAction = "unknown";

  for (const call of details.moveCalls) {
    const packageId = normalizedPackageFromMoveCall(call);
    const packageRule = directPackage(rule, packageId);
    if (packageRule === undefined) {
      continue;
    }
    evidence.push({
      kind: "moveCall",
      package: call.package,
      ...packageEvidenceFields(packageRule),
      module: call.module,
      function: call.function,
      commandIndex: call.commandIndex
    });
    matchBasis = selectPreferredMatchBasis(matchBasis, "direct_move_call");
    declaredAction = strongestPrimaryAction(declaredAction, rule.actionForMoveCall?.(call) ?? "unknown");
  }

  for (const event of details.events) {
    const origin = typeEvidence(rule, event.eventType);
    if (origin && event.eventType) {
      const packageId = origin.id, packageRule = origin.evidence;
      evidence.push({
        kind: "eventType",
        package: packageId,
        ...packageEvidenceFields(packageRule),
        eventType: event.eventType,
        ...(event.sequenceNumber === undefined ? {} : { sequenceNumber: event.sequenceNumber })
      });
      matchBasis = selectPreferredMatchBasis(matchBasis, "event_type");
    }
  }

  for (const change of details.objectChanges) {
    for (const type of uniqueStrings([change.inputType, change.outputType].flatMap((value) => value === undefined ? [] : [value]))) {
      const origin = typeEvidence(rule, type);
      if (origin) {
        const packageId = origin.id, packageRule = origin.evidence;
        evidence.push({
          kind: "objectType",
          objectId: change.objectId,
          changeKind: change.changeKind,
          package: packageId,
          ...packageEvidenceFields(packageRule),
          type
        });
        matchBasis = selectPreferredMatchBasis(matchBasis, "object_type");
      }
    }

    const objectId = parseSuiAddress(change.objectId);
    const sharedObjectLabel = objectId === undefined ? undefined : rule.sharedObjects[objectId];
    if (sharedObjectLabel !== undefined) {
      evidence.push({
        kind: "sharedObject",
        objectId: change.objectId,
        label: sharedObjectLabel
      });
      matchBasis = selectPreferredMatchBasis(matchBasis, "shared_object");
    }
  }

  if (evidence.length === 0 || matchBasis === undefined) {
    return [];
  }

  addTruncationLimitations(details, limitationSet);
  if (matchBasis === "shared_object") {
    limitationSet.add("shared_object_match_does_not_prove_wallet_position");
  }
  if (!evidence.some((item) => item.kind === "moveCall") && (matchBasis === "event_type" || matchBasis === "object_type")) {
    limitationSet.add("no_direct_move_call_match");
  }
  limitationSet.add("declared_call_does_not_prove_fill_or_account_effect");
  limitationSet.add("transaction_activity_label_only");
  limitationSet.add("not_position_inventory_or_pnl_or_signing");

  return [{
    classifierVersion: SUI_DEFI_ACTIVITY_CLASSIFIER_VERSION,
    protocolId: rule.protocolId,
    displayName: rule.displayName,
    activityCategory: rule.activityCategory,
    declaredAction,
    transactionStatus,
    matchBasis,
    evidence: uniqueEvidence(evidence),
    relatedProtocols: [],
    limitations: [...limitationSet].sort(compareAscii)
  }];
}

function addTruncationLimitations(
  details: ExternalActivityTransactionDetail,
  limitations: Set<string>
): void {
  if (details.truncation.moveCalls) {
    limitations.add("move_call_details_truncated");
  }
  if (details.truncation.objectChanges) {
    limitations.add("object_change_details_truncated");
  }
  if (details.truncation.events) {
    limitations.add("event_details_truncated");
  }
}

function selectPreferredMatchBasis(
  current: ProtocolMatchBasis | undefined,
  candidate: ProtocolMatchBasis
): ProtocolMatchBasis {
  return current === undefined || matchBasisPriority(candidate) < matchBasisPriority(current)
    ? candidate
    : current;
}

function matchBasisPriority(matchBasis: ProtocolMatchBasis): number {
  switch (matchBasis) {
    case "event_type":
      return 0;
    case "object_type":
      return 1;
    case "direct_move_call":
      return 2;
    case "shared_object":
      return 3;
  }
}

function strongestPrimaryAction(
  current: ProtocolActivityPrimaryAction,
  candidate: ProtocolActivityPrimaryAction
): ProtocolActivityPrimaryAction {
  const priority = declaredActionPriority[candidate] - declaredActionPriority[current];
  if (priority !== 0) {
    return priority < 0 ? candidate : current;
  }
  return current === "unknown" ? candidate : current;
}

function normalizedPackageFromMoveCall(call: { package: string; target: string }): string | undefined {
  return parseSuiAddress(call.package) ?? normalizedPackageFromType(call.target);
}

function normalizedPackageFromType(type: string): string | undefined {
  const [packageCandidate] = type.split("::");
  return packageCandidate === undefined ? undefined : parseSuiAddress(packageCandidate);
}

function packageEvidenceFields(
  packageRule: ProtocolPackageRule
): PackageEvidenceFields {
  return {
    packageSource: packageRule.source,
    ...(packageRule.mvrName === undefined ? {} : { mvrName: packageRule.mvrName })
  };
}

function uniqueEvidence(evidence: ProtocolActivityEvidence[]): ProtocolActivityEvidence[] {
  const seen = new Set<string>();
  const unique: ProtocolActivityEvidence[] = [];
  for (const item of evidence) {
    const key = evidenceKey(item);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(item);
    }
  }
  return unique;
}

function evidenceKey(evidence: ProtocolActivityEvidence): string {
  switch (evidence.kind) {
    case "moveCall":
      return keyParts([
        evidence.kind,
        evidence.package,
        evidence.packageSource,
        evidence.mvrName,
        evidence.module,
        evidence.function,
        String(evidence.commandIndex)
      ]);
    case "eventType":
      return keyParts([
        evidence.kind,
        evidence.package,
        evidence.packageSource,
        evidence.mvrName,
        evidence.eventType,
        evidence.sequenceNumber
      ]);
    case "objectType":
      return keyParts([
        evidence.kind,
        evidence.objectId,
        evidence.changeKind,
        evidence.package,
        evidence.packageSource,
        evidence.mvrName,
        evidence.type
      ]);
    case "sharedObject":
      return keyParts([evidence.kind, evidence.objectId, evidence.label]);
  }
}

function keyParts(values: Array<string | undefined>): string {
  return values.map((value) => value ?? "").join("\u001f");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function compareAscii(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}
