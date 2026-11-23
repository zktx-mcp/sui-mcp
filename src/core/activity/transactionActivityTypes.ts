import type { ToolErrorKind } from "../action/types.js";
import type {
  ExternalActivityIncompleteReason,
  ExternalActivityRelationship,
  ExternalActivityScanRecord,
  ExternalActivitySummaryResult,
  ExternalActivityTransactionStatus
} from "./activityStore.js";
import type { SuiActivityAnalysis } from "./transactionActivityAnalysis.js";
import type { ExternalActivityTransactionDetail } from "./transactionActivityDetails.js";

export type SuiTransactionActivityFact = {
  compact?: import("./transactionActivityDetails.js").ExternalActivityTransactionCompactFacts | undefined;
  digest: string;
  checkpoint?: string | undefined;
  timestamp?: string | undefined;
  status: ExternalActivityTransactionStatus;
  sender?: string | undefined;
  details?: ExternalActivityTransactionDetail | undefined;
  accountEffects?: SuiTransactionAccountEffects | undefined;
};

export type SuiAccountBalanceChangeCompleteness = "complete" | "truncated" | "unavailable";
export type SuiAccountBalanceChangeEvidence =
  | "account_balance_changes_returned"
  | "no_account_balance_changes_returned"
  | "incomplete_account_balance_changes"
  | "account_balance_changes_unavailable";
export type SuiAccountBalanceChangeInferencePolicy =
  | "use_returned_account_balance_changes"
  | "no_account_balance_changes_in_complete_details"
  | "do_not_infer_from_transaction_context";
export type SuiTransactionAccountRole = "sender" | "affected_only" | "unconfirmed";
export type SuiTransactionAccountEffectLimitation =
  | "provider_balance_changes_truncated"
  | "transaction_details_unavailable";

export type SuiAccountScopedBalanceChange = {
  index: number;
  coinType: string;
  amountRaw: string;
  direction: "increase" | "decrease" | "zero";
};

export type SuiTransactionAccountEffects = {
  account: string;
  scope: "requested_account";
  role: SuiTransactionAccountRole;
  sentByAccount: boolean;
  balanceChangeEvidence: SuiAccountBalanceChangeEvidence;
  accountBalanceChangeInferencePolicy: SuiAccountBalanceChangeInferencePolicy;
  balanceChangeCompleteness: SuiAccountBalanceChangeCompleteness;
  balanceChanges: SuiAccountScopedBalanceChange[];
  coinFlows: Array<{
    coinType: string;
    increaseRaw: string;
    decreaseRaw: string;
    netRaw: string;
  }>;
  limitations: SuiTransactionAccountEffectLimitation[];
};

export type SuiRequestedAccountActivity = {
  account: string;
  relationship: ExternalActivityRelationship;
  sentCount: number;
  affectedOnlyCount: number;
  unconfirmedCount: number;
  balanceChangeCompleteness: SuiAccountBalanceChangeCompleteness;
  coinFlows: Array<{
    coinType: string;
    increaseRaw: string;
    decreaseRaw: string;
    netRaw: string;
    transactionCount: number;
  }>;
};

export type SuiTransactionActivityPage = {
  sourceRange?: import("./activityStore.js").ScanSourceRange | undefined;
  orderingVerified?: boolean;
  transactions: SuiTransactionActivityFact[];
  hasMore: boolean;
  cursor?: string | undefined;
};

export type SuiTransactionActivitySourceInfo = {
  endpointHost: string;
  chainIdentifier: string;
  transport: "graphql";
};

export type SuiTransactionActivitySource = {
  verifyMainnet(): Promise<SuiTransactionActivitySourceInfo>;
  getTransaction(digest: string): Promise<SuiTransactionActivityFact | null>;
  scanAccount(input: {
    account: string;
    relationship: ExternalActivityRelationship;
    limit: number;
    cursor?: string | undefined;
    fromCheckpoint?: string | undefined;
    toCheckpoint?: string | undefined;
  }): Promise<SuiTransactionActivityPage>;
  scanFunction(input: {
    functionTarget: string;
    sentAddress: string;
    limit: number;
    cursor?: string | undefined;
    fromCheckpoint?: string | undefined;
    toCheckpoint?: string | undefined;
  }): Promise<SuiTransactionActivityPage>;
};

