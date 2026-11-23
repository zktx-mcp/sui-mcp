import type {
  ExternalActivityCoverageLimitation,
  ExternalActivityCoverageResult,
  ExternalActivityScanRecord,
  ReviewActivityAccountSource
} from "./activityStore.js";

export type ExternalActivityCoverageScope = {
  account: string;
  accountId?: number | undefined;
  accountSource: ReviewActivityAccountSource;
};

export function buildExternalActivityCoverageResult(input: {
  scope: ExternalActivityCoverageScope;
  from: string;
  to: string;
  scans: ExternalActivityScanRecord[];
  scanCount: number;
  storedTransactionCount: number;
  transactionsWithoutTime?: number;
  storedTransactionRange?: ExternalActivityCoverageResult["storedTransactionRange"] | undefined;
  scansTruncated?: boolean | undefined;
  proofIds?: string[];
}): ExternalActivityCoverageResult {
  const completeAffectedAccountScanIds = input.proofIds ?? input.scans
    .filter((scan) => scanCompletesAffectedAccountRange(scan, input.from, input.to))
    .map((scan) => scan.scanId);
  const incompleteScanIds = input.scans
    .filter((scan) => scan.windowComplete === false || scan.incompleteReason !== undefined)
    .map((scan) => scan.scanId);
  const sentOnlyScanIds = input.scans
    .filter((scan) => scan.kind === "account_scan" && scan.relationship === "sent")
    .map((scan) => scan.scanId);
  const limitations = new Set<ExternalActivityCoverageLimitation>();
  const scansTruncated = input.scansTruncated === true;

  if (input.scanCount === 0) {
    limitations.add("no_stored_activity_scans");
  }
  if (completeAffectedAccountScanIds.length === 0) {
    limitations.add("no_complete_affected_account_scan");
  }
  if (sentOnlyScanIds.length > 0) {
    limitations.add("sent_only_scan_not_full_account_coverage");
  }
  if (incompleteScanIds.length > 0) {
    limitations.add("scan_window_incomplete");
  }
  if (input.scans.some((scan) => scan.fromTimestamp === undefined || scan.toTimestamp === undefined)) {
    limitations.add("scan_window_unbounded");
  }
  if (scansTruncated) {
    limitations.add("scan_records_truncated");
  }

  return {
    dataScope: {
      account: input.scope.account,
      from: input.from,
      to: input.to,
      recordCount: input.storedTransactionCount
    },
    accountSource: input.scope.accountSource,
    accountKnown: input.scope.accountId !== undefined,
    requestedRange: {
      from: input.from,
      to: input.to
    },
    coverageStatus: input.scanCount === 0
      ? "no_stored_scans"
      : completeAffectedAccountScanIds.length > 0
        ? "complete"
        : "partial",
    scanCount: input.scanCount,
    returnedScanCount: input.scans.length,
    scansTruncated,
    storedTransactionCount: input.storedTransactionCount,
    transactionsWithoutTime: input.transactionsWithoutTime ?? 0,
    ...(input.storedTransactionRange === undefined ? {} : { storedTransactionRange: input.storedTransactionRange }),
    coverageEvidence: {
      completeAffectedAccountScanIds,
      incompleteScanIds,
      sentOnlyScanIds
    },
    limitations: [...limitations].sort(),
    scans: input.scans
  };
}

export function scanCompletesAffectedAccountRange(scan: ExternalActivityScanRecord, from: string, to: string): boolean {
  return scan.kind === "account_scan" &&
    scan.relationship === "affected" &&
    scan.windowComplete === true && scan.fromCheckpoint === undefined && scan.toCheckpoint === undefined &&
    scan.incompleteReason === undefined &&
    scan.fromTimestamp !== undefined &&
    scan.toTimestamp !== undefined &&
    scan.fromTimestamp <= from &&
    scan.toTimestamp >= to;
}
