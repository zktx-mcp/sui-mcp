import { randomUUID } from "node:crypto";
import { isValidTransactionDigest } from "@mysten/sui/utils";
import { SuiEndpointError } from "../suiEndpoint.js";
import { parseSuiAddress } from "../suiAddress.js";
import {
  REVIEW_ACTIVITY_LIST_DEFAULT_LIMIT,
  type ActivityStore,
  type AccountRecord,
  type ExternalActivityRelationship,
  type ExternalActivitySummaryFilter,
  type ExternalActivityTransactionInput
} from "./activityStore.js";
import {
  externalActivityTransactionBalanceOwners,
  externalActivityTransactionTouchesAccount,
  sanitizeExternalActivityTransactionDetailsForKnownAccount
} from "./transactionActivityDetails.js";
import {
  attachRequestedAccountEffects,
  buildRequestedAccountActivity,
  requestedAccountEffectsForTransaction
} from "./transactionActivityAccountEffects.js";
import {
  assertCheckpointRange,
  assertTimestampRange,
  compareActivityFactsDescending,
  filterTransactionsForRequestedWindow,
  incompleteReasonForScan,
  isMonotonicActivityOrder,
  normalizeActivityLimit,
  normalizeCheckpointBound,
  normalizeTimestampBound,
  transactionMatchesKnownStorageAccount,
  windowCompletion
} from "./transactionActivityScanPolicy.js";
import { parseSuiFunctionTarget } from "./suiFunctionTarget.js";
import {
  TransactionActivityError,
  TransactionActivitySourceError,
  type InspectSuiTransactionInput,
  type InspectSuiTransactionResult,
  type ScanSuiAccountActivityInput,
  type ScanSuiAccountActivityResult,
  type ScanSuiFunctionActivityInput,
  type ScanSuiFunctionActivityResult,
  type SuiTransactionActivityFact,
  type SuiTransactionActivityPage,
  type SuiTransactionActivitySource,
  type SuiTransactionActivitySourceInfo,
  type SummarizeSuiAccountActivityResult,
  type SummarizeSuiActivityScanResult,
  type SummarizeSuiFunctionActivityScanResult
} from "./transactionActivityTypes.js";
import { buildSuiActivityAnalysis } from "./transactionActivityAnalysis.js";

export {
  TransactionActivityError,
  TransactionActivitySourceError
} from "./transactionActivityTypes.js";
export type {
  InspectSuiTransactionInput,
  InspectSuiTransactionResult,
  ScanSuiAccountActivityInput,
  ScanSuiAccountActivityResult,
  ScanSuiFunctionActivityInput,
  ScanSuiFunctionActivityResult,
  SuiTransactionActivityFact,
  SuiTransactionActivityPage,
  SuiTransactionActivitySource,
  SuiTransactionActivitySourceInfo,
  SummarizeSuiAccountActivityResult,
  SummarizeSuiActivityScanResult,
  SummarizeSuiFunctionActivityScanResult
} from "./transactionActivityTypes.js";

export type TransactionActivityServiceOptions = {
  activityStore: ActivityStore;
  source: SuiTransactionActivitySource;
  now?: (() => Date) | undefined;
  scanId?: (() => string) | undefined;
};

type ActivityScanBaseRequest = {
  account?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
  fromCheckpoint?: string | undefined;
  toCheckpoint?: string | undefined;
  fromTimestamp?: string | undefined;
  toTimestamp?: string | undefined;
};

type ActivityScanSourceContext = {
  account: string;
  relationship: ExternalActivityRelationship;
  limit: number;
  cursor?: string | undefined;
  fromCheckpoint?: string | undefined;
  toCheckpoint?: string | undefined;
};

type ActivityScanRunResult<
  TRelationship extends ExternalActivityRelationship,
  TExtra extends object
> = Omit<ScanSuiAccountActivityResult, "relationship"> & {
  relationship: TRelationship;
} & TExtra;

export class TransactionActivityService {
  private readonly now: () => Date;
  private readonly scanId: () => string;

  constructor(private readonly options: TransactionActivityServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.scanId = options.scanId ?? (() => randomUUID());
  }

