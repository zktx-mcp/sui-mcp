import { DeepBookClient, mainnetPools } from "@mysten/deepbook-v3";
import { appendGuardedSwap, type DeepbookSwapTransactionMaterialProducerInput } from "../../src/adapters/deepbook/deepbookTransactionMaterialProducer.js";
import { verifyDeepbookSwapCommands } from "../../src/adapters/deepbook/deepbookSwapCommands.js";
import { createDeepbookBuildClient } from "./deepbookBuildClient.js";

export function isFixtureSharedObject(id: string) {
  return id === `0x${"c".repeat(64)}` || id === "0x" + "6".padStart(64,"0") || Object.values(mainnetPools).some((p) => p.address === id);
}

function fixtureLimits(input: DeepbookSwapTransactionMaterialProducerInput) {
  return { account: input.account, poolKey: input.poolResolution.poolKey, poolId: input.poolResolution.pool.address,
    baseType: input.quote.rawQuote.baseOut.coinType, quoteType: input.quote.rawQuote.quoteOut.coinType,
    deepType: input.quote.rawQuote.deepRequired.coinType, direction: input.quotePolicy.direction,
    principal: BigInt(input.quotePolicy.sourceAmountRaw), minimum: BigInt(input.quotePolicy.minOutRaw), deepBudget: BigInt(input.quotePolicy.feeBudgetRaw) };
}
import { SUI_MAINNET_CHAIN_IDENTIFIER as BUILD_CHAIN } from "../../src/runtime/suiEndpoint.js";
import type { TransactionFundingEvidence } from "../../src/core/action/transactionFunding.js";
import { Inputs, Transaction } from "@mysten/sui/transactions";
import type {
  LocalTransactionMaterialDigestCommitment,
  LocalTransactionMaterialHandle,
  LocalTransactionMaterialStore
} from "../../src/core/session/transactionMaterialStore.js";

export async function buildTestTransactionBytes(
  account: string,
  options: { swap?: DeepbookSwapTransactionMaterialProducerInput | undefined; includeSharedObject?: boolean | undefined; moveCallTarget?: string | undefined; addressBalance?: boolean | undefined } = {}
): Promise<Uint8Array> {
  const transaction = new Transaction();
  transaction.setSender(account);
  transaction.setGasBudget(1000);
  transaction.setGasPrice(1);
  transaction.setGasPayment(options.addressBalance ? [] : [
    {
      objectId: `0x${"b".repeat(64)}`,
      version: "1",
      digest: "7".repeat(44)
    }
  ]);
  if (options.swap) {
    const limits = fixtureLimits(options.swap);
    const addressBalances = options.addressBalance ? { [limits.baseType]: "2000000000", [limits.quoteType]: "2000000000", [limits.deepType]: "2000000000" } : {};
    const client = createDeepbookBuildClient({ expectedChainIdentifier: BUILD_CHAIN, addressBalances,
      ...(options.addressBalance ? { gasPayments: [] } : {}) });
    const sdk = new DeepBookClient({ address: account, network: "mainnet", client });
    appendGuardedSwap(transaction, sdk, limits);
    return transaction.build({ client });
  }
  if (options.addressBalance) {
    transaction.setExpiration({ ValidDuring: { minEpoch: "1", maxEpoch: "2", minTimestamp: null, maxTimestamp: null, chain: BUILD_CHAIN, nonce: 7 } });
    const coin = transaction.moveCall({ target: "0x2::coin::redeem_funds", typeArguments: ["0x2::sui::SUI"], arguments: [transaction.withdrawal({ amount: 1000000000n })] });
    transaction.transferObjects([coin], account);
  }
  if (options.moveCallTarget) {
    transaction.moveCall({
      target: options.moveCallTarget,
      arguments: [transaction.pure.u64(1n)]
    });
  }
  if (options.includeSharedObject) {
    const shared = transaction.object(
      Inputs.SharedObjectRef({
        objectId: `0x${"c".repeat(64)}`,
        initialSharedVersion: "1",
        mutable: false
      })
    );
    transaction.moveCall({
      target: "0x2::clock::timestamp_ms",
      arguments: [shared]
    });
  }
  return transaction.build();
}

export async function recordTestTransactionMaterial(input: {
  swap?: DeepbookSwapTransactionMaterialProducerInput | undefined;
  materialStore: Pick<LocalTransactionMaterialStore, "recordTransactionMaterial">;
  reviewSessionId: string;
  planId: string;
  account: string;
  now: Date;
  computedAt?: Date | undefined;
  expiresAt: Date;
  includeSharedObject?: boolean | undefined;
  addressBalance?: boolean | undefined;
  moveCallTarget?: string | undefined;
}): Promise<{
  guardCommand?: number;
  handle: LocalTransactionMaterialHandle;
  digest: LocalTransactionMaterialDigestCommitment;
}> {
  const transactionBytes = await buildTestTransactionBytes(input.account, {
    swap: input.swap, includeSharedObject: input.includeSharedObject,
    addressBalance: input.addressBalance,
    moveCallTarget: input.moveCallTarget
  });
  const handle = input.materialStore.recordTransactionMaterial(
    {
      reviewSessionId: input.reviewSessionId,
      planId: input.planId,
      account: input.account,
      kind: "deepbook_swap_transaction_data",
      source: "sui_mcp_built",
      transactionBytes,
      expiresAt: input.expiresAt
    },
    input.now
  );
  const transactionDigest = await Transaction.from(transactionBytes).getDigest();
  return {
    handle,
    ...(input.swap ? { guardCommand: verifyDeepbookSwapCommands(Transaction.from(transactionBytes).getData(), fixtureLimits(input.swap)) } : {}),
    digest: {
      materialId: handle.materialId,
      reviewSessionId: handle.reviewSessionId,
      planId: handle.planId,
      account: handle.account,
      kind: handle.kind,
      source: handle.source,
      digestKind: "sui_transaction_digest",
      transactionDigest,
      computedAt: (input.computedAt ?? input.now).toISOString(),
      expiresAt: handle.expiresAt
    }
  };
}

// Independent facts for buildTestTransactionBytes' fixed object-funded input.
export function testObjectFunding(account: string, chainIdentifier = "mainnet-chain"): TransactionFundingEvidence {
  const objectId = `0x${"b".repeat(64)}`;
  return { sender: account, gasOwner: account, chainIdentifier, gasBudgetRaw: "1000", gasPriceRaw: "1",
    gasMode: "coin_objects", gasPayments: [{ objectId, version: "1", digest: "7".repeat(44) }],
    gasObjectIds: [objectId], reservations: [], withdrawals: [], expiration: { kind: "none" }, addressBalances: [] };
}
