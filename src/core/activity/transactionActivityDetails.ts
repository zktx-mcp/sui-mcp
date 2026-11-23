import { isDeepStrictEqual } from "node:util";
import { Buffer } from "node:buffer";
import { MIST_PER_SUI, SUI_DECIMALS } from "@mysten/sui/utils";
import { z } from "zod";
import { parseSuiAddress } from "../suiAddress.js";
import {
  classifySuiDeFiActivity,
  protocolActivityClassifierMatchSchema
} from "./transactionActivityClassifier.js";

export const EXTERNAL_ACTIVITY_TRANSACTION_DETAIL_JSON_MAX_BYTES = 64 * 1024;
export const SUI_GAS_UNIT_SOURCE = "@mysten/sui MIST_PER_SUI" as const;

export const externalActivityGasCostFactSchema = z.object({
  netCostRaw: z.string().regex(/^-?\d+$/),
  rawUnit: z.literal("MIST"),
  display: z.string().regex(/^-?\d+(?:\.\d+)?$/),
  displayUnit: z.literal("SUI"),
  decimals: z.literal(SUI_DECIMALS),
  unitSource: z.literal(SUI_GAS_UNIT_SOURCE)
}).strict();

export const detailFieldNames = ["moveCalls","balanceChanges","objectChanges","events"] as const;
type DetailField = typeof detailFieldNames[number];
export type PartialFieldReason = "not_returned" | "source_truncated" | "unreadable_rows" | "truncated_and_unreadable" | "conflicting_observations";
const fieldReason = z.enum(["not_returned","source_truncated","unreadable_rows","truncated_and_unreadable","conflicting_observations"]);
const identifiedField = z.enum(["moveCalls", "events", "objectChanges"]);
const rowConflict = z.object({
  field: identifiedField,
  id: z.string().min(1),
  property: z.enum(["sender", "package", "module", "eventType", "inputType", "outputType"]).optional()
}).strict();
type RowConflict = z.infer<typeof rowConflict>;
export const externalActivityTransactionDetailSchema = z.object({
  transactionKind: z.string().optional(),
  moveCalls: z.array(z.object({
    commandIndex: z.number().int().nonnegative(),
    package: z.string(),
    module: z.string(),
    function: z.string(),
    target: z.string()
  }).strict()),
  balanceChanges: z.array(z.object({
    index: z.number().int().nonnegative(),
    owner: z.string().optional(),
    coinType: z.string(),
    amountRaw: z.string().regex(/^-?\d+$/),
    direction: z.enum(["increase", "decrease", "zero"])
  }).strict()),
  objectChanges: z.array(z.object({
    index: z.number().int().nonnegative(),
    objectId: z.string(),
    changeKind: z.enum(["created", "mutated", "deleted"]),
    inputType: z.string().optional(),
    outputType: z.string().optional()
  }).strict()),
  events: z.array(z.object({
    sequenceNumber: z.string().regex(/^\d+$/),
    sender: z.string().optional(),
    package: z.string().optional(),
    module: z.string().optional(),
    eventType: z.string().optional()
  }).strict()),
  gas: z.object({
    gasObjectId: z.string().optional(),
    computationCostRaw: z.string().regex(/^\d+$/).optional(),
    storageCostRaw: z.string().regex(/^\d+$/).optional(),
    storageRebateRaw: z.string().regex(/^\d+$/).optional(),
    nonRefundableStorageFeeRaw: z.string().regex(/^\d+$/).optional(),
    netGasCostRaw: z.string().regex(/^-?\d+$/).optional()
  }).strict().optional(),
  executionError: z.object({
    message: z.string(),
    abortCodeRaw: z.string().regex(/^\d+$/).optional(),
    identifier: z.string().optional(),
    instructionOffset: z.number().int().nonnegative().optional(),
    sourceLineNumber: z.number().int().nonnegative().optional(),
    package: z.string().optional(),
    module: z.string().optional(),
    function: z.string().optional()
  }).strict().optional(),
  accountBalanceScope: z.string().optional(),
  partialReasons: z.partialRecord(z.enum(detailFieldNames), fieldReason).optional(),
  rowConflicts: z.array(rowConflict).optional(),
  observedFullLists: z.array(identifiedField).optional(),
  conflictingFields: z.array(z.enum([...detailFieldNames, "gas", "executionError", "transactionKind"])).optional(),
  truncation: z.object({
    moveCalls: z.boolean(),
    balanceChanges: z.boolean(),
    objectChanges: z.boolean(),
    events: z.boolean()
  }).strict()
}).strict().superRefine((detail, ctx) => {
  for (const conflict of detail.rowConflicts ?? []) {
    const rows = conflict.field === "events" ? detail.events.filter(r => r.sequenceNumber === conflict.id)
      : conflict.field === "objectChanges" ? detail.objectChanges.filter(r => r.objectId + "/" + r.changeKind === conflict.id)
      : detail.moveCalls.filter(r => String(r.commandIndex) === conflict.id);
    const optional = conflict.field === "events" ? ["eventType", "package", "sender", "module"]
      : conflict.field === "objectChanges" ? ["inputType", "outputType"] : [];
    if (!detail.truncation[conflict.field] || !detail.conflictingFields?.includes(conflict.field) ||
        (conflict.property ? !optional.includes(conflict.property) || rows.some(r => Object.hasOwn(r, conflict.property!)) : rows.length > 0)) {
      ctx.addIssue({ code: "custom", message: "A conflicting activity fact cannot be asserted as observed." });
    }
  }
});

