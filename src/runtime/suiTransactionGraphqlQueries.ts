import type { SuiGraphQLClient } from "@mysten/sui/graphql";
import { TransactionActivitySourceError } from "../core/activity/transactionActivityTypes.js";
import type { GraphqlTransactionNode } from "./suiTransactionGraphqlMapping.js";

const LOCAL_TRANSACTION_DETAIL_LIMITS = {
  moveCallLimit: 50,
  balanceChangeLimit: 100,
  objectChangeLimit: 100,
  eventLimit: 50
} as const;

const TRANSACTION_DETAIL_FRAGMENT = `
  fragment SuiMcpTransactionDetail on Transaction {
    digest
    sender { address }
    kind {
      __typename
      ... on ProgrammableTransaction {
        commands(first: $moveCallLimit) {
          nodes {
            __typename
            ... on MoveCallCommand {
              function {
                fullyQualifiedName
                name
                module {
                  name
                  package { address }
                }
              }
            }
          }
          pageInfo { hasNextPage }
        }
      }
    }
    effects {
      status
      timestamp
      checkpoint { sequenceNumber }
      executionError {
        message
        abortCode
        identifier
        instructionOffset
        sourceLineNumber
        module {
          name
          package { address }
        }
        function {
          name
          module {
            name
            package { address }
          }
        }
      }
      gasEffects {
        gasObject { address }
        gasSummary {
          computationCost
          storageCost
          storageRebate
          nonRefundableStorageFee
        }
      }
      balanceChanges(first: $balanceChangeLimit) {
        nodes {
          amount
          coinType { repr }
          owner { address }
        }
        pageInfo { hasNextPage }
      }
      objectChanges(first: $objectChangeLimit) {
        nodes {
          address
          idCreated
          idDeleted
          inputState { asMoveObject { contents { type { repr } } } }
          outputState { asMoveObject { contents { type { repr } } } }
        }
        pageInfo { hasNextPage }
      }
      events(first: $eventLimit) {
        nodes {
          sequenceNumber
          sender { address }
          transactionModule {
            name
            package { address }
          }
          contents { type { repr } }
        }
        pageInfo { hasNextPage }
      }
    }
  }
`;

export type GraphqlTransactionResult = {
  transaction?: GraphqlTransactionNode | null;
};

export type GraphqlTransactionsResult = {
  serviceConfig?: { availableRange?: {
    first: { sequenceNumber: number; timestamp: string } | null;
    last: { sequenceNumber: number; timestamp: string } | null;
  } | null };
  transactions?: {
    nodes?: GraphqlTransactionNode[] | null;
    pageInfo?: {
      hasPreviousPage?: unknown;
      startCursor?: unknown;
    } | null;
  } | null;
};

type GraphqlServiceConfigResult = {
  serviceConfig?: {
    transactionPageLimit?: unknown;
    moveCallLimit?: unknown;
    balanceChangeLimit?: unknown;
    objectChangeLimit?: unknown;
    eventLimit?: unknown;
  } | null;
};

export type GraphqlServiceLimits = {
  transactionPageLimit: number;
  moveCallLimit: number;
  balanceChangeLimit: number;
  objectChangeLimit: number;
  eventLimit: number;
};

export async function queryInspectTransaction(
  client: SuiGraphQLClient,
  input: { digest: string; limits: GraphqlServiceLimits }
): Promise<GraphqlTransactionResult> {
  return queryGraphql<GraphqlTransactionResult>(client, {
    query: `
      query SuiMcpInspectTransaction(
        $digest: String!
        $moveCallLimit: Int!
        $balanceChangeLimit: Int!
        $objectChangeLimit: Int!
        $eventLimit: Int!
      ) {
        transaction(digest: $digest) {
          ...SuiMcpTransactionDetail
        }
      }
      ${TRANSACTION_DETAIL_FRAGMENT}
    `,
    variables: transactionDetailVariables({ digest: input.digest }, input.limits)
  });
}

export async function queryScanAccountTransactions(
  client: SuiGraphQLClient,
  input: {
    last: number;
    before?: string | undefined;
    filter: Record<string, unknown>;
    limits: GraphqlServiceLimits;
  }
): Promise<GraphqlTransactionsResult> {
  return queryGraphql<GraphqlTransactionsResult>(client, {
    query: `
      query SuiMcpScanAccountActivity(
        $last: Int!
        $before: String
        $filter: TransactionFilter!
        $rangeFilters: [String!]!
        $moveCallLimit: Int!
        $balanceChangeLimit: Int!
        $objectChangeLimit: Int!
        $eventLimit: Int!
      ) {
        serviceConfig {
          availableRange(type: "Query", field: "transactions", filters: $rangeFilters) {
            first { sequenceNumber timestamp }
            last { sequenceNumber timestamp }
          }
        }
        transactions(last: $last, before: $before, filter: $filter) {
          nodes {
            ...SuiMcpTransactionDetail
          }
          pageInfo {
            hasPreviousPage
            startCursor
          }
        }
      }
      ${TRANSACTION_DETAIL_FRAGMENT}
    `,
    variables: {
      ...transactionDetailVariables({}, input.limits),
      last: input.last,
      before: input.before ?? null,
      rangeFilters: Object.keys(input.filter).filter(key => key !== "afterCheckpoint" && key !== "beforeCheckpoint"),
      filter: input.filter
    }
  });
}

