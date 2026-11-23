import { describe, expect, it } from "vitest";
import {
  buildSuiActivityAnalysis,
  type SuiActivityAnalysisTransaction
} from "../src/core/activity/transactionActivityAnalysis.js";
import { SUI_DEFI_ACTIVITY_CLASSIFIER_VERSION } from "../src/core/activity/transactionActivityClassifier.js";
import type { ExternalActivityTransactionCompactFacts } from "../src/core/activity/transactionActivityDetails.js";

const baseDigest = "5".repeat(44);

function compact(
  overrides: Partial<ExternalActivityTransactionCompactFacts> = {}
): ExternalActivityTransactionCompactFacts {
  return {
    balanceChangeScope: "transaction",
    factScope: "transaction",
    requestedAccountScoped: false,
    moveCallTargets: [],
    balanceChanges: [],
    objectChangeCounts: { created: 0, mutated: 0, deleted: 0 },
    eventTypes: [],
    detailTruncated: false,
    ...overrides
  };
}

function tx(
  overrides: Partial<SuiActivityAnalysisTransaction> = {}
): SuiActivityAnalysisTransaction {
  return {
    digest: overrides.digest ?? baseDigest,
    checkpoint: "100",
    timestamp: "2026-05-11T00:00:00.000Z",
    status: "success",
    relationship: "affected",
    compact: compact(),
    ...overrides
  };
}

function protocolMatch(protocolId: string, displayName = protocolId) {
  return {
    classifierVersion: SUI_DEFI_ACTIVITY_CLASSIFIER_VERSION,
    protocolId,
    displayName,
    activityCategory: "swap_or_order",
    declaredAction: "swap" as const,
    transactionStatus: "unknown" as const,
    matchBasis: "direct_move_call" as const,
    evidence: [
      {
        kind: "moveCall" as const,
        package: "0x2",
        module: "pool",
        function: "swap",
        commandIndex: 0
      }
    ],
    relatedProtocols: [],
    limitations: []
  };
}

