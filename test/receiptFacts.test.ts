import { describe, expect, it } from "vitest";
import { parseReceipt } from "../review-app/src/receiptFacts.js";
import { chainReceiptAccount, chainReceiptDigest, chainReceiptObjectId } from "./fixtures/chainReceipt.js";

const gasObjectId = `0x${"d".repeat(64)}`;

// Synthetic account, transaction, object, amount and time values; protocol identifiers
// retain their real meanings. Gas net cost is 100000 + 200000 - 50000 = 250000.
// A well-formed response with nested entries, mutated per case below. Each
// case asserts that a specific shape drift — top-level OR inside a balance
// change / Move call / object-type entry — fails closed (returns null → the page
// shows an error) instead of rendering a partial or "undefined ..." receipt.
function validReceipt(): Record<string, unknown> {
  return {
    txDigest: chainReceiptDigest,
    sender: chainReceiptAccount,
    effectsStatus: { success: true },
    packageCalls: [
      {
        commandIndex: 0,
        packageId: "0x0000000000000000000000000000000000000000000000000000000000000002",
        module: "coin",
        function: "zero",
        target: "0x0000000000000000000000000000000000000000000000000000000000000002::coin::zero"
      }
    ],
    balanceChanges: [
      {
        index: 0,
        address: chainReceiptAccount,
        coinType: "0x2::sui::SUI",
        amountRaw: "1000000000",
        direction: "increase"
      }
    ],
    objectTypes: {
      [chainReceiptObjectId]:
        "0x2::coin::Coin<0x2::sui::SUI>"
    },
    gas: {
      totalMist: "250000",
      computationMist: "100000",
      storageMist: "200000",
      storageRebateMist: "50000",
      nonRefundableStorageMist: "0",
      budgetMist: "1000000",
      priceMist: "1000",
      paymentObjectId: gasObjectId
    },
    inputs: [
      { index: 0, kind: "pure", objectId: undefined },
      { index: 1, kind: "object", objectId: chainReceiptObjectId }
    ],
    events: [
      {
        index: 0,
        packageId: "0x0000000000000000000000000000000000000000000000000000000000000002",
        module: "coin",
        eventType: "0x0000000000000000000000000000000000000000000000000000000000000002::coin::CoinEvent",
        sender: chainReceiptAccount
      }
    ],
    chainIdentifier: "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S",
    fetchedAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("parseReceipt", () => {
  it("accepts a well-formed receipt with nested entries and returns the validated shape", () => {
    const parsed = parseReceipt(validReceipt());
    expect(parsed).not.toBeNull();
    // It returns the validated, typed facts the page renders.
    expect(parsed?.balanceChanges[0]).toEqual({
      index: 0,
      address: chainReceiptAccount,
      coinType: "0x2::sui::SUI",
      amountRaw: "1000000000",
      direction: "increase"
    });
    expect(parsed?.packageCalls[0]?.target).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000002::coin::zero"
    );
  });

  it("accepts a failed-effects receipt and a missing sender (both legitimate, not drift)", () => {
    expect(parseReceipt({ ...validReceipt(), effectsStatus: { success: false, errorMessage: "Move abort" } })).not.toBeNull();
    const noSender = validReceipt();
    delete noSender.sender;
    expect(parseReceipt(noSender)).not.toBeNull();
  });

  // --- top-level drift ---
  it("rejects a non-object response", () => {
    expect(parseReceipt(null)).toBeNull();
    expect(parseReceipt("a string")).toBeNull();
  });

  it("rejects a missing/non-string txDigest, chainIdentifier, or fetchedAt", () => {
    for (const field of ["txDigest", "chainIdentifier", "fetchedAt"]) {
      const dropped = validReceipt();
      delete dropped[field];
      expect(parseReceipt(dropped), `missing ${field}`).toBeNull();
      expect(parseReceipt({ ...validReceipt(), [field]: 123 }), `numeric ${field}`).toBeNull();
    }
  });

  it("rejects a non-boolean effectsStatus.success (the drift that showed success as 'failure')", () => {
    expect(parseReceipt({ ...validReceipt(), effectsStatus: { success: "true" } })).toBeNull();
    expect(parseReceipt({ ...validReceipt(), effectsStatus: {} })).toBeNull();
    // A non-string error message on a failed status is also drift.
    expect(parseReceipt({ ...validReceipt(), effectsStatus: { success: false, errorMessage: 7 } })).toBeNull();
  });

  it("rejects non-array balanceChanges / packageCalls and non-object objectTypes", () => {
    expect(parseReceipt({ ...validReceipt(), balanceChanges: { 0: "x" } })).toBeNull();
    expect(parseReceipt({ ...validReceipt(), packageCalls: "swap" })).toBeNull();
    expect(parseReceipt({ ...validReceipt(), objectTypes: "0x2::coin::Coin" })).toBeNull();
    expect(parseReceipt({ ...validReceipt(), objectTypes: [] })).toBeNull();
  });

  // --- nested entry drift (the round-3 finding: top-level arrays were fine but
  // entries were trusted and could render "undefined ...") ---
  it("rejects a balance change entry with a missing or wrong-typed field", () => {
    const missingAddress = validReceipt();
    (missingAddress.balanceChanges as Array<Record<string, unknown>>)[0] = {
      index: 0,
      coinType: "0x2::sui::SUI",
      amountRaw: "1",
      direction: "increase"
    };
    expect(parseReceipt(missingAddress)).toBeNull();

    expect(
      parseReceipt({
        ...validReceipt(),
        balanceChanges: [{ index: 0, address: "0xabc", coinType: "0x2::sui::SUI", amountRaw: 1, direction: "increase" }]
      }),
      "numeric amountRaw"
    ).toBeNull();

    expect(
      parseReceipt({
        ...validReceipt(),
        balanceChanges: [{ index: 0, address: "0xabc", coinType: "0x2::sui::SUI", amountRaw: "1", direction: "sideways" }]
      }),
      "invalid direction"
    ).toBeNull();
  });

  it("rejects a Move call entry with a missing or wrong-typed target", () => {
    expect(
      parseReceipt({
        ...validReceipt(),
        packageCalls: [{ commandIndex: 0, packageId: "0x2", module: "coin", function: "zero" }]
      }),
      "missing target"
    ).toBeNull();
    expect(
      parseReceipt({
        ...validReceipt(),
        packageCalls: [{ commandIndex: 0, packageId: "0x2", module: "coin", function: "zero", target: 5 }]
      }),
      "numeric target"
    ).toBeNull();
  });

  it("rejects an object-type entry whose value is not a string", () => {
    expect(parseReceipt({ ...validReceipt(), objectTypes: { "0xobj": 42 } })).toBeNull();
  });

  it("validates gas, inputs, events, and the optional PTB graph", () => {
    // Gas: a required mist field must be a string, not a number.
    expect(parseReceipt({ ...validReceipt(), gas: { totalMist: 250000 } })).toBeNull();
    // Inputs: an unrecognized kind is drift.
    expect(parseReceipt({ ...validReceipt(), inputs: [{ index: 0, kind: "weird", objectId: undefined }] })).toBeNull();
    // Inputs: a non-string bytes is drift; a string bytes is surfaced.
    expect(
      parseReceipt({ ...validReceipt(), inputs: [{ index: 0, kind: "pure", objectId: undefined, bytes: 5 }] })
    ).toBeNull();
    const withBytes = parseReceipt({
      ...validReceipt(),
      inputs: [{ index: 0, kind: "pure", objectId: undefined, bytes: "0x0100000000000000" }]
    });
    expect(withBytes?.inputs[0]).toMatchObject({ kind: "pure", bytes: "0x0100000000000000" });
    // Events: a non-string eventType is drift.
    expect(
      parseReceipt({ ...validReceipt(), events: [{ index: 0, packageId: "0x2", module: "m", eventType: 1, sender: "0x1" }] })
    ).toBeNull();
    // The PTB graph is optional: absent is valid; a mermaid missing the raw/named
    // text pair is drift.
    expect(parseReceipt({ ...validReceipt(), ptbGraph: undefined })).not.toBeNull();
    expect(parseReceipt({ ...validReceipt(), ptbGraph: { mermaid: 5 } })).toBeNull();
    expect(parseReceipt({ ...validReceipt(), ptbGraph: { mermaid: "flowchart LR" } })).toBeNull();
    const mermaid = { text: "flowchart LR\n  A-->B", namedText: "flowchart LR\n  pkg-->B" };
    const withGraph = parseReceipt({ ...validReceipt(), ptbGraph: { mermaid } });
    expect(withGraph?.ptbGraph).toEqual({ mermaid });
  });

  it("accepts optional balance-change decimals/symbol and fails closed on wrong-typed ones", () => {
    const base = `0x${"e".repeat(64)}`;
    // Present and well-typed: surfaced so the page can render a decimal amount.
    const enriched = parseReceipt({
      ...validReceipt(),
      balanceChanges: [
        { index: 0, address: base, coinType: "0x2::sui::SUI", amountRaw: "1000000000", direction: "increase", decimals: 9, symbol: "SUI" }
      ]
    });
    expect(enriched?.balanceChanges[0]).toMatchObject({ decimals: 9, symbol: "SUI" });
    // Absent is valid: enrichment is best-effort.
    expect(parseReceipt(validReceipt())).not.toBeNull();
    // Present-but-wrong-typed is drift and fails closed (so the page never renders
    // a malformed amount or "undefined SYMBOL").
    expect(
      parseReceipt({
        ...validReceipt(),
        balanceChanges: [{ index: 0, address: base, coinType: "0x2::sui::SUI", amountRaw: "1", direction: "increase", decimals: "9" }]
      }),
      "string decimals"
    ).toBeNull();
    expect(
      parseReceipt({
        ...validReceipt(),
        balanceChanges: [{ index: 0, address: base, coinType: "0x2::sui::SUI", amountRaw: "1", direction: "increase", symbol: 5 }]
      }),
      "numeric symbol"
    ).toBeNull();
  });
});