  async inspectSuiTransaction(input: InspectSuiTransactionInput): Promise<InspectSuiTransactionResult> {
    const digest = parseTransactionDigest(input.digest);
    const explicitAccount = input.account === undefined ? undefined : parseAccount(input.account);
    const source = await this.verifySource();
    const fetchedAt = this.now().toISOString();
    const transaction = await this.mapSourceCall(() => this.options.source.getTransaction(digest));
    if (!transaction) {
      return {
        status: "ok",
        fetchedAt,
        source: { ...source, method: "Query.transaction" },
        transaction: { digest, status: "unknown" },
        persistence: { stored: false, reason: "transaction_not_found" }
      };
    }

    const transactionForExplicitAccount = explicitAccount === undefined
      ? transaction
      : {
          ...transaction,
          accountEffects: requestedAccountEffectsForTransaction(transaction, explicitAccount)
        };
    const known = await this.knownDigestAccountForStorage(explicitAccount, transaction);
    if (!known) {
      return {
        status: "ok",
        fetchedAt,
        source: { ...source, method: "Query.transaction" },
        transaction: transactionForExplicitAccount,
        persistence: { stored: false, reason: "no_known_wallet_relation" }
      };
    }

    const transactionForKnownAccount = {
      ...transaction,
      accountEffects: requestedAccountEffectsForTransaction(transaction, known.account.address)
    };
    const scan = await this.options.activityStore.recordExternalActivityScan({
      scanId: this.scanId(),
      kind: "digest_lookup",
      account: known.account.address,
      relationship: known.relationship,
      inputDigest: digest,
      limit: 1,
      endpointHost: source.endpointHost,
      chainIdentifier: source.chainIdentifier,
      fetchedAt,
      hasMore: false,
      windowComplete: true,
      transactions: [await this.transactionInputForKnownAccount(transactionForKnownAccount, known.relationship, known.account.address)]
    });
    return {
      status: "ok",
      fetchedAt,
      source: { ...source, method: "Query.transaction" },
      transaction: transactionForKnownAccount,
      persistence: {
        stored: true,
        account: known.account.address,
        relationship: known.relationship,
        scan
      }
    };
  }

  async scanSuiAccountActivity(input: ScanSuiAccountActivityInput): Promise<ScanSuiAccountActivityResult> {
    const relationship = input.relationship ?? "affected";
    return this.runActivityScan({
      request: input,
      scanKind: "account_scan",
      relationship,
      cursorInvalidMessage: "Activity scan cursor was rejected by the provider",
      sourceCall: ({ account, limit, cursor, fromCheckpoint, toCheckpoint }) => this.options.source.scanAccount({
        account,
        relationship,
        limit,
        cursor,
        fromCheckpoint,
        toCheckpoint
      })
    });
  }

  async scanSuiFunctionActivity(input: ScanSuiFunctionActivityInput): Promise<ScanSuiFunctionActivityResult> {
    const functionTarget = parseSuiFunctionTarget(input.function);
    return this.runActivityScan({
      request: input,
      scanKind: "function_scan",
      relationship: "sent",
      cursorInvalidMessage: "Function activity scan cursor was rejected by the provider",
      extraResultFields: { function: functionTarget.target },
      sourceCall: ({ account, limit, cursor, fromCheckpoint, toCheckpoint }) => this.options.source.scanFunction({
        functionTarget: functionTarget.target,
        sentAddress: account,
        limit,
        cursor,
        fromCheckpoint,
        toCheckpoint
      })
    });
  }

