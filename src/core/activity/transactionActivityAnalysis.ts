import type {
  ExternalActivityIncompleteReason,
  ExternalActivityRelationship,
  ExternalActivityTransactionStatus
} from "./activityStore.js";
import {
  compactExternalActivityTransactionDetails,
  suiGasCostFact,
  type ExternalActivityGasCostFact,
  type ExternalActivityTransactionCompactFacts,
  type ExternalActivityTransactionDetail
} from "./transactionActivityDetails.js";

export const SUI_ACTIVITY_ANALYSIS_MOVE_CALL_TARGET_LIMIT = 20;
export const SUI_ACTIVITY_ANALYSIS_PROTOCOL_LIMIT = 20;
export const SUI_ACTIVITY_ANALYSIS_COIN_FLOW_LIMIT = 50;
export const SUI_ACTIVITY_ANALYSIS_EVENT_TYPE_LIMIT = 20;
export const SUI_ACTIVITY_ANALYSIS_FAILURE_LIMIT = 20;

export const suiActivityAnalysisLimitations = [
  "details_missing",
  "protocol_labels_absent",
  "failed_without_error_detail",
  "detail_truncated",
  "window_incomplete",
  "window_latest_only",
  "ordering_unverified",
  "stored_scan_incomplete",
  "empty_result",
  "analysis_rows_truncated",
  "move_call_targets_truncated",
  "protocols_truncated",
  "coin_flows_truncated",
  "event_types_truncated",
  "failures_truncated"
] as const;

export type SuiActivityAnalysisLimitation = typeof suiActivityAnalysisLimitations[number];

export type SuiActivityAnalysisTransaction = {
  digest: string;
  checkpoint?: string | undefined;
  timestamp?: string | undefined;
  status: ExternalActivityTransactionStatus;
  relationship?: ExternalActivityRelationship | undefined;
  compact?: ExternalActivityTransactionCompactFacts | undefined;
  details?: ExternalActivityTransactionDetail | undefined;
  lastScanIncompleteReason?: ExternalActivityIncompleteReason | undefined;
};

export type SuiActivityAnalysisContext = {
  storedAccountFlows?: boolean;
  relationship?: ExternalActivityRelationship | undefined;
  windowComplete?: boolean | null | undefined;
  orderingVerified?: boolean | undefined;
  truncated?: boolean | undefined;
  summary?: {
    transactionCount: number;
    statusCounts: Record<ExternalActivityTransactionStatus, number>;
    relationshipCounts: Record<ExternalActivityRelationship, number>;
    relationshipObservationCounts?: Record<ExternalActivityRelationship, number>;
    earliestTimestamp?: string | undefined;
    latestTimestamp?: string | undefined;
  } | undefined;
};

export type SuiActivityAnalysis = {
  overview: {
    transactionCount: number;
    analyzedTransactionCount: number;
    statusCounts: Record<ExternalActivityTransactionStatus, number>;
    relationshipCounts: Record<ExternalActivityRelationship, number>;
    relationshipObservationCounts?: Record<ExternalActivityRelationship, number>;
    earliestTimestamp?: string | undefined;
    latestTimestamp?: string | undefined;
    earliestCheckpoint?: string | undefined;
    latestCheckpoint?: string | undefined;
  };
  moveCallTargets: Array<{ target: string; count: number }>;
  protocols: Array<{ protocolId: string; displayName?: string | undefined; count: number; statusCounts: Record<ExternalActivityTransactionStatus, number> }>;
  coinFlows: Array<{
    coinType: string;
    increaseRaw: string;
    decreaseRaw: string;
    netRaw: string;
    transactionCount: number;
  }>;
  objectChanges: {
    created: number;
    mutated: number;
    deleted: number;
  };
  eventTypes: Array<{ eventType: string; count: number }>;
  gas?: {
    transactionCount: number;
    netGasCostRaw: string;
    netGasCost: ExternalActivityGasCostFact;
  } | undefined;
  failures: Array<{
    message: string;
    count: number;
    abortCodeRaw?: string | undefined;
    package?: string | undefined;
    module?: string | undefined;
    function?: string | undefined;
  }>;
  limitations: SuiActivityAnalysisLimitation[];
};

