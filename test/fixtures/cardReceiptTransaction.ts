import type { SuiClientTypes } from "@mysten/sui/client";
import { chainReceiptAccount as account, chainReceiptDigest as digest,
  chainReceiptPackageId as packageId, chainReceiptObjectId as objectId } from "./chainReceipt.js";

// External SDK response fixture; the reader, projection, DB and MCP consumers
// remain real. Pure values match the independently specified reader cases.
export const cardReceiptTransaction = {
  digest, signatures: ["fixture-signature-never-exposed"], epoch: "42", timestampMs: null, checkpoint: null,
  status: { success: true, error: null },
  balanceChanges: [{ address: account, coinType: "0x2::sui::SUI", amount: "-1000" }],
  effects: {
    bcs: null, version: 1, status: { success: true, error: null },
    gasUsed: { computationCost: "100", storageCost: "50", storageRebate: "20", nonRefundableStorageFee: "0" },
    transactionDigest: digest, gasObject: null, eventsDigest: null, dependencies: [], lamportVersion: null,
    changedObjects: [], unchangedConsensusObjects: [], auxiliaryDataDigest: null
  },
  events: [], objectTypes: { [objectId]: "0x2::coin::Coin<0x2::sui::SUI>" },
  transaction: {
    version: 2, sender: account, expiration: null,
    gasData: { budget: "1000000", price: "1000", owner: account, payment: [] },
    inputs: [{ Pure: { bytes: "AA==" } }, { Pure: { bytes: "mMJ29jIAAAA=" } }],
    commands: [{ MoveCall: { package: packageId, module: "pool", function: "swap", typeArguments: [], arguments: [{ Input: 0 }, { Input: 1 }] } }]
  },
  bcs: undefined
} satisfies SuiClientTypes.Transaction<{ transaction: true; effects: true; balanceChanges: true; objectTypes: true; events: true }>;
