import type { SuiClientTypes } from "@mysten/sui/client";
import { describe, expect, it } from "vitest";
import {
  readPublicChainReceipt,
  type PublicChainReceiptReaderClient
} from "../src/core/action/suiChainReceiptReader.js";
import { SUI_METADATA_UNIT_SOURCE } from "../src/core/read/coinMetadata.js";

type ChainReceiptInclude = {
  transaction: true;
  effects: true;
  balanceChanges: true;
  objectTypes: true;
  events: true;
};

type FixtureClient = PublicChainReceiptReaderClient & {
  calls: SuiClientTypes.GetTransactionOptions<ChainReceiptInclude>[];
};

const account = `0x${"a".repeat(64)}`;
const otherAccount = `0x${"b".repeat(64)}`;
const packageId = `0x${"c".repeat(64)}`;
const objectId = `0x${"d".repeat(64)}`;
const digest = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const normalizedSuiCoinType = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const now = new Date("2026-06-26T00:00:00.000Z");

function createClient(
  transaction: SuiClientTypes.Transaction<ChainReceiptInclude>,
  chainIdentifier = "mainnet-chain"
): FixtureClient {
  const calls: FixtureClient["calls"] = [];
  return {
    calls,
    core: {
      async getChainIdentifier() {
        return { chainIdentifier };
      },
      async getTransaction(options) {
        calls.push(options);
        return { $kind: "Transaction", Transaction: transaction };
      }
    }
  };
}

function createThrowingClient(error: unknown): FixtureClient {
  const calls: FixtureClient["calls"] = [];
  return {
    calls,
    core: {
      async getChainIdentifier() {
        return { chainIdentifier: "mainnet-chain" };
      },
      async getTransaction(options) {
        calls.push(options);
        throw error;
      }
    }
  };
}