describe("buildSuiActivityAnalysis", () => {
  it("summarizes raw coin flows and gas with BigInt-safe decimal strings", () => {
    const analysis = buildSuiActivityAnalysis([
      tx({
        digest: "1".repeat(44),
        compact: compact({
          balanceChanges: [
            { coinType: "0x2::sui::SUI", amountRaw: "-100000000000000000000", direction: "decrease" },
            { coinType: "0x3::coin::COIN", amountRaw: "7", direction: "increase" }
          ],
          gasNetCostRaw: "115"
        })
      }),
      tx({
        digest: "2".repeat(44),
        compact: compact({
          balanceChanges: [
            { coinType: "0x2::sui::SUI", amountRaw: "1", direction: "increase" },
            { coinType: "0x2::sui::SUI", amountRaw: "-2", direction: "decrease" }
          ],
          gasNetCostRaw: "-5"
        })
      })
    ]);

    expect(analysis.coinFlows).toEqual([
      {
        coinType: "0x2::sui::SUI",
        increaseRaw: "1",
        decreaseRaw: "100000000000000000002",
        netRaw: "-100000000000000000001",
        transactionCount: 2
      },
      {
        coinType: "0x3::coin::COIN",
        increaseRaw: "7",
        decreaseRaw: "0",
        netRaw: "7",
        transactionCount: 1
      }
    ]);
    expect(analysis.gas).toEqual({
      transactionCount: 2,
      netGasCostRaw: "110",
      netGasCost: {
        netCostRaw: "110",
        rawUnit: "MIST",
        display: "0.00000011",
        displayUnit: "SUI",
        decimals: 9,
        unitSource: "@mysten/sui MIST_PER_SUI"
      }
    });
  });

  it("honors compact repeated balance-change counts without increasing transaction count", () => {
    const analysis = buildSuiActivityAnalysis([
      tx({
        digest: "1".repeat(44),
        compact: compact({
          balanceChanges: [
            { coinType: "0x3::coin::RWA", amountRaw: "1000", direction: "increase", count: 50 },
            { coinType: "0x2::sui::SUI", amountRaw: "-10", direction: "decrease" }
          ]
        })
      })
    ]);

    expect(analysis.coinFlows).toEqual([
      {
        coinType: "0x2::sui::SUI",
        increaseRaw: "0",
        decreaseRaw: "10",
        netRaw: "-10",
        transactionCount: 1
      },
      {
        coinType: "0x3::coin::RWA",
        increaseRaw: "50000",
        decreaseRaw: "0",
        netRaw: "50000",
        transactionCount: 1
      }
    ]);
  });

  it("aggregates protocol matches by protocolId once per transaction", () => {
    const analysis = buildSuiActivityAnalysis([
      tx({
        digest: "1".repeat(44),
        compact: compact({
          protocolMatches: [
            protocolMatch("cetus-clmm", "Cetus CLMM"),
            protocolMatch("cetus-clmm", "Changed Display"),
            protocolMatch("deepbook-v3", "DeepBook v3")
          ]
        })
      }),
      tx({
        digest: "2".repeat(44), status: "failure",
        compact: compact({
          protocolMatches: [protocolMatch("cetus-clmm", "Cetus CLMM")]
        })
      })
    ]);

    expect(analysis.protocols).toEqual([
      { protocolId: "cetus-clmm", displayName: "Cetus CLMM", count: 2, statusCounts: { success: 1, failure: 1, unknown: 0 } },
      { protocolId: "deepbook-v3", displayName: "DeepBook v3", count: 1, statusCounts: { success: 1, failure: 0, unknown: 0 } }
    ]);
  });

  it("reports absence and coverage limitations without inventing missing facts", () => {
    const analysis = buildSuiActivityAnalysis(
      [
        tx({ digest: "1".repeat(44), compact: undefined, details: undefined }),
        tx({
          digest: "2".repeat(44),
          status: "failure",
          compact: compact({ detailTruncated: true })
        }),
        tx({
          digest: "3".repeat(44),
          status: "failure",
          compact: compact({
            executionError: { message: "MoveAbort", abortCodeRaw: "1", package: "0x2", module: "pool", function: "swap" }
          }),
          lastScanIncompleteReason: "ordering_unverified"
        })
      ],
      { windowComplete: false, orderingVerified: false }
    );

    expect(analysis.limitations).toEqual(expect.arrayContaining([
      "details_missing",
      "protocol_labels_absent",
      "failed_without_error_detail",
      "detail_truncated",
      "stored_scan_incomplete",
      "window_incomplete",
      "ordering_unverified"
    ]));
    expect(analysis.failures).toEqual([
      {
        message: "MoveAbort",
        abortCodeRaw: "1",
        package: "0x2",
        module: "pool",
        function: "swap",
        count: 1
      }
    ]);
  });

  it("reports empty and capped analysis limitations", () => {
    const empty = buildSuiActivityAnalysis([], { windowComplete: null });
    expect(empty.limitations).toEqual(expect.arrayContaining(["empty_result", "window_latest_only"]));

    const many = buildSuiActivityAnalysis([
      tx({
        compact: compact({
          moveCallTargets: Array.from({ length: 21 }, (_, index) => `0x2::m::call_${index}`),
          balanceChanges: Array.from({ length: 51 }, (_, index) => ({
            coinType: `0x${index}::coin::T`,
            amountRaw: "1",
            direction: "increase" as const
          })),
          eventTypes: Array.from({ length: 21 }, (_, index) => `0x2::m::Event${index}`),
          protocolMatches: Array.from({ length: 21 }, (_, index) => protocolMatch(`protocol-${index}`)),
          executionError: { message: "E".repeat(1), abortCodeRaw: "1" }
        })
      }),
      ...Array.from({ length: 20 }, (_, index) => tx({
        digest: `${index}`.padStart(44, "a"),
        status: "failure",
        compact: compact({
          executionError: { message: `error-${index}` }
        })
      }))
    ]);

    expect(many.moveCallTargets).toHaveLength(20);
    expect(many.protocols).toHaveLength(20);
    expect(many.coinFlows).toHaveLength(50);
    expect(many.eventTypes).toHaveLength(20);
    expect(many.failures).toHaveLength(20);
    expect(many.limitations).toEqual(expect.arrayContaining([
      "move_call_targets_truncated",
      "protocols_truncated",
      "coin_flows_truncated",
      "event_types_truncated",
      "failures_truncated"
    ]));
  });
});