export const externalActivityTransactionCompactFactsSchema = z.object({
  balanceChangeScope: z.enum(["transaction", "requested_account"]),
  factScope: z.literal("transaction"),
  requestedAccountScoped: z.literal(false),
  balanceChangesAccount: z.string().optional(),
  moveCallTargets: z.array(z.string()),
  balanceChanges: z.array(z.object({
    coinType: z.string(),
    amountRaw: z.string().regex(/^-?\d+$/),
    direction: z.enum(["increase", "decrease", "zero"]),
    count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()
  }).strict()),
  objectChangeCounts: z.object({
    created: z.number().int().nonnegative(),
    mutated: z.number().int().nonnegative(),
    deleted: z.number().int().nonnegative()
  }).strict(),
  eventTypes: z.array(z.string()),
  gasCost: externalActivityGasCostFactSchema.optional(),
  gasNetCostRaw: z.string().regex(/^-?\d+$/).optional(),
  executionError: z.object({
    message: z.string(),
    abortCodeRaw: z.string().regex(/^\d+$/).optional(),
    package: z.string().optional(),
    module: z.string().optional(),
    function: z.string().optional()
  }).strict().optional(),
  detailTruncated: z.boolean(),
  protocolMatches: z.array(protocolActivityClassifierMatchSchema).optional()
}).strict();

export type ExternalActivityTransactionDetail = z.infer<typeof externalActivityTransactionDetailSchema>;
export type ExternalActivityGasCostFact = z.infer<typeof externalActivityGasCostFactSchema>;
export type ExternalActivityTransactionCompactFacts = z.infer<typeof externalActivityTransactionCompactFactsSchema>;
export type ExternalActivityMoveCallFact = ExternalActivityTransactionDetail["moveCalls"][number];
export type ExternalActivityBalanceChangeFact = ExternalActivityTransactionDetail["balanceChanges"][number];
export type ExternalActivityObjectChangeFact = ExternalActivityTransactionDetail["objectChanges"][number];

export function externalActivityTransactionDetailJsonByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function sanitizeExternalActivityTransactionDetailsForKnownAccount(
  details: ExternalActivityTransactionDetail,
  storageAccount: string
): ExternalActivityTransactionDetail {
  return {
    ...details,
    accountBalanceScope: storageAccount,
    balanceChanges: details.balanceChanges.filter((change) => addressMatches(change.owner, storageAccount))
      .map((change) => ({ ...change, owner: storageAccount })),
    events: details.events.map((event) => {
      if (addressMatches(event.sender, storageAccount)) {
        return { ...event, sender: storageAccount };
      }
      const { sender: _sender, ...withoutSender } = event;
      return withoutSender;
    })
  };
}