function transactionFixture(
  overrides: Partial<SuiClientTypes.Transaction<ChainReceiptInclude>> = {}
): SuiClientTypes.Transaction<ChainReceiptInclude> {
  const base = {
    digest,
    signatures: ["wallet-signature-not-stored"],
    epoch: "42",
    timestampMs: null, checkpoint: null,
    status: { success: true, error: null },
    balanceChanges: [
      { address: account, coinType: "0x2::sui::SUI", amount: "-1000" },
      { address: otherAccount, coinType: "0x2::sui::SUI", amount: "999" },
      { address: account, coinType: "0x2::sui::SUI", amount: "0" }
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
    events: [],
    objectTypes: {
      [objectId]: "0x2::coin::Coin<0x2::sui::SUI>"
    },
    transaction: {
      version: 2,
      sender: account,
      expiration: null,
      gasData: { budget: "1000000", price: "1000", owner: account, payment: [] },
      inputs: [],
      commands: [
        {
          MoveCall: { package: packageId, module: "pool", function: "swap", typeArguments: [], arguments: [] }
        }
      ]
    },
    bcs: undefined
  } satisfies SuiClientTypes.Transaction<ChainReceiptInclude>;

  return { ...base, ...overrides } satisfies SuiClientTypes.Transaction<ChainReceiptInclude>;
}

async function readWith(client: FixtureClient, extra: { digest?: string } = {}) {
  return readPublicChainReceipt(
    { client, network: "mainnet", expectedChainIdentifier: "mainnet-chain" },
    { digest, now, ...extra }
  );
}

describe("public chain receipt reader", () => {
  it("keeps every balance change tagged with its address and applies no account filter", async () => {
    const client = createClient(transactionFixture());

    const result = await readWith(client);

    expect(result.status).toBe("found");
    if (result.status !== "found") {
      throw new Error("reader did not return a receipt");
    }
    // Unlike the account-bound verifier, the public reader keeps all three
    // balance changes (both accounts), each tagged with its owner address.
    expect(result.receipt.balanceChanges).toEqual([
      { index: 0, address: account, coinType: normalizedSuiCoinType, amountRaw: "-1000", direction: "decrease" },
      { index: 1, address: otherAccount, coinType: normalizedSuiCoinType, amountRaw: "999", direction: "increase" },
      { index: 2, address: account, coinType: normalizedSuiCoinType, amountRaw: "0", direction: "zero" }
    ]);
    expect(result.receipt).toMatchObject({
      txDigest: digest,
      sender: account,
      effectsStatus: { success: true },
      chainIdentifier: "mainnet-chain",
      fetchedAt: now.toISOString()
    });
    // The reader never surfaces signatures or BCS.
    const json = JSON.stringify(result.receipt);
    expect(json).not.toContain("wallet-signature-not-stored");
    expect(json).not.toContain("bcs");
  });

  it("rejects an invalid transaction digest before any chain read", async () => {
    const client = createClient(transactionFixture());

    const result = await readWith(client, { digest: "not-a-digest" });

    expect(result).toEqual({ status: "invalid_digest" });
    expect(client.calls).toHaveLength(0);
  });

  it("reports not_found when Sui mainnet has not indexed the digest", async () => {
    const error = Object.assign(new Error("transaction not found"), { code: "NOT_FOUND" });
    const client = createThrowingClient(error);

    const result = await readWith(client);

    expect(result).toEqual({ status: "not_found" });
  });

  it("maps a provider availability outage to unavailable, not not_found", async () => {
    // "service not available" is an outage, not "this digest does not exist".
    const error = new Error("503 service not available");
    const client = createThrowingClient(error);

    const result = await readWith(client);

    expect(result.status).toBe("unavailable");
  });

  it("fails closed to unavailable when a balance change address is malformed", async () => {
    const client = createClient(
      transactionFixture({
        balanceChanges: [
          { address: account, coinType: "0x2::sui::SUI", amount: "-1000" },
          { address: "not-an-address", coinType: "0x2::sui::SUI", amount: "5" }
        ]
      })
    );

    const result = await readWith(client);

    // A malformed payload must not yield a partial `found` receipt; it fails
    // closed so the public page never presents silently dropped facts.
    expect(result.status).toBe("unavailable");
  });

  it("fails closed before lookup when the mainnet chain identifier is not verified", async () => {
    const client = createClient(transactionFixture(), "wrong-chain");

    const result = await readWith(client);

    expect(result.status).toBe("unavailable");
    expect(client.calls).toHaveLength(0);
  });

  it("relabels registered packages and shortens unknown addresses in the receipt PTB graph", async () => {
    const suiFramework = `0x${"0".repeat(63)}2`;
    const base = transactionFixture();
    const client = createClient(
      transactionFixture({
        transaction: {
          ...base.transaction,
          commands: [
            { MoveCall: { package: suiFramework, module: "coin", function: "zero", typeArguments: [], arguments: [] } },
            { MoveCall: { package: packageId, module: "pool", function: "swap", typeArguments: [], arguments: [] } }
          ]
        }
      })
    );

    const result = await readWith(client);

    expect(result.status).toBe("found");
    if (result.status !== "found") {
      throw new Error("reader did not return a receipt");
    }
    const named = result.receipt.ptbGraph?.mermaid.namedText ?? "";
    // The named version: a registered framework package shows its Move alias, not the
    // raw address, and an unregistered package address is shortened.
    expect(named).toContain("sui::coin::zero");
    expect(named).not.toContain(`${suiFramework}::`);
    expect(named).toContain("0xcccccc...cccc::pool::swap");
    expect(named).not.toContain(packageId);
    // The raw version keeps the full un-relabeled address for the address toggle.
    const raw = result.receipt.ptbGraph?.mermaid.text ?? "";
    expect(raw).toContain(packageId);
  });

  it("surfaces a pure input's raw bytes as 0x-hex", async () => {
    const base = transactionFixture();
    const client = createClient(
      transactionFixture({
        transaction: {
          ...base.transaction,
          inputs: [{ Pure: { bytes: "AA==" } }, { Pure: { bytes: "mMJ29jIAAAA=" } }]
        }
      })
    );

    const result = await readWith(client);

    expect(result.status).toBe("found");
    if (result.status !== "found") {
      throw new Error("reader did not return a receipt");
    }
    // base64 "AA==" → 0x00, "mMJ29jIAAAA=" → the u64-width raw bytes. The receipt
    // surfaces the verifiable bytes; it does not guess a scalar type.
    expect(result.receipt.inputs).toEqual([
      { index: 0, kind: "pure", objectId: undefined, bytes: "0x00" },
      { index: 1, kind: "pure", objectId: undefined, bytes: "0x98c276f632000000" }
    ]);
  });

  it("enriches balance changes with verified decimals and symbol when a resolver is provided", async () => {
    const client = createClient(transactionFixture());

    const result = await readPublicChainReceipt(
      {
        client,
        network: "mainnet",
        expectedChainIdentifier: "mainnet-chain",
        resolveCoinUnit: async () => ({
          status: "available",
          source: SUI_METADATA_UNIT_SOURCE,
          decimals: 9,
          symbol: "SUI",
          name: "Sui"
        })
      },
      { digest, now }
    );

    expect(result.status).toBe("found");
    if (result.status !== "found") {
      throw new Error("reader did not return a receipt");
    }
    // Each change carries the verified unit so the page renders a decimal amount.
    expect(result.receipt.balanceChanges[0]).toMatchObject({ amountRaw: "-1000", decimals: 9, symbol: "SUI" });
  });

  it("leaves balance changes on raw amounts when decimals are unresolved (best-effort, never fails the receipt)", async () => {
    const unavailable = createClient(transactionFixture());
    const unresolved = await readPublicChainReceipt(
      {
        client: unavailable,
        network: "mainnet",
        expectedChainIdentifier: "mainnet-chain",
        resolveCoinUnit: async () => ({ status: "unavailable", reason: "metadata_not_found" })
      },
      { digest, now }
    );
    expect(unresolved.status).toBe("found");
    if (unresolved.status !== "found") {
      throw new Error("reader did not return a receipt");
    }
    expect(unresolved.receipt.balanceChanges[0]).not.toHaveProperty("decimals");
    expect(unresolved.receipt.balanceChanges[0]?.amountRaw).toBe("-1000");

    // A resolver that throws (a metadata outage) must also leave the receipt intact.
    const outage = createClient(transactionFixture());
    const throwing = await readPublicChainReceipt(
      {
        client: outage,
        network: "mainnet",
        expectedChainIdentifier: "mainnet-chain",
        resolveCoinUnit: async () => {
          throw new Error("coin metadata service unavailable");
        }
      },
      { digest, now }
    );
    expect(throwing.status).toBe("found");
    if (throwing.status !== "found") {
      throw new Error("reader did not return a receipt");
    }
    expect(throwing.receipt.balanceChanges[0]).not.toHaveProperty("decimals");
  });
});
