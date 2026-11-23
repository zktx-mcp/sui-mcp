import { testObjectFunding } from "./fixtures/transactionMaterial.js";
import { describe, expect, it } from "vitest";
import { Inputs, Transaction } from "@mysten/sui/transactions";
import {
  createDeepbookSwapTransactionMaterialDigestProducer,
  createDeepbookSwapTransactionMaterialProducer
} from "../src/adapters/deepbook/deepbookTransactionMaterialProducer.js";
import { deriveDeepbookSwapQuotePolicy } from "../src/adapters/deepbook/deepbookQuotePolicy.js";
import type { DeepbookSwapRequestedIntent } from "../src/adapters/deepbook/deepbookSwapIntent.js";
import type { ActionPlan } from "../src/core/action/types.js";
import {
  mapTransactionObjectOwnershipEvidenceToContractDraft,
  type TransactionObjectOwnershipEvidence
} from "../src/core/action/transactionObjectOwnershipEvidence.js";
import { resolveDeepbookPoolForSymbols } from "../src/core/read/deepbookRegistry.js";
import {
  createTransactionObjectOwnershipProducer,
  type TransactionObjectOwnershipObjectSource
} from "../src/core/action/transactionObjectOwnershipProducer.js";
import {
  InMemoryLocalTransactionMaterialStore,
  type LocalTransactionMaterialDigestCommitment
} from "../src/core/session/transactionMaterialStore.js";
import { createDeepbookBuildClient } from "./fixtures/deepbookBuildClient.js";
import { deepbookDisplayQuote } from "./fixtures/deepbookQuote.js";

const account = `0x${"a".repeat(64)}`;
const otherAccount = `0x${"d".repeat(64)}`;
const gasObjectId = `0x${"b".repeat(64)}`;
const sharedObjectId = `0x${"c".repeat(64)}`;
const immutableObjectId = `0x${"e".repeat(64)}`;
const suiCoinObjectType = "0x2::coin::Coin<0x2::sui::SUI>";
const usdcCoinObjectType = `0x2::coin::Coin<0x${"f".repeat(64)}::usdc::USDC>`;
const sharedObjectType = "0x2::clock::Clock";
const immutableObjectType = "0x2::clock::Clock";
const nonCoinObjectType = "0x2::object::UID";
const chainIdentifier = "mainnet-chain";
const requestedIntent: DeepbookSwapRequestedIntent = {
  type: "swap",
  from: {
    symbol: "SUI",
    amountDisplay: "1"
  },
  to: {
    symbol: "USDC"
  },
  maxSlippageBps: 50
};
const deepbookPlan: ActionPlan & {
  actionKind: "swap";
  adapterId: "deepbook-swap";
  protocol: "DeepBookV3";
} = {
  id: "plan_1",
  actionKind: "swap",
  adapterId: "deepbook-swap",
  protocol: "DeepBookV3",
  title: "Review swap",
  summary: "Review a swap",
  assetFlowPreview: {
    outgoing: [{ symbol: "SUI", amount: "1", amountKind: "display_intent" }],
    expectedIncoming: [{ symbol: "USDC", amount: "unknown", amountKind: "display_intent", approx: true }]
  },
  adapterData: {
    requestedIntent
  },
  createdAt: "2026-05-15T00:00:00.000Z"
};