type CountRow = { key: string; count: number };

type CoinFlowAccumulator = {
  increaseRaw: bigint;
  decreaseRaw: bigint;
  netRaw: bigint;
  digests: Set<string>;
};

type FailureKey = {
  message: string;
  abortCodeRaw?: string | undefined;
  package?: string | undefined;
  module?: string | undefined;
  function?: string | undefined;
};

export function buildSuiActivityAnalysis(
  transactions: SuiActivityAnalysisTransaction[],
  context: SuiActivityAnalysisContext = {}
): SuiActivityAnalysis {
  const limitations = new Set<SuiActivityAnalysisLimitation>();
  if (transactions.length === 0) {
    limitations.add("empty_result");
  }
  if (context.windowComplete === false) {
    limitations.add("window_incomplete");
  } else if (context.windowComplete === null) {
    limitations.add("window_latest_only");
  }
  if (context.orderingVerified === false) {
    limitations.add("ordering_unverified");
  }
  if (context.truncated === true) {
    limitations.add("analysis_rows_truncated");
  }

  const statusCounts = zeroStatusCounts();
  const relationshipCounts = zeroRelationshipCounts();
  let earliestTimestamp: string | undefined;
  let latestTimestamp: string | undefined;
  let earliestCheckpoint: string | undefined;
  let latestCheckpoint: string | undefined;
  const moveCallCounts = new Map<string, number>();
  const protocolCounts = new Map<string, { displayName?: string | undefined; count: number; statusCounts: Record<ExternalActivityTransactionStatus, number> }>();
  const coinFlows = new Map<string, CoinFlowAccumulator>();
  const objectChanges = { created: 0, mutated: 0, deleted: 0 };
  const eventTypeCounts = new Map<string, number>();
  let gasTransactionCount = 0;
  let gasNetCostRaw = 0n;
  const failures = new Map<string, { key: FailureKey; count: number }>();

  for (const transaction of transactions) {
    statusCounts[transaction.status] += 1;
    const relationship = transaction.relationship ?? context.relationship;
    if (relationship !== undefined) {
      relationshipCounts[relationship] += 1;
    }
    earliestTimestamp = earlierIso(earliestTimestamp, transaction.timestamp);
    latestTimestamp = laterIso(latestTimestamp, transaction.timestamp);
    earliestCheckpoint = earlierCheckpoint(earliestCheckpoint, transaction.checkpoint);
    latestCheckpoint = laterCheckpoint(latestCheckpoint, transaction.checkpoint);
    if (transaction.lastScanIncompleteReason !== undefined) {
      limitations.add("stored_scan_incomplete");
    }

    const compact = compactFacts(transaction);
    if (compact === undefined) {
      limitations.add("details_missing");
      if (transaction.status === "failure") {
        limitations.add("failed_without_error_detail");
      }
      continue;
    }

    if (compact.protocolMatches === undefined || compact.protocolMatches.length === 0) {
      limitations.add("protocol_labels_absent");
    }
    if (compact.detailTruncated) {
      limitations.add("detail_truncated");
    }
    for (const target of compact.moveCallTargets) {
      incrementMap(moveCallCounts, target);
    }
    const protocolsInTransaction = new Set<string>();
    for (const match of compact.protocolMatches ?? []) {
      if (protocolsInTransaction.has(match.protocolId)) {
        continue;
      }
      protocolsInTransaction.add(match.protocolId);
      const existing = protocolCounts.get(match.protocolId);
      const counts = existing?.statusCounts ?? zeroStatusCounts();
      counts[transaction.status] += 1;
      protocolCounts.set(match.protocolId, {
        statusCounts: counts,
        displayName: existing?.displayName ?? match.displayName,
        count: (existing?.count ?? 0) + 1
      });
    }
    for (const change of context.storedAccountFlows && transaction.details?.truncation.balanceChanges ? [] : compact.balanceChanges) {
      const entry = coinFlows.get(change.coinType) ?? {
        increaseRaw: 0n,
        decreaseRaw: 0n,
        netRaw: 0n,
        digests: new Set<string>()
      };
      const count = BigInt(change.count ?? 1);
      const amount = BigInt(change.amountRaw) * count;
      entry.netRaw += amount;
      if (change.direction === "increase") {
        entry.increaseRaw += absBigInt(amount);
      } else if (change.direction === "decrease") {
        entry.decreaseRaw += absBigInt(amount);
      }
      entry.digests.add(transaction.digest);
      coinFlows.set(change.coinType, entry);
    }
    objectChanges.created += compact.objectChangeCounts.created;
    objectChanges.mutated += compact.objectChangeCounts.mutated;
    objectChanges.deleted += compact.objectChangeCounts.deleted;
    for (const eventType of compact.eventTypes) {
      incrementMap(eventTypeCounts, eventType);
    }
    if (compact.gasNetCostRaw !== undefined) {
      gasTransactionCount += 1;
      gasNetCostRaw += BigInt(compact.gasNetCostRaw);
    }
    if (transaction.status === "failure" && compact.executionError === undefined) {
      limitations.add("failed_without_error_detail");
    }
    if (compact.executionError !== undefined) {
      const key = failureKey(compact.executionError);
      const serialized = JSON.stringify(key);
      const existing = failures.get(serialized);
      failures.set(serialized, { key, count: (existing?.count ?? 0) + 1 });
    }
  }

  const moveCallTargets = topCountRows(moveCallCounts, SUI_ACTIVITY_ANALYSIS_MOVE_CALL_TARGET_LIMIT)
    .map((row) => ({ target: row.key, count: row.count }));
  if (moveCallCounts.size > SUI_ACTIVITY_ANALYSIS_MOVE_CALL_TARGET_LIMIT) {
    limitations.add("move_call_targets_truncated");
  }
  const protocols = [...protocolCounts.entries()]
    .map(([protocolId, value]) => ({ protocolId, ...value }))
    .sort(compareProtocolRows)
    .slice(0, SUI_ACTIVITY_ANALYSIS_PROTOCOL_LIMIT);
  if (protocolCounts.size > SUI_ACTIVITY_ANALYSIS_PROTOCOL_LIMIT) {
    limitations.add("protocols_truncated");
  }
  const coinFlowRows = [...coinFlows.entries()]
    .map(([coinType, value]) => ({
      coinType,
      increaseRaw: value.increaseRaw.toString(),
      decreaseRaw: value.decreaseRaw.toString(),
      netRaw: value.netRaw.toString(),
      transactionCount: value.digests.size
    }))
    .sort(compareCoinFlowRows)
    .slice(0, SUI_ACTIVITY_ANALYSIS_COIN_FLOW_LIMIT);
  if (coinFlows.size > SUI_ACTIVITY_ANALYSIS_COIN_FLOW_LIMIT) {
    limitations.add("coin_flows_truncated");
  }
  const eventTypes = topCountRows(eventTypeCounts, SUI_ACTIVITY_ANALYSIS_EVENT_TYPE_LIMIT)
    .map((row) => ({ eventType: row.key, count: row.count }));
  if (eventTypeCounts.size > SUI_ACTIVITY_ANALYSIS_EVENT_TYPE_LIMIT) {
    limitations.add("event_types_truncated");
  }
  const failureRows = [...failures.values()]
    .sort(compareFailureRows)
    .slice(0, SUI_ACTIVITY_ANALYSIS_FAILURE_LIMIT)
    .map(({ key, count }) => ({ ...key, count }));
  if (failures.size > SUI_ACTIVITY_ANALYSIS_FAILURE_LIMIT) {
    limitations.add("failures_truncated");
  }

  const overviewSummary = context.summary;
  const overviewEarliestTimestamp = overviewSummary?.earliestTimestamp ?? earliestTimestamp;
  const overviewLatestTimestamp = overviewSummary?.latestTimestamp ?? latestTimestamp;
  return {
    overview: {
      transactionCount: overviewSummary?.transactionCount ?? transactions.length,
      analyzedTransactionCount: transactions.length,
      statusCounts: overviewSummary?.statusCounts ?? statusCounts,
      relationshipCounts: overviewSummary?.relationshipCounts ?? relationshipCounts,
      ...(overviewSummary?.relationshipObservationCounts ? { relationshipObservationCounts: overviewSummary.relationshipObservationCounts } : {}),
      ...(overviewEarliestTimestamp === undefined ? {} : { earliestTimestamp: overviewEarliestTimestamp }),
      ...(overviewLatestTimestamp === undefined ? {} : { latestTimestamp: overviewLatestTimestamp }),
      ...(earliestCheckpoint === undefined ? {} : { earliestCheckpoint }),
      ...(latestCheckpoint === undefined ? {} : { latestCheckpoint })
    },
    moveCallTargets,
    protocols,
    coinFlows: coinFlowRows,
    objectChanges,
    eventTypes,
    ...(gasTransactionCount === 0
      ? {}
      : {
          gas: {
            transactionCount: gasTransactionCount,
            netGasCostRaw: gasNetCostRaw.toString(),
            netGasCost: suiGasCostFact(gasNetCostRaw.toString())
          }
        }),
    failures: failureRows,
    limitations: [...limitations].sort()
  };
}

