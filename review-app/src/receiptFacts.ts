import type {
  PublicChainReceipt,
  PublicChainReceiptBalanceChange,
  PublicChainReceiptEvent,
  PublicChainReceiptGas,
  PublicChainReceiptInput,
  PublicChainReceiptPtbGraph
} from "../../src/core/action/suiChainReceiptReader.js";
import type { SuiChainReceiptEffectsStatus, SuiChainReceiptPackageCall } from "../../src/core/action/suiChainReceiptEvidence.js";
import { asRecord } from "./parse.js";

// Pure, DOM-free validation of the shared receipt reader response against the shared
// server SOT types. Kept out of receipt.ts so the fail-closed behaviour is unit
// tested directly (vitest runs in a node environment), not only asserted by a
// source grep.
//
// It validates EVERY field the page renders, down to each balance-change,
// Move-call, input, event, and object-type entry, and CONSTRUCTS the typed result
// instead of casting an unchecked value. A cast would lie about nested fields, so a
// drifted entry (e.g. a numeric amountRaw or a missing address) could render
// "undefined ..."; here any drift returns null and the page shows an error.
// Building the object also makes a future field added to the type a compile
// error here, so the validator cannot silently fall behind the type.
export function parseReceipt(value: unknown): PublicChainReceipt | null {
  const r = asRecord(value);
  if (!r) {
    return null;
  }
  if (typeof r.txDigest !== "string") {
    return null;
  }
  if (r.sender !== undefined && typeof r.sender !== "string") {
    return null;
  }
  if (typeof r.chainIdentifier !== "string") {
    return null;
  }
  if (typeof r.fetchedAt !== "string") {
    return null;
  }
  const effectsStatus = parseEffectsStatus(r.effectsStatus);
  if (!effectsStatus) {
    return null;
  }
  const balanceChanges = parseBalanceChanges(r.balanceChanges);
  if (!balanceChanges) {
    return null;
  }
  const packageCalls = parsePackageCalls(r.packageCalls);
  if (!packageCalls) {
    return null;
  }
  const objectTypes = parseObjectTypes(r.objectTypes);
  if (!objectTypes) {
    return null;
  }
  if (r.unavailableFields !== undefined && (!Array.isArray(r.unavailableFields) || !r.unavailableFields.every(v =>
    ["sender","packageCalls","balanceChanges","objectTypes","gas","inputs","events","ptbGraph"].includes(v)))) return null;
  const unavailableFields = r.unavailableFields as string[] | undefined;
  const gas = parseGas(r.gas);
  if (!gas && !(r.gas === undefined && unavailableFields?.includes("gas"))) {
    return null;
  }
  const inputs = parseInputs(r.inputs);
  if (!inputs) {
    return null;
  }
  const events = parseEvents(r.events);
  if (!events) {
    return null;
  }
  const ptbGraph = parsePtbGraph(r.ptbGraph);
  if (!ptbGraph.ok) {
    return null;
  }
  return {
    txDigest: r.txDigest,
    sender: r.sender,
    effectsStatus,
    packageCalls,
    balanceChanges,
    objectTypes,
    gas: gas ?? undefined,
    ...(unavailableFields ? { unavailableFields } : {}),
    inputs,
    events,
    ptbGraph: ptbGraph.graph,
    chainIdentifier: r.chainIdentifier,
    fetchedAt: r.fetchedAt
  };
}

function parseEffectsStatus(value: unknown): SuiChainReceiptEffectsStatus | null {
  const r = asRecord(value);
  if (!r || typeof r.success !== "boolean") {
    return null;
  }
  if (r.success) {
    return { success: true };
  }
  const status: { success: false; errorKind?: string; errorMessage?: string; failedCommand?: number; minimumReceiveFailure?: true } = { success: false };
  if (typeof r.failedCommand === "number" && Number.isSafeInteger(r.failedCommand) && r.failedCommand >= 0) status.failedCommand = r.failedCommand;
  if (r.minimumReceiveFailure === true && status.failedCommand !== undefined) status.minimumReceiveFailure = true;
  if (r.errorKind !== undefined) {
    if (typeof r.errorKind !== "string") {
      return null;
    }
    status.errorKind = r.errorKind;
  }
  if (r.errorMessage !== undefined) {
    if (typeof r.errorMessage !== "string") {
      return null;
    }
    status.errorMessage = r.errorMessage;
  }
  return status;
}

function parseBalanceChanges(value: unknown): PublicChainReceiptBalanceChange[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const changes: PublicChainReceiptBalanceChange[] = [];
  for (const entry of value) {
    const r = asRecord(entry);
    if (!r) {
      return null;
    }
    if (typeof r.index !== "number") {
      return null;
    }
    if (typeof r.address !== "string" || typeof r.coinType !== "string" || typeof r.amountRaw !== "string") {
      return null;
    }
    if (r.direction !== "increase" && r.direction !== "decrease" && r.direction !== "zero") {
      return null;
    }
    // decimals + symbol are optional best-effort enrichment: absent is valid, a
    // present-but-wrong-typed value is drift and fails closed.
    const decimals = optionalNumber(r.decimals);
    const symbol = optionalString(r.symbol);
    if (decimals === INVALID || symbol === INVALID) {
      return null;
    }
    const change: PublicChainReceiptBalanceChange = {
      index: r.index,
      address: r.address,
      coinType: r.coinType,
      amountRaw: r.amountRaw,
      direction: r.direction
    };
    if (decimals !== undefined) {
      change.decimals = decimals;
    }
    if (symbol !== undefined) {
      change.symbol = symbol;
    }
    changes.push(change);
  }
  return changes;
}