describe("transaction object ownership producer", () => {
  it("verifies contract-mappable ownership from actual first adapter material bytes", async () => {
    const materialStore = new InMemoryLocalTransactionMaterialStore();
    const materialProducer = createDeepbookSwapTransactionMaterialProducer({
      client: createDeepbookBuildClient({ expectedChainIdentifier: chainIdentifier }),
      network: "mainnet",
      chainIdentifier,
      expectedChainIdentifier: chainIdentifier,
      materialStore
    });
    const quote = deepbookDisplayQuote();
    const quotePolicy = deriveDeepbookSwapQuotePolicy({
      rawQuote: quote.rawQuote,
      fetchedAt: quote.fetchedAt,
      maxSlippageBps: 50,
      now: new Date("2026-05-15T00:00:29.000Z")
    });
    if (quotePolicy.status !== "ok") {
      throw new Error("quote fixture unexpectedly requires refresh");
    }

    const materialOutcome = await materialProducer({
      reviewSessionId: "review_1",
      plan: deepbookPlan,
      account,
      requestedIntent,
      poolResolution: resolveDeepbookPoolForSymbols({ sourceSymbol: "SUI", targetSymbol: "USDC" }),
      quote,
      quotePolicy: { ...quotePolicy, feeBudgetRaw: quotePolicy.quotedDeepRequiredRaw },
      now: new Date("2026-05-15T00:00:29.000Z")
    });
    expect(materialOutcome.status).toBe("completed");
    if (materialOutcome.status !== "completed") {
      throw new Error("material producer did not complete");
    }
    const digestOutcome = await createDeepbookSwapTransactionMaterialDigestProducer({ materialStore })({
      materialHandle: materialOutcome.evidence,
      now: new Date("2026-05-15T00:00:29.500Z")
    });
    expect(digestOutcome.status).toBe("completed");
    if (digestOutcome.status !== "completed") {
      throw new Error("digest producer did not complete");
    }
    const stored = materialStore.getTransactionMaterial(
      materialOutcome.evidence,
      new Date("2026-05-15T00:00:29.500Z")
    );
    if (!stored) {
      throw new Error("material was not stored");
    }
    const expectedObjects = objectSourceForStoredBytes(stored.transactionBytes);
    const producer = createTransactionObjectOwnershipProducer({
      materialStore,
      objectSource: objectSource(expectedObjects),
      network: "mainnet",
      chainIdentifier,
      expectedChainIdentifier: chainIdentifier
    });

    const outcome = await producer({
      materialHandle: materialOutcome.evidence,
      materialDigest: digestOutcome.evidence,
      now: new Date("2026-05-15T00:00:29.750Z")
    });

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") {
      throw new Error("ownership producer did not complete");
    }
    expect(outcome.evidence.objectCount).toBe(Object.keys(expectedObjects).length);
    const contractMapping = mapTransactionObjectOwnershipEvidenceToContractDraft(outcome.evidence);
    expect(contractMapping).toMatchObject({ status: "mapped" });
    if (contractMapping.status !== "mapped") {
      throw new Error("ownership evidence was not contract-mappable");
    }
    expect(contractMapping.gasObjectOwnershipLinks.length).toBeGreaterThan(0);
    for (const gasLink of contractMapping.gasObjectOwnershipLinks) {
      expect(contractMapping.objectOwnership.objects).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            objectId: gasLink.objectId,
            role: "gas_coin",
            ownership: "owned_by_account",
            evidenceClaimId: gasLink.ownershipClaimId
          })
        ])
      );
      expect(contractMapping.evidenceClaims).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: gasLink.ownershipClaimId,
            factKind: "object_ownership",
            objectId: gasLink.objectId,
            ownership: "owned_by_account"
          })
        ])
      );
    }
  });

  it("verifies gas and shared object ownership from stored transaction material", async () => {
    const materialStore = new InMemoryLocalTransactionMaterialStore();
    const material = await recordTransactionMaterial({
      materialStore,
      transactionBytes: await buildTransactionBytes({ includeSharedObject: true })
    });
    const producer = createTransactionObjectOwnershipProducer({
      materialStore,
      objectSource: objectSource({
        [gasObjectId]: { owner: { $kind: "AddressOwner", AddressOwner: account }, type: suiCoinObjectType },
        [sharedObjectId]: { owner: { $kind: "Shared", Shared: { initialSharedVersion: "1" } }, type: sharedObjectType }
      }),
      network: "mainnet",
      chainIdentifier,
      expectedChainIdentifier: chainIdentifier
    });

    const outcome = await producer({
      materialHandle: material.handle,
      materialDigest: material.digest,
      now: new Date("2026-05-15T00:00:29.500Z")
    });

    expect(outcome).toMatchObject({
      status: "completed",
      evidence: {
        evidenceVersion: "transaction-object-ownership-v2",
      funding: testObjectFunding(account),
        materialId: material.handle.materialId,
        account,
        transactionDigest: material.digest.transactionDigest,
        objectCount: 2
      },
      checks: [
        {
          id: "transaction_object_ownership_verified",
          status: "pass",
          source: "wallet"
        }
      ]
    });
    if (outcome.status !== "completed") {
      throw new Error("object ownership producer did not complete");
    }
    expect(outcome.evidence.objects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          objectId: gasObjectId,
          roles: ["gas_object"],
          ownership: "owned_by_account",
          ownerKind: "AddressOwner",
          ownerAccount: account,
          objectType: expect.stringContaining("::coin::Coin<")
        }),
        expect.objectContaining({
          objectId: sharedObjectId,
          roles: ["shared_object"],
          ownership: "shared_object",
          ownerKind: "Shared",
          objectType: expect.stringContaining("::clock::Clock")
        })
      ])
    );
    expect(JSON.stringify(outcome.evidence)).not.toContain("transactionBytes");

    const contractMapping = mapTransactionObjectOwnershipEvidenceToContractDraft(outcome.evidence);
    expect(contractMapping).toMatchObject({
      status: "mapped",
      objectOwnership: {
        ownerAccount: account,
        objects: expect.arrayContaining([
          expect.objectContaining({
            objectId: gasObjectId,
            role: "gas_coin",
            ownership: "owned_by_account"
          }),
          expect.objectContaining({
            objectId: sharedObjectId,
            role: "shared_object",
            ownership: "shared_object"
          })
        ])
      },
      evidenceClaims: expect.arrayContaining([
        expect.objectContaining({
          factKind: "object_ownership",
          objectId: gasObjectId,
          ownership: "owned_by_account"
        }),
        expect.objectContaining({
          factKind: "object_ownership",
          objectId: sharedObjectId,
          ownership: "shared_object"
        })
      ])
    });
    if (contractMapping.status !== "mapped") {
      throw new Error("ownership evidence was not contract-mappable");
    }
    expect(contractMapping.gasObjectOwnershipLinks).toEqual([
      expect.objectContaining({
        objectId: gasObjectId,
        ownerAccount: account,
        ownershipClaimId: expect.any(String)
      })
    ]);
    expect(contractMapping.evidenceClaims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: contractMapping.gasObjectOwnershipLinks[0]?.ownershipClaimId,
          factKind: "object_ownership",
          objectId: gasObjectId,
          ownership: "owned_by_account"
        })
      ])
    );
  });

  it("fails closed when the gas object is not owned by the connected account", async () => {
    const materialStore = new InMemoryLocalTransactionMaterialStore();
    const material = await recordTransactionMaterial({
      materialStore,
      transactionBytes: await buildTransactionBytes()
    });
    const producer = createTransactionObjectOwnershipProducer({
      materialStore,
      objectSource: objectSource({
        [gasObjectId]: { owner: { $kind: "AddressOwner", AddressOwner: otherAccount }, type: suiCoinObjectType }
      }),
      network: "mainnet",
      chainIdentifier,
      expectedChainIdentifier: chainIdentifier
    });

    const outcome = await producer({
      materialHandle: material.handle,
      materialDigest: material.digest,
      now: new Date("2026-05-15T00:00:29.500Z")
    });

    expect(outcome).toMatchObject({
      status: "blocked",
      blockedReason: "object_resolution_failed",
      checks: [{ id: "transaction_object_ownership_unverified", status: "fail" }]
    });
  });

  it("fails closed when the gas object is not a SUI coin", async () => {
    const materialStore = new InMemoryLocalTransactionMaterialStore();
    const material = await recordTransactionMaterial({
      materialStore,
      transactionBytes: await buildTransactionBytes({ includeSharedObject: true })
    });
    const producer = createTransactionObjectOwnershipProducer({
      materialStore,
      objectSource: objectSource({
        [gasObjectId]: { owner: { $kind: "AddressOwner", AddressOwner: account }, type: usdcCoinObjectType },
        [sharedObjectId]: { owner: { $kind: "Shared", Shared: { initialSharedVersion: "1" } }, type: sharedObjectType }
      }),
      network: "mainnet",
      chainIdentifier,
      expectedChainIdentifier: chainIdentifier
    });

    const outcome = await producer({
      materialHandle: material.handle,
      materialDigest: material.digest,
      now: new Date("2026-05-15T00:00:29.500Z")
    });

    expect(outcome).toMatchObject({
      status: "blocked",
      blockedReason: "object_resolution_failed",
      checks: [{ id: "transaction_object_ownership_contract_mapping_unsupported", status: "fail" }]
    });
  });

  it("does not treat a gas-only object set as complete contract-mappable ownership", async () => {
    const materialStore = new InMemoryLocalTransactionMaterialStore();
    const material = await recordTransactionMaterial({
      materialStore,
      transactionBytes: await buildTransactionBytes()
    });
    const producer = createTransactionObjectOwnershipProducer({
      materialStore,
      objectSource: objectSource({
        [gasObjectId]: { owner: { $kind: "AddressOwner", AddressOwner: account }, type: suiCoinObjectType }
      }),
      network: "mainnet",
      chainIdentifier,
      expectedChainIdentifier: chainIdentifier
    });

    const outcome = await producer({
      materialHandle: material.handle,
      materialDigest: material.digest,
      now: new Date("2026-05-15T00:00:29.500Z")
    });

    expect(outcome).toMatchObject({
      status: "blocked",
      blockedReason: "object_resolution_failed",
      checks: [{ id: "transaction_object_ownership_contract_mapping_unsupported", status: "fail" }]
    });
  });

  it("accepts immutable refs that the pinned SDK represents as ImmOrOwnedObject inputs", async () => {
    const materialStore = new InMemoryLocalTransactionMaterialStore();
    const material = await recordTransactionMaterial({
      materialStore,
      transactionBytes: await buildTransactionBytes({ includeImmutableObject: true })
    });
    const producer = createTransactionObjectOwnershipProducer({
      materialStore,
      objectSource: objectSource({
        [gasObjectId]: { owner: { $kind: "AddressOwner", AddressOwner: account }, type: suiCoinObjectType },
        [immutableObjectId]: { owner: { $kind: "Immutable", Immutable: true }, type: immutableObjectType }
      }),
      network: "mainnet",
      chainIdentifier,
      expectedChainIdentifier: chainIdentifier
    });

    const outcome = await producer({
      materialHandle: material.handle,
      materialDigest: material.digest,
      now: new Date("2026-05-15T00:00:29.500Z")
    });

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") {
      throw new Error("object ownership producer did not complete");
    }
    expect(outcome.evidence.objects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          objectId: immutableObjectId,
          roles: ["imm_or_owned_object"],
          ownership: "immutable_object",
          ownerKind: "Immutable"
        })
      ])
    );
  });

  it("does not accept object owner evidence for a different object id", async () => {
    const materialStore = new InMemoryLocalTransactionMaterialStore();
    const material = await recordTransactionMaterial({
      materialStore,
      transactionBytes: await buildTransactionBytes()
    });
    const producer = createTransactionObjectOwnershipProducer({
      materialStore,
      objectSource: {
        async getObject() {
          return {
            object: {
              objectId: sharedObjectId,
              owner: { $kind: "AddressOwner", AddressOwner: account },
              type: suiCoinObjectType
            }
          };
        }
      },
      network: "mainnet",
      chainIdentifier,
      expectedChainIdentifier: chainIdentifier
    });

    const outcome = await producer({
      materialHandle: material.handle,
      materialDigest: material.digest,
      now: new Date("2026-05-15T00:00:29.500Z")
    });

    expect(outcome).toMatchObject({
      status: "blocked",
      blockedReason: "object_resolution_failed",
      checks: [{ id: "transaction_object_ownership_read_failed", status: "fail" }]
    });
  });

  it("does not trust a digest that is not derived from the stored bytes", async () => {
    const materialStore = new InMemoryLocalTransactionMaterialStore();
    const material = await recordTransactionMaterial({
      materialStore,
      transactionBytes: await buildTransactionBytes()
    });
    const producer = createTransactionObjectOwnershipProducer({
      materialStore,
      objectSource: objectSource({
        [gasObjectId]: { owner: { $kind: "AddressOwner", AddressOwner: account }, type: suiCoinObjectType }
      }),
      network: "mainnet",
      chainIdentifier,
      expectedChainIdentifier: chainIdentifier
    });

    const outcome = await producer({
      materialHandle: material.handle,
      materialDigest: {
        ...material.digest,
        transactionDigest: "1".repeat(32)
      },
      now: new Date("2026-05-15T00:00:29.500Z")
    });

    expect(outcome).toMatchObject({
      status: "blocked",
      blockedReason: "object_resolution_failed",
      checks: [{ id: "transaction_object_ownership_material_unavailable", status: "fail" }]
    });
  });

  it("maps owned ImmOrOwnedObject coin refs to contract input coins", async () => {
    const materialStore = new InMemoryLocalTransactionMaterialStore();
    const material = await recordTransactionMaterial({
      materialStore,
      transactionBytes: await buildTransactionBytes({ includeImmutableObject: true })
    });
    const producer = createTransactionObjectOwnershipProducer({
      materialStore,
      objectSource: objectSource({
        [gasObjectId]: { owner: { $kind: "AddressOwner", AddressOwner: account }, type: suiCoinObjectType },
        [immutableObjectId]: { owner: { $kind: "AddressOwner", AddressOwner: account }, type: usdcCoinObjectType }
      }),
      network: "mainnet",
      chainIdentifier,
      expectedChainIdentifier: chainIdentifier
    });

    const outcome = await producer({
      materialHandle: material.handle,
      materialDigest: material.digest,
      now: new Date("2026-05-15T00:00:29.500Z")
    });

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") {
      throw new Error("object ownership producer did not complete");
    }
    expect(mapTransactionObjectOwnershipEvidenceToContractDraft(outcome.evidence)).toMatchObject({
      status: "mapped",
      objectOwnership: {
        objects: expect.arrayContaining([
          expect.objectContaining({
            objectId: immutableObjectId,
            role: "input_coin",
            ownership: "owned_by_account"
          })
        ])
      }
    });
  });

  it("fails closed when an owned ImmOrOwnedObject is not a coin object", async () => {
    const materialStore = new InMemoryLocalTransactionMaterialStore();
    const material = await recordTransactionMaterial({
      materialStore,
      transactionBytes: await buildTransactionBytes({ includeImmutableObject: true })
    });
    const producer = createTransactionObjectOwnershipProducer({
      materialStore,
      objectSource: objectSource({
        [gasObjectId]: { owner: { $kind: "AddressOwner", AddressOwner: account }, type: suiCoinObjectType },
        [immutableObjectId]: { owner: { $kind: "AddressOwner", AddressOwner: account }, type: nonCoinObjectType }
      }),
      network: "mainnet",
      chainIdentifier,
      expectedChainIdentifier: chainIdentifier
    });

    const outcome = await producer({
      materialHandle: material.handle,
      materialDigest: material.digest,
      now: new Date("2026-05-15T00:00:29.500Z")
    });

    expect(outcome).toMatchObject({
      status: "blocked",
      blockedReason: "object_resolution_failed",
      checks: [{ id: "transaction_object_ownership_contract_mapping_unsupported", status: "fail" }]
    });
  });

  it("fails closed when object type evidence is missing", async () => {
    const materialStore = new InMemoryLocalTransactionMaterialStore();
    const material = await recordTransactionMaterial({
      materialStore,
      transactionBytes: await buildTransactionBytes()
    });
    const producer = createTransactionObjectOwnershipProducer({
      materialStore,
      objectSource: {
        async getObject(input) {
          return {
            object: {
              objectId: input.objectId,
              owner: { $kind: "AddressOwner", AddressOwner: account },
              type: undefined
            }
          } as never;
        }
      },
      network: "mainnet",
      chainIdentifier,
      expectedChainIdentifier: chainIdentifier
    });

    const outcome = await producer({
      materialHandle: material.handle,
      materialDigest: material.digest,
      now: new Date("2026-05-15T00:00:29.500Z")
    });

    expect(outcome).toMatchObject({
      status: "blocked",
      blockedReason: "object_resolution_failed",
      checks: [{ id: "transaction_object_ownership_read_failed", status: "fail" }]
    });
  });

  it("does not map owned ImmOrOwnedObject refs to contract input coins without coin object type evidence", async () => {
    const evidence: TransactionObjectOwnershipEvidence = {
      evidenceVersion: "transaction-object-ownership-v2",
      funding: testObjectFunding(account),
      materialId: "txmat_test",
      reviewSessionId: "review_1",
      planId: "plan_1",
      account,
      transactionDigest: "1".repeat(32),
      objectCount: 1,
      objects: [
        {
          objectId: immutableObjectId,
          roles: ["imm_or_owned_object"],
          ownership: "owned_by_account",
          ownerKind: "AddressOwner",
          ownerAccount: account,
          objectType: nonCoinObjectType,
          source: "stored_transaction_data_and_mainnet_object_read"
        }
      ],
      verifiedAt: "2026-05-15T00:00:29.500Z",
      expiresAt: "2026-05-15T00:30:29.000Z"
    };

    expect(mapTransactionObjectOwnershipEvidenceToContractDraft(evidence)).toMatchObject({
      status: "unsupported",
      objectId: immutableObjectId,
      roles: ["imm_or_owned_object"],
      ownership: "owned_by_account",
      reason: expect.stringMatching(/Coin<T>/i)
    });
  });

  it("requires the object read source to match the verified mainnet chain", async () => {
    const materialStore = new InMemoryLocalTransactionMaterialStore();
    const material = await recordTransactionMaterial({
      materialStore,
      transactionBytes: await buildTransactionBytes()
    });
    const producer = createTransactionObjectOwnershipProducer({
      materialStore,
      objectSource: objectSource({
        [gasObjectId]: { owner: { $kind: "AddressOwner", AddressOwner: account }, type: suiCoinObjectType }
      }),
      network: "mainnet",
      chainIdentifier: "wrong-chain",
      expectedChainIdentifier: chainIdentifier
    });

    const outcome = await producer({
      materialHandle: material.handle,
      materialDigest: material.digest,
      now: new Date("2026-05-15T00:00:29.500Z")
    });

    expect(outcome).toMatchObject({
      status: "blocked",
      blockedReason: "network_mismatch",
      checks: [{ id: "transaction_object_ownership_network_mismatch", status: "fail" }]
    });
  });

  it("requires live stored material before reading object owners", async () => {
    const materialStore = new InMemoryLocalTransactionMaterialStore();
    const material = await recordTransactionMaterial({
      materialStore,
      transactionBytes: await buildTransactionBytes(),
      expiresAt: new Date("2026-05-15T00:00:30.000Z")
    });
    const producer = createTransactionObjectOwnershipProducer({
      materialStore,
      objectSource: objectSource({
        [gasObjectId]: { owner: { $kind: "AddressOwner", AddressOwner: account }, type: suiCoinObjectType }
      }),
      network: "mainnet",
      chainIdentifier,
      expectedChainIdentifier: chainIdentifier
    });

    const outcome = await producer({
      materialHandle: material.handle,
      materialDigest: material.digest,
      now: new Date("2026-05-15T00:00:30.000Z")
    });

    expect(outcome).toMatchObject({
      status: "refresh_required",
      refreshReason: "quote_stale",
      checks: [{ id: "transaction_object_ownership_material_unavailable", status: "fail" }]
    });
  });
});

