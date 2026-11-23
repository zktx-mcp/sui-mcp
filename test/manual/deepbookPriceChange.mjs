// Isolated Sui execution fixture. Run on a disposable loopback genesis with
// its own funded keys and a v9 DeepBook + token bytecode bundle.
import assert from "node:assert/strict";
import { createLocalPool, prepareFeePayingBuy } from "./deepbookLocalPool.mjs";
import { Transaction } from "@mysten/sui/transactions";
import { DeepBookClient } from "@mysten/deepbook-v3";
import { normalizeStructTag, SUI_TYPE_ARG } from "@mysten/sui/utils";
import { appendGuardedSwap } from "../../src/adapters/deepbook/deepbookTransactionMaterialProducer.ts";
import { createHash } from "node:crypto";

const fixture = await createLocalPool(...process.argv.slice(2));
const { user, client, execute, pkg, deep, poolId, managerId } = fixture;
async function ask(price, replace = false) {
  const tx=new Transaction(), bm=tx.object(managerId), pool=tx.object(poolId), clk=tx.object.clock();
  const proof=tx.moveCall({target:pkg+"::balance_manager::generate_proof_as_owner",arguments:[bm]});
  if (replace) tx.moveCall({target:pkg+"::pool::cancel_all_orders",typeArguments:[SUI_TYPE_ARG,deep],arguments:[pool,bm,proof,clk]});
  tx.moveCall({target:pkg+"::pool::place_limit_order",typeArguments:[SUI_TYPE_ARG,deep],arguments:[
    pool,bm,proof,tx.pure.u64(1),tx.pure.u8(0),tx.pure.u8(0),tx.pure.u64(price),tx.pure.u64(1000000000),
    tx.pure.bool(false),tx.pure.bool(false),tx.pure.u64(BigInt(Date.now())+3600000n),clk]});
  await execute(tx);
}
await ask(1000000n);
const sdk = new DeepBookClient({client,address:user.toSuiAddress(),network:"localnet",packageIds:{DEEPBOOK_PACKAGE_ID:pkg},
  coins:{SUI:{type:SUI_TYPE_ARG,scalar:1e9,address:"0x2"},DEEP:{type:deep,scalar:1e6,address:pkg}},
  pools:{SUI_DEEP:{address:poolId,baseCoin:"SUI",quoteCoin:"DEEP"}}});
const fixed = new Transaction(); fixed.setSender(user.toSuiAddress()); fixed.setGasBudget(50000000n);
appendGuardedSwap(fixed,sdk,{poolKey:"SUI_DEEP",poolId,baseType:SUI_TYPE_ARG,quoteType:deep,deepType:deep,
  account:user.toSuiAddress(),direction:"quote_to_base",principal:100000n,minimum:99500000n,deepBudget:0n});
const bytes=await fixed.build({client});
const guard=Transaction.from(bytes).getData().commands.findLastIndex(c=>c.SplitCoins);
const fingerprint=createHash("sha256").update(bytes).digest("hex");
async function simulate(label, expected, baseReceived, quoteSpent) {
  const {GrpcTypes}=await import("@mysten/sui/grpc");
  const {response}=await client.transactionExecutionService.simulateTransaction({
    transaction:{bcs:{value:bytes}}, checks:GrpcTypes.SimulateTransactionRequest_TransactionChecks.ENABLED, doGasSelection:false,
    readMask:{paths:["transaction.effects","transaction.transaction.bcs","transaction.balance_changes"]}});
  const tx=response.transaction, status=tx?.effects?.status;
  assert.deepEqual(Buffer.from(tx.transaction.bcs.value),Buffer.from(bytes));
  assert.equal(status.success,expected,JSON.stringify(status,(_,v)=>typeof v==="bigint"?v.toString():v));
  if (!expected) {
    assert.equal(Number(status.error.command),guard);
    assert.equal(status.error.kind,GrpcTypes.ExecutionError_ExecutionErrorKind.INSUFFICIENT_COIN_BALANCE);
  }
  if (expected) {
    const gas=tx.effects.gasUsed;
    const sum=(asset)=>tx.balanceChanges.filter(c=>c.address===user.toSuiAddress()&&normalizeStructTag(c.coinType)===asset)
      .reduce((n,c)=>n+BigInt(c.amount),0n);
    assert.equal(sum(SUI_TYPE_ARG)+gas.computationCost+gas.storageCost-gas.storageRebate,baseReceived);
    assert.equal(sum(deep),-quoteSpent);
  }
  console.log(JSON.stringify({label,sha256:fingerprint,guard,success:status.success,baseReceivedRaw:baseReceived?.toString(),quoteSpentRaw:quoteSpent?.toString(),failureCommand:status.error?.command?.toString()}));
}
await simulate("reviewed price",true,100000000n,100000n);
await ask(1010000n,true);
await simulate("higher ask: below minimum base lot",false);
await ask(501000n,true);
await simulate("partial fill immediately above a lot boundary",true,100000000n,50100n);
await ask(500000n,true);
await simulate("lower ask: one extra lot",true,200000000n,100000n);

// Use the second deployment's token as an independent quote currency. The trading
// pool and the fee token continue to belong to the first protocol deployment.
async function feePayingBaseLot() {
  const { GrpcTypes } = await import("@mysten/sui/grpc");
  const { deepbookFeeBudget } = await import("../../src/adapters/deepbook/deepbookQuotePolicy.ts");
  const { target, counter, base, lot, principal, fee, budget, buildFor, place } =
    await prepareFeePayingBuy(fixture, deepbookFeeBudget, appendGuardedSwap);
  const fixed = await buildFor(user.toSuiAddress());
  const sha256=createHash("sha256").update(fixed).digest("hex");
  async function verify(expectedBase,expectedFee) {
    const {response}=await client.transactionExecutionService.simulateTransaction({transaction:{bcs:{value:fixed}},
      checks:GrpcTypes.SimulateTransactionRequest_TransactionChecks.ENABLED,doGasSelection:false,
      readMask:{paths:["transaction.effects","transaction.transaction.bcs","transaction.balance_changes"]}});
    const executed=response.transaction,gas=executed.effects.gasUsed;
    assert.equal(executed.effects.status.success,true,executed.effects.status.error?.description);
    assert.deepEqual(Buffer.from(executed.transaction.bcs.value),Buffer.from(fixed));
    const sum=type=>executed.balanceChanges.filter(row=>row.address===user.toSuiAddress()&&normalizeStructTag(row.coinType)===type)
      .reduce((total,row)=>total+BigInt(row.amount),0n);
    assert.equal(sum(SUI_TYPE_ARG)+gas.computationCost+gas.storageCost-gas.storageRebate,expectedBase);
    assert.equal(sum(counter),-principal);
    assert.equal(sum(deep),-expectedFee);
    console.log(JSON.stringify({label:"fee-paying base lot",sha256,receivedBaseRaw:expectedBase.toString(),principal:principal.toString(),
      quotedFee:fee.toString(),supplied:budget.toString(),actualFee:expectedFee.toString(),returnedFee:(budget-expectedFee).toString()}));
  }
  await verify(base,fee);
  await place(target,counter,1_000_000n,false,true);
  await verify(base+lot,budget);
}
await feePayingBaseLot();