export function cursorFromPageInfo(pageInfo: { hasPreviousPage?: unknown; startCursor?: unknown }): string | undefined {
  if (pageInfo.hasPreviousPage !== true) {
    return undefined;
  }
  if (typeof pageInfo.startCursor !== "string" || pageInfo.startCursor.length === 0) {
    throw new TransactionActivitySourceError(
      "provider_error",
      "Sui GraphQL transaction scan reported another page without a continuation cursor"
    );
  }
  return pageInfo.startCursor;
}

export async function loadGraphqlServiceLimits(client: SuiGraphQLClient): Promise<GraphqlServiceLimits> {
  const result = await queryGraphql<GraphqlServiceConfigResult>(client, {
    query: `
      query SuiMcpGraphqlServiceLimits {
        serviceConfig {
          transactionPageLimit: maxPageSize(type: "Query", field: "transactions")
          moveCallLimit: maxPageSize(type: "ProgrammableTransaction", field: "commands")
          balanceChangeLimit: maxPageSize(type: "TransactionEffects", field: "balanceChanges")
          objectChangeLimit: maxPageSize(type: "TransactionEffects", field: "objectChanges")
          eventLimit: maxPageSize(type: "TransactionEffects", field: "events")
        }
      }
    `
  });
  const config = result.serviceConfig;
  if (!config) {
    throw new TransactionActivitySourceError("provider_error", "Sui GraphQL serviceConfig was unavailable");
  }
  return {
    transactionPageLimit: positiveIntFromServiceConfig(config.transactionPageLimit, "Query.transactions"),
    moveCallLimit: Math.min(
      positiveIntFromServiceConfig(config.moveCallLimit, "ProgrammableTransaction.commands"),
      LOCAL_TRANSACTION_DETAIL_LIMITS.moveCallLimit
    ),
    balanceChangeLimit: Math.min(
      positiveIntFromServiceConfig(config.balanceChangeLimit, "TransactionEffects.balanceChanges"),
      LOCAL_TRANSACTION_DETAIL_LIMITS.balanceChangeLimit
    ),
    objectChangeLimit: Math.min(
      positiveIntFromServiceConfig(config.objectChangeLimit, "TransactionEffects.objectChanges"),
      LOCAL_TRANSACTION_DETAIL_LIMITS.objectChangeLimit
    ),
    eventLimit: Math.min(
      positiveIntFromServiceConfig(config.eventLimit, "TransactionEffects.events"),
      LOCAL_TRANSACTION_DETAIL_LIMITS.eventLimit
    )
  };
}

export function graphQlAfterCheckpointForInclusiveLowerBound(value: string): number | undefined {
  const checkpoint = BigInt(value);
  return checkpoint === 0n ? undefined : Number(checkpoint - 1n);
}

export function graphQlBeforeCheckpointForInclusiveUpperBound(value: string): number | undefined {
  const checkpoint = BigInt(value);
  return checkpoint >= BigInt(Number.MAX_SAFE_INTEGER) ? undefined : Number(checkpoint + 1n);
}

function transactionDetailVariables(
  extra: Record<string, unknown>,
  limits: GraphqlServiceLimits
): Record<string, unknown> {
  return {
    ...extra,
    moveCallLimit: limits.moveCallLimit,
    balanceChangeLimit: limits.balanceChangeLimit,
    objectChangeLimit: limits.objectChangeLimit,
    eventLimit: limits.eventLimit
  };
}

function positiveIntFromServiceConfig(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TransactionActivitySourceError("provider_error", "Sui GraphQL serviceConfig returned an invalid page size", {
      field,
      value
    });
  }
  return value;
}

async function queryGraphql<T>(
  client: SuiGraphQLClient,
  options: { query: string; variables?: Record<string, unknown> | undefined }
): Promise<T> {
  try {
    const result = await client.query<T>({ query: options.query, variables: options.variables ?? {} });
    if (result.errors && result.errors.length > 0) {
      const message = result.errors.map((error) => error.message).join("; ");
      // The pinned SDK exposes provider GraphQL errors as messages here. Cursor
      // rejection is intentionally detected conservatively and otherwise falls
      // back to provider_error.
      throw new TransactionActivitySourceError(
        message.toLowerCase().includes("cursor") ? "cursor_invalid" : "provider_error",
        "Sui GraphQL query returned errors",
        { message }
      );
    }
    if (!result.data) {
      throw new TransactionActivitySourceError("provider_error", "Sui GraphQL query returned no data");
    }
    return result.data;
  } catch (error) {
    if (error instanceof TransactionActivitySourceError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new TransactionActivitySourceError(
      message.toLowerCase().includes("cursor") ? "cursor_invalid" : "provider_error",
      "Sui GraphQL query failed",
      { message }
    );
  }
}