export function externalActivityTransactionTouchesAccount(
  transaction: { details?: ExternalActivityTransactionDetail | undefined },
  account: string
): boolean {
  return externalActivityTransactionBalanceOwners(transaction).includes(account);
}

export function externalActivityTransactionBalanceOwners(
  transaction: { details?: ExternalActivityTransactionDetail | undefined }
): string[] {
  const owners = transaction.details?.balanceChanges.flatMap((change) => {
    const owner = change.owner === undefined ? undefined : parseSuiAddress(change.owner);
    return owner === undefined ? [] : [owner];
  }) ?? [];
  return [...new Set(owners)];
}

export function externalActivityTransactionDetailsReferenceOnlyAccount(
  details: ExternalActivityTransactionDetail,
  account: string
): boolean {
  return (!details.accountBalanceScope || details.accountBalanceScope === account) && details.balanceChanges.every((change) => addressMatches(change.owner, account))
    && details.events.every((event) => event.sender === undefined || addressMatches(event.sender, account));
}

export function compactExternalActivityTransactionDetails(
  details: ExternalActivityTransactionDetail,
  status: "success" | "failure" | "unknown" = "unknown"
): ExternalActivityTransactionCompactFacts {
  const objectChangeCounts = {
    created: 0,
    mutated: 0,
    deleted: 0
  };
  for (const change of details.objectChanges) {
    objectChangeCounts[change.changeKind] += 1;
  }

  const executionError = details.executionError === undefined
    ? undefined
    : {
        message: details.executionError.message,
        ...(details.executionError.abortCodeRaw === undefined ? {} : { abortCodeRaw: details.executionError.abortCodeRaw }),
        ...(details.executionError.package === undefined ? {} : { package: details.executionError.package }),
        ...(details.executionError.module === undefined ? {} : { module: details.executionError.module }),
        ...(details.executionError.function === undefined ? {} : { function: details.executionError.function })
      };

  const protocolMatches = classifySuiDeFiActivity(details, status);

  return {
    balanceChangeScope: details.accountBalanceScope ? "requested_account" : "transaction",
    factScope: "transaction",
    requestedAccountScoped: false,
    ...(details.accountBalanceScope ? { balanceChangesAccount: details.accountBalanceScope } : {}),
    moveCallTargets: uniqueStrings(details.moveCalls.map((call) => call.target)),
    balanceChanges: compactBalanceChanges(details.balanceChanges),
    objectChangeCounts,
    eventTypes: uniqueStrings(details.events.flatMap((event) => event.eventType === undefined ? [] : [event.eventType])),
    ...(details.gas?.netGasCostRaw === undefined ? {} : { gasCost: suiGasCostFact(details.gas.netGasCostRaw) }),
    ...(details.gas?.netGasCostRaw === undefined ? {} : { gasNetCostRaw: details.gas.netGasCostRaw }),
    ...(executionError === undefined ? {} : { executionError }),
    detailTruncated: details.truncation.moveCalls
      || details.truncation.balanceChanges
      || details.truncation.objectChanges
      || details.truncation.events,
    ...(protocolMatches.length === 0 ? {} : { protocolMatches })
  };
}

export function suiGasCostFact(netCostRaw: string): ExternalActivityGasCostFact {
  return {
    netCostRaw,
    rawUnit: "MIST",
    display: formatSignedMistAsSui(netCostRaw),
    displayUnit: "SUI",
    decimals: SUI_DECIMALS,
    unitSource: SUI_GAS_UNIT_SOURCE
  };
}

function formatSignedMistAsSui(raw: string): string {
  if (!/^-?\d+$/.test(raw)) {
    throw new Error("gas raw amount must be a signed integer string");
  }
  const negative = raw.startsWith("-");
  const unsignedRaw = negative ? raw.slice(1) : raw;
  const amount = BigInt(unsignedRaw);
  const whole = amount / MIST_PER_SUI;
  const fractional = amount % MIST_PER_SUI;
  const sign = negative && amount !== 0n ? "-" : "";
  if (fractional === 0n) {
    return `${sign}${whole.toString()}`;
  }
  const fractionalText = fractional
    .toString()
    .padStart(SUI_DECIMALS, "0")
    .replace(/0+$/, "");
  return `${sign}${whole.toString()}.${fractionalText}`;
}