function compactFacts(transaction: SuiActivityAnalysisTransaction): ExternalActivityTransactionCompactFacts | undefined {
  if (transaction.compact !== undefined) {
    return transaction.compact;
  }
  return transaction.details === undefined
    ? undefined
    : compactExternalActivityTransactionDetails(transaction.details, transaction.status);
}

function zeroStatusCounts(): Record<ExternalActivityTransactionStatus, number> {
  return { success: 0, failure: 0, unknown: 0 };
}

function zeroRelationshipCounts(): Record<ExternalActivityRelationship, number> {
  return { affected: 0, sent: 0 };
}

function incrementMap(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function topCountRows(map: Map<string, number>, limit: number): CountRow[] {
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort(compareCountRows)
    .slice(0, limit);
}

function compareCountRows(a: CountRow, b: CountRow): number {
  return b.count - a.count || compareAscii(a.key, b.key);
}

function compareProtocolRows(
  a: { protocolId: string; count: number },
  b: { protocolId: string; count: number }
): number {
  return b.count - a.count || compareAscii(a.protocolId, b.protocolId);
}

function compareCoinFlowRows(
  a: { coinType: string; transactionCount: number },
  b: { coinType: string; transactionCount: number }
): number {
  return b.transactionCount - a.transactionCount || compareAscii(a.coinType, b.coinType);
}

function compareFailureRows(
  a: { key: FailureKey; count: number },
  b: { key: FailureKey; count: number }
): number {
  return b.count - a.count || compareAscii(failureSortKey(a.key), failureSortKey(b.key));
}

function failureKey(error: NonNullable<ExternalActivityTransactionCompactFacts["executionError"]>): FailureKey {
  return {
    message: error.message,
    ...(error.abortCodeRaw === undefined ? {} : { abortCodeRaw: error.abortCodeRaw }),
    ...(error.package === undefined ? {} : { package: error.package }),
    ...(error.module === undefined ? {} : { module: error.module }),
    ...(error.function === undefined ? {} : { function: error.function })
  };
}

function failureSortKey(key: FailureKey): string {
  return [
    key.message,
    key.abortCodeRaw ?? "",
    key.package ?? "",
    key.module ?? "",
    key.function ?? ""
  ].join("\u0000");
}

function earlierIso(current: string | undefined, candidate: string | undefined): string | undefined {
  if (candidate === undefined) return current;
  if (current === undefined) return candidate;
  return candidate < current ? candidate : current;
}

function laterIso(current: string | undefined, candidate: string | undefined): string | undefined {
  if (candidate === undefined) return current;
  if (current === undefined) return candidate;
  return candidate > current ? candidate : current;
}

function earlierCheckpoint(current: string | undefined, candidate: string | undefined): string | undefined {
  if (candidate === undefined) return current;
  if (current === undefined) return candidate;
  return BigInt(candidate) < BigInt(current) ? candidate : current;
}

function laterCheckpoint(current: string | undefined, candidate: string | undefined): string | undefined {
  if (candidate === undefined) return current;
  if (current === undefined) return candidate;
  return BigInt(candidate) > BigInt(current) ? candidate : current;
}

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function compareAscii(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
