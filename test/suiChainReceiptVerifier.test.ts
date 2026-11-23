import { bcs } from "@mysten/sui/bcs";
import { TransactionError, type SuiClientTypes } from "@mysten/sui/client";
import { describe, expect, it } from "vitest";
import {
  SUI_CHAIN_RECEIPT_GET_TRANSACTION_INCLUDE,

  type SuiChainReceiptVerifierClient,
  verifySuiChainReceipt
} from "../src/core/action/suiChainReceiptVerifier.js";
import { SUI_CHAIN_RECEIPT_REQUIRED_INCLUDE } from "../src/core/action/suiChainReceiptEvidence.js";

type ChainReceiptInclude = {
  transaction: true;
  effects: true;
  balanceChanges: true;
  objectTypes: true;
};

type FixtureClient = SuiChainReceiptVerifierClient & {
  calls: SuiClientTypes.GetTransactionOptions<ChainReceiptInclude>[];
  chainIdentifierCalls: string[];
};

const account = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const otherAccount = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const packageId = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const objectId = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const digest = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const otherDigest = "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR";
const normalizedSuiCoinType = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const now = new Date("2026-06-26T00:00:00.000Z");

function createClient(
  transaction: SuiClientTypes.Transaction<ChainReceiptInclude>,
  kind: "Transaction" | "FailedTransaction" = "Transaction",
  chainIdentifier = "mainnet-chain"
): FixtureClient {
  const calls: FixtureClient["calls"] = [];
  const chainIdentifierCalls: FixtureClient["chainIdentifierCalls"] = [];
  return {
    calls,
    chainIdentifierCalls,
    core: {
      async getChainIdentifier() {
        chainIdentifierCalls.push(chainIdentifier);
        return { chainIdentifier };
      },
      async getTransaction(options) {
        calls.push(options);
        return kind === "Transaction"
          ? { $kind: "Transaction", Transaction: transaction }
          : { $kind: "FailedTransaction", FailedTransaction: transaction };
      }
    }
  };
}

function createThrowingClient(error: unknown): FixtureClient {
  const calls: FixtureClient["calls"] = [];
  const chainIdentifierCalls: FixtureClient["chainIdentifierCalls"] = [];
  return {
    calls,
    chainIdentifierCalls,
    core: {
      async getChainIdentifier() {
        chainIdentifierCalls.push("mainnet-chain");
        return { chainIdentifier: "mainnet-chain" };
      },
      async getTransaction(options) {
        calls.push(options);
        throw error;
      }
    }
  };
}

function transactionFixture(overrides: Partial<SuiClientTypes.Transaction<ChainReceiptInclude>> = {}) {
  const base = {
    digest,
    signatures: ["wallet-signature-not-stored"],
    epoch: "42",
    timestampMs: null, checkpoint: null,
    status: { success: true, error: null },
    balanceChanges: [
      {
        address: account,
        coinType: "0x2::sui::SUI",
        amount: "-1000"
      },
      {
        address: otherAccount,
        coinType: "0x2::sui::SUI",
        amount: "999"
      },
      {
        address: account,
        coinType: "0x2::sui::SUI",
        amount: "0"
      }
    ],
    effects: {
      bcs: null,
      version: 1,
      status: { success: true, error: null },
      gasUsed: {
        computationCost: "100",
        storageCost: "50",
        storageRebate: "20",
        nonRefundableStorageFee: "0"
      },
      transactionDigest: digest,
      gasObject: null,
      eventsDigest: null,
      dependencies: [],
      lamportVersion: null,
      changedObjects: [],
      unchangedConsensusObjects: [],
      auxiliaryDataDigest: null
    },
    events: undefined,
    objectTypes: {
      [objectId]: "0x2::coin::Coin<0x2::sui::SUI>"
    },
    transaction: {
      version: 2,
      sender: account,
      expiration: null,
      gasData: {
        budget: "1000000",
        price: "1000",
        owner: account,
        payment: []
      },
      inputs: [],
      commands: [
        {
          MoveCall: {
            package: packageId,
            module: "pool",
            function: "swap",
            typeArguments: [],
            arguments: []
          }
        },
        {
          TransferObjects: {
            objects: [],
            address: { Input: 0 }
          }
        }
      ]
    },
    bcs: undefined
  } satisfies SuiClientTypes.Transaction<ChainReceiptInclude>;

  return {
    ...base,
    ...overrides
  } satisfies SuiClientTypes.Transaction<ChainReceiptInclude>;
}

