import type { WalletChainId } from "../session/chainAccounts.js";
export const LOCAL_DATA_EXPORT_FORMAT = "sui-mcp.local-data" as const;
export const LOCAL_DATA_NETWORK = "mainnet" as const;

export type LocalDataCounts = {
  accounts: number;
  reviewSessions: number;
  reviewStateSnapshots: number;
  reviewStatusTransitions: number;
  reviewExecutions: number;
  reviewRequests: number;
  outcomeUnknownRequests: number;
  externalActivityScans: number;
  externalActivityTransactions: number;
  localSettings: number;
};

export type LocalDataEnvelope = {
  format: typeof LOCAL_DATA_EXPORT_FORMAT;
  network: typeof LOCAL_DATA_NETWORK;
  exportedAt: string;
  data: LocalDataPayload;
};

export type LocalDataPayload = {
  accounts: AccountExportRow[];
  reviewSessions: ReviewSessionExportRow[];
  reviewStateSnapshots: ReviewStateSnapshotExportRow[];
  reviewStatusTransitions: ReviewStatusTransitionExportRow[];
  reviewExecutions: ReviewExecutionExportRow[];
  reviewRequests: ReviewRequestExportRow[];
  externalActivityScans: ExternalActivityScanExportRow[];
  externalActivityTransactions: ExternalActivityTransactionExportRow[];
  localSettings: LocalSettingExportRow[];
};

export type AccountExportRow = {
  id: number;
  chain_id: WalletChainId;
  address: string;
  first_seen_at: string;
  last_used_at: string;
  first_source: string;
  last_source: string;
};

export type ReviewSessionExportRow = {
  id: string;
  plan_id: string;
  action_kind: string;
  adapter_id: string;
  protocol: string;
  account_id: number | null;
  current_status: string;
  current_attempt_id: string | null;
  opened_at: string | null;
  plan_json: string;
  intent_json: string | null;
  created_at: string;
  updated_at: string;
};

export type ReviewStateSnapshotExportRow = {
  id: number;
  review_revision: number;
  review_session_id: string;
  plan_id: string;
  account_id: number;
  status: string;
  blocked_reason: string | null;
  refresh_reason: string | null;
  state_json: string;
  updated_at: string;
  recorded_at: string;
};

export type ReviewStatusTransitionExportRow = {
  id: number;
  review_session_id: string;
  event: string;
  domain: "review" | "request";
  attempt_id: string | null;
  from_status: string | null;
  to_status: string;
  account_id: number | null;
  reason: string | null;
  transitioned_at: string;
};

export type ReviewExecutionExportRow = {
  attempt_id: string;
  review_session_id: string;
  plan_id: string;
  account_id: number;
  status: string;
  tx_digest: string | null;
  explorer_url: string | null;
  failure_reason: string | null;
  result_json: string;
  recorded_at: string;
  updated_at: string;
};

export type ReviewRequestExportRow = {
  attempt_id: string; review_session_id: string; plan_id: string; review_revision: number;
  account_id: number; transaction_digest: string; review_state_json: string;
  request_status: import("../session/transactionRequest.js").TransactionRequestStatus;
  revision: number; reason: string | null; created_at: string; updated_at: string;
  signature_verified_at: string | null; submitted_at: string | null;
};

export type ExternalActivityScanExportRow = {
  scan_id: string;
  kind: string;
  account_id: number;
  relationship: string;
  input_digest: string | null;
  from_checkpoint: string | null;
  to_checkpoint: string | null;
  from_timestamp: string | null;
  to_timestamp: string | null;
  limit_count: number;
  request_cursor: string | null;
  response_cursor: string | null;
  endpoint_host: string;
  chain_identifier: string;
  fetched_at: string;
  stored_count: number;
  skipped_count: number;
  has_more: number;
  window_complete: number | null;
  incomplete_reason: string | null;
};

export type ExternalActivityTransactionExportRow = {
  account_id: number;
  digest: string;
  relationship: string;
  checkpoint: string | null;
  timestamp: string | null;
  status: string;
  known_sender_account_id: number | null;
  first_scan_id: string;
  last_scan_id: string;
  first_fetched_at: string;
  last_fetched_at: string;
  detail_json: string | null;
};

export type LocalSettingExportRow = {
  key: string;
  value_json: string;
  updated_at: string;
};

export type LocalDataImportPreview = {
  status: "valid";
  format: typeof LOCAL_DATA_EXPORT_FORMAT;
  network: typeof LOCAL_DATA_NETWORK;
  exportedAt: string;
  currentCounts: LocalDataCounts;
  incomingCounts: LocalDataCounts;
  willReplace: true;
  restartRequiredAfterImport: boolean;
};

export type LocalDataMutationResult = {
  status: "reset" | "imported";
  dataCounts: LocalDataCounts;
  sessionsInvalidated: true;
};

export class LocalDataError extends Error {
  constructor(
    readonly kind: "input_invalid" | "internal_error",
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

export interface LocalDataService {
  getDataCounts(): Promise<LocalDataCounts>;
  exportLocalData(now?: Date): Promise<LocalDataEnvelope>;
  previewImportLocalData(input: unknown): Promise<LocalDataImportPreview>;
  importLocalDataReplace(input: unknown, now?: Date): Promise<LocalDataMutationResult>;
  resetLocalData(now?: Date): Promise<LocalDataMutationResult>;
}

type EndpointImportValidator = (url: string) => Promise<void> | void;

export type SqliteLocalDataServiceOptions = {
  onDataReplaced?: (() => void) | undefined;
  advanceRequestDeadlines: (now: Date) => void;
  now?: (() => Date) | undefined;
  suiGrpcUrl: string;
  suiGraphqlUrl: string;
  verifySuiGrpcUrl: EndpointImportValidator;
  verifySuiGraphqlUrl: EndpointImportValidator;
};
