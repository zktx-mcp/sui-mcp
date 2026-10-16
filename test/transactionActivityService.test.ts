import { describe, expect, it, vi } from "vitest";
import {
  TransactionActivityError,
  TransactionActivityService,
  TransactionActivitySourceError,
  type SuiTransactionActivityFact,
  type SuiTransactionActivitySource
} from "../src/core/activity/transactionActivityService.js";
import { InMemoryActivityStore } from "./fixtures/inMemoryActivityStore.js";

const walletAccount = `0x${"a".repeat(64)}`;
const otherWalletAccount = `0x${"b".repeat(64)}`;
const thirdWalletAccount = `0x${"c".repeat(64)}`;
const digest = "5".repeat(44);
const normalizedSuiPackage = `0x${"0".repeat(63)}2`;
const functionTargetInput = "0x2::coin::transfer";
const normalizedFunctionTarget = `${normalizedSuiPackage}::coin::transfer`;
const transactionDetails = {
  transactionKind: "ProgrammableTransaction",
  moveCalls: [
    {
      commandIndex: 0,
      package: "0x2",
      module: "coin",
      function: "transfer",
      target: "0x2::coin::transfer"
    }
  ],
  balanceChanges: [
    {
      index: 0,
      owner: walletAccount,
      coinType: "0x2::sui::SUI",
      amountRaw: "-1000",
      direction: "decrease" as const
    }
  ],
  objectChanges: [
    {
      index: 0,
      objectId: `0x${"8".repeat(64)}`,
      changeKind: "mutated" as const,
      inputType: "0x2::coin::Coin<0x2::sui::SUI>",
      outputType: "0x2::coin::Coin<0x2::sui::SUI>"
    }
  ],
  events: [
    {
      sequenceNumber: "0",
      sender: walletAccount,
      package: "0x2",
      module: "coin",
      eventType: "0x2::coin::CoinCreated<0x2::sui::SUI>"
    }
  ],
  gas: {
    gasObjectId: `0x${"9".repeat(64)}`,
    computationCostRaw: "100",
    storageCostRaw: "20",
    storageRebateRaw: "5",
    nonRefundableStorageFeeRaw: "1",
    netGasCostRaw: "115"
  },
  truncation: {
    moveCalls: false,
    balanceChanges: false,
    objectChanges: false,
    events: false
  }
};

function source(overrides: Partial<SuiTransactionActivitySource> = {}): SuiTransactionActivitySource {
  return {
    async verifyMainnet() {
      return {
        endpointHost: "graphql.mainnet.sui.io",
        chainIdentifier: "mainnet-chain",
        transport: "graphql"
      };
    },
    async getTransaction() {
      return {
        digest,
        checkpoint: "100",
        timestamp: "2026-05-11T00:00:00.000Z",
        status: "success",
        sender: walletAccount,
        details: transactionDetails
      };
    },
    async scanAccount() {
      return {
        transactions: [
          {
            digest,
            checkpoint: "100",
            timestamp: "2026-05-11T00:00:00.000Z",
            status: "success",
            sender: walletAccount,
            details: transactionDetails
          }
        ],
        hasMore: false
      };
    },
    async scanFunction() {
      return {
        transactions: [
          {
            digest,
            checkpoint: "100",
            timestamp: "2026-05-11T00:00:00.000Z",
            status: "success",
            sender: walletAccount,
            details: transactionDetails
          }
        ],
        hasMore: false
      };
    },
    ...overrides
  };
}

function serviceFor(store: InMemoryActivityStore, activitySource = source()): TransactionActivityService {
  return new TransactionActivityService({
    activityStore: store,
    source: activitySource,
    now: () => new Date("2026-05-11T00:00:00.000Z"),
    scanId: vi.fn()
      .mockReturnValueOnce("scan_1")
      .mockReturnValueOnce("scan_2")
  });
}

