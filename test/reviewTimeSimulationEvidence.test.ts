import { GrpcTypes } from "@mysten/sui/grpc";
import { withGrpcSimulation } from "./fixtures/reviewTimeSimulation.js";
import { describe, expect, it } from "vitest";
import {
  createReviewTimeSimulationProducer,
  publicTransactionSimulationSummaryFromEvidence,
  verifyReviewTimeSimulationEvidence
} from "../src/core/action/reviewTimeSimulationEvidence.js";
import { InMemoryLocalTransactionMaterialStore } from "../src/core/session/transactionMaterialStore.js";
import { recordTestTransactionMaterial } from "./fixtures/transactionMaterial.js";
import {
  createFailedReviewTimeSimulationClient,
  createSuccessfulReviewTimeSimulationClient
} from "./fixtures/reviewTimeSimulation.js";

const account = `0x${"a".repeat(64)}`;
const chainIdentifier = "mainnet-chain";

describe("review-time simulation evidence", () => {
  it("simulates stored transaction material with required fields and keeps public summary redacted", async () => {
    const materialStore = new InMemoryLocalTransactionMaterialStore();
    const material = await recordTestTransactionMaterial({
      materialStore,
      reviewSessionId: "review_1",
      planId: "plan_1",
      account,
      now: new Date("2026-06-06T00:00:00.000Z"),
      computedAt: new Date("2026-06-06T00:00:01.000Z"),
      expiresAt: new Date("2026-06-06T00:30:00.000Z")
    });
    const client = createSuccessfulReviewTimeSimulationClient(account);
    const producer = createReviewTimeSimulationProducer({
      client,
      materialStore,
      network: "mainnet",
      chainIdentifier,
      expectedChainIdentifier: chainIdentifier
    });

    const outcome = await producer({
      transactionMaterial: material.handle,
      transactionMaterialDigest: material.digest,
      now: new Date("2026-06-06T00:00:02.000Z")
    });

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") {
      throw new Error("simulation producer did not complete");
    }
    expect(client.calls[0]).toMatchObject({
      include: {
        transaction: true,
        effects: true,
        balanceChanges: true,
        objectTypes: true
      },
      checksEnabled: true
    });
    expect(client.rpcCalls[0]).toMatchObject({ checks: 0, doGasSelection: true,
      readMask: { paths: expect.arrayContaining(["transaction.transaction.bcs", "transaction.effects", "transaction.balance_changes", "transaction.objects.objects.object_type"]) } });
    expect(client.rpcCalls[0]?.transaction?.bcs?.value).toEqual(materialStore.getTransactionMaterial(material.handle, new Date(material.handle.createdAt))!.transactionBytes);
    expect(outcome.evidence).toMatchObject({
      evidenceVersion: "review-time-simulation-v2",
      materialId: material.handle.materialId,
      transactionDigest: material.digest.transactionDigest,
      provider: "client.transactionExecutionService.simulateTransaction",
      checksEnabled: true,
      status: "success",
      requiredFields: ["effects", "balanceChanges", "objectTypes", "transaction"],
      missingFields: [],
      effects: {
        transactionDigest: material.digest.transactionDigest,
        gasCostSummary: {
          computationCostRaw: "100",
          storageCostRaw: "50",
          storageRebateRaw: "20",
          nonRefundableStorageFeeRaw: "0"
        }
      }
    });
    expect(verifyReviewTimeSimulationEvidence({
        transactionBytes: materialStore.getTransactionMaterial(material.handle, new Date(material.handle.createdAt))!.transactionBytes,
      transactionMaterial: material.handle,
      transactionMaterialDigest: material.digest,
      evidence: outcome.evidence,
      now: new Date("2026-06-06T00:00:03.000Z")
    })).toEqual(outcome.evidence);
    const publicSummary = publicTransactionSimulationSummaryFromEvidence(outcome.evidence);
    expect(publicSummary).toMatchObject({
      provider: "client.transactionExecutionService.simulateTransaction",
      checksEnabled: true,
      success: true,
      gasCostSummary: {
        computationCostRaw: "100",
        storageCostRaw: "50",
        storageRebateRaw: "20",
        nonRefundableStorageFeeRaw: "0"
      }
    });
    expect(JSON.stringify(publicSummary)).not.toContain("transactionBytes");
    expect(JSON.stringify(publicSummary)).not.toContain(material.handle.materialId);
    expect(JSON.stringify(publicSummary)).not.toContain(material.digest.transactionDigest);
  });

  it("fails closed before simulation when the mainnet identity is not verified", async () => {
    const materialStore = new InMemoryLocalTransactionMaterialStore();
    const material = await recordTestTransactionMaterial({
      materialStore,
      reviewSessionId: "review_1",
      planId: "plan_1",
      account,
      now: new Date("2026-06-06T00:00:00.000Z"),
      computedAt: new Date("2026-06-06T00:00:01.000Z"),
      expiresAt: new Date("2026-06-06T00:30:00.000Z")
    });
    const client = createSuccessfulReviewTimeSimulationClient(account);
    const producer = createReviewTimeSimulationProducer({
      client,
      materialStore,
      network: "mainnet",
      chainIdentifier: "wrong-chain",
      expectedChainIdentifier: chainIdentifier
    });

    const outcome = await producer({
      transactionMaterial: material.handle,
      transactionMaterialDigest: material.digest,
      now: new Date("2026-06-06T00:00:02.000Z")
    });

    expect(outcome).toMatchObject({
      status: "blocked",
      blockedReason: "network_mismatch",
      checks: [{ id: "review_time_simulation_network_mismatch", status: "fail" }]
    });
    expect(client.calls).toHaveLength(0);
  });

  it("blocks deterministic failed simulation results instead of marking them refreshable", async () => {
    const materialStore = new InMemoryLocalTransactionMaterialStore();
    const material = await recordTestTransactionMaterial({
      materialStore,
      reviewSessionId: "review_1",
      planId: "plan_1",
      account,
      now: new Date("2026-06-06T00:00:00.000Z"),
      computedAt: new Date("2026-06-06T00:00:01.000Z"),
      expiresAt: new Date("2026-06-06T00:30:00.000Z")
    });
    const producer = createReviewTimeSimulationProducer({
      client: createFailedReviewTimeSimulationClient("MoveAbort stale min-out"),
      materialStore,
      network: "mainnet",
      chainIdentifier,
      expectedChainIdentifier: chainIdentifier
    });

    const outcome = await producer({
      transactionMaterial: material.handle,
      transactionMaterialDigest: material.digest,
      now: new Date("2026-06-06T00:00:02.000Z")
    });

    expect(outcome).toMatchObject({
      status: "blocked",
      blockedReason: "object_resolution_failed",
      checks: [{ id: "review_time_simulation_result_failed", status: "fail",
        message: "Review-time simulation did not succeed: The checked simulation rejected the transaction. No transaction was signed or submitted." }]
    });
  });

  it.each([
    [GrpcTypes.ExecutionError_ExecutionErrorKind.INSUFFICIENT_GAS, "insufficient_gas", "gas"],
    [GrpcTypes.ExecutionError_ExecutionErrorKind.INSUFFICIENT_COIN_BALANCE, "insufficient_balance", "coin balance"]
  ] as const)("classifies explicit failed simulation kind %s from its typed source", async (kind, blockedReason, asset) => {
    const materialStore = new InMemoryLocalTransactionMaterialStore();
    const material = await recordTestTransactionMaterial({
      materialStore,
      reviewSessionId: "review_1",
      planId: "plan_1",
      account,
      now: new Date("2026-06-06T00:00:00.000Z"),
      computedAt: new Date("2026-06-06T00:00:01.000Z"),
      expiresAt: new Date("2026-06-06T00:30:00.000Z")
    });
    const producer = createReviewTimeSimulationProducer({
      client: createFailedReviewTimeSimulationClient("private node description", kind),
      materialStore,
      network: "mainnet",
      chainIdentifier,
      expectedChainIdentifier: chainIdentifier
    });

    const outcome = await producer({
      transactionMaterial: material.handle,
      transactionMaterialDigest: material.digest,
      now: new Date("2026-06-06T00:00:02.000Z")
    });

    expect(outcome).toMatchObject({
      status: "blocked",
      blockedReason,
      checks: [{ id: "review_time_simulation_result_failed", status: "fail",
        message: `Review-time simulation did not succeed: The checked simulation reported insufficient ${asset}.` }]
    });
  });

  it.each([
    "transaction", "effects", "status", "success", "non_boolean_success",
    "gasUsed", "computationCost", "storageCost", "storageRebate", "nonRefundableStorageFee",
    "changedObjects_deleted_after_decode"
  ] as const)("blocks incomplete or malformed %s without claiming transaction rejection", async (fault) => {
    const materialStore = new InMemoryLocalTransactionMaterialStore();
    const material = await recordTestTransactionMaterial({
      materialStore, reviewSessionId: "review_1", planId: "plan_1", account,
      now: new Date("2026-06-06T00:00:00.000Z"),
      expiresAt: new Date("2026-06-06T00:30:00.000Z")
    });
    const client = createSuccessfulReviewTimeSimulationClient(account);
    const simulate = client.transactionExecutionService.simulateTransaction;
    client.transactionExecutionService.simulateTransaction = async (request) => {
      // Mutate only the returned gRPC source, after the valid fixture is built.
      const result = await simulate(request);
      const tx = result.response.transaction!;
      switch (fault) {
        case "transaction": delete result.response.transaction; break;
        case "effects": delete tx.effects; break;
        case "status": delete tx.effects!.status; break;
        case "success": delete tx.effects!.status!.success; break;
        case "non_boolean_success": tx.effects!.status!.success = "false" as never; break;
        case "gasUsed": delete tx.effects!.gasUsed; break;
        case "changedObjects_deleted_after_decode":
          // Real protobuf omission decodes to []; this models a malformed JS source.
          Reflect.deleteProperty(tx.effects!, "changedObjects"); break;
        default: delete tx.effects!.gasUsed![fault];
      }
      return result;
    };
    const outcome = await createReviewTimeSimulationProducer({
      client, materialStore, network: "mainnet", chainIdentifier, expectedChainIdentifier: chainIdentifier
    })({ transactionMaterial: material.handle, transactionMaterialDigest: material.digest,
      now: new Date("2026-06-06T00:00:02.000Z") });

    expect(client.rpcCalls).toHaveLength(1);
    expect(outcome).toEqual({
      status: "blocked", blockedReason: "object_resolution_failed",
      checks: [{ id: "review_time_simulation_result_invalid", label: "Review-time simulation", status: "fail",
        message: "Review-time simulation returned incomplete or unverifiable evidence. Nothing was signed or submitted.",
        source: "simulation" }]
    });
  });

  it.each([["guard", true], ["pool", true], ["different_digest", false], ["different_command", false]] as const)(
    "qualifies the minimum failure against returned effects and bytes for %s", async (scenario, expected) => {
    const materialStore = new InMemoryLocalTransactionMaterialStore(), now = new Date("2026-06-06T00:00:00.000Z");
    const material = await recordTestTransactionMaterial({ materialStore, reviewSessionId: "review_1", planId: "plan_1", account, now, expiresAt: new Date(now.getTime() + 30000) });
    const guard = { commandFailure: "InsufficientCoinBalance" as const, commandIndex: 3, transactionDigest: material.digest.transactionDigest,
      protocolAbort: { commandIndex: 2, packageId: account, moduleOrigin: account, module: "pool", code: "12" } };
    const source = createFailedReviewTimeSimulationClient();
    const producer = createReviewTimeSimulationProducer({ materialStore, network: "mainnet", chainIdentifier, expectedChainIdentifier: chainIdentifier,
      client: { transactionExecutionService: { async simulateTransaction(request) {
        const result = await source.transactionExecutionService.simulateTransaction(request);
        const tx = result.response.transaction!, effects = tx.effects!;
        if (scenario === "different_digest") effects.transactionDigest = "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR";
        tx.transaction = GrpcTypes.Transaction.create({ bcs: { value: request.transaction!.bcs!.value! } });
        effects.status!.error = GrpcTypes.ExecutionError.create(scenario === "pool" ? {
          command: 2n, kind: GrpcTypes.ExecutionError_ExecutionErrorKind.MOVE_ABORT,
          errorDetails: { oneofKind: "abort", abort: { location: { package: account, module: "pool" }, abortCode: 12n } }
        } : { command: scenario === "different_command" ? 1n : 3n, kind: GrpcTypes.ExecutionError_ExecutionErrorKind.INSUFFICIENT_COIN_BALANCE });
        return result;
      } } } });
    const outcome = await producer({ transactionMaterial: material.handle, transactionMaterialDigest: material.digest, now,
      minimumOutputGuard: guard });
    expect(outcome.status).toBe(expected ? "refresh_required" : "blocked");
    expect(outcome.checks[0]?.id).toBe(expected ? "minimum_output_not_met" : "review_time_simulation_result_failed");
  });

  it("marks transport-level thrown simulation calls as transient refresh-required failures", async () => {
    const materialStore = new InMemoryLocalTransactionMaterialStore();
    const material = await recordTestTransactionMaterial({
      materialStore,
      reviewSessionId: "review_1",
      planId: "plan_1",
      account,
      now: new Date("2026-06-06T00:00:00.000Z"),
      computedAt: new Date("2026-06-06T00:00:01.000Z"),
      expiresAt: new Date("2026-06-06T00:30:00.000Z")
    });
    const producer = createReviewTimeSimulationProducer({
      client: withGrpcSimulation({
        core: {
          async simulateTransaction() {
            throw new Error("gRPC unavailable");
          }
        }
      }),
      materialStore,
      network: "mainnet",
      chainIdentifier,
      expectedChainIdentifier: chainIdentifier
    });

    const outcome = await producer({
      transactionMaterial: material.handle,
      transactionMaterialDigest: material.digest,
      now: new Date("2026-06-06T00:00:02.000Z")
    });

    expect(outcome).toMatchObject({
      status: "refresh_required",
      refreshReason: "simulation_transient_failure",
      checks: [{ id: "review_time_simulation_transient_failure", status: "fail" }]
    });
  });

  it("blocks non-transient thrown simulation calls instead of marking them refreshable", async () => {
    const materialStore = new InMemoryLocalTransactionMaterialStore();
    const material = await recordTestTransactionMaterial({
      materialStore,
      reviewSessionId: "review_1",
      planId: "plan_1",
      account,
      now: new Date("2026-06-06T00:00:00.000Z"),
      computedAt: new Date("2026-06-06T00:00:01.000Z"),
      expiresAt: new Date("2026-06-06T00:30:00.000Z")
    });
    const producer = createReviewTimeSimulationProducer({
      client: withGrpcSimulation({
        core: {
          async simulateTransaction() {
            throw new Error("invalid simulateTransaction request shape");
          }
        }
      }),
      materialStore,
      network: "mainnet",
      chainIdentifier,
      expectedChainIdentifier: chainIdentifier
    });

    const outcome = await producer({
      transactionMaterial: material.handle,
      transactionMaterialDigest: material.digest,
      now: new Date("2026-06-06T00:00:02.000Z")
    });

    expect(outcome).toMatchObject({
      status: "blocked",
      blockedReason: "object_resolution_failed",
      checks: [{ id: "review_time_simulation_exception_blocked", status: "fail" }]
    });
  });

  it("rejects successful simulation responses that omit required included fields", async () => {
    const materialStore = new InMemoryLocalTransactionMaterialStore();
    const material = await recordTestTransactionMaterial({
      materialStore,
      reviewSessionId: "review_1",
      planId: "plan_1",
      account,
      now: new Date("2026-06-06T00:00:00.000Z"),
      computedAt: new Date("2026-06-06T00:00:01.000Z"),
      expiresAt: new Date("2026-06-06T00:30:00.000Z")
    });
    const baseClient = createSuccessfulReviewTimeSimulationClient(account);
    const producer = createReviewTimeSimulationProducer({
      client: withGrpcSimulation({
        core: {
          async simulateTransaction(options) {
            const result = await baseClient.core.simulateTransaction(options);
            if (result.$kind !== "Transaction") {
              return result;
            }
            return {
              ...result,
              Transaction: {
                ...result.Transaction,
                objectTypes: undefined as never
              }
            };
          }
        }
      }),
      materialStore,
      network: "mainnet",
      chainIdentifier,
      expectedChainIdentifier: chainIdentifier
    });

    const outcome = await producer({
      transactionMaterial: material.handle,
      transactionMaterialDigest: material.digest,
      now: new Date("2026-06-06T00:00:02.000Z")
    });

    expect(outcome).toMatchObject({
      status: "blocked",
      blockedReason: "object_resolution_failed",
      checks: [{ id: "review_time_simulation_result_invalid", status: "fail" }]
    });
  });

  it("rejects non-canonical signed balance delta amounts from simulation results", async () => {
    const materialStore = new InMemoryLocalTransactionMaterialStore();
    const material = await recordTestTransactionMaterial({
      materialStore,
      reviewSessionId: "review_1",
      planId: "plan_1",
      account,
      now: new Date("2026-06-06T00:00:00.000Z"),
      computedAt: new Date("2026-06-06T00:00:01.000Z"),
      expiresAt: new Date("2026-06-06T00:30:00.000Z")
    });
    const baseClient = createSuccessfulReviewTimeSimulationClient(account);
    const producer = createReviewTimeSimulationProducer({
      client: withGrpcSimulation({
        core: {
          async simulateTransaction(options) {
            const result = await baseClient.core.simulateTransaction(options);
            if (result.$kind !== "Transaction") {
              return result;
            }
            return {
              ...result,
              Transaction: {
                ...result.Transaction,
                balanceChanges: result.Transaction.balanceChanges.map((change) => ({
                  ...change,
                  amount: "-0"
                }))
              }
            };
          }
        }
      }),
      materialStore,
      network: "mainnet",
      chainIdentifier,
      expectedChainIdentifier: chainIdentifier
    });

    const outcome = await producer({
      transactionMaterial: material.handle,
      transactionMaterialDigest: material.digest,
      now: new Date("2026-06-06T00:00:02.000Z")
    });

    expect(outcome).toMatchObject({
      status: "blocked",
      blockedReason: "object_resolution_failed",
      checks: [{ id: "review_time_simulation_result_invalid", status: "fail" }]
    });
  });

  it("rejects simulation evidence whose digest does not match stored material", async () => {
    const materialStore = new InMemoryLocalTransactionMaterialStore();
    const material = await recordTestTransactionMaterial({
      materialStore,
      reviewSessionId: "review_1",
      planId: "plan_1",
      account,
      now: new Date("2026-06-06T00:00:00.000Z"),
      computedAt: new Date("2026-06-06T00:00:01.000Z"),
      expiresAt: new Date("2026-06-06T00:30:00.000Z")
    });
    const client = createSuccessfulReviewTimeSimulationClient(account);
    const producer = createReviewTimeSimulationProducer({
      client,
      materialStore,
      network: "mainnet",
      chainIdentifier,
      expectedChainIdentifier: chainIdentifier
    });
    const outcome = await producer({
      transactionMaterial: material.handle,
      transactionMaterialDigest: material.digest,
      now: new Date("2026-06-06T00:00:02.000Z")
    });
    if (outcome.status !== "completed") {
      throw new Error("simulation producer did not complete");
    }

    expect(() =>
      verifyReviewTimeSimulationEvidence({
        transactionBytes: materialStore.getTransactionMaterial(material.handle, new Date(material.handle.createdAt))!.transactionBytes,
        transactionMaterial: material.handle,
        transactionMaterialDigest: {
          ...material.digest,
          transactionDigest: "1".repeat(32)
        },
        evidence: outcome.evidence,
        now: new Date("2026-06-06T00:00:03.000Z")
      })
    ).toThrow("review-time simulation evidence must match material and digest identity");
  });

  it("rejects simulation evidence whose changed object count does not match object changes", async () => {
    const materialStore = new InMemoryLocalTransactionMaterialStore();
    const material = await recordTestTransactionMaterial({
      materialStore,
      reviewSessionId: "review_1",
      planId: "plan_1",
      account,
      now: new Date("2026-06-06T00:00:00.000Z"),
      computedAt: new Date("2026-06-06T00:00:01.000Z"),
      expiresAt: new Date("2026-06-06T00:30:00.000Z")
    });
    const producer = createReviewTimeSimulationProducer({
      client: createSuccessfulReviewTimeSimulationClient(account),
      materialStore,
      network: "mainnet",
      chainIdentifier,
      expectedChainIdentifier: chainIdentifier
    });
    const outcome = await producer({
      transactionMaterial: material.handle,
      transactionMaterialDigest: material.digest,
      now: new Date("2026-06-06T00:00:02.000Z")
    });
    if (outcome.status !== "completed") {
      throw new Error("simulation producer did not complete");
    }

    expect(() =>
      verifyReviewTimeSimulationEvidence({
        transactionBytes: materialStore.getTransactionMaterial(material.handle, new Date(material.handle.createdAt))!.transactionBytes,
        transactionMaterial: material.handle,
        transactionMaterialDigest: material.digest,
        evidence: {
          ...outcome.evidence,
          effects: {
            ...outcome.evidence.effects,
            changedObjectCount: outcome.evidence.objectChanges.length + 1
          }
        },
        now: new Date("2026-06-06T00:00:03.000Z")
      })
    ).toThrow("simulation changedObjectCount must match objectChanges length");
  });

  it("requires live stored material before simulation", async () => {
    const materialStore = new InMemoryLocalTransactionMaterialStore();
    const material = await recordTestTransactionMaterial({
      materialStore,
      reviewSessionId: "review_1",
      planId: "plan_1",
      account,
      now: new Date("2026-06-06T00:00:00.000Z"),
      computedAt: new Date("2026-06-06T00:00:01.000Z"),
      expiresAt: new Date("2026-06-06T00:00:05.000Z")
    });
    const client = createSuccessfulReviewTimeSimulationClient(account);
    const producer = createReviewTimeSimulationProducer({
      client,
      materialStore,
      network: "mainnet",
      chainIdentifier,
      expectedChainIdentifier: chainIdentifier
    });

    const outcome = await producer({
      transactionMaterial: material.handle,
      transactionMaterialDigest: material.digest,
      now: new Date("2026-06-06T00:00:05.000Z")
    });

    expect(outcome).toMatchObject({
      status: "refresh_required",
      refreshReason: "quote_stale",
      checks: [{ id: "review_time_simulation_material_unavailable", status: "fail" }]
    });
    expect(client.calls).toHaveLength(0);
  });
});
