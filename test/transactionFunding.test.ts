import { GrpcTypes } from "@mysten/sui/grpc";
import { clonePrivateReviewArtifacts } from "../src/core/session/privateReviewArtifacts.js";
import { verifyTransactionObjectOwnershipEvidence } from "../src/core/action/transactionObjectOwnershipEvidence.js";
import { mainnetCoins } from "@mysten/deepbook-v3";
import { readPublicChainReceipt } from "../src/core/action/suiChainReceiptReader.js";
import { createDeepbookSwapTransactionMaterialDigestProducer } from "../src/adapters/deepbook/deepbookTransactionMaterialProducer.js";
import { describe, expect, it, vi } from "vitest";
import { Transaction } from "@mysten/sui/transactions";
import { bcs, TypeTagSerializer } from "@mysten/sui/bcs";
import { deriveDynamicFieldID, fromBase58, fromHex, normalizeSuiAddress, SUI_TYPE_ARG, toBase58, toHex } from "@mysten/sui/utils";
import { describeTransactionFunding, readTransactionFunding, transactionFundingEvidenceSchema } from "../src/core/action/transactionFunding.js";
import { createTransactionObjectOwnershipProducer } from "../src/core/action/transactionObjectOwnershipProducer.js";
import { createReviewTimeSimulationProducer } from "../src/core/action/reviewTimeSimulationEvidence.js";
import { createSuccessfulReviewTimeSimulationClient } from "./fixtures/reviewTimeSimulation.js";
import { createDeepbookBuildClient, buildFixtureCoin, BUILD_CHAIN } from "./fixtures/deepbookBuildClient.js";
import { InMemoryLocalTransactionMaterialStore } from "../src/core/session/transactionMaterialStore.js";

const account = normalizeSuiAddress("0xa");
const gasObject = `0x${"b".repeat(64)}`;
const clock = normalizeSuiAddress("0x6");
const now = new Date("2026-09-26T00:00:00.000Z");
const gasRef = { objectId: gasObject, version: 1n, digest: "7".repeat(44) };

// Independent source vector from the documented Rust reservation wire format.
// Product decoding is never used to construct expected refs or amounts.
function reservedRef(amount: bigint, epoch = 1, owner = account) {
  const id = deriveDynamicFieldID(normalizeSuiAddress("0xacc"),
    TypeTagSerializer.parseFromStr("0x2::accumulator::Key<0x2::balance::Balance<0x2::sui::SUI>>"), bcs.Address.serialize(owner).toBytes());
  const masked = fromHex(id.slice(2)), chain = fromBase58(BUILD_CHAIN);
  masked.forEach((byte, i) => { masked[i] = byte ^ chain[i]!; });
  const payload = new Uint8Array(32).fill(0xac);
  new DataView(payload.buffer).setBigUint64(0, amount, true);
  new DataView(payload.buffer).setUint32(8, epoch, true);
  return { objectId: normalizeSuiAddress(toHex(masked)), version: 0n, digest: toBase58(payload) };
}

async function material(mode: "objects" | "address" | "mixed" | "address_input_object_gas" | "object_input_address_gas", balance = "1000000000", expirationEpoch?: number | string) {
  const address = mode === "objects" ? "0" : mode === "mixed" ? "100000000" : balance;
  const coins = mode === "address" ? "0" : mode === "mixed" ? "250000000" : "1000000000";
  const client = createDeepbookBuildClient({ expectedChainIdentifier: BUILD_CHAIN,
    addressBalances: { [SUI_TYPE_ARG]: address }, coinBalances: { [SUI_TYPE_ARG]: coins },
    gasPayments: mode === "address" || mode === "object_input_address_gas" ? [] : mode === "mixed" ? [reservedRef(100000000n), gasRef] : [gasRef] });
  const tx = new Transaction(); tx.setSender(account); tx.setGasBudget(50000000n);
  if (expirationEpoch !== undefined) tx.setExpiration({ Epoch: expirationEpoch });
  tx.moveCall({ target: "0x2::clock::timestamp_ms", arguments: [tx.object(clock)] });
  tx.transferObjects([tx.coin({ balance: 300000000n, ...(mode === "object_input_address_gas" ? { type: mainnetCoins.USDC!.type } : {}) })], account);
  const bytes = await tx.build({ client });
  const store = new InMemoryLocalTransactionMaterialStore();
  const handle = store.recordTransactionMaterial({ reviewSessionId: "funding-review", planId: "funding-plan", account,
    kind: "deepbook_swap_transaction_data", source: "sui_mcp_built", transactionBytes: bytes,
    expiresAt: new Date(now.getTime() + 30000) }, now);
  const result = await createDeepbookSwapTransactionMaterialDigestProducer({ materialStore: store })({ materialHandle: handle, now });
  if (result.status !== "completed") throw new Error("Material digest missing");
  const digest = result.evidence;
  return { client, bytes, store, handle, digest, description: describeTransactionFunding(Transaction.from(bytes).getData(), account, BUILD_CHAIN) };
}