export type InspectSuiTransactionInput = {
  digest: string;
  account?: string | undefined;
};

export type InspectSuiTransactionResult = {
  status: "ok";
  fetchedAt: string;
  source: SuiTransactionActivitySourceInfo & { method: "Query.transaction" };
  transaction: SuiTransactionActivityFact;
  persistence: {
    stored: boolean;
    reason?: "no_known_wallet_relation" | "transaction_not_found" | undefined;
    account?: string | undefined;
    relationship?: ExternalActivityRelationship | undefined;
    scan?: ExternalActivityScanRecord | undefined;
  };
};

export type ScanSuiAccountActivityInput = {
  account?: string | undefined;
  relationship?: ExternalActivityRelationship | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
  fromCheckpoint?: string | undefined;
  toCheckpoint?: string | undefined;
  fromTimestamp?: string | undefined;
  toTimestamp?: string | undefined;
};

export type ScanSuiFunctionActivityInput = {
  function: string;
  account?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
  fromCheckpoint?: string | undefined;
  toCheckpoint?: string | undefined;
  fromTimestamp?: string | undefined;
  toTimestamp?: string | undefined;
};

export type SuiFunctionTarget = {
  package: string;
  module: string;
  function: string;
  target: string;
};

export type ScanSuiAccountActivityResult = {
  status: "ok";
  fetchedAt: string;
  account: string;
  accountKnown: boolean;
  accountSource: "active_account_context" | "explicit_filter";
  relationship: ExternalActivityRelationship;
  requestedAccount: SuiRequestedAccountActivity;
  source: SuiTransactionActivitySourceInfo & { method: "Query.transactions" };
  transactions: SuiTransactionActivityFact[];
  hasMore: boolean;
  continuationCursor?: string | undefined;
  windowComplete: boolean | null;
  orderingVerified: boolean;
  incompleteReason?: ExternalActivityIncompleteReason | undefined;
  persistence: {
    stored: boolean;
    reason?: "account_not_known" | undefined;
    scan?: ExternalActivityScanRecord | undefined;
  };
};

export type ScanSuiFunctionActivityResult = {
  status: "ok";
  fetchedAt: string;
  account: string;
  accountKnown: boolean;
  accountSource: "active_account_context" | "explicit_filter";
  function: string;
  relationship: "sent";
  requestedAccount: SuiRequestedAccountActivity;
  source: SuiTransactionActivitySourceInfo & { method: "Query.transactions" };
  transactions: SuiTransactionActivityFact[];
  hasMore: boolean;
  continuationCursor?: string | undefined;
  windowComplete: boolean | null;
  orderingVerified: boolean;
  incompleteReason?: ExternalActivityIncompleteReason | undefined;
  persistence: {
    stored: boolean;
    reason?: "account_not_known" | undefined;
    scan?: ExternalActivityScanRecord | undefined;
  };
};

export type SummarizeSuiActivityScanResult = ScanSuiAccountActivityResult & {
  analysis: SuiActivityAnalysis;
};

export type SummarizeSuiFunctionActivityScanResult = ScanSuiFunctionActivityResult & {
  analysis: SuiActivityAnalysis;
};

export type SummarizeSuiAccountActivityResult = ExternalActivitySummaryResult & {
  status: "ok";
  analysis: Omit<SuiActivityAnalysis, "coinFlows">;
  accountCoinFlows: { scope: "complete_stored_balance_changes_in_returned_transactions"; completeTransactions: number;
    incompleteTransactions: number; rowsTruncated: boolean; rows: SuiActivityAnalysis["coinFlows"] };
};

export class TransactionActivityError extends Error {
  constructor(
    readonly kind: Extract<ToolErrorKind, "input_invalid" | "active_account_not_set" | "network_mismatch" | "internal_error">,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

export class TransactionActivitySourceError extends Error {
  constructor(
    readonly reason: "provider_error" | "cursor_invalid",
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
  }
}