async function buildTransactionBytes(input: {
  includeSharedObject?: boolean | undefined;
  includeImmutableObject?: boolean | undefined;
} = {}): Promise<Uint8Array> {
  const transaction = new Transaction();
  transaction.setSender(account);
  transaction.setGasBudget(1000);
  transaction.setGasPrice(1);
  transaction.setGasPayment([
    {
      objectId: gasObjectId,
      version: "1",
      digest: "7".repeat(44)
    }
  ]);

  if (input.includeSharedObject) {
    const shared = transaction.object(
      Inputs.SharedObjectRef({
        objectId: sharedObjectId,
        initialSharedVersion: "1",
        mutable: false
      })
    );
    transaction.moveCall({
      target: "0x2::clock::timestamp_ms",
      arguments: [shared]
    });
  }

  if (input.includeImmutableObject) {
    const immutable = transaction.object(
      Inputs.ObjectRef({
        objectId: immutableObjectId,
        version: "1",
        digest: "8".repeat(44)
      })
    );
    transaction.moveCall({
      target: "0x2::object::id",
      arguments: [immutable]
    });
  }

  return transaction.build();
}

async function recordTransactionMaterial(input: {
  materialStore: InMemoryLocalTransactionMaterialStore;
  transactionBytes: Uint8Array;
  expiresAt?: Date | undefined;
}): Promise<{
  handle: ReturnType<InMemoryLocalTransactionMaterialStore["recordTransactionMaterial"]>;
  digest: LocalTransactionMaterialDigestCommitment;
}> {
  const now = new Date("2026-05-15T00:00:29.000Z");
  const handle = input.materialStore.recordTransactionMaterial(
    {
      reviewSessionId: "review_1",
      planId: "plan_1",
      account,
      kind: "deepbook_swap_transaction_data",
      source: "sui_mcp_built",
      transactionBytes: input.transactionBytes,
      expiresAt: input.expiresAt ?? new Date("2026-05-15T00:30:29.000Z")
    },
    now
  );
  return {
    handle,
    digest: {
      materialId: handle.materialId,
      reviewSessionId: handle.reviewSessionId,
      planId: handle.planId,
      account: handle.account,
      kind: handle.kind,
      source: handle.source,
      digestKind: "sui_transaction_digest",
      transactionDigest: await Transaction.from(input.transactionBytes).getDigest(),
      computedAt: now.toISOString(),
      expiresAt: handle.expiresAt
    }
  };
}

