import { activityPackageFamilies } from "../src/core/activity/transactionActivityLineages.js";
import { describe, expect, it } from "vitest";
import {
  SUI_DEFI_ACTIVITY_CLASSIFIER_VERSION,
  classifySuiDeFiActivity
} from "../src/core/activity/transactionActivityClassifier.js";
import {
  compactExternalActivityTransactionDetails,
  type ExternalActivityTransactionDetail
} from "../src/core/activity/transactionActivityDetails.js";
import { SUI_DEFI_ACTIVITY_PROTOCOL_RULES } from "../src/core/activity/transactionActivityProtocolRules.js";
import { parseSuiAddress } from "../src/core/suiAddress.js";

const DEEPBOOK_PINNED_PACKAGE =
  "0xf48222c4e057fa468baf136bff8e12504209d43850c5778f76159292a96f621e";
const DEEPBOOK_DOCS_PACKAGE =
  "0x337f4f4f6567fcd778d5454f27c16c70e2f274cc6377ea6249ddf491482ef497";
const DEEPTRADE_PACKAGE =
  "0xc10d536b6580d809711b9bb8eee3945d5e96f92a346c84d74ff7a0697e664695";
const CETUS_TYPE_ORIGIN = "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb";
const CETUS_PACKAGE =
  "0x25ebb9a7c50eb17b3fa9c5a30fb8b5ad8f97caaf4928943acbcff7153dfee5e3";
const CETUS_GLOBAL_CONFIG =
  "0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f";
const SUILEND_PACKAGE =
  "0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf";
const SUILEND_MVR_CORE_PACKAGE =
  "0xe53906c2c058d1e369763114418f3c144d1b74960d29b2785718a782fec09b61";
const AFTERMATH_EVENTS_PACKAGE =
  "0x7f6ce7ade63857c4fd16ef7783fed2dfc4d7fb7e40615abdb653030b76aef0c6";
const AFTERMATH_AFSUI_PACKAGE =
  "0x1575034d2729907aefca1ac757d6ccfcd3fc7e9e77927523c06007d8353ad836";
const KNOWN_MATCH_LIMITATIONS = new Set([
  "deepbook_package_conflict_open",
  "event_details_truncated",
  "move_call_details_truncated",
  "no_direct_move_call_match",
  "not_position_inventory_or_pnl_or_signing",
  "object_change_details_truncated",
  "shared_object_match_does_not_prove_wallet_position",
  "transaction_activity_label_only",
  "declared_call_does_not_prove_fill_or_account_effect"
]);

function detail(overrides: Partial<ExternalActivityTransactionDetail>): ExternalActivityTransactionDetail {
  return {
    transactionKind: "ProgrammableTransaction",
    moveCalls: [],
    balanceChanges: [],
    objectChanges: [],
    events: [],
    truncation: {
      moveCalls: false,
      balanceChanges: false,
      objectChanges: false,
      events: false
    },
    ...overrides
  };
}

function moveCall(
  packageId: string,
  module: string,
  functionName: string,
  commandIndex = 0
): ExternalActivityTransactionDetail["moveCalls"][number] {
  return {
    commandIndex,
    package: packageId,
    module,
    function: functionName,
    target: `${packageId}::${module}::${functionName}`
  };
}