async function verifyWith(client: FixtureClient, extra: Partial<Parameters<typeof verifySuiChainReceipt>[1]> = {}) {
  return verifySuiChainReceipt(
    {
      client,
      network: "mainnet",
      expectedChainIdentifier: "mainnet-chain"
    },
    {
      txDigest: digest,
      reviewedTransactionDigest: digest,
      account,
      now,
      ...extra
    }
  );
}

describe("Sui chain receipt verifier", () => {
  it("reads Sui mainnet transaction facts without requesting or storing BCS/signatures", async () => {
    const client = createClient(transactionFixture());

    const result = await verifyWith(client);

    expect(result.status).toBe("verified_success");
    if (result.status !== "verified_success") {
      throw new Error("receipt verifier did not verify");
    }
    expect(client.chainIdentifierCalls).toEqual(["mainnet-chain"]);
    expect(client.calls).toEqual([
      {
        digest,
        include: SUI_CHAIN_RECEIPT_GET_TRANSACTION_INCLUDE,
        signal: expect.any(AbortSignal)
      }
    ]);
    expect(Object.keys(SUI_CHAIN_RECEIPT_GET_TRANSACTION_INCLUDE)).toEqual(SUI_CHAIN_RECEIPT_REQUIRED_INCLUDE);
    expect(client.calls[0]?.include).not.toHaveProperty("bcs");
    expect(result.receipt).toMatchObject({
      kind: "sui_chain_receipt_v1",
      source: {
        method: "client.core.getTransaction",
        network: "sui:mainnet",
        chainIdentifier: "mainnet-chain",
        fetchedAt: now.toISOString(),
        include: ["transaction", "effects", "balanceChanges", "objectTypes"]
      },
      txDigest: digest,
      sender: account,
      effectsStatus: { success: true },
      packageCalls: [
        {
          commandIndex: 0,
          packageId,
          module: "pool",
          function: "swap",
          target: `${packageId}::pool::swap`
        }
      ],
      accountBalanceChanges: [
        {
          index: 0,
          coinType: normalizedSuiCoinType,
          amountRaw: "-1000",
          direction: "decrease"
        },
        {
          index: 2,
          coinType: normalizedSuiCoinType,
          amountRaw: "0",
          direction: "zero"
        }
      ],
      objectTypes: {
        [objectId]: "0x2::coin::Coin<0x2::sui::SUI>"
      }
    });
    const json = JSON.stringify(result.receipt);
    expect(json).not.toContain("wallet-signature-not-stored");
    expect(json).not.toContain("signatures");
    expect(json).not.toContain("bcs");
    expect(json).not.toContain(otherAccount);
  });

  it("scopes balance changes to the reviewed account", async () => {
    const client = createClient(transactionFixture());

    const result = await verifyWith(client);

    expect(result.status).toBe("verified_success");
    if (result.status !== "verified_success") {
      throw new Error("receipt verifier did not verify account-scoped balance changes");
    }
    expect(result.receipt.accountBalanceChanges).toEqual([
      {
        index: 0,
        coinType: normalizedSuiCoinType,
        amountRaw: "-1000",
        direction: "decrease"
      },
      {
        index: 2,
        coinType: normalizedSuiCoinType,
        amountRaw: "0",
        direction: "zero"
      }
    ]);
    expect(JSON.stringify(result.receipt.accountBalanceChanges)).not.toContain(otherAccount);
  });

  it("verifies failed effects from a normal transaction response", async () => {
    const failedStatus = {
      success: false,
      error: {
        $kind: "MoveAbort",
        MoveAbort: { abortCode: "7" },
        message: "Move abort"
      }
    } as SuiClientTypes.ExecutionStatus;
    const client = createClient(transactionFixture({
      status: failedStatus,
      effects: {
        ...transactionFixture().effects,
        status: failedStatus
      }
    }));

    const result = await verifyWith(client);

    expect(result).toMatchObject({
      status: "verified_failure",
      failureReason: "chain_execution_failed"
    });
    if (result.status !== "verified_failure") {
      throw new Error("failed effects receipt was not verified");
    }
    expect(result.receipt.effectsStatus).toEqual({
      success: false,
      errorKind: "MoveAbort",
      errorMessage: "Move abort"
    });
  });

  it.each([
    { command: 2, code: "12", module: "pool", matched: true },
    { command: 1, code: "12", module: "pool", matched: false },
    { command: 2, code: "11", module: "pool", matched: false },
    { command: 2, code: "12", module: "other", matched: false }
  ])("attributes only the reviewed Move abort at $module/$code, command $command", async sample => {
    const error = { MoveAbort: [{ module: { address: packageId, name: sample.module }, function: 0, instruction: 0, functionName: null }, sample.code] } as const;
    const failure = { success: false as const, error: { $kind: "Unknown" as const, Unknown: null, message: "Move call failed" } };
    const base = transactionFixture();
    const bytes = bcs.TransactionEffects.serialize({ V2: {
      status: { Failure: { command: sample.command, error: { MoveAbort: [error.MoveAbort[0], error.MoveAbort[1]] } } },
      executedEpoch: 1, gasUsed: base.effects.gasUsed, transactionDigest: digest, gasObjectIndex: null, eventsDigest: null,
      dependencies: [], lamportVersion: 1, changedObjects: [], unchangedConsensusObjects: [], auxDataDigest: null
    } }).toBytes();
    const result = await verifyWith(createClient(transactionFixture({ status: failure, effects: { ...base.effects, status: failure, bcs: bytes } })),
      { guard: { transactionDigest: digest, commandIndex: 3, protocolAbort: { commandIndex: 2, packageId, moduleOrigin: packageId, module: "pool", code: "12" } } });
    expect(result.status).toBe("verified_failure");
    if (result.status !== "verified_failure" || result.receipt.effectsStatus.success) throw Error("Expected verified failed effects");
    expect(!!result.receipt.effectsStatus.minimumReceiveFailure).toBe(sample.matched);
  });

  it("verifies failed SDK transaction response shapes", async () => {
    const failedStatus = {
      success: false,
      error: {
        $kind: "CommandArgumentError",
        CommandArgumentError: { argument: 0, name: "TypeMismatch" },
        message: "Command argument error"
      }
    } as SuiClientTypes.ExecutionStatus;
    const client = createClient(
      transactionFixture({
        status: failedStatus,
        effects: {
          ...transactionFixture().effects,
          status: failedStatus
        }
      }),
      "FailedTransaction"
    );

    const result = await verifyWith(client);

    expect(result).toMatchObject({
      status: "verified_failure",
      failureReason: "chain_execution_failed"
    });
    if (result.status !== "verified_failure") {
      throw new Error("failed transaction shape was not verified");
    }
    expect(result.receipt.effectsStatus).toMatchObject({
      success: false,
      errorKind: "CommandArgumentError",
      errorMessage: "Command argument error"
    });
  });

  it("records the verified outcome when an object type exceeds the optional detail schema", async () => {
    // A coin of nested pool shares can have a long type tag with short Move identifiers.
    const asset = (name: string) => `${packageId}::asset::${name}`;
    const share = (base: string, quote: string) => `${packageId}::pool::LP<${base},${quote}>`;
    const nestedShare = share(share(asset("A"), asset("B")), share(asset("C"), asset("D")));
    const objectType = `0x2::coin::Coin<${nestedShare}>`;
    const result = await verifyWith(createClient(transactionFixture({ objectTypes: { [objectId]: objectType } })));
    expect(result).toMatchObject({
      status: "verified_success",
      receipt: {
        kind: "sui_chain_receipt_outcome_v2",
        txDigest: digest,
        detailStatus: "incomplete",
        effectsStatus: { success: true },
        accountBalanceChanges: expect.arrayContaining([
          { index: 0, coinType: normalizedSuiCoinType, amountRaw: "-1000", direction: "decrease" }
        ])
      }
    });
    expect(result).not.toHaveProperty("receipt.objectTypes");
  });

  it("keeps a timed-out same-digest wait distinct from an absent transaction", async () => {
    expect(await verifyWith(createThrowingClient(new DOMException("Elapsed", "TimeoutError")))).toMatchObject({
      status: "wait_timed_out", failureReason: "chain_receipt_unavailable" });
  });

  it("reports not_found when Sui mainnet has not indexed the digest", async () => {
    const error = Object.assign(new Error("transaction not found"), { code: "NOT_FOUND" });
    const client = createThrowingClient(error);

    const result = await verifyWith(client);

    expect(result).toEqual({
      status: "not_found",
      failureReason: "chain_receipt_unavailable",
      message: "This node has not returned the transaction. Check the same digest again."
    });
  });

  it("recognizes the pinned SDK's absent digest and rejects a different digest", async () => {
    expect(await verifyWith(createThrowingClient(new TransactionError("notFound", digest)))).toMatchObject({ status: "not_found" });
    expect(await verifyWith(createThrowingClient(new TransactionError("notFound", otherDigest)))).toMatchObject({ status: "verification_failed" });
  });

  it("fails verification when the returned digest does not match the signed digest", async () => {
    const client = createClient(transactionFixture({
      digest: otherDigest
    }));

    const result = await verifyWith(client);

    expect(result).toMatchObject({
      status: "verification_failed",
      failureReason: "receipt_verification_failed"
    });
    if (result.status !== "verification_failed") {
      throw new Error("digest mismatch did not fail verification");
    }
    expect(result.message).toMatch(/digest/i);
  });

  it("fails verification when the reviewed commitment does not match the signed digest", async () => {
    const client = createClient(transactionFixture());

    const result = await verifyWith(client, { reviewedTransactionDigest: otherDigest });

    expect(result).toMatchObject({
      status: "verification_failed",
      failureReason: "receipt_verification_failed"
    });
    expect(client.calls).toHaveLength(1);
    if (result.status !== "verification_failed") {
      throw new Error("reviewed commitment mismatch did not fail verification");
    }
    expect(result.message).toMatch(/reviewed transaction digest/i);
  });

  it("fails verification when the sender does not match the reviewed account", async () => {
    const client = createClient(transactionFixture({
      transaction: {
        ...transactionFixture().transaction,
        sender: otherAccount
      }
    }));

    const result = await verifyWith(client);

    expect(result).toMatchObject({
      status: "verification_failed",
      failureReason: "receipt_verification_failed"
    });
    if (result.status !== "verification_failed") {
      throw new Error("sender mismatch did not fail verification");
    }
    expect(result.message).toMatch(/sender/i);
  });

  it("fails closed before lookup when the mainnet chain identifier is not verified", async () => {
    const client = createClient(transactionFixture(), "Transaction", "wrong-chain");

    const result = await verifySuiChainReceipt(
      {
        client,
        network: "mainnet",
        expectedChainIdentifier: "mainnet-chain"
      },
      {
        txDigest: digest,
        reviewedTransactionDigest: digest,
        account,
        now
      }
    );

    expect(result).toMatchObject({
      status: "wrong_chain",
      failureReason: "chain_receipt_unavailable"
    });
    expect(client.calls).toHaveLength(0);
  });
});