function compactBalanceChanges(
  balanceChanges: ExternalActivityTransactionDetail["balanceChanges"]
): ExternalActivityTransactionCompactFacts["balanceChanges"] {
  const compacted = new Map<string, {
    coinType: string;
    amountRaw: string;
    direction: "increase" | "decrease" | "zero";
    count: number;
  }>();

  for (const change of balanceChanges) {
    const key = `${change.coinType}\n${change.amountRaw}\n${change.direction}`;
    const existing = compacted.get(key);
    if (existing === undefined) {
      compacted.set(key, {
        coinType: change.coinType,
        amountRaw: change.amountRaw,
        direction: change.direction,
        count: 1
      });
      continue;
    }
    existing.count += 1;
  }

  return [...compacted.values()].map((change) => ({
    coinType: change.coinType,
    amountRaw: change.amountRaw,
    direction: change.direction,
    ...(change.count === 1 ? {} : { count: change.count })
  }));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function addressMatches(candidate: string | undefined, account: string): candidate is string {
  const normalized = candidate === undefined ? undefined : parseSuiAddress(candidate);
  return normalized !== undefined && normalized === account;
}

// Optional fields describe observations. Different defined values on the same
// immutable fact are a conflict; a missing field can be filled by a later read.
function combineProperties<T extends object>(left: T, right: T, position?: keyof T): T | undefined {
  const merged = { ...left };
  for (const key of Object.keys(right) as (keyof T)[]) {
    const value = right[key];
    if (key === position || value === undefined) continue;
    if (merged[key] !== undefined && !isDeepStrictEqual(merged[key], value)) return undefined;
    merged[key] = value;
  }
  return merged;
}

function combineIdentifiedRows<T extends object>(
  left: T[], right: T[], leftFull: boolean, rightFull: boolean, field: RowConflict["field"],
  conflicts: RowConflict[], key: (row: T) => string, ignore?: keyof T
): T[] {
  const rows = new Map<string, T>(), priorIds = new Set<string>();
  const nextIds = new Set<string>();
  const excluded = new Set(conflicts.filter(c => c.field === field && !c.property).map(c => c.id));
  function exclude(id: string) {
    if (!excluded.has(id)) conflicts.push({ field, id });
    excluded.add(id);
  }
  for (const row of left) {
    const id = key(row);
    if (priorIds.has(id)) exclude(id);
    priorIds.add(id);
    rows.set(id, { ...row });
  }
  for (const row of right) {
    const id = key(row);
    if (nextIds.has(id) || leftFull && !priorIds.has(id)) exclude(id);
    nextIds.add(id);
    const combined = rows.get(id);
    if (!combined) { rows.set(id, { ...row }); continue; }
    for (const property of Object.keys(row) as (keyof T)[]) {
      if (property === ignore || row[property] === undefined) continue;
      if (combined[property] === undefined || isDeepStrictEqual(combined[property], row[property])) {
        combined[property] = row[property];
      } else if (field === "moveCalls") {
        // A Move target requires all of its components.
        exclude(id);
      } else {
        conflicts.push({ field, id, property: property as RowConflict["property"] });
      }
    }
  }
  if (rightFull) for (const id of priorIds) if (!nextIds.has(id)) exclude(id);
  for (const conflict of conflicts) {
    if (conflict.field !== field) continue;
    const row = rows.get(conflict.id);
    if (row && conflict.property) delete row[conflict.property as keyof T];
    else rows.delete(conflict.id);
  }
  return Array.from(rows.values());
}

export function mergeActivityDetails(prior: ExternalActivityTransactionDetail, next: ExternalActivityTransactionDetail): ExternalActivityTransactionDetail {
  const merged = { ...prior, ...next, truncation: { ...next.truncation } };
  const reasons: Partial<Record<DetailField, PartialFieldReason>> = {};
  const conflicts = new Set([...(prior.conflictingFields ?? []), ...(next.conflictingFields ?? [])]);
  const evidence = [...(prior.rowConflicts ?? []), ...(next.rowConflicts ?? [])];
  const fullLists = new Set([...(prior.observedFullLists ?? []), ...(next.observedFullLists ?? [])]);
  for (const field of detailFieldNames) {
    const leftComplete = !prior.truncation[field], rightComplete = !next.truncation[field];
    const leftFull = leftComplete || field !== "balanceChanges" && !!prior.observedFullLists?.includes(field);
    const rightFull = rightComplete || field !== "balanceChanges" && !!next.observedFullLists?.includes(field);
    let rows;
    switch (field) {
      case "moveCalls": rows = combineIdentifiedRows(prior.moveCalls, next.moveCalls, leftFull, rightFull, field, evidence, r => String(r.commandIndex)); break;
      case "events": rows = combineIdentifiedRows(prior.events, next.events, leftFull, rightFull, field, evidence, r => r.sequenceNumber); break;
      case "objectChanges": rows = combineIdentifiedRows(prior.objectChanges, next.objectChanges, leftFull, rightFull, field, evidence, r => r.objectId + "/" + r.changeKind, "index"); break;
      case "balanceChanges": {
        // Provider offsets are not stable identities. Preserve multiplicity and
        // compare full observations as multisets. Never add two partial lists.
        const amounts = (items: typeof prior.balanceChanges) => items.map(r => JSON.stringify([r.owner, r.coinType, r.amountRaw])).sort();
        if (leftComplete || rightComplete) {
          const complete = amounts(leftComplete ? prior.balanceChanges : next.balanceChanges);
          const observed = amounts(leftComplete ? next.balanceChanges : prior.balanceChanges);
          let index = 0;
          for (const item of complete) if (item === observed[index]) index++;
          if (index !== observed.length || leftComplete && rightComplete && complete.length !== observed.length) break;
        }
        rows = leftComplete || !rightComplete && prior.balanceChanges.length > next.balanceChanges.length ? prior.balanceChanges : next.balanceChanges;
        break;
      }
    }
    const rowDisagreement = field !== "balanceChanges" && evidence.some(c => c.field === field);
    if (!rows || rowDisagreement) conflicts.add(field);
    if (conflicts.has(field)) {
      const unknownPrior = [prior, next].some(detail => detail.conflictingFields?.includes(field) && !detail.rowConflicts?.some(c => c.field === field));
      Object.assign(merged, { [field]: rowDisagreement && !unknownPrior ? rows : [] });
      if (field !== "balanceChanges" && rowDisagreement && (leftFull || rightFull)) fullLists.add(field);
      merged.truncation[field] = true;
      reasons[field] = "conflicting_observations";
    } else {
      Object.assign(merged, { [field]: rows });
      merged.truncation[field] = !leftComplete && !rightComplete;
      if (merged.truncation[field]) {
        const reason = next.partialReasons?.[field] ?? prior.partialReasons?.[field];
        if (reason) reasons[field] = reason;
      }
    }
  }
  for (const field of ["gas", "executionError"] as const) {
    const left = prior[field], right = next[field];
    const value = left && right ? combineProperties<object>(left, right) : left ?? right;
    if (left && right && !value) conflicts.add(field);
    if (conflicts.has(field)) delete merged[field];
    else if (value) Object.assign(merged, { [field]: value });
  }
  if (prior.transactionKind && next.transactionKind && prior.transactionKind !== next.transactionKind) conflicts.add("transactionKind");
  if (conflicts.has("transactionKind")) delete merged.transactionKind;
  else if (prior.transactionKind) merged.transactionKind = prior.transactionKind;
  if (Object.keys(reasons).length) merged.partialReasons = reasons; else delete merged.partialReasons;
  if (evidence.length) merged.rowConflicts = [...new Map(evidence.map(c => [JSON.stringify([c.field,c.id,c.property]),c])).values()];
  if (fullLists.size) merged.observedFullLists = [...fullLists];
  if (conflicts.size) merged.conflictingFields = [...conflicts].sort();
  return merged;
}