function parsePackageCalls(value: unknown): SuiChainReceiptPackageCall[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const calls: SuiChainReceiptPackageCall[] = [];
  for (const entry of value) {
    const r = asRecord(entry);
    if (!r) {
      return null;
    }
    if (typeof r.commandIndex !== "number") {
      return null;
    }
    if (
      typeof r.packageId !== "string" ||
      typeof r.module !== "string" ||
      typeof r.function !== "string" ||
      typeof r.target !== "string"
    ) {
      return null;
    }
    calls.push({
      commandIndex: r.commandIndex,
      packageId: r.packageId,
      module: r.module,
      function: r.function,
      target: r.target
    });
  }
  return calls;
}

function parseObjectTypes(value: unknown): Record<string, string> | null {
  if (Array.isArray(value)) {
    return null;
  }
  const r = asRecord(value);
  if (!r) {
    return null;
  }
  const objectTypes: Record<string, string> = {};
  for (const [objectId, objectType] of Object.entries(r)) {
    if (typeof objectType !== "string") {
      return null;
    }
    objectTypes[objectId] = objectType;
  }
  return objectTypes;
}

function parseGas(value: unknown): PublicChainReceiptGas | null {
  const r = asRecord(value);
  if (!r) {
    return null;
  }
  if (
    typeof r.totalMist !== "string" ||
    typeof r.computationMist !== "string" ||
    typeof r.storageMist !== "string" ||
    typeof r.storageRebateMist !== "string" ||
    typeof r.nonRefundableStorageMist !== "string"
  ) {
    return null;
  }
  const budgetMist = optionalString(r.budgetMist);
  const priceMist = optionalString(r.priceMist);
  const paymentObjectId = optionalString(r.paymentObjectId);
  if (budgetMist === INVALID || priceMist === INVALID || paymentObjectId === INVALID) {
    return null;
  }
  return {
    totalMist: r.totalMist,
    computationMist: r.computationMist,
    storageMist: r.storageMist,
    storageRebateMist: r.storageRebateMist,
    nonRefundableStorageMist: r.nonRefundableStorageMist,
    budgetMist,
    priceMist,
    paymentObjectId
  };
}

function parseInputs(value: unknown): PublicChainReceiptInput[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const inputs: PublicChainReceiptInput[] = [];
  for (const entry of value) {
    const r = asRecord(entry);
    if (!r || typeof r.index !== "number") {
      return null;
    }
    const kind = r.kind;
    if (
      kind !== "object" &&
      kind !== "shared_object" &&
      kind !== "receiving" &&
      kind !== "pure" &&
      kind !== "withdrawal" &&
      kind !== "unknown"
    ) {
      return null;
    }
    const objectId = optionalString(r.objectId);
    const bytes = optionalString(r.bytes);
    if (objectId === INVALID || bytes === INVALID) {
      return null;
    }
    const parsedInput: PublicChainReceiptInput = { index: r.index, kind, objectId };
    if (bytes !== undefined) {
      parsedInput.bytes = bytes;
    }
    inputs.push(parsedInput);
  }
  return inputs;
}

function parseEvents(value: unknown): PublicChainReceiptEvent[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const events: PublicChainReceiptEvent[] = [];
  for (const entry of value) {
    const r = asRecord(entry);
    if (!r || typeof r.index !== "number") {
      return null;
    }
    if (
      typeof r.packageId !== "string" ||
      typeof r.module !== "string" ||
      typeof r.eventType !== "string" ||
      typeof r.sender !== "string"
    ) {
      return null;
    }
    events.push({ index: r.index, packageId: r.packageId, module: r.module, eventType: r.eventType, sender: r.sender });
  }
  return events;
}

// The PTB graph is optional: absent is valid (undefined), a present-but-malformed
// value fails closed.
function parsePtbGraph(value: unknown): { ok: true; graph: PublicChainReceiptPtbGraph | undefined } | { ok: false } {
  if (value === undefined || value === null) {
    return { ok: true, graph: undefined };
  }
  const r = asRecord(value);
  const mermaid = r ? asRecord(r.mermaid) : undefined;
  if (!mermaid || typeof mermaid.text !== "string" || typeof mermaid.namedText !== "string") {
    return { ok: false };
  }
  return { ok: true, graph: { mermaid: { text: mermaid.text, namedText: mermaid.namedText } } };
}

const INVALID = Symbol("invalid");

// undefined → valid absent; string → valid; anything else → INVALID sentinel.
function optionalString(value: unknown): string | undefined | typeof INVALID {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "string" ? value : INVALID;
}

// undefined → valid absent; number → valid; anything else → INVALID sentinel.
function optionalNumber(value: unknown): number | undefined | typeof INVALID {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "number" ? value : INVALID;
}
