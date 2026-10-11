import { GrpcTypes } from "@mysten/sui/grpc";
import type { SuiClientTypes } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import type {
  ReviewTimeSimulationClient
} from "../../src/core/action/reviewTimeSimulationEvidence.js";

export type CoreSimulationFixture = { core: { simulateTransaction(input: SuiClientTypes.SimulateTransactionOptions<{ transaction: true; effects: true; balanceChanges: true; objectTypes: true }>): Promise<SuiClientTypes.SimulateTransactionResult<{ transaction: true; effects: true; balanceChanges: true; objectTypes: true }>> } };

export type ReviewTimeSimulationClientFixture = CoreSimulationFixture & ReviewTimeSimulationClient & {
  rpcCalls: GrpcTypes.SimulateTransactionRequest[];
  calls: Array<SuiClientTypes.SimulateTransactionOptions<{
    transaction: true;
    effects: true;
    balanceChanges: true;
    objectTypes: true;
  }>>;
};

export function createSuccessfulReviewTimeSimulationClient(
  account: string, sourceEffects: { gasObjectId?: string | null } = {}
): ReviewTimeSimulationClientFixture {
  const calls: ReviewTimeSimulationClientFixture["calls"] = [];
  return withGrpcSimulation<CoreSimulationFixture & Pick<ReviewTimeSimulationClientFixture, "calls">>({
    calls,
    core: {
      async simulateTransaction(options) {
        calls.push(options);
        const transactionBytes = options.transaction;
        if (!(transactionBytes instanceof Uint8Array)) {
          throw new Error("test simulation fixture expects transaction bytes");
        }
        const transaction = Transaction.from(transactionBytes);
        const digest = await transaction.getDigest();
        const transactionData = transaction.getData() as SuiClientTypes.TransactionData;
        const gasObjectId = sourceEffects.gasObjectId === undefined ? transactionData.gasData.payment?.[0]?.objectId : sourceEffects.gasObjectId;
        const gasObjectType = "0x2::coin::Coin<0x2::sui::SUI>";
        return {
          $kind: "Transaction",
          Transaction: {
            digest,
            signatures: [],
            epoch: "1",
            timestampMs: null, checkpoint: null,
            status: { success: true, error: null },
            balanceChanges: [
              {
                address: account,
                coinType: "0x2::sui::SUI",
                amount: "-1000"
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
              changedObjects: gasObjectId ? [
                {
                  objectId: gasObjectId,
                  inputState: "Exists",
                  inputVersion: "1",
                  inputDigest: "7".repeat(44),
                  inputOwner: null,
                  outputState: "ObjectWrite",
                  outputVersion: "2",
                  outputDigest: "8".repeat(44),
                  outputOwner: null,
                  idOperation: "None"
                }
              ] : [],
              unchangedConsensusObjects: [],
              auxiliaryDataDigest: null
            },
            events: undefined,
            objectTypes: gasObjectId ? { [gasObjectId]: gasObjectType } : {},
            transaction: transactionData,
            bcs: undefined
          },
          commandResults: undefined,
          gasPaymentMocked: false
        };
      }
    }
  });
}

export function createFailedReviewTimeSimulationClient(
  message = "simulated transaction failed", errorKind: GrpcTypes.ExecutionError_ExecutionErrorKind = GrpcTypes.ExecutionError_ExecutionErrorKind.EXECUTION_ERROR_KIND_UNKNOWN
): ReviewTimeSimulationClientFixture {
  const calls: ReviewTimeSimulationClientFixture["calls"] = [];
  return withGrpcSimulation<CoreSimulationFixture & Pick<ReviewTimeSimulationClientFixture, "calls">>({
    calls,
    core: {
      async simulateTransaction(options) {
        calls.push(options);
        const transactionBytes = options.transaction;
        if (!(transactionBytes instanceof Uint8Array)) {
          throw new Error("test simulation fixture expects transaction bytes");
        }
        const transaction = Transaction.from(transactionBytes);
        const digest = await transaction.getDigest();
        const transactionData = transaction.getData() as SuiClientTypes.TransactionData;
        return {
          $kind: "FailedTransaction",
          FailedTransaction: {
            digest,
            signatures: [],
            epoch: "1",
            timestampMs: null, checkpoint: null,
            status: {
              success: false,
              error: { message, $kind: "Unknown", Unknown: null }
            } as SuiClientTypes.ExecutionStatus,
            balanceChanges: [],
            effects: {
              bcs: null,
              version: 1,
              status: {
                success: false,
                error: { message, $kind: "Unknown", Unknown: null }
              } as SuiClientTypes.ExecutionStatus,
              gasUsed: {
                computationCost: "0",
                storageCost: "0",
                storageRebate: "0",
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
            objectTypes: {},
            transaction: transactionData,
            bcs: undefined
          },
          commandResults: undefined,
          gasPaymentMocked: false
        };
      }
    }
  }, { failureKind: errorKind });
}

// Source adapter only: model the public RPC response from the existing synthetic
// chain facts. Product verification and SDK parsing are never replaced.
export function withGrpcSimulation<T extends CoreSimulationFixture>(client: T, source: { failureKind?: GrpcTypes.ExecutionError_ExecutionErrorKind } = {}): T & ReviewTimeSimulationClient & { rpcCalls: GrpcTypes.SimulateTransactionRequest[] } {
  const rpcCalls: GrpcTypes.SimulateTransactionRequest[] = [];
  return Object.assign(client, { rpcCalls, transactionExecutionService: {
    async simulateTransaction(request: GrpcTypes.SimulateTransactionRequest) {
      rpcCalls.push(request);
      const bytes = request.transaction?.bcs?.value;
      if (!bytes) throw new Error("Missing source simulation bytes");
      const result = await client.core.simulateTransaction({ transaction: bytes,
        checksEnabled: request.checks === GrpcTypes.SimulateTransactionRequest_TransactionChecks.ENABLED,
        include: { transaction: true, effects: true, balanceChanges: true, objectTypes: true } });
      const tx = result.$kind === "Transaction" ? result.Transaction : result.FailedTransaction;
      const returned = tx.transaction ? await Transaction.from(JSON.stringify(tx.transaction)).build() : undefined;
      const inputStates = { Exists: GrpcTypes.ChangedObject_InputObjectState.EXISTS, DoesNotExist: GrpcTypes.ChangedObject_InputObjectState.DOES_NOT_EXIST, Unknown: GrpcTypes.ChangedObject_InputObjectState.UNKNOWN };
      const outputStates = { ObjectWrite: GrpcTypes.ChangedObject_OutputObjectState.OBJECT_WRITE, PackageWrite: GrpcTypes.ChangedObject_OutputObjectState.PACKAGE_WRITE, DoesNotExist: GrpcTypes.ChangedObject_OutputObjectState.DOES_NOT_EXIST, AccumulatorWriteV1: GrpcTypes.ChangedObject_OutputObjectState.ACCUMULATOR_WRITE, Unknown: GrpcTypes.ChangedObject_OutputObjectState.UNKNOWN };
      const operations = { None: GrpcTypes.ChangedObject_IdOperation.NONE, Created: GrpcTypes.ChangedObject_IdOperation.CREATED, Deleted: GrpcTypes.ChangedObject_IdOperation.DELETED, Unknown: GrpcTypes.ChangedObject_IdOperation.ID_OPERATION_UNKNOWN };
      const transaction = GrpcTypes.ExecutedTransaction.create({
        ...(tx.digest === undefined ? {} : { digest: tx.digest }),
        ...(returned ? { transaction: { bcs: { value: returned } } } : {}),
        effects: { transactionDigest: tx.effects.transactionDigest,
          status: { success: tx.status.success, ...(tx.status.error ? { error: { description: tx.status.error.message, kind: source.failureKind ?? GrpcTypes.ExecutionError_ExecutionErrorKind.EXECUTION_ERROR_KIND_UNKNOWN } } : {}) },
          gasUsed: { computationCost: BigInt(tx.effects.gasUsed.computationCost), storageCost: BigInt(tx.effects.gasUsed.storageCost),
            storageRebate: BigInt(tx.effects.gasUsed.storageRebate), nonRefundableStorageFee: BigInt(tx.effects.gasUsed.nonRefundableStorageFee) },
          changedObjects: tx.effects.changedObjects.map((item) => ({ objectId: item.objectId,
            inputState: inputStates[item.inputState], outputState: outputStates[item.outputState], idOperation: operations[item.idOperation] })) },
        balanceChanges: tx.balanceChanges.map((item) => ({ address: item.address, coinType: item.coinType, amount: item.amount })),
        ...(tx.objectTypes ? { objects: { objects: Object.entries(tx.objectTypes).map(([objectId, objectType]) => ({ objectId, objectType })) } } : {})
      });
      return { response: GrpcTypes.SimulateTransactionResponse.create({ transaction }) };
    }
  } });
}