  private async runActivityScan<
    TRelationship extends ExternalActivityRelationship,
    TExtra extends object = Record<string, never>
  >(input: {
    request: ActivityScanBaseRequest;
    scanKind: "account_scan" | "function_scan";
    relationship: TRelationship;
    cursorInvalidMessage: string;
    sourceCall: (context: ActivityScanSourceContext) => Promise<SuiTransactionActivityPage>;
    extraResultFields?: TExtra | undefined;
  }): Promise<ActivityScanRunResult<TRelationship, TExtra>> {
    const limit = normalizeActivityLimit(input.request.limit);
    const fromCheckpoint = normalizeCheckpointBound(input.request.fromCheckpoint, "fromCheckpoint");
    const toCheckpoint = normalizeCheckpointBound(input.request.toCheckpoint, "toCheckpoint");
    assertCheckpointRange(fromCheckpoint, toCheckpoint);
    const fromTimestamp = normalizeTimestampBound(input.request.fromTimestamp, "fromTimestamp");
    const toTimestamp = normalizeTimestampBound(input.request.toTimestamp, "toTimestamp");
    assertTimestampRange(fromTimestamp, toTimestamp);
    const accountScope = input.request.account === undefined
      ? await this.resolveActiveAccount()
      : { account: parseAccount(input.request.account), accountSource: "explicit_filter" as const };
    const knownAccount = await this.options.activityStore.getKnownAccount(accountScope.account);
    const source = await this.verifySource();
    const fetchedAt = this.now().toISOString();

    let page: SuiTransactionActivityPage;
    try {
      page = await input.sourceCall({
        account: accountScope.account,
        relationship: input.relationship,
        limit,
        cursor: input.request.cursor,
        fromCheckpoint,
        toCheckpoint
      });
    } catch (error) {
      if (error instanceof TransactionActivitySourceError && error.reason === "cursor_invalid") {
        throw new TransactionActivityError("input_invalid", input.cursorInvalidMessage, {
          reason: "cursor_invalid"
        });
      }
      throw this.sourceError(error);
    }

    const orderingVerified = isMonotonicActivityOrder(page.transactions);
    const orderedTransactions = [...page.transactions].sort(compareActivityFactsDescending);
    const orderedPage = { ...page, transactions: orderedTransactions };
    const windowComplete = windowCompletion(
      {
        account: input.request.account,
        relationship: input.relationship,
        limit: input.request.limit,
        cursor: input.request.cursor,
        fromCheckpoint,
        toCheckpoint,
        fromTimestamp,
        toTimestamp
      },
      orderedPage,
      orderingVerified
    );
    const filteredTransactions = filterTransactionsForRequestedWindow(
      orderedTransactions,
      {
        account: accountScope.account,
        relationship: input.relationship,
        fromCheckpoint,
        toCheckpoint,
        fromTimestamp,
        toTimestamp
      }
    );
    const accountScopedTransactions = attachRequestedAccountEffects(filteredTransactions, accountScope.account);
    const cursor = page.hasMore ? page.cursor : undefined;
    const incompleteReason = incompleteReasonForScan({ orderingVerified, windowComplete });
    const resultBase = {
      status: "ok" as const,
      fetchedAt,
      account: accountScope.account,
      accountKnown: knownAccount !== undefined,
      accountSource: accountScope.accountSource,
      ...(input.extraResultFields ?? ({} as TExtra)),
      relationship: input.relationship,
      requestedAccount: buildRequestedAccountActivity({
        account: accountScope.account,
        relationship: input.relationship,
        transactions: accountScopedTransactions
      }),
      source: { ...source, method: "Query.transactions" as const },
      transactions: accountScopedTransactions,
      hasMore: page.hasMore,
      ...(cursor === undefined ? {} : { continuationCursor: cursor }),
      windowComplete,
      orderingVerified,
      ...(incompleteReason === undefined ? {} : { incompleteReason })
    };

    if (!knownAccount) {
      return {
        ...resultBase,
        persistence: { stored: false, reason: "account_not_known" }
      };
    }

    const storageTransactions = accountScopedTransactions.filter((transaction) =>
      transactionMatchesKnownStorageAccount(transaction, knownAccount.address, input.relationship)
    );
    const scan = await this.options.activityStore.recordExternalActivityScan({
      scanId: this.scanId(),
      kind: input.scanKind,
      account: knownAccount.address,
      relationship: input.relationship,
      fromCheckpoint,
      toCheckpoint,
      fromTimestamp,
      toTimestamp,
      limit,
      requestCursor: input.request.cursor,
      responseCursor: cursor,
      endpointHost: source.endpointHost,
      chainIdentifier: source.chainIdentifier,
      fetchedAt,
      hasMore: page.hasMore,
      windowComplete,
      incompleteReason,
      skippedCount: page.transactions.length - storageTransactions.length,
      transactions: await Promise.all(
        storageTransactions.map((transaction) => this.transactionInputForKnownAccount(
          transaction,
          input.relationship,
          knownAccount.address
        ))
      )
    });
    return {
      ...resultBase,
      persistence: { stored: true, scan }
    };
  }

  async summarizeSuiAccountActivity(filter: ExternalActivitySummaryFilter): Promise<SummarizeSuiAccountActivityResult> {
    const summary = await this.options.activityStore.summarizeExternalActivity({
      ...filter,
      limit: filter.limit ?? REVIEW_ACTIVITY_LIST_DEFAULT_LIMIT
    });
    return {
      ...summary,
      status: "ok" as const,
      analysis: buildSuiActivityAnalysis(summary.transactions, {
        truncated: summary.truncated,
        summary: summary.summary
      })
    };
  }

  async summarizeSuiActivityScan(input: ScanSuiAccountActivityInput): Promise<SummarizeSuiActivityScanResult> {
    const result = await this.scanSuiAccountActivity(input);
    return {
      ...result,
      analysis: buildSuiActivityAnalysis(
        result.transactions.map((transaction) => ({
          ...transaction,
          relationship: result.relationship
        })),
        {
          relationship: result.relationship,
          windowComplete: result.windowComplete,
          orderingVerified: result.orderingVerified
        }
      )
    };
  }

