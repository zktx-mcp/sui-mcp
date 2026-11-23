import type {
  ExternalActivityTransactionRecord,
  ExternalActivityTransactionStreamResult,
  ReviewActivityAccountSource
} from "./activityStore.js";

export type ExternalActivityTransactionStreamScope = {
  account: string;
  accountId?: number | undefined;
  accountSource: ReviewActivityAccountSource;
};

export function buildExternalActivityTransactionStreamResult(input: {
  scope: ExternalActivityTransactionStreamScope;
  from: string;
  to: string;
  transactions: ExternalActivityTransactionRecord[];
  truncated: boolean;
  transactionCount: number;
}): ExternalActivityTransactionStreamResult {
  return {
    dataScope: {
      account: input.scope.account,
      from: input.from,
      to: input.to,
      recordCount: input.transactionCount
    },
    accountSource: input.scope.accountSource,
    accountKnown: input.scope.accountId !== undefined,
    truncated: input.truncated,
    transactionCount: input.transactionCount,
    transactions: input.transactions
  };
}