function objectSourceForStoredBytes(
  transactionBytes: Uint8Array
): Record<string, {
  owner: Awaited<ReturnType<TransactionObjectOwnershipObjectSource["getObject"]>>["object"]["owner"];
  type: string;
}> {
  const transaction = Transaction.from(transactionBytes);
  const data = transaction.getData();
  const objects: Record<string, {
    owner: Awaited<ReturnType<TransactionObjectOwnershipObjectSource["getObject"]>>["object"]["owner"];
    type: string;
  }> = {};
  for (const payment of data.gasData.payment ?? []) {
    objects[payment.objectId] = {
      owner: { $kind: "AddressOwner", AddressOwner: account },
      type: suiCoinObjectType
    };
  }
  for (const input of data.inputs) {
    const inputKind = enumKind(input, [
      "Object",
      "Pure",
      "UnresolvedPure",
      "UnresolvedObject",
      "FundsWithdrawal"
    ]);
    if (inputKind !== "Object") {
      continue;
    }
    const objectInput = (input as { Object?: unknown }).Object;
    const objectKind = enumKind(objectInput, [
      "ImmOrOwnedObject",
      "SharedObject",
      "Receiving"
    ]);
    if (objectKind === "ImmOrOwnedObject") {
      objects[readObjectId((objectInput as { ImmOrOwnedObject?: unknown }).ImmOrOwnedObject)] = {
        owner: { $kind: "AddressOwner", AddressOwner: account },
        type: usdcCoinObjectType
      };
    } else if (objectKind === "SharedObject") {
      objects[readObjectId((objectInput as { SharedObject?: unknown }).SharedObject)] = {
        owner: { $kind: "Shared", Shared: { initialSharedVersion: "1" } },
        type: sharedObjectType
      };
    } else if (objectKind === "Receiving") {
      objects[readObjectId((objectInput as { Receiving?: unknown }).Receiving)] = {
        owner: { $kind: "AddressOwner", AddressOwner: account },
        type: usdcCoinObjectType
      };
    }
  }
  return objects;
}

function objectSource(
  objects: Record<string, {
    owner: Awaited<ReturnType<TransactionObjectOwnershipObjectSource["getObject"]>>["object"]["owner"];
    type: string;
  }>
): TransactionObjectOwnershipObjectSource {
  return {
    async getObject(input) {
      const object = objects[input.objectId];
      if (!object) {
        throw new Error(`missing object owner for ${input.objectId}`);
      }
      return {
        object: {
          objectId: input.objectId,
          owner: object.owner,
          type: object.type
        }
      };
    }
  };
}

function enumKind(value: unknown, allowedKinds: readonly string[]): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  if ("$kind" in value) {
    return typeof value.$kind === "string" && allowedKinds.includes(value.$kind)
      ? value.$kind
      : undefined;
  }
  const matchingKeys = allowedKinds.filter((kind) => kind in value);
  return matchingKeys.length === 1 ? matchingKeys[0] : undefined;
}

function readObjectId(value: unknown): string {
  if (typeof value !== "object" || value === null || typeof (value as { objectId?: unknown }).objectId !== "string") {
    throw new Error("test transaction object ref is missing objectId");
  }
  return (value as { objectId: string }).objectId;
}
