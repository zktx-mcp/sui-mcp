import {
  SUI_CHAIN_RECEIPT_REQUIRED_INCLUDE,
  type SuiChainReceiptEvidence
} from "../../src/core/action/suiChainReceiptEvidence.js";

export const chainReceiptAccount = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const chainReceiptPackageId = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
export const chainReceiptObjectId = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
// Synthetic digests: Base58 encodings of 32 bytes filled with 1 and 2.
export const chainReceiptDigest = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
export const otherChainReceiptDigest = "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR";

export function chainReceiptFixture(
  overrides: Partial<SuiChainReceiptEvidence> = {}
): SuiChainReceiptEvidence {
  const txDigest = overrides.txDigest ?? chainReceiptDigest;
  return {
    kind: "sui_chain_receipt_v1",
    source: {
      method: "client.core.getTransaction",
      network: "sui:mainnet",
      chainIdentifier: "mainnet-chain",
      fetchedAt: "2026-06-26T00:00:00.000Z",
      include: [...SUI_CHAIN_RECEIPT_REQUIRED_INCLUDE]
    },
    txDigest,
    sender: chainReceiptAccount,
    effectsStatus: { success: true },
    packageCalls: [
      {
        commandIndex: 0,
        packageId: chainReceiptPackageId,
        module: "pool",
        function: "swap",
        target: `${chainReceiptPackageId}::pool::swap`
      }
    ],
    accountBalanceChanges: [
      {
        index: 0,
        coinType: "0x2::sui::SUI",
        amountRaw: "-1000",
        direction: "decrease"
      }
    ],
    objectTypes: {
      [chainReceiptObjectId]: "0x2::coin::Coin<0x2::sui::SUI>"
    },
    ...overrides
  };
}