const objects = { getObject: vi.fn(async ({ objectId }: { objectId: string }) => ({ object: { objectId,
  owner: objectId === clock ? { $kind: "Shared" as const, Shared: { initialSharedVersion: "1" } }
    : { $kind: "AddressOwner" as const, AddressOwner: account },
  type: objectId === clock ? "0x2::clock::Clock" : objectId === gasObject ? "0x2::coin::Coin<0x2::sui::SUI>" : `0x2::coin::Coin<${mainnetCoins.USDC!.type}>` } })) };

async function ownership(m: Awaited<ReturnType<typeof material>>) {
  return createTransactionObjectOwnershipProducer({ materialStore: m.store, objectSource: objects,
    fundingSource: m.client.core, network: "mainnet", chainIdentifier: BUILD_CHAIN, expectedChainIdentifier: BUILD_CHAIN })({
    materialHandle: m.handle, materialDigest: m.digest, now });
}

describe("transaction funding across the real SDK build and stored evidence", () => {
  it.each([
    { epoch: 0, canonicalEpoch: "0", observedEpoch: "0", valid: true },
    { epoch: 7, canonicalEpoch: "7", observedEpoch: "7", valid: true },
    { epoch: 7, canonicalEpoch: "7", observedEpoch: "8", valid: false }
  ])("verifies SDK Epoch $epoch at observed epoch $observedEpoch (valid: $valid)", async ({ epoch, canonicalEpoch, observedEpoch, valid }) => {
    const m = await material("objects", "1000000000", epoch);
    expect(Transaction.from(m.bytes).getData().expiration).toMatchObject({ Epoch: epoch });
    expect(m.description.expiration).toEqual({ kind: "epoch", epoch: canonicalEpoch });
    const fundingSource = {
      getCurrentSystemState: vi.fn(async () => ({ systemState: { epoch: observedEpoch } })),
      getBalance: vi.fn(async () => { throw new Error("Object-only funding must not read address balances"); })
    };
    const objectSource = { getObject: vi.fn((input: { objectId: string }) => objects.getObject(input)) };
    const result = await createTransactionObjectOwnershipProducer({
      materialStore: m.store, objectSource, fundingSource,
      network: "mainnet", chainIdentifier: BUILD_CHAIN, expectedChainIdentifier: BUILD_CHAIN
    })({ materialHandle: m.handle, materialDigest: m.digest, now });

    expect(fundingSource.getCurrentSystemState).toHaveBeenCalledTimes(1);
    expect(fundingSource.getBalance).not.toHaveBeenCalled();
    if (!valid) {
      expect(result).toMatchObject({ status: "blocked", blockedReason: "object_resolution_failed" });
      expect(result).not.toHaveProperty("evidence");
      expect(objectSource.getObject).not.toHaveBeenCalled();
      return;
    }
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("Expected valid epoch ownership evidence");
    expect(result.evidence.funding).toMatchObject({ expiration: { kind: "epoch", epoch: canonicalEpoch }, observedEpoch });
    expect(objectSource.getObject.mock.calls.map(([input]) => input.objectId).sort()).toEqual([clock, gasObject].sort());
    expect(verifyTransactionObjectOwnershipEvidence({
      transactionMaterial: m.handle, transactionMaterialDigest: m.digest,
      transactionBytes: m.bytes, evidence: result.evidence, now
    })).toEqual(result.evidence);
  });

  it("rejects imprecise Epoch numbers and non-canonical strings without changing other u64 fields", async () => {
    const m = await material("objects");
    const data = Transaction.from(m.bytes).getData();
    for (const epoch of [Number.MAX_SAFE_INTEGER + 1, -1, 1.5, NaN, Infinity, "07", "-1", "1.5", "18446744073709551616"]) {
      expect(() => describeTransactionFunding({ ...data, expiration: { Epoch: epoch } }, account, BUILD_CHAIN)).toThrow();
    }
    for (const epoch of ["0", "7", "18446744073709551615"]) {
      expect(describeTransactionFunding({ ...data, expiration: { Epoch: epoch } }, account, BUILD_CHAIN).expiration)
        .toEqual({ kind: "epoch", epoch });
    }
    expect(() => describeTransactionFunding({ ...data, gasData: { ...data.gasData, budget: 50000000 } }, account, BUILD_CHAIN)).toThrow();

    // The pinned BCS decoder uses Number for Epoch; reject a lossy real decode.
    const tx = Transaction.from(m.bytes);
    tx.setExpiration({ Epoch: "9007199254740993" });
    const decoded = Transaction.from(await tx.build()).getData();
    if (decoded.expiration?.$kind !== "Epoch") throw new Error("Expected SDK Epoch decoding");
    expect(Number.isSafeInteger(decoded.expiration.Epoch)).toBe(false);
    expect(() => describeTransactionFunding(decoded, account, BUILD_CHAIN)).toThrow(/safe integer/);
  });

  it.each(["objects", "address", "mixed", "address_input_object_gas", "object_input_address_gas"] as const)("preserves %s funding through ownership and simulation", async (mode) => {
    const m = await material(mode); objects.getObject.mockClear();
    const addressGas = mode === "address" || mode === "object_input_address_gas";
    const owned = await ownership(m);
    expect(owned.status).toBe("completed");
    if (owned.status !== "completed") throw new Error(JSON.stringify(owned));
    expect(owned.evidence.funding.gasMode).toBe(addressGas ? "address_balance" : mode === "mixed" ? "coin_reservation" : "coin_objects");
    expect(owned.evidence.funding.addressBalances.map((row) => row.requiredRaw)).toEqual(
      mode === "objects" ? [] : [mode === "mixed" ? "100000000" : mode === "address" ? "350000000" : mode === "object_input_address_gas" ? "50000000" : "300000000"]);
    expect(objects.getObject.mock.calls.map(([input]) => input.objectId).sort()).toEqual((mode === "address" ? [clock] : mode === "object_input_address_gas" ? [clock, buildFixtureCoin(mainnetCoins.USDC!.type).objectId] : [clock, gasObject]).sort());
    const simulationClient = createSuccessfulReviewTimeSimulationClient(account, { gasObjectId: addressGas ? null : gasObject });
    const simulation = await createReviewTimeSimulationProducer({ client: simulationClient,
      materialStore: m.store, network: "mainnet", chainIdentifier: BUILD_CHAIN, expectedChainIdentifier: BUILD_CHAIN })({
      transactionMaterial: m.handle, transactionMaterialDigest: m.digest, now });
    expect(simulation.status).toBe("completed");
    if (simulation.status !== "completed") throw new Error(JSON.stringify(simulation));
    expect(simulation.evidence.transaction.gasPaymentCount).toBe(addressGas ? 0 : mode === "mixed" ? 2 : 1);
    expect(simulation.evidence.transaction.funding).toEqual(m.description);
    expect(simulation.evidence.objectChanges.map((item) => item.objectId)).toEqual(addressGas ? [] : [gasObject]);
    expect(m.client.transactionExecutionService.simulateTransaction).toHaveBeenCalledTimes(1);
    const clone = clonePrivateReviewArtifacts({ transactionObjectOwnership: owned.evidence });
    clone.transactionObjectOwnership!.funding.gasObjectIds.push(normalizeSuiAddress("0xff"));
    expect(owned.evidence.funding.gasObjectIds).not.toContain(normalizeSuiAddress("0xff"));
    expect(verifyTransactionObjectOwnershipEvidence({ transactionMaterial: m.handle, transactionMaterialDigest: m.digest,
      transactionBytes: m.bytes, evidence: owned.evidence, now })).toEqual(owned.evidence);

    const chainResponse = await simulationClient.core.simulateTransaction({ transaction: m.bytes,
      checksEnabled: true, include: { transaction: true, effects: true, balanceChanges: true, objectTypes: true } });
    if (chainResponse.$kind !== "Transaction") throw new Error("Invalid synthetic chain response");
    const receipt = await readPublicChainReceipt({ network: "mainnet", expectedChainIdentifier: BUILD_CHAIN,
      client: { core: { getChainIdentifier: async () => ({ chainIdentifier: BUILD_CHAIN }),
        getTransaction: async () => ({ ...chainResponse, Transaction: { ...chainResponse.Transaction, events: [] } }) as never } } },
      { digest: m.digest.transactionDigest, now });
    expect(receipt.status).toBe("found");
    if (receipt.status === "found") expect(receipt.receipt.gas?.paymentObjectId).toBe(addressGas ? undefined : gasObject);

  });

  it("does not expose raw node rejection descriptions or transaction bytes", async () => {
    const m = await material("address");
    const client = createSuccessfulReviewTimeSimulationClient(account);
    const source = client.transactionExecutionService.simulateTransaction;
    client.transactionExecutionService.simulateTransaction = async (request) => {
      const result = await source(request);
      result.response.transaction!.effects!.status = { success: false, error: GrpcTypes.ExecutionError.create({
        kind: GrpcTypes.ExecutionError_ExecutionErrorKind.MOVE_ABORT,
        description: "private node detail " + Buffer.from(m.bytes).toString("base64") }) };
      return result;
    };
    const result = await createReviewTimeSimulationProducer({ client, materialStore: m.store, network: "mainnet",
      chainIdentifier: BUILD_CHAIN, expectedChainIdentifier: BUILD_CHAIN })({ transactionMaterial: m.handle, transactionMaterialDigest: m.digest, now });
    expect(result).toMatchObject({ status: "blocked", blockedReason: "object_resolution_failed" });
    expect(JSON.stringify(result)).not.toContain("private node detail");
    expect(JSON.stringify(result)).not.toContain(Buffer.from(m.bytes).toString("base64"));
  });

  it.each(["changed_bytes", "different_effects_digest", "missing_bcs"] as const)("rejects %s from the checked gRPC endpoint", async (fault) => {
    const m = await material("address");
    const client = createSuccessfulReviewTimeSimulationClient(account);
    const source = client.transactionExecutionService.simulateTransaction;
    client.transactionExecutionService.simulateTransaction = async (request) => {
      const result = await source(request);
      const returned = result.response.transaction!;
      if (fault === "different_effects_digest") returned.effects!.transactionDigest = "1".repeat(32);
      else if (fault === "missing_bcs") delete returned.transaction!.bcs;
      else {
        const changed = Transaction.from(m.bytes); changed.setGasBudget(50000001n);
        returned.transaction!.bcs = { value: await changed.build() };
      }
      return result;
    };
    const result = await createReviewTimeSimulationProducer({ client, materialStore: m.store, network: "mainnet",
      chainIdentifier: BUILD_CHAIN, expectedChainIdentifier: BUILD_CHAIN })({ transactionMaterial: m.handle, transactionMaterialDigest: m.digest, now });
    expect(result).toMatchObject({ status: "blocked", checks: [expect.objectContaining({ id: "review_time_simulation_result_invalid" })] });
    expect(client.rpcCalls[0]).toMatchObject({ checks: 0, doGasSelection: true });
  });

  it("rejects a node transaction with a foreign payer even when its digest echo matches", async () => {
    const m = await material("address");
    const client = createSuccessfulReviewTimeSimulationClient(account);
    const simulate = client.core.simulateTransaction;
    client.core.simulateTransaction = async (input) => {
      const response = await simulate(input);
      if (response.$kind !== "Transaction") throw new Error("Expected source transaction");
      response.Transaction.transaction.gasData.owner = normalizeSuiAddress("0xff");
      return response;
    };
    const result = await createReviewTimeSimulationProducer({ client, materialStore: m.store, network: "mainnet",
      chainIdentifier: BUILD_CHAIN, expectedChainIdentifier: BUILD_CHAIN })({ transactionMaterial: m.handle, transactionMaterialDigest: m.digest, now });
    expect(result).toMatchObject({ status: "blocked", checks: [expect.objectContaining({ id: "review_time_simulation_result_invalid" })] });
  });

  it("uses address balance alone for the address reservation boundary R-1 / R", async () => {
    const m = await material("address");
    for (const [held, sufficient] of [["349999999", false], ["350000000", true]] as const) {
      const source = { getCurrentSystemState: async () => ({ systemState: { epoch: "1" } }),
        getBalance: async () => ({ balance: { coinType: SUI_TYPE_ARG, addressBalance: held, balance: "999999999999", coinBalance: "999999999999" } }) };
      if (sufficient) expect((await readTransactionFunding(m.description, source)).addressBalances[0]?.requiredRaw).toBe("350000000");
      else await expect(readTransactionFunding(m.description, source)).rejects.toMatchObject({ kind: "insufficient_balance" });
    }
  });

  it("aggregates repeated withdrawals and separates source failures from insufficient funds", async () => {
    const m = await material("address");
    const description = { ...m.description, withdrawals: [...m.description.withdrawals,
      { inputIndex: 99, owner: account, coinType: SUI_TYPE_ARG, maxAmountRaw: "10" }] };
    const source = { getCurrentSystemState: async () => ({ systemState: { epoch: "1" } }),
      getBalance: vi.fn(async () => ({ balance: { coinType: SUI_TYPE_ARG, addressBalance: "350000010" } })) };
    expect((await readTransactionFunding(description, source)).addressBalances[0]?.requiredRaw).toBe("350000010");
    expect(source.getBalance).toHaveBeenCalledTimes(1);
    source.getBalance.mockRejectedValueOnce(new Error("private upstream detail"));
    await expect(readTransactionFunding(description, source)).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("accepts reservation N and N+1, rejects N+2 and forged owner/chain reservations", async () => {
    const m = await material("mixed");
    for (const epoch of ["1", "2", "3"]) {
      const source = { getCurrentSystemState: async () => ({ systemState: { epoch } }),
        getBalance: async () => ({ balance: { coinType: SUI_TYPE_ARG, addressBalance: "100000000" } }) };
      if (epoch === "3") await expect(readTransactionFunding(m.description, source)).rejects.toThrow(/epoch/);
      else expect((await readTransactionFunding(m.description, source)).observedEpoch).toBe(epoch);
    }
    const data = Transaction.from(m.bytes).getData();
    data.gasData.payment![0]!.objectId = normalizeSuiAddress("0x123");
    expect(() => describeTransactionFunding(data, account, BUILD_CHAIN)).toThrow(/reservation/);
  });

  it("rejects missing payments, foreign payers, sponsor withdrawals and altered evidence", async () => {
    const m = await material("address");
    const data = Transaction.from(m.bytes).getData();
    const noPayment = structuredClone(data); noPayment.gasData.payment = null;
    expect(() => describeTransactionFunding(noPayment, account, BUILD_CHAIN)).toThrow(/payments/);
    const foreign = structuredClone(data); foreign.gasData.owner = normalizeSuiAddress("0xf");
    expect(() => describeTransactionFunding(foreign, account, BUILD_CHAIN)).toThrow(/reviewed account/);
    const input = data.inputs.find((item) => item.$kind === "FundsWithdrawal")!;
    if (input.$kind !== "FundsWithdrawal") throw new Error("Missing real SDK withdrawal");
    input.FundsWithdrawal.withdrawFrom = { $kind: "Sponsor", Sponsor: true };
    expect(() => describeTransactionFunding(data, account, BUILD_CHAIN)).toThrow(/withdrawal/);
    const evidence = await readTransactionFunding(m.description, m.client.core);
    expect(transactionFundingEvidenceSchema.safeParse({ ...evidence, gasMode: "coin_objects" }).success).toBe(false);
    expect(transactionFundingEvidenceSchema.safeParse({ ...evidence, addressBalances: [] }).success).toBe(false);
  });
});