describe("TransactionActivityService", () => {
  it("stores digest lookups only when the sender is a known wallet", async () => {
    const store = new InMemoryActivityStore();
    await store.seedReadAccount(walletAccount, new Date("2026-05-11T00:00:00.000Z"));
    const service = serviceFor(store);

    await expect(service.inspectSuiTransaction({ digest })).resolves.toMatchObject({
      status: "ok",
      transaction: { digest, sender: walletAccount },
      persistence: {
        stored: true,
        account: walletAccount,
        relationship: "sent"
      }
    });
    expect(store.externalActivityTransactions).toHaveLength(1);
    expect(store.externalActivityTransactions[0]).toMatchObject({
      digest,
      account: walletAccount,
      relationship: "sent",
      details: {
        moveCalls: [{ target: "0x2::coin::transfer" }],
        balanceChanges: [{ coinType: "0x2::sui::SUI", amountRaw: "-1000" }],
        gas: { netGasCostRaw: "115" }
      }
    });
  });

  it("does not store digest lookups when no known wallet relation is confirmed", async () => {
    const store = new InMemoryActivityStore();
    await store.seedReadAccount(walletAccount, new Date("2026-05-11T00:00:00.000Z"));
    const service = serviceFor(
      store,
      source({
        async getTransaction(): Promise<SuiTransactionActivityFact> {
          return {
            digest,
            checkpoint: "100",
            timestamp: "2026-05-11T00:00:00.000Z",
            status: "success",
            sender: otherWalletAccount
          };
        }
      })
    );

    await expect(service.inspectSuiTransaction({ digest })).resolves.toMatchObject({
      persistence: {
        stored: false,
        reason: "no_known_wallet_relation"
      }
    });
    expect(store.externalActivityTransactions).toEqual([]);
  });

  it("returns requested-account effects for explicit digest lookups without storing unknown accounts", async () => {
    const store = new InMemoryActivityStore();
    const service = serviceFor(
      store,
      source({
        async getTransaction(): Promise<SuiTransactionActivityFact> {
          return {
            digest,
            checkpoint: "100",
            timestamp: "2026-05-11T00:00:00.000Z",
            status: "success",
            sender: otherWalletAccount,
            details: {
              ...transactionDetails,
              balanceChanges: [
                {
                  index: 0,
                  owner: walletAccount,
                  coinType: "0x2::sui::SUI",
                  amountRaw: "1000",
                  direction: "increase" as const
                },
                {
                  index: 1,
                  owner: otherWalletAccount,
                  coinType: "0x2::sui::SUI",
                  amountRaw: "-1000",
                  direction: "decrease" as const
                }
              ]
            }
          };
        }
      })
    );

    await expect(service.inspectSuiTransaction({ digest, account: walletAccount })).resolves.toMatchObject({
      transaction: {
        accountEffects: {
          sentByAccount: false,
          balanceChangeEvidence: "account_balance_changes_returned",
          balanceChangeCompleteness: "complete",
          balanceChanges: [
            {
              index: 0,
              coinType: "0x2::sui::SUI",
              amountRaw: "1000",
              direction: "increase"
            }
          ]
        }
      },
      persistence: {
        stored: false,
        reason: "no_known_wallet_relation"
      }
    });
    expect(store.externalActivityTransactions).toEqual([]);
  });

  it("stores digest lookups when a returned balance-change owner is a known wallet", async () => {
    const store = new InMemoryActivityStore();
    await store.seedReadAccount(walletAccount, new Date("2026-05-11T00:00:00.000Z"));
    const service = serviceFor(
      store,
      source({
        async getTransaction(): Promise<SuiTransactionActivityFact> {
          return {
            digest,
            checkpoint: "100",
            timestamp: "2026-05-11T00:00:00.000Z",
            status: "success",
            sender: otherWalletAccount,
            details: {
              ...transactionDetails,
              balanceChanges: [
                {
                  index: 0,
                  owner: walletAccount,
                  coinType: "0x2::sui::SUI",
                  amountRaw: "1000",
                  direction: "increase" as const
                }
              ],
              events: [
                {
                  sequenceNumber: "0",
                  sender: otherWalletAccount,
                  package: "0x2",
                  module: "coin",
                  eventType: "0x2::coin::CoinCreated<0x2::sui::SUI>"
                }
              ]
            }
          };
        }
      })
    );

    await expect(service.inspectSuiTransaction({ digest })).resolves.toMatchObject({
      persistence: {
        stored: true,
        account: walletAccount,
        relationship: "affected"
      }
    });
    expect(store.externalActivityTransactions).toHaveLength(1);
    expect(store.externalActivityTransactions[0]).toMatchObject({
      account: walletAccount,
      relationship: "affected",
      details: {
        balanceChanges: [{ owner: walletAccount, amountRaw: "1000" }]
      }
    });
    expect(store.externalActivityTransactions[0]?.details?.events[0]).not.toHaveProperty("sender");
  });

  it("stores digest lookups for known non-active sender accounts without storing unknown parties", async () => {
    const store = new InMemoryActivityStore();
    await store.seedReadAccount(walletAccount, new Date("2026-05-11T00:00:00.000Z"));
    await store.seedReadAccount(otherWalletAccount, new Date("2026-05-11T00:01:00.000Z"));
    const service = serviceFor(
      store,
      source({
        async getTransaction(): Promise<SuiTransactionActivityFact> {
          return {
            digest,
            checkpoint: "100",
            timestamp: "2026-05-11T00:00:00.000Z",
            status: "success",
            sender: walletAccount
          };
        }
      })
    );

    await expect(service.inspectSuiTransaction({ digest })).resolves.toMatchObject({
      persistence: {
        stored: true,
        account: walletAccount,
        relationship: "sent"
      }
    });
    expect(store.externalActivityTransactions).toEqual([
      expect.objectContaining({
        account: walletAccount,
        knownSenderAccountId: 1
      })
    ]);
  });

  it("stores bounded scans for known accounts and leaves recent-N windows unclaimed", async () => {
    const store = new InMemoryActivityStore();
    await store.seedReadAccount(walletAccount, new Date("2026-05-11T00:00:00.000Z"));
    const service = serviceFor(
      store,
      source({
        async scanAccount(input) {
          expect(input).toMatchObject({
            account: walletAccount,
            relationship: "affected",
            limit: 100
          });
          return {
            transactions: [
              {
                digest,
                checkpoint: "100",
                timestamp: "2026-05-11T00:00:00.000Z",
                status: "success",
                sender: walletAccount
              }
            ],
            hasMore: true,
            cursor: "cursor_1"
          };
        }
      })
    );

    await expect(service.scanSuiAccountActivity({})).resolves.toMatchObject({
      account: walletAccount,
      accountKnown: true,
      relationship: "affected",
      hasMore: true,
      continuationCursor: "cursor_1",
      windowComplete: null,
      persistence: {
        stored: true,
        scan: {
          hasMore: true,
          windowComplete: null,
          storedCount: 1
        }
      }
    });
    expect(store.externalActivityTransactions).toHaveLength(1);
  });

  it("summarizes a live bounded scan through the existing scan path", async () => {
    const store = new InMemoryActivityStore();
    await store.seedReadAccount(walletAccount, new Date("2026-05-11T00:00:00.000Z"));
    const service = serviceFor(store);

    await expect(service.summarizeSuiActivityScan({})).resolves.toMatchObject({
      account: walletAccount,
      accountKnown: true,
      relationship: "affected",
      windowComplete: null,
      analysis: {
        overview: {
          transactionCount: 1,
          analyzedTransactionCount: 1,
          statusCounts: { success: 1, failure: 0, unknown: 0 },
          relationshipCounts: { affected: 1, sent: 0 }
        },
        coinFlows: [
          {
            coinType: "0x2::sui::SUI",
            increaseRaw: "0",
            decreaseRaw: "1000",
            netRaw: "-1000",
            transactionCount: 1
          }
        ],
        gas: { transactionCount: 1, netGasCostRaw: "115" },
        limitations: expect.arrayContaining(["protocol_labels_absent", "window_latest_only"])
      },
      persistence: {
        stored: true
      }
    });
  });

  it("separates requested-account raw flows from transaction-wide compact aggregates", async () => {
    const store = new InMemoryActivityStore();
    const rwaCoinType = `0x${"c".repeat(64)}::rwa::RWA`;
    const service = serviceFor(
      store,
      source({
        async scanAccount() {
          return {
            transactions: [
              {
                digest,
                checkpoint: "100",
                timestamp: "2026-05-11T00:00:00.000Z",
                status: "success",
                sender: otherWalletAccount,
                details: {
                  ...transactionDetails,
                  balanceChanges: [
                    {
                      index: 0,
                      owner: walletAccount,
                      coinType: rwaCoinType,
                      amountRaw: "4000000000",
                      direction: "increase" as const
                    },
                    {
                      index: 1,
                      owner: otherWalletAccount,
                      coinType: rwaCoinType,
                      amountRaw: "4000000000",
                      direction: "increase" as const
                    },
                    {
                      index: 2,
                      owner: thirdWalletAccount,
                      coinType: rwaCoinType,
                      amountRaw: "4000000000",
                      direction: "increase" as const
                    }
                  ]
                }
              }
            ],
            hasMore: false
          };
        }
      })
    );

    const result = await service.summarizeSuiActivityScan({ account: walletAccount });

    expect(result.requestedAccount).toEqual({
      account: walletAccount,
      relationship: "affected",
      sentCount: 0,
      affectedOnlyCount: 1,
      balanceChangeCompleteness: "complete",
      coinFlows: [
        {
          coinType: rwaCoinType,
          increaseRaw: "4000000000",
          decreaseRaw: "0",
          netRaw: "4000000000",
          transactionCount: 1
        }
      ]
    });
    expect(result.analysis.coinFlows).toEqual([
      {
        coinType: rwaCoinType,
        increaseRaw: "12000000000",
        decreaseRaw: "0",
        netRaw: "12000000000",
        transactionCount: 1
      }
    ]);
    expect(result.transactions[0]?.accountEffects).toEqual({
      account: walletAccount,
      scope: "requested_account",
      role: "affected_only",
      sentByAccount: false,
      balanceChangeEvidence: "account_balance_changes_returned",
      accountBalanceChangeInferencePolicy: "use_returned_account_balance_changes",
      balanceChangeCompleteness: "complete",
      balanceChanges: [
        {
          index: 0,
          coinType: rwaCoinType,
          amountRaw: "4000000000",
          direction: "increase"
        }
      ],
      coinFlows: [
        {
          coinType: rwaCoinType,
          increaseRaw: "4000000000",
          decreaseRaw: "0",
          netRaw: "4000000000"
        }
      ],
      limitations: []
    });
  });

  it("marks requested-account balance changes as truncated when provider detail pages are truncated", async () => {
    const store = new InMemoryActivityStore();
    const service = serviceFor(
      store,
      source({
        async scanAccount() {
          return {
            transactions: [
              {
                digest,
                checkpoint: "100",
                timestamp: "2026-05-11T00:00:00.000Z",
                status: "success",
                sender: otherWalletAccount,
                details: {
                  ...transactionDetails,
                  truncation: {
                    ...transactionDetails.truncation,
                    balanceChanges: true
                  }
                }
              }
            ],
            hasMore: false
          };
        }
      })
    );

    const result = await service.summarizeSuiActivityScan({ account: walletAccount });

    expect(result.requestedAccount.balanceChangeCompleteness).toBe("truncated");
    expect(result.transactions[0]?.accountEffects?.balanceChangeEvidence).toBe("incomplete_account_balance_changes");
    expect(result.transactions[0]?.accountEffects?.balanceChangeEvidence).toBe("incomplete_account_balance_changes");
    expect(result.transactions[0]?.accountEffects?.accountBalanceChangeInferencePolicy).toBe(
      "do_not_infer_from_transaction_context"
    );
    expect(result.transactions[0]?.accountEffects?.balanceChangeCompleteness).toBe("truncated");
    expect(result.transactions[0]?.accountEffects?.limitations).toEqual(["provider_balance_changes_truncated"]);
    expect(result.transactions[0]?.accountEffects?.coinFlows).toEqual([
      {
        coinType: "0x2::sui::SUI",
        increaseRaw: "0",
        decreaseRaw: "1000",
        netRaw: "-1000"
      }
    ]);
  });

  it("scans sent function activity and stores only sender-matching known rows", async () => {
    const store = new InMemoryActivityStore();
    await store.seedReadAccount(walletAccount, new Date("2026-05-11T00:00:00.000Z"));
    const scanFunction = vi.fn(async () => ({
      transactions: [
        {
          digest: "6".repeat(44),
          checkpoint: "101",
          timestamp: "2026-05-11T00:00:01.000Z",
          status: "success" as const,
          sender: otherWalletAccount,
          details: transactionDetails
        },
        {
          digest,
          checkpoint: "100",
          timestamp: "2026-05-11T00:00:00.000Z",
          status: "success" as const,
          sender: walletAccount,
          details: transactionDetails
        }
      ],
      hasMore: true,
      cursor: "cursor_1"
    }));
    const service = serviceFor(store, source({ scanFunction }));

    await expect(
      service.scanSuiFunctionActivity({
        function: functionTargetInput,
        limit: 10,
        fromCheckpoint: "90",
        toCheckpoint: "110"
      })
    ).resolves.toMatchObject({
      account: walletAccount,
      accountKnown: true,
      function: normalizedFunctionTarget,
      relationship: "sent",
      transactions: [{ digest, sender: walletAccount }],
      hasMore: true,
      continuationCursor: "cursor_1",
      windowComplete: false,
      incompleteReason: "limit_reached",
      persistence: {
        stored: true,
          scan: {
            kind: "function_scan",
            relationship: "sent",
            storedCount: 1,
            skippedCount: 1
        }
      }
    });
    expect(store.externalActivityScans).toEqual([
      expect.objectContaining({
        kind: "function_scan",
        relationship: "sent"
      })
    ]);
    expect(scanFunction).toHaveBeenCalledWith({
      functionTarget: normalizedFunctionTarget,
      sentAddress: walletAccount,
      limit: 10,
      cursor: undefined,
      fromCheckpoint: "90",
      toCheckpoint: "110"
    });
    expect(store.externalActivityTransactions).toEqual([
      expect.objectContaining({
        digest,
        account: walletAccount,
        relationship: "sent"
      })
    ]);
  });

  it("summarizes sent function activity without full details and without storing unknown explicit accounts", async () => {
    const store = new InMemoryActivityStore();
    const service = serviceFor(
      store,
      source({
        async scanFunction() {
          return {
            transactions: [
              {
                digest,
                checkpoint: "100",
                timestamp: "2026-05-11T00:00:00.000Z",
                status: "success",
                sender: otherWalletAccount,
                details: {
                  ...transactionDetails,
                  balanceChanges: [
                    {
                      index: 0,
                      owner: otherWalletAccount,
                      coinType: "0x2::sui::SUI",
                      amountRaw: "-1000",
                      direction: "decrease" as const
                    }
                  ],
                  events: []
                }
              }
            ],
            hasMore: false
          };
        }
      })
    );

    await expect(
      service.summarizeSuiFunctionActivityScan({
        function: functionTargetInput,
        account: otherWalletAccount
      })
    ).resolves.toMatchObject({
      account: otherWalletAccount,
      accountKnown: false,
      function: normalizedFunctionTarget,
      relationship: "sent",
      analysis: {
        overview: {
          transactionCount: 1,
          relationshipCounts: { affected: 0, sent: 1 }
        },
        coinFlows: [{ coinType: "0x2::sui::SUI", decreaseRaw: "1000" }]
      },
      persistence: {
        stored: false,
        reason: "account_not_known"
      }
    });
    expect(store.externalActivityScans).toEqual([]);
    expect(store.externalActivityTransactions).toEqual([]);
  });

  it("validates function targets before issuing function scans", async () => {
    const store = new InMemoryActivityStore();
    await store.seedReadAccount(walletAccount, new Date("2026-05-11T00:00:00.000Z"));
    const scanFunction = vi.fn(source().scanFunction);
    const service = serviceFor(store, source({ scanFunction }));
    const invalidTargets = [
      "",
      " 0x2::coin::transfer",
      "0x2::coin::transfer ",
      "transfer",
      "0x2",
      "0x2::coin",
      "not-an-address::coin::transfer",
      "0x2::1coin::transfer",
      "0x2::coin::1transfer",
      "0x2::coin::transfer<T>",
      "0x2::coin::transfer::extra"
    ];

    for (const target of invalidTargets) {
      await expect(service.scanSuiFunctionActivity({ function: target })).rejects.toMatchObject({
        kind: "input_invalid",
        details: {
          field: "function",
          reason: "invalid_function_target"
        }
      } satisfies Partial<TransactionActivityError>);
    }
    expect(scanFunction).not.toHaveBeenCalled();
  });

  it("summarizes explicit unknown account scans without storing local facts", async () => {
    const store = new InMemoryActivityStore();
    const service = serviceFor(
      store,
      source({
        async scanAccount() {
          return {
            transactions: [
              {
                digest,
                checkpoint: "100",
                timestamp: "2026-05-11T00:00:00.000Z",
                status: "success",
                sender: otherWalletAccount,
                details: {
                  ...transactionDetails,
                  balanceChanges: [
                    {
                      index: 0,
                      owner: otherWalletAccount,
                      coinType: "0x2::sui::SUI",
                      amountRaw: "-1000",
                      direction: "decrease" as const
                    }
                  ],
                  events: []
                }
              }
            ],
            hasMore: false
          };
        }
      })
    );

    await expect(service.summarizeSuiActivityScan({ account: otherWalletAccount })).resolves.toMatchObject({
      account: otherWalletAccount,
      accountKnown: false,
      analysis: {
        overview: { transactionCount: 1 },
        coinFlows: [{ coinType: "0x2::sui::SUI", decreaseRaw: "1000" }]
      },
      persistence: {
        stored: false,
        reason: "account_not_known"
      }
    });
    expect(store.externalActivityScans).toEqual([]);
    expect(store.externalActivityTransactions).toEqual([]);
  });

  it("does not persist non-known party addresses inside normalized transaction details", async () => {
    const store = new InMemoryActivityStore();
    await store.seedReadAccount(walletAccount, new Date("2026-05-11T00:00:00.000Z"));
    const service = serviceFor(
      store,
      source({
        async scanAccount() {
          return {
            transactions: [
              {
                digest,
                checkpoint: "100",
                timestamp: "2026-05-11T00:00:00.000Z",
                status: "success",
                sender: otherWalletAccount,
                details: {
                  ...transactionDetails,
                  balanceChanges: [
                    {
                      index: 0,
                      owner: walletAccount,
                      coinType: "0x2::sui::SUI",
                      amountRaw: "1000",
                      direction: "increase" as const
                    },
                    {
                      index: 1,
                      owner: otherWalletAccount,
                      coinType: "0x2::sui::SUI",
                      amountRaw: "1000",
                      direction: "increase" as const
                    }
                  ],
                  events: [
                    {
                      sequenceNumber: "0",
                      sender: otherWalletAccount,
                      package: "0x2",
                      module: "coin",
                      eventType: "0x2::coin::CoinCreated<0x2::sui::SUI>"
                    }
                  ]
                }
              }
            ],
            hasMore: false
          };
        }
      })
    );

    await service.scanSuiAccountActivity({});

    expect(store.externalActivityTransactions).toHaveLength(1);
    expect(store.externalActivityTransactions[0]?.details?.balanceChanges[0]).toMatchObject({ owner: walletAccount });
    expect(store.externalActivityTransactions[0]?.details?.balanceChanges[1]).not.toHaveProperty("owner");
    expect(store.externalActivityTransactions[0]?.details?.events[0]).not.toHaveProperty("sender");
  });

  it("filters sent scans to transactions whose sender matches the known account", async () => {
    const store = new InMemoryActivityStore();
    await store.seedReadAccount(walletAccount, new Date("2026-05-11T00:00:00.000Z"));
    const service = serviceFor(
      store,
      source({
        async scanAccount() {
          return {
            transactions: [
              {
                digest,
                checkpoint: "100",
                timestamp: "2026-05-11T00:00:00.000Z",
                status: "success",
                sender: walletAccount
              },
              {
                digest: "6".repeat(44),
                checkpoint: "99",
                timestamp: "2026-05-10T00:00:00.000Z",
                status: "success",
                sender: otherWalletAccount
              }
            ],
            hasMore: false
          };
        }
      })
    );

    await expect(service.scanSuiAccountActivity({ relationship: "sent" })).resolves.toMatchObject({
      transactions: [{ digest, sender: walletAccount }],
      persistence: {
        stored: true,
        scan: {
          storedCount: 1,
          skippedCount: 1
        }
      }
    });
    expect(store.externalActivityTransactions).toHaveLength(1);
    expect(store.externalActivityTransactions[0]).toMatchObject({
      digest,
      account: walletAccount,
      relationship: "sent"
    });
  });

  it("skips affected scan storage when returned rows do not prove a known wallet relation", async () => {
    const store = new InMemoryActivityStore();
    await store.seedReadAccount(walletAccount, new Date("2026-05-11T00:00:00.000Z"));
    const service = serviceFor(
      store,
      source({
        async scanAccount() {
          return {
            transactions: [
              {
                digest: "6".repeat(44),
                checkpoint: "101",
                timestamp: "2026-05-11T00:00:01.000Z",
                status: "success",
                sender: otherWalletAccount,
                details: {
                  ...transactionDetails,
                  balanceChanges: [
                    {
                      index: 0,
                      owner: otherWalletAccount,
                      coinType: "0x2::sui::SUI",
                      amountRaw: "1000",
                      direction: "increase" as const
                    }
                  ]
                }
              },
              {
                digest,
                checkpoint: "100",
                timestamp: "2026-05-11T00:00:00.000Z",
                status: "success",
                sender: otherWalletAccount,
                details: {
                  ...transactionDetails,
                  balanceChanges: [
                    {
                      index: 0,
                      owner: walletAccount,
                      coinType: "0x2::sui::SUI",
                      amountRaw: "1000",
                      direction: "increase" as const
                    }
                  ]
                }
              }
            ],
            hasMore: false
          };
        }
      })
    );

    await expect(service.scanSuiAccountActivity({ relationship: "affected" })).resolves.toMatchObject({
      transactions: [
        { digest: "6".repeat(44) },
        { digest }
      ],
      persistence: {
        stored: true,
        scan: {
          storedCount: 1,
          skippedCount: 1
        }
      }
    });
    expect(store.externalActivityTransactions).toHaveLength(1);
    expect(store.externalActivityTransactions[0]).toMatchObject({
      digest,
      account: walletAccount,
      relationship: "affected"
    });
  });

  it("applies timestamp windows as page filters and reports incomplete coverage while more pages remain", async () => {
    const store = new InMemoryActivityStore();
    await store.seedReadAccount(walletAccount, new Date("2026-05-11T00:00:00.000Z"));
    const service = serviceFor(
      store,
      source({
        async scanAccount() {
          return {
            transactions: [
              {
                digest: "6".repeat(44),
                checkpoint: "102",
                timestamp: "2026-05-12T00:00:00.000Z",
                status: "success",
                sender: walletAccount
              },
              {
                digest,
                checkpoint: "101",
                timestamp: "2026-05-11T00:00:00.000Z",
                status: "success",
                sender: walletAccount
              }
            ],
            hasMore: true,
            cursor: "cursor_2"
          };
        }
      })
    );

    await expect(
      service.scanSuiAccountActivity({
        fromTimestamp: "2026-05-10T00:00:00.000Z",
        toTimestamp: "2026-05-11T00:00:00.000Z"
      })
    ).resolves.toMatchObject({
      transactions: [{ digest, timestamp: "2026-05-11T00:00:00.000Z" }],
      continuationCursor: "cursor_2",
      windowComplete: false,
      persistence: {
        scan: {
          storedCount: 1,
          skippedCount: 1,
          windowComplete: false,
          incompleteReason: "limit_reached"
        }
      }
    });
  });

  it("allows explicit account filters but stores only known wallet scans", async () => {
    const store = new InMemoryActivityStore();
    await store.seedReadAccount(walletAccount, new Date("2026-05-11T00:00:00.000Z"));
    const service = serviceFor(store);

    await expect(service.scanSuiAccountActivity({ account: otherWalletAccount, relationship: "sent" })).resolves.toMatchObject({
      account: otherWalletAccount,
      accountKnown: false,
      accountSource: "explicit_filter",
      persistence: {
        stored: false,
        reason: "account_not_known"
      }
    });
    expect(store.externalActivityTransactions).toEqual([]);
  });

  it("returns ephemeral explicit-address scans when provider ordering is unverified", async () => {
    const store = new InMemoryActivityStore();
    await store.seedReadAccount(walletAccount, new Date("2026-05-11T00:00:00.000Z"));
    const service = serviceFor(
      store,
      source({
        async scanAccount(input) {
          expect(input.account).toBe(otherWalletAccount);
          return {
            transactions: [
              { digest: "6".repeat(44), checkpoint: "100", timestamp: "2026-05-11T00:00:00.000Z", status: "success" },
              { digest: "8".repeat(44), checkpoint: "102", timestamp: "2026-05-11T00:00:02.000Z", status: "success" },
              { digest: "7".repeat(44), checkpoint: "101", timestamp: "2026-05-11T00:00:01.000Z", status: "success" }
            ],
            hasMore: false
          };
        }
      })
    );

    await expect(service.scanSuiAccountActivity({ account: otherWalletAccount })).resolves.toMatchObject({
      account: otherWalletAccount,
      accountKnown: false,
      transactions: [
        { digest: "8".repeat(44), checkpoint: "102" },
        { digest: "7".repeat(44), checkpoint: "101" },
        { digest: "6".repeat(44), checkpoint: "100" }
      ],
      orderingVerified: false,
      incompleteReason: "ordering_unverified",
      persistence: {
        stored: false,
        reason: "account_not_known"
      }
    });
    expect(store.externalActivityTransactions).toEqual([]);
  });

  it("returns a locally ordered page when the provider returns the latest page oldest-first", async () => {
    const store = new InMemoryActivityStore();
    await store.seedReadAccount(walletAccount, new Date("2026-05-11T00:00:00.000Z"));
    const service = serviceFor(
      store,
      source({
        async scanAccount() {
          return {
            transactions: [
              { digest: "6".repeat(44), checkpoint: "100", timestamp: "2026-05-11T00:00:00.000Z", status: "success", sender: walletAccount },
              { digest: "7".repeat(44), checkpoint: "101", timestamp: "2026-05-11T00:00:01.000Z", status: "success", sender: walletAccount }
            ],
            hasMore: false
          };
        }
      })
    );

    await expect(service.scanSuiAccountActivity({})).resolves.toMatchObject({
      transactions: [
        { digest: "7".repeat(44), checkpoint: "101" },
        { digest: "6".repeat(44), checkpoint: "100" }
      ],
      orderingVerified: true,
      persistence: {
        scan: {
          storedCount: 2
        }
      }
    });
    expect(store.externalActivityTransactions.map((row) => row.digest)).toEqual(["7".repeat(44), "6".repeat(44)]);
  });

  it("marks stored scans incomplete when provider order is not monotonic", async () => {
    const store = new InMemoryActivityStore();
    await store.seedReadAccount(walletAccount, new Date("2026-05-11T00:00:00.000Z"));
    const service = serviceFor(
      store,
      source({
        async scanAccount() {
          return {
            transactions: [
              { digest: "6".repeat(44), checkpoint: "100", timestamp: "2026-05-11T00:00:00.000Z", status: "success", sender: walletAccount },
              { digest: "8".repeat(44), checkpoint: "102", timestamp: "2026-05-11T00:00:02.000Z", status: "success", sender: walletAccount },
              { digest: "7".repeat(44), checkpoint: "101", timestamp: "2026-05-11T00:00:01.000Z", status: "success", sender: walletAccount }
            ],
            hasMore: false
          };
        }
      })
    );

    await expect(service.scanSuiAccountActivity({})).resolves.toMatchObject({
      transactions: [
        { digest: "8".repeat(44), checkpoint: "102" },
        { digest: "7".repeat(44), checkpoint: "101" },
        { digest: "6".repeat(44), checkpoint: "100" }
      ],
      orderingVerified: false,
      incompleteReason: "ordering_unverified",
      persistence: {
        scan: {
          storedCount: 3,
          incompleteReason: "ordering_unverified"
        }
      }
    });
    await expect(service.summarizeSuiAccountActivity({})).resolves.toMatchObject({
      transactions: expect.arrayContaining([
        expect.objectContaining({
          digest: "8".repeat(44),
          lastScanIncompleteReason: "ordering_unverified"
        })
      ])
    });
  });

  it("maps invalid provider cursors to input errors without writing continuation state", async () => {
    const store = new InMemoryActivityStore();
    await store.seedReadAccount(walletAccount, new Date("2026-05-11T00:00:00.000Z"));
    const service = serviceFor(
      store,
      source({
        async scanAccount() {
          throw new TransactionActivitySourceError("cursor_invalid", "invalid cursor");
        }
      })
    );

    await expect(service.scanSuiAccountActivity({ cursor: "bad_cursor" })).rejects.toMatchObject({
      kind: "input_invalid",
      details: { reason: "cursor_invalid" }
    } satisfies Partial<TransactionActivityError>);
    await expect(service.summarizeSuiActivityScan({ cursor: "bad_cursor" })).rejects.toMatchObject({
      kind: "input_invalid",
      details: { reason: "cursor_invalid" }
    } satisfies Partial<TransactionActivityError>);
    expect(store.externalActivityScans).toEqual([]);
    expect(store.externalActivityTransactions).toEqual([]);
  });

  it("maps invalid provider cursors for function scans without writing continuation state", async () => {
    const store = new InMemoryActivityStore();
    await store.seedReadAccount(walletAccount, new Date("2026-05-11T00:00:00.000Z"));
    const service = serviceFor(
      store,
      source({
        async scanFunction() {
          throw new TransactionActivitySourceError("cursor_invalid", "invalid cursor");
        }
      })
    );

    await expect(
      service.scanSuiFunctionActivity({ function: functionTargetInput, cursor: "bad_cursor" })
    ).rejects.toMatchObject({
      kind: "input_invalid",
      details: { reason: "cursor_invalid" }
    } satisfies Partial<TransactionActivityError>);
    await expect(
      service.summarizeSuiFunctionActivityScan({ function: functionTargetInput, cursor: "bad_cursor" })
    ).rejects.toMatchObject({
      kind: "input_invalid",
      details: { reason: "cursor_invalid" }
    } satisfies Partial<TransactionActivityError>);
    expect(store.externalActivityScans).toEqual([]);
    expect(store.externalActivityTransactions).toEqual([]);
  });

  it("maps rejected function filters to source evidence errors", async () => {
    const store = new InMemoryActivityStore();
    await store.seedReadAccount(walletAccount, new Date("2026-05-11T00:00:00.000Z"));
    const service = serviceFor(
      store,
      source({
        async scanFunction() {
          throw new TransactionActivitySourceError(
            "provider_error",
            "Sui GraphQL function activity scan rejected a verified filter combination",
            {
              reason: "function_filter_rejected_by_graphql_validation",
              providerReason: "provider_error",
              message: "Failed to parse \"TransactionFilter\": At most one of [affectedAddress, affectedObject, function, kind] can be specified"
            }
          );
        }
      })
    );

    await expect(service.scanSuiFunctionActivity({ function: functionTargetInput })).rejects.toMatchObject({
      kind: "internal_error",
      details: {
        reason: "function_filter_rejected_by_graphql_validation",
        providerReason: "provider_error"
      }
    } satisfies Partial<TransactionActivityError>);
  });

  it("validates checkpoint bounds before issuing account scans", async () => {
    const store = new InMemoryActivityStore();
    await store.seedReadAccount(walletAccount, new Date("2026-05-11T00:00:00.000Z"));
    const scanAccount = vi.fn(source().scanAccount);
    const service = serviceFor(store, source({ scanAccount }));

    await expect(service.scanSuiAccountActivity({ fromCheckpoint: "9007199254740992" })).rejects.toMatchObject({
      kind: "input_invalid",
      details: {
        field: "fromCheckpoint",
        max: "9007199254740991"
      }
    } satisfies Partial<TransactionActivityError>);
    expect(scanAccount).not.toHaveBeenCalled();
  });

  it("rejects reversed checkpoint and timestamp windows before issuing account scans", async () => {
    const store = new InMemoryActivityStore();
    await store.seedReadAccount(walletAccount, new Date("2026-05-11T00:00:00.000Z"));
    const scanAccount = vi.fn(source().scanAccount);
    const service = serviceFor(store, source({ scanAccount }));

    await expect(service.scanSuiAccountActivity({ fromCheckpoint: "20", toCheckpoint: "10" })).rejects.toMatchObject({
      kind: "input_invalid"
    } satisfies Partial<TransactionActivityError>);
    await expect(
      service.scanSuiAccountActivity({
        fromTimestamp: "2026-05-12T00:00:00.000Z",
        toTimestamp: "2026-05-11T00:00:00.000Z"
      })
    ).rejects.toMatchObject({
      kind: "input_invalid"
    } satisfies Partial<TransactionActivityError>);
    expect(scanAccount).not.toHaveBeenCalled();
  });

  it("summarizes stored normalized facts without reading GraphQL", async () => {
    const store = new InMemoryActivityStore();
    await store.seedReadAccount(walletAccount, new Date("2026-05-11T00:00:00.000Z"));
    const service = serviceFor(store);
    await service.scanSuiAccountActivity({});

    await expect(service.summarizeSuiAccountActivity({ account: walletAccount })).resolves.toMatchObject({
      status: "ok",
      dataScope: { account: walletAccount },
      summary: {
        transactionCount: 1,
        statusCounts: { success: 1, failure: 0, unknown: 0 },
        relationshipCounts: { affected: 1, sent: 0 }
      },
      analysis: {
        overview: {
          transactionCount: 1,
          analyzedTransactionCount: 1,
          statusCounts: { success: 1, failure: 0, unknown: 0 },
          relationshipCounts: { affected: 1, sent: 0 }
        },
        gas: { transactionCount: 1, netGasCostRaw: "115" }
      },
      transactions: [{ digest }]
    });
  });
});
