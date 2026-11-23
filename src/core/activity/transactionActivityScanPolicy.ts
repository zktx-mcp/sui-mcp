import { z } from "zod";
import {
  EXTERNAL_ACTIVITY_SCAN_DEFAULT_LIMIT,
  EXTERNAL_ACTIVITY_SCAN_MAX_LIMIT,
  type ExternalActivityIncompleteReason,
  type ExternalActivityScanRecord,
  type ScanContinuity,
  type ExternalActivityRelationship
} from "./activityStore.js";
import { externalActivityTransactionTouchesAccount } from "./transactionActivityDetails.js";
import {
  TransactionActivityError,
  type SuiTransactionActivityFact
} from "./transactionActivityTypes.js";

export function normalizeActivityLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return EXTERNAL_ACTIVITY_SCAN_DEFAULT_LIMIT;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > EXTERNAL_ACTIVITY_SCAN_MAX_LIMIT) {
    throw new TransactionActivityError("input_invalid", "limit must be an integer from 1 to 100", {
      limit,
      min: 1,
      max: EXTERNAL_ACTIVITY_SCAN_MAX_LIMIT
    });
  }
  return limit;
}

export function normalizeCheckpointBound(value: string | undefined, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    throw new TransactionActivityError("input_invalid", "checkpoint bounds must be unsigned integer strings", { field });
  }
  if (BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TransactionActivityError("input_invalid", "checkpoint bounds exceed the current GraphQL numeric filter range", {
      field,
      max: String(Number.MAX_SAFE_INTEGER)
    });
  }
  return String(BigInt(value));
}

export function assertCheckpointRange(fromCheckpoint: string | undefined, toCheckpoint: string | undefined): void {
  if (fromCheckpoint !== undefined && toCheckpoint !== undefined && BigInt(fromCheckpoint) > BigInt(toCheckpoint)) {
    throw new TransactionActivityError("input_invalid", "fromCheckpoint must be less than or equal to toCheckpoint", {
      fromCheckpoint,
      toCheckpoint
    });
  }
}

export function normalizeTimestampBound(value: string | undefined, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TransactionActivityError("input_invalid", "timestamp bounds must be ISO 8601 UTC timestamps", { field });
  }
  return value;
}

export function assertTimestampRange(fromTimestamp: string | undefined, toTimestamp: string | undefined): void {
  if (fromTimestamp !== undefined && toTimestamp !== undefined && fromTimestamp > toTimestamp) {
    throw new TransactionActivityError("input_invalid", "fromTimestamp must be less than or equal to toTimestamp", {
      fromTimestamp,
      toTimestamp
    });
  }
}

export function isMonotonicActivityOrder(transactions: SuiTransactionActivityFact[]): boolean {
  let direction: "ascending" | "descending" | undefined;
  for (let index = 1; index < transactions.length; index += 1) {
    const previous = transactions[index - 1]!;
    const current = transactions[index]!;
    const comparison = compareActivityFactTimeAscending(previous, current);
    if (comparison === 0) {
      continue;
    }
    const pairDirection = comparison < 0 ? "ascending" : "descending";
    if (direction === undefined) {
      direction = pairDirection;
      continue;
    }
    if (direction !== pairDirection) {
      return false;
    }
  }
  return true;
}

export function compareActivityFactsDescending(
  a: SuiTransactionActivityFact,
  b: SuiTransactionActivityFact
): number {
  return -compareActivityFactsAscending(a, b);
}

const checkpointNumber = z.string().regex(/^\d+$/);
const checkpointTime = z.iso.datetime({ precision: 3 });
export const scanContinuitySchema = z.object({
  rootScanId: z.string().min(1), predecessorScanId: z.string().min(1).optional(),
  sourceLower: z.object({ checkpoint: checkpointNumber, timestamp: checkpointTime }).strict().optional(),
  newestCheckpoint: checkpointNumber.optional(), oldestCheckpoint: checkpointNumber.optional(),
  newestTimestamp: checkpointTime.optional(), oldestTimestamp: checkpointTime.optional()
}).strict();

export type ScanPageProof = z.infer<typeof scanContinuitySchema>;

type ScanWindow = Pick<ExternalActivityScanRecord, "scanId" | "requestCursor" | "hasMore" | "continuity" |
  "fromTimestamp" | "toTimestamp" | "fromCheckpoint" | "toCheckpoint" | "sourceUpperTimestamp" | "sourceUpperCheckpoint">;

export function validScanPageBounds(proof: ScanContinuity, upper: string, upperTime: string): boolean {
  const { newestCheckpoint, oldestCheckpoint, newestTimestamp, oldestTimestamp, sourceLower } = proof;
  if (sourceLower && (BigInt(sourceLower.checkpoint) > BigInt(upper) || sourceLower.timestamp > upperTime)) return false;
  if (!newestCheckpoint && !oldestCheckpoint && !newestTimestamp && !oldestTimestamp) return true;
  return !!newestCheckpoint && !!oldestCheckpoint && !!newestTimestamp && !!oldestTimestamp &&
    BigInt(oldestCheckpoint) <= BigInt(newestCheckpoint) && BigInt(newestCheckpoint) <= BigInt(upper) &&
    oldestTimestamp <= newestTimestamp && newestTimestamp <= upperTime;
}

export function scanPageFollows(previous: ScanContinuity, next: ScanContinuity): boolean {
  const before = previous.sourceLower, after = next.sourceLower;
  if (!!before !== !!after || (before && after &&
      (BigInt(after.checkpoint) < BigInt(before.checkpoint) || after.timestamp < before.timestamp))) return false;
  return previous.rootScanId === next.rootScanId && previous.oldestCheckpoint !== undefined &&
    previous.oldestTimestamp !== undefined && (!next.newestCheckpoint || BigInt(next.newestCheckpoint) <= BigInt(previous.oldestCheckpoint)) &&
    (!next.newestTimestamp || next.newestTimestamp <= previous.oldestTimestamp);
}