describe("Sui DeFi activity classifier", () => {
  it("keeps protocol rule provenance structurally bounded", () => {
    const protocolIds = new Set<string>();

    for (const rule of SUI_DEFI_ACTIVITY_PROTOCOL_RULES) {
      expect(protocolIds.has(rule.protocolId)).toBe(false);
      protocolIds.add(rule.protocolId);
      const family = activityPackageFamilies[rule.protocolId]!;
      expect(family.versions.length).toBeGreaterThan(0);
      for (const address of family.versions) expect(parseSuiAddress(address)).toBe(address);
      for (const [address, name] of Object.entries(rule.namedPackages ?? {})) {
        expect(family.versions).toContain(address);
        expect(name).toMatch(/^@[^/]+\/[^/]+$/);
      }
      for (const [origin, types] of Object.entries(family.types)) {
        expect(family.versions).toContain(origin);
        expect(types.length).toBeGreaterThan(0);
      }

      for (const [address, label] of Object.entries(rule.sharedObjects)) {
        expect(parseSuiAddress(address)).toBe(address);
        expect(label.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("keeps balance-only activity unclassified", () => {
    const matches = classifySuiDeFiActivity(detail({
      balanceChanges: [
        {
          index: 0,
          coinType: "0x2::sui::SUI",
          amountRaw: "-1000",
          direction: "decrease"
        }
      ]
    }));

    expect(matches).toEqual([]);
  });

  it("classifies DeepTrade wrapper activity as primary over DeepBook dependency evidence", () => {
    const matches = classifySuiDeFiActivity(detail({
      moveCalls: [
        moveCall(DEEPTRADE_PACKAGE, "dt_order", "create_limit_order", 0),
        moveCall(DEEPBOOK_PINNED_PACKAGE, "pool", "place_limit_order", 1)
      ]
    }));

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      classifierVersion: SUI_DEFI_ACTIVITY_CLASSIFIER_VERSION,
      protocolId: "deeptrade-core",
      declaredAction: "order",
      matchBasis: "direct_move_call",
      relatedProtocols: [
        {
          protocolId: "deepbook-v3",
          reason: "deeptrade_wrapper_touched_deepbook_evidence"
        }
      ]
    });
    expect(matches[0]?.evidence).toContainEqual(expect.objectContaining({
      kind: "moveCall",
      packageSource: "mainnet_direct_call_v1",
      mvrName: "@deeptrade/deeptrade-core"
    }));
    expect(matches[0]?.limitations).toContain("transaction_activity_label_only");
  });

  it("reports the verified outer type and retains independent direct-call evidence", () => {
    const [match] = classifySuiDeFiActivity(detail({
      moveCalls: [moveCall(CETUS_PACKAGE, "pool", "swap")],
      events: [{ sequenceNumber: "0", eventType: `${CETUS_TYPE_ORIGIN}::pool::SwapEvent`, package: "0x2" }]
    }));
    expect(match?.matchBasis).toBe("event_type");
    expect(match?.evidence.map(item => item.kind)).toContain("moveCall");
    expect(match?.limitations).not.toContain("no_direct_move_call_match");
  });

  it("attributes an earlier directly called DeepBook version to its published package", () => {
    const matches = classifySuiDeFiActivity(detail({
      moveCalls: [
        moveCall(DEEPBOOK_DOCS_PACKAGE, "pool", "swap_exact_base_for_quote")
      ]
    }));

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      protocolId: "deepbook-v3",
      declaredAction: "swap",
      matchBasis: "direct_move_call"
    });
    expect(matches[0]?.evidence[0]).toMatchObject({ packageSource: "mainnet_direct_call_v6" });
  });

  it("uses shared objects as shared_object evidence without inferring a position", () => {
    const matches = classifySuiDeFiActivity(detail({
      objectChanges: [
        {
          index: 0,
          objectId: CETUS_GLOBAL_CONFIG,
          changeKind: "mutated"
        }
      ]
    }));

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      protocolId: "cetus-clmm",
      matchBasis: "shared_object",
      declaredAction: "unknown",
      evidence: [
        {
          kind: "sharedObject",
          objectId: CETUS_GLOBAL_CONFIG,
          label: "cetus_global_config"
        }
      ]
    });
    expect(matches[0]?.limitations).toContain("shared_object_match_does_not_prove_wallet_position");
  });

  it("identifies event and object types from their on-chain defining package", () => {
    const matches = classifySuiDeFiActivity(detail({
      events: [
        {
          sequenceNumber: "0",
          package: CETUS_PACKAGE,
          eventType: `${CETUS_TYPE_ORIGIN}::pool::SwapEvent`
        }
      ],
      objectChanges: [
        {
          index: 0,
          objectId: "0x1",
          changeKind: "mutated",
          outputType: `${CETUS_TYPE_ORIGIN}::position::Position`
        }
      ]
    }));

    expect(matches[0]).toMatchObject({
      protocolId: "cetus-clmm",
      evidence: expect.arrayContaining([
        expect.objectContaining({
          kind: "eventType",
          packageSource: "mainnet_type_origin_v1"
        }),
        expect.objectContaining({
          kind: "objectType",
          packageSource: "mainnet_type_origin_v1"
        })
      ])
    });
  });

  it("requires the outer defining module and type, even when an emitter or type argument matches", () => {
    expect(classifySuiDeFiActivity(detail({ events: [
      { sequenceNumber: "0", package: CETUS_PACKAGE, eventType: `0x2::example::Wrapped<${CETUS_TYPE_ORIGIN}::pool::SwapEvent>` },
      { sequenceNumber: "1", package: CETUS_PACKAGE, eventType: `${CETUS_TYPE_ORIGIN}::unknown::SwapEvent` }
    ] }))).toEqual([]);
  });
  it("deduplicates repeated structural evidence", () => {
    const matches = classifySuiDeFiActivity(detail({
      events: [
        {
          sequenceNumber: "0",
          package: CETUS_PACKAGE,
          eventType: `${CETUS_TYPE_ORIGIN}::pool::SwapEvent`
        },
        {
          sequenceNumber: "0",
          package: CETUS_PACKAGE,
          eventType: `${CETUS_TYPE_ORIGIN}::pool::SwapEvent`
        }
      ]
    }));

    expect(matches[0]?.evidence).toHaveLength(1);
    expect(matches[0]?.classifierVersion).toBe(SUI_DEFI_ACTIVITY_CLASSIFIER_VERSION);
  });

  it("classifies lending direct package calls by action assetGroup", () => {
    const mvrSuilendMatches = classifySuiDeFiActivity(detail({
      moveCalls: [moveCall(SUILEND_MVR_CORE_PACKAGE, "lending", "borrow")]
    }));
    expect(mvrSuilendMatches[0]).toMatchObject({
      protocolId: "suilend-lending",
      declaredAction: "lending",
      matchBasis: "direct_move_call",
      evidence: [
        expect.objectContaining({
          kind: "moveCall",
          packageSource: "mainnet_direct_call_v21",
          mvrName: "@suilend/core"
        })
      ]
    });
  });

  it("does not treat type-only package rules as direct move-call evidence", () => {
    expect(classifySuiDeFiActivity(detail({
      moveCalls: [moveCall(SUILEND_PACKAGE, "lending", "borrow")]
    }))).toEqual([]);

    expect(classifySuiDeFiActivity(detail({
      moveCalls: [moveCall(AFTERMATH_AFSUI_PACKAGE, "afsui", "unstake")]
    }))).toEqual([]);

    expect(classifySuiDeFiActivity(detail({
      moveCalls: [moveCall(AFTERMATH_EVENTS_PACKAGE, "afsui", "unstake")]
    }))).toEqual([]);

    const objectTypeMatches = classifySuiDeFiActivity(detail({
      objectChanges: [
        {
          index: 0,
          objectId: "0x2",
          changeKind: "mutated",
          outputType: `${SUILEND_PACKAGE}::lending_market::LendingMarket`
        }
      ]
    }));
    expect(objectTypeMatches[0]).toMatchObject({
      protocolId: "suilend-lending",
      matchBasis: "object_type",
      declaredAction: "unknown"
    });
  });

  it("keeps type-only package rules available for object type evidence", () => {
    const matches = classifySuiDeFiActivity(detail({
      events: [
        {
          sequenceNumber: "0",
          package: AFTERMATH_EVENTS_PACKAGE,
          eventType: `${AFTERMATH_EVENTS_PACKAGE}::events::StakedEvent`
        }
      ],
      objectChanges: [
        {
          index: 0,
          objectId: "0x3",
          changeKind: "mutated",
          outputType: `${AFTERMATH_EVENTS_PACKAGE}::staked_sui_vault::StakedSuiVault`
        }
      ]
    }));

    expect(matches[0]).toMatchObject({
      protocolId: "aftermath-afsui",
      matchBasis: "event_type",
      declaredAction: "unknown"
    });
    expect(matches[0]?.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "eventType" }),
      expect.objectContaining({ kind: "objectType" })
    ]));
  });

  it("prefers admin/versioning over broad protocol action keywords", () => {
    expect(classifySuiDeFiActivity(detail({
      moveCalls: [moveCall(CETUS_PACKAGE, "global_config", "set_fee_rate")]
    }))[0]).toMatchObject({
      protocolId: "cetus-clmm",
      declaredAction: "admin_or_versioning"
    });

    expect(classifySuiDeFiActivity(detail({
      moveCalls: [moveCall(SUILEND_MVR_CORE_PACKAGE, "reserve_config", "update_risk_parameters")]
    }))[0]).toMatchObject({
      protocolId: "suilend-lending",
      declaredAction: "admin_or_versioning"
    });
  });

  it("prefers substantive user actions over helper or admin calls in the same protocol match", () => {
    expect(classifySuiDeFiActivity(detail({
      moveCalls: [
        moveCall(DEEPTRADE_PACKAGE, "fee", "settle_protocol_fee_and_record", 0),
        moveCall(DEEPTRADE_PACKAGE, "swap", "swap_exact_base_for_quote_input_fee", 1)
      ]
    }))[0]).toMatchObject({
      protocolId: "deeptrade-core",
      declaredAction: "swap"
    });

    expect(classifySuiDeFiActivity(detail({
      moveCalls: [
        moveCall(CETUS_PACKAGE, "global_config", "set_fee_rate", 0),
        moveCall(CETUS_PACKAGE, "pool", "swap", 1)
      ]
    }))[0]).toMatchObject({
      protocolId: "cetus-clmm",
      declaredAction: "swap"
    });
  });

  it("does not classify reset-style names as admin solely because they contain set_", () => {
    expect(classifySuiDeFiActivity(detail({
      moveCalls: [moveCall(CETUS_PACKAGE, "pool", "reset_position")]
    }))[0]).toMatchObject({
      protocolId: "cetus-clmm",
      declaredAction: "liquidity"
    });
  });

  it("adds protocol matches to compact facts only when evidence exists", () => {
    expect(compactExternalActivityTransactionDetails(detail({
      moveCalls: [moveCall(CETUS_PACKAGE, "pool", "swap")]
    }))).toMatchObject({
      protocolMatches: [
        {
          protocolId: "cetus-clmm",
          declaredAction: "swap"
        }
      ]
    });

    expect(compactExternalActivityTransactionDetails(detail({
      balanceChanges: [
        {
          index: 0,
          coinType: "0x2::sui::SUI",
          amountRaw: "1000",
          direction: "increase"
        }
      ]
    }))).not.toHaveProperty("protocolMatches");
  });

  it("keeps an unsuccessful swap call as declared activity with a failed chain outcome", () => {
    const facts = compactExternalActivityTransactionDetails(detail({ moveCalls: [moveCall(CETUS_PACKAGE, "pool", "swap")] }), "failure");
    expect(facts.protocolMatches?.[0]).toMatchObject({ declaredAction: "swap", transactionStatus: "failure" });
    expect(facts.balanceChanges).toEqual([]);
  });

  it("aggregates repeated ownerless balance changes in compact facts", () => {
    const compact = compactExternalActivityTransactionDetails(detail({
      balanceChanges: [
        {
          index: 0,
          coinType: "0x3::coin::RWA",
          amountRaw: "1000",
          direction: "increase"
        },
        {
          index: 1,
          coinType: "0x3::coin::RWA",
          amountRaw: "1000",
          direction: "increase"
        },
        {
          index: 2,
          coinType: "0x3::coin::RWA",
          amountRaw: "1000",
          direction: "increase"
        },
        {
          index: 3,
          coinType: "0x2::sui::SUI",
          amountRaw: "-10",
          direction: "decrease"
        }
      ]
    }));

    expect(compact.factScope).toBe("transaction");
    expect(compact.requestedAccountScoped).toBe(false);
    expect(compact.balanceChanges).toEqual([
      {
        coinType: "0x3::coin::RWA",
        amountRaw: "1000",
        direction: "increase",
        count: 3
      },
      {
        coinType: "0x2::sui::SUI",
        amountRaw: "-10",
        direction: "decrease"
      }
    ]);
  });

  it("keeps produced match limitations in the transaction-label boundary set", () => {
    const detailCases = [
      detail({
        moveCalls: [
          moveCall(DEEPTRADE_PACKAGE, "dt_order", "create_limit_order", 0),
          moveCall(DEEPBOOK_PINNED_PACKAGE, "pool", "place_limit_order", 1)
        ]
      }),
      detail({
        moveCalls: [moveCall(DEEPBOOK_DOCS_PACKAGE, "pool", "swap_exact_base_for_quote")]
      }),
      detail({
        objectChanges: [
          {
            index: 0,
            objectId: CETUS_GLOBAL_CONFIG,
            changeKind: "mutated"
          }
        ],
        truncation: {
          moveCalls: true,
          balanceChanges: false,
          objectChanges: true,
          events: true
        }
      }),
      detail({
        events: [
          {
            sequenceNumber: "0",
            package: CETUS_PACKAGE,
            eventType: `${CETUS_TYPE_ORIGIN}::pool::SwapEvent`
          }
        ],
        objectChanges: [
          {
            index: 0,
            objectId: "0x1",
            changeKind: "mutated",
            outputType: `${CETUS_TYPE_ORIGIN}::position::Position`
          }
        ]
      }),
      detail({
        moveCalls: [moveCall(SUILEND_MVR_CORE_PACKAGE, "lending", "borrow")]
      }),
      detail({
        events: [
          {
            sequenceNumber: "0",
            package: AFTERMATH_EVENTS_PACKAGE,
            eventType: `${AFTERMATH_EVENTS_PACKAGE}::events::StakedEvent`
          }
        ],
        objectChanges: [
          {
            index: 0,
            objectId: "0x3",
            changeKind: "mutated",
            outputType: `${AFTERMATH_EVENTS_PACKAGE}::staked_sui_vault::StakedSuiVault`
          }
        ]
      })
    ];

    for (const match of detailCases.flatMap((item) => classifySuiDeFiActivity(item))) {
      expect(match.limitations).toContain("transaction_activity_label_only");
      expect(match.limitations).toContain("not_position_inventory_or_pnl_or_signing");
      for (const limitation of match.limitations) {
        expect(KNOWN_MATCH_LIMITATIONS.has(limitation)).toBe(true);
      }
    }
  });
});