  async summarizeSuiFunctionActivityScan(
    input: ScanSuiFunctionActivityInput
  ): Promise<SummarizeSuiFunctionActivityScanResult> {
    const result = await this.scanSuiFunctionActivity(input);
    return {
      ...result,
      analysis: buildSuiActivityAnalysis(
        result.transactions.map((transaction) => ({
          ...transaction,
          relationship: result.relationship
        })),
        {
          relationship: result.relationship,
          windowComplete: result.windowComplete,
          orderingVerified: result.orderingVerified
        }
      )
    };
  }

  private async verifySource(): Promise<SuiTransactionActivitySourceInfo> {
    try {
      return await this.options.source.verifyMainnet();
    } catch (error) {
      throw this.sourceError(error);
    }
  }

  private async resolveActiveAccount(): Promise<{ account: string; accountSource: "active_account_context" }> {
    const active = await this.options.activityStore.getActiveAccount();
    if (!active) {
      throw new TransactionActivityError("active_account_not_set", "No saved read address is set. Provide an explicit Sui account for this read.", {
        action: "provide_account"
      });
    }
    return { account: active.address, accountSource: "active_account_context" };
  }

  private async knownDigestAccountForStorage(
    explicitAccount: string | undefined,
    transaction: SuiTransactionActivityFact
  ): Promise<{ account: AccountRecord; relationship: ExternalActivityRelationship } | undefined> {
    const sender = transaction.sender === undefined ? undefined : parseSuiAddress(transaction.sender);
    if (explicitAccount !== undefined) {
      const account = await this.options.activityStore.getKnownAccount(explicitAccount);
      if (!account) {
        return undefined;
      }
      if (explicitAccount === sender) {
        return { account, relationship: "sent" };
      }
      return externalActivityTransactionTouchesAccount(transaction, explicitAccount) ? { account, relationship: "affected" } : undefined;
    }
    const active = await this.options.activityStore.getActiveAccount();
    if (active && active.address === sender) {
      const account = await this.options.activityStore.getKnownAccount(active.address);
      return account === undefined ? undefined : { account, relationship: "sent" };
    }
    if (active && externalActivityTransactionTouchesAccount(transaction, active.address)) {
      const account = await this.options.activityStore.getKnownAccount(active.address);
      return account === undefined ? undefined : { account, relationship: "affected" };
    }
    if (sender !== undefined) {
      const senderAccount = await this.options.activityStore.getKnownAccount(sender);
      if (senderAccount) {
        return { account: senderAccount, relationship: "sent" };
      }
    }
    for (const owner of externalActivityTransactionBalanceOwners(transaction)) {
      const account = await this.options.activityStore.getKnownAccount(owner);
      if (account) {
        return { account, relationship: "affected" };
      }
    }
    return undefined;
  }

  private async transactionInputForKnownAccount(
    transaction: SuiTransactionActivityFact,
    relationship: ExternalActivityRelationship,
    storageAccount: string
  ): Promise<ExternalActivityTransactionInput> {
    const sender = transaction.sender ? await this.options.activityStore.getKnownAccount(transaction.sender) : undefined;
    return {
      digest: transaction.digest,
      relationship,
      checkpoint: transaction.checkpoint,
      timestamp: transaction.timestamp,
      status: transaction.status,
      knownSenderAccountId: sender?.id,
      details: transaction.details === undefined
        ? undefined
        : sanitizeExternalActivityTransactionDetailsForKnownAccount(transaction.details, storageAccount)
    };
  }

  private async mapSourceCall<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw this.sourceError(error);
    }
  }

  private sourceError(error: unknown): TransactionActivityError {
    if (error instanceof TransactionActivityError) {
      return error;
    }
    if (error instanceof TransactionActivitySourceError) {
      return new TransactionActivityError("internal_error", "Sui GraphQL activity source failed", {
        reason: error.reason,
        ...error.details
      });
    }
    if (error instanceof SuiEndpointError && error.kind === "chain_identifier_mismatch") {
      return new TransactionActivityError("network_mismatch", "Sui GraphQL endpoint is not mainnet", {
        reason: "chain_identifier_mismatch"
      });
    }
    return new TransactionActivityError("internal_error", "Sui GraphQL activity source failed", {
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

function parseAccount(value: string): string {
  const normalized = parseSuiAddress(value);
  if (!normalized) {
    throw new TransactionActivityError("input_invalid", "Invalid Sui account address", { field: "account" });
  }
  return normalized;
}

function parseTransactionDigest(value: string): string {
  const trimmed = value.trim();
  if (!isValidTransactionDigest(trimmed)) {
    throw new TransactionActivityError("input_invalid", "Invalid Sui transaction digest", { field: "digest" });
  }
  return trimmed;
}