export function windowCompletion(scan: ScanWindow): boolean | null {
  const { fromTimestamp, toTimestamp, fromCheckpoint, toCheckpoint, continuity: proof } = scan;
  if (!fromTimestamp && !toTimestamp && !fromCheckpoint && !toCheckpoint) return null;
  if (!proof?.sourceLower || !scan.sourceUpperCheckpoint || !scan.sourceUpperTimestamp) return false;
  if (scan.requestCursor ? !proof.predecessorScanId : proof.rootScanId !== scan.scanId || proof.predecessorScanId) return false;

  const first = proof.sourceLower;
  const endCheckpoint = toCheckpoint ?? fromCheckpoint;
  const endTimestamp = toTimestamp ?? fromTimestamp;
  if (BigInt(first.checkpoint) > BigInt(scan.sourceUpperCheckpoint) || first.timestamp > scan.sourceUpperTimestamp ||
      (endCheckpoint && BigInt(endCheckpoint) > BigInt(scan.sourceUpperCheckpoint)) ||
      (endTimestamp && endTimestamp > scan.sourceUpperTimestamp)) return false;
  // Checkpoints can share a timestamp. At a pruned floor, equality alone cannot
  // cover all transactions at the start millisecond.
  const lowerCovered = BigInt(first.checkpoint) === 0n ||
    (fromCheckpoint !== undefined && BigInt(fromCheckpoint) >= BigInt(first.checkpoint)) ||
    (fromTimestamp !== undefined && fromTimestamp > first.timestamp);
  if (!lowerCovered) return false;
  return scanReachedLowerBound(scan);
}

export function scanReachedLowerBound(scan: Pick<ScanWindow, "hasMore" | "fromCheckpoint" | "fromTimestamp" | "continuity">): boolean {
  const { fromTimestamp, fromCheckpoint } = scan;
  return !scan.hasMore ||
    (fromCheckpoint !== undefined && scan.continuity?.oldestCheckpoint !== undefined && BigInt(scan.continuity.oldestCheckpoint) < BigInt(fromCheckpoint)) ||
    (fromTimestamp !== undefined && scan.continuity?.oldestTimestamp !== undefined && scan.continuity.oldestTimestamp < fromTimestamp);
}

export function incompleteReasonForScan(input: {
  orderingVerified: boolean;
  windowComplete: boolean | null;
  hasMore: boolean;
}): ExternalActivityIncompleteReason | undefined {
  if (!input.orderingVerified) return "ordering_unverified";
  return input.windowComplete === false && input.hasMore ? "limit_reached" : undefined;
}

export function filterTransactionsForRequestedWindow(
  transactions: SuiTransactionActivityFact[],
  input: {
    account: string;
    relationship: ExternalActivityRelationship;
    fromCheckpoint?: string | undefined;
    toCheckpoint?: string | undefined;
    fromTimestamp?: string | undefined;
    toTimestamp?: string | undefined;
  }
): SuiTransactionActivityFact[] {
  return transactions.filter((transaction) => {
    if (input.relationship === "sent" && transaction.sender !== input.account) {
      return false;
    }
    if (input.fromCheckpoint !== undefined && (transaction.checkpoint === undefined || BigInt(transaction.checkpoint) < BigInt(input.fromCheckpoint))) {
      return false;
    }
    if (input.toCheckpoint !== undefined && (transaction.checkpoint === undefined || BigInt(transaction.checkpoint) > BigInt(input.toCheckpoint))) {
      return false;
    }
    if (input.fromTimestamp !== undefined && (transaction.timestamp === undefined || transaction.timestamp < input.fromTimestamp)) {
      return false;
    }
    if (input.toTimestamp !== undefined && (transaction.timestamp === undefined || transaction.timestamp > input.toTimestamp)) {
      return false;
    }
    return true;
  });
}

export function transactionMatchesKnownStorageAccount(
  transaction: SuiTransactionActivityFact,
  account: string,
  relationship: ExternalActivityRelationship
): boolean {
  if (relationship === "sent") {
    return transaction.sender === account;
  }
  return transaction.sender === account || externalActivityTransactionTouchesAccount(transaction, account);
}

function compareActivityFactsAscending(a: SuiTransactionActivityFact, b: SuiTransactionActivityFact): number {
  const timeComparison = compareActivityFactTimeAscending(a, b);
  return timeComparison === 0 ? compareStringsAscending(a.digest, b.digest) : timeComparison;
}

function compareActivityFactTimeAscending(a: SuiTransactionActivityFact, b: SuiTransactionActivityFact): number {
  if (a.checkpoint !== undefined && b.checkpoint !== undefined) {
    const checkpointDelta = BigInt(a.checkpoint) - BigInt(b.checkpoint);
    if (checkpointDelta < 0n) return -1;
    if (checkpointDelta > 0n) return 1;
  } else if (a.checkpoint !== undefined) {
    return 1;
  } else if (b.checkpoint !== undefined) {
    return -1;
  }
  if (a.timestamp !== undefined && b.timestamp !== undefined) {
    const timestampDelta = compareStringsAscending(a.timestamp, b.timestamp);
    if (timestampDelta !== 0) return timestampDelta;
  } else if (a.timestamp !== undefined) {
    return 1;
  } else if (b.timestamp !== undefined) {
    return -1;
  }
  return 0;
}

function compareStringsAscending(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
