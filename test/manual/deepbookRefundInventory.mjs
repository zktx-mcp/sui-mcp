// Execute only on the disposable genesis owned by the manual fixture.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { DeepBookClient } from "@mysten/deepbook-v3";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, SUI_TYPE_ARG } from "@mysten/sui/utils";
import { createLocalPool, prepareFeePayingBuy } from "./deepbookLocalPool.mjs";

const [genesis, bundle, installed] = process.argv.slice(2);
const load = path => import(pathToFileURL(resolve(installed, "dist", path + ".js")).href);
const { appendGuardedSwap } = await load("adapters/deepbook/deepbookTransactionMaterialProducer");
const { describeTransactionFunding } = await load("core/action/transactionFunding");
const { createMcpServer } = await load("mcp/server");
const { createCardStore } = await load("mcp-ui/readCards");
const { SqliteActivityStore } = await load("core/activity/sqliteActivityStore");
const { validateSupportedAdapterLifecycle } = await load("adapters/adapterLifecycleValidators");
const { AccountInventoryReader } = await load("core/read/accountInventoryReader");
const { SUI_METADATA_UNIT_SOURCE } = await load("core/read/coinMetadata");
const fixture = await createLocalPool(genesis, bundle);
const { client, chain, execute, deep, poolId, managerId, pkg } = fixture;
const coinType = type => normalizeStructTag("0x2::coin::Coin<"+type+">");

// Three sells each fill ten 0.1-SUI lots. The remaining 0.05 SUI returns to the sender.
const principal = 1_050_000_000n, fill = 1_000_000_000n, price = 1_000_000n;
const bid = new Transaction(), mgr = bid.object(managerId);
bid.moveCall({ target: pkg+"::balance_manager::deposit", typeArguments:[deep],
  arguments:[mgr,bid.coin({type:deep,balance:3n*price})] });
const proof = bid.moveCall({target:pkg+"::balance_manager::generate_proof_as_owner",arguments:[mgr]});
bid.moveCall({target:pkg+"::pool::place_limit_order",typeArguments:[SUI_TYPE_ARG,deep],arguments:[
  bid.object(poolId), mgr, proof, bid.pure.u64(1),bid.pure.u8(0),bid.pure.u8(0),bid.pure.u64(price),bid.pure.u64(3n*fill),
  bid.pure.bool(true),bid.pure.bool(false),bid.pure.u64(BigInt(Date.now())+3_600_000n),bid.object.clock()]});
await execute(bid);

async function owned(owner) {
  const rows = new Map();
  let cursor;
  do {
    const page = await client.core.listOwnedObjects({owner,cursor,include:{json:true}});
    for (const object of page.objects) {
      assert.equal(object.owner.AddressOwner, owner);
      rows.set(object.objectId, object);
    }
    cursor = page.hasNextPage ? page.cursor : null;
  } while (cursor);
  return rows;
}

async function accountCard(owner, pageLimit) {
  const pages = [];
  const core = new Proxy(client.core,{get(target,key) {
    if (key === "listOwnedObjects") return async input => {
      const page = await target.listOwnedObjects({...input,...(pageLimit ? {limit:pageLimit} : {})});
      pages.push(page.objects.map(o=>o.objectId));return page;
    };
    const member=Reflect.get(target,key,target);
    return typeof member === "function" ? member.bind(target) : member;
  }});
  const db = new SqliteActivityStore({databasePath:":memory:",validateAdapterLifecycle:validateSupportedAdapterLifecycle});
  const readService = new AccountInventoryReader({core}, async balance => {
    const { coinMetadata } = await core.getCoinMetadata({coinType:balance.coinType});
    if (!coinMetadata) return { ...balance, unit:{status:"unavailable",reason:"metadata_not_found"} };
    return { ...balance, unit:{status:"available",source:SUI_METADATA_UNIT_SOURCE,
      decimals:coinMetadata.decimals,symbol:coinMetadata.symbol,name:coinMetadata.name} };
  }, () => new Date().toISOString());
  const cards = createCardStore({records:db.createCardRecordStore(),ownerId:"local-refund-fixture",readService});
  const server = createMcpServer({readService,activityStore:db,cards:{store:cards},logger:{error(){}}});
  const host = new Client({name:"local-refund-account",version:"1"},{capabilities:{extensions:{[EXTENSION_ID]:{mimeTypes:[RESOURCE_MIME_TYPE]}}}});
  const [c,s] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(s);await host.connect(c);
    const result=await host.callTool({name:"ui_open_account",arguments:{account:owner}});
    assert.ok(result.structuredContent?.ok);
    const card=result.structuredContent.data;
    const saved=await host.readResource({uri:"suimcp://cards/"+card.cardId});
    assert.deepEqual(JSON.parse(saved.contents[0].text).data,card.data);
    assert.equal(card.data.account,owner);assert.equal(card.data.scannedObjects,new Set(pages.flat()).size);
    assert.deepEqual(card.data.objectGroups,[]);assert.deepEqual(card.data.nfts,[]);
    return {data:card.data,pages};
  } finally {await host.close();await server.close();cards.stop();db.close();}
}

function coinEffects(before,after,receipt,owner) {
  const written=receipt.effects.changedObjects.filter(o=>o.outputOwner?.AddressOwner===owner && o.outputState==="ObjectWrite");
  const created=written.filter(o=>o.idOperation==="Created").map(o=>o.objectId);
  const added=[...after.keys()].filter(id=>!before.has(id));
  assert.deepEqual(new Set(added),new Set(created));
  const coins=written.map(o=>{const obj=after.get(o.objectId);assert.ok(obj);return {id:o.objectId,type:normalizeStructTag(obj.type),raw:BigInt(obj.json.balance)};});
  return {written,created,added,coins};
}

async function verifyAccountPages(owner,after) {
  const full=await accountCard(owner),capped=await accountCard(owner,1);
  assert.equal(full.data.objectScanStatus,"complete");
  assert.deepEqual(new Set(full.pages.flat()),new Set(after.keys()));
  assert.equal(capped.pages.length, Math.min(after.size,6));
  assert.equal(capped.data.scannedObjects,Math.min(after.size,6));
  assert.equal(capped.data.objectsTruncated,after.size>6);
  assert.equal(capped.data.objectScanStatus,after.size>6?"partial":"complete");
  if(after.size>6)assert.equal(capped.data.objectScanReason,"page_limit");
  return {full,capped};
}

for (const mode of ["coin_objects","address_balance","coin_reservation"]) {
  const signer=Ed25519Keypair.generate(),owner=signer.toSuiAddress();
  const setup=new Transaction(), objectFunded=mode!=="address_balance";
  const funds=2_000_000_000n;
  if (objectFunded) setup.transferObjects([setup.splitCoins(setup.gas,[funds])[0]],owner);
  if (mode!=="coin_objects") setup.moveCall({target:"0x2::coin::send_funds",typeArguments:[SUI_TYPE_ARG],
    arguments:[setup.splitCoins(setup.gas,[mode==="address_balance"?funds:10_000_000n])[0],setup.pure.address(owner)]});
  // At one actual object per RPC page the six-page reader is exactly full before the swap.
  const seeds=Array.from({length:objectFunded?5:6},()=>setup.moveCall({target:"0x2::coin::zero",typeArguments:[deep]}));
  setup.transferObjects(seeds,owner);await execute(setup);
  const before=await owned(owner),baseline=await accountCard(owner,1);
  assert.equal(before.size,6);assert.equal(baseline.data.objectScanStatus,"complete");
  assert.deepEqual(new Set(baseline.pages.flat()),new Set(before.keys()));
  const sdk=new DeepBookClient({client,address:owner,network:"localnet",packageIds:{DEEPBOOK_PACKAGE_ID:pkg},
    coins:{SUI:{type:SUI_TYPE_ARG,scalar:1e9,address:"0x2"},DEEP:{type:deep,scalar:1e6,address:pkg}},
    pools:{SUI_DEEP:{address:poolId,baseCoin:"SUI",quoteCoin:"DEEP"}}});
  const tx=new Transaction();tx.setSender(owner);tx.setGasBudget(50_000_000n);
  appendGuardedSwap(tx,sdk,{poolKey:"SUI_DEEP",poolId,baseType:SUI_TYPE_ARG,quoteType:deep,deepType:deep,account:owner,
    direction:"base_to_quote",principal,minimum:price,deepBudget:0n});
  const bytes=await tx.build({client});
  const funding=describeTransactionFunding(Transaction.from(bytes).getData(),owner,chain);
  assert.equal(funding.gasMode,mode);
  const receipt=await execute(bytes,signer),after=await owned(owner);
  const {written,created,added,coins}=coinEffects(before,after,receipt,owner);
  const output=coins.filter(c=>c.type===coinType(deep));
  assert.equal(output.length,1);assert.equal(output[0].raw,price);assert.ok(added.includes(output[0].id));
  const gas=receipt.effects.gasUsed;
  const gasCost=BigInt(gas.computationCost)+BigInt(gas.storageCost)-BigInt(gas.storageRebate);
  const balance=(await client.core.getBalance({owner,coinType:SUI_TYPE_ARG})).balance;
  const initialTotal=funds+(mode==="coin_reservation"?10_000_000n:0n);
  assert.equal(BigInt(balance.balance),initialTotal-fill-gasCost);
  if (mode==="address_balance") {
    const refund=coins.filter(c=>c.type===coinType(SUI_TYPE_ARG));
    assert.equal(refund.length,1);assert.equal(refund[0].raw,principal-fill);assert.ok(added.includes(refund[0].id));
  }
  assert.equal(created.length,mode==="address_balance"?2:1);
  if(mode==="coin_objects") {
    const gasCoin=coins.find(c=>c.type===coinType(SUI_TYPE_ARG));
    assert.ok(gasCoin && before.has(gasCoin.id));
    assert.equal(gasCoin.raw,initialTotal-fill-gasCost);
  } else if(mode==="coin_reservation") {
    assert.equal(BigInt(balance.addressBalance),initialTotal-fill-gasCost);
    assert.equal(BigInt(balance.coinBalance),0n);
  }
  const {full,capped} = await verifyAccountPages(owner, after);
  const holding=full.data.balances.find(b=>normalizeStructTag(b.coinType)===deep);
  assert.equal(BigInt(holding.balance),price);
  console.log(JSON.stringify({mode,ownedBefore:before.size,ownedAfter:after.size,newOwnedCoins:created.length,
    writtenSenderCoins:written.length,removedOwnedCoins:[...before.keys()].filter(id=>!after.has(id)).length,refundRaw:String(principal-fill),
    receivedRaw:String(price),realDefaultPages:full.pages.length,cappedPages:capped.pages.length,cappedStatus:capped.data.objectScanStatus,
    returnedIdsOnFirstSix:[...created].filter(id=>capped.pages.flat().includes(id)).length,ownerMatched:true}));
}

// Separate fee token: only an independently retained funding coin can receive
// its change. An address withdrawal needs an actual sender-owned refund coin.
const feeSigners = [Ed25519Keypair.generate(), Ed25519Keypair.generate()];
const provision = new Transaction();
for (const [i,signer] of feeSigners.entries()) {
  const owner=signer.toSuiAddress(),addressFunded=i===1;
  for(const [type,raw] of [[SUI_TYPE_ARG,2_000_000_000n],[deep,100_000n]]) {
    const coin=provision.coin({type,balance:raw});
    if(addressFunded) provision.moveCall({target:"0x2::coin::send_funds",typeArguments:[type],arguments:[coin,provision.pure.address(owner)]});
    else provision.transferObjects([coin],owner);
  }
  const seeds=Array.from({length:addressFunded?6:3},()=>provision.moveCall({target:"0x2::coin::zero",typeArguments:["0x2::object::ID"]}));
  provision.transferObjects(seeds,owner);
}
await execute(provision);
const { deepbookFeeBudget } = await load("adapters/deepbook/deepbookQuotePolicy");
const feeBuy = await prepareFeePayingBuy({...fixture,user:feeSigners[0]},deepbookFeeBudget,appendGuardedSwap);
const quoteFunds = new Transaction();
quoteFunds.moveCall({target:"0x2::coin::send_funds",typeArguments:[feeBuy.counter],arguments:[
  quoteFunds.coin({type:feeBuy.counter,balance:feeBuy.principal}),quoteFunds.pure.address(feeSigners[1].toSuiAddress())]});
await execute(quoteFunds);
for(const [i,signer] of feeSigners.entries()) {
  const owner=signer.toSuiAddress(),mode=i===0?"coin_objects":"address_balance";
  const before=await owned(owner),baseline=await accountCard(owner,1);
  assert.equal(before.size,6);assert.equal(baseline.data.objectScanStatus,"complete");
  const startingFee=BigInt((await client.core.getBalance({owner,coinType:deep})).balance.balance);
  const bytes=await feeBuy.buildFor(owner);
  assert.equal(describeTransactionFunding(Transaction.from(bytes).getData(),owner,chain).gasMode,mode);
  const receipt=await execute(bytes,signer),after=await owned(owner);
  const {coins,created}=coinEffects(before,after,receipt,owner);
  const [feeCoin]=coins.filter(c=>c.type===coinType(deep));
  assert.ok(feeCoin);assert.equal(coins.filter(c=>c.type===coinType(deep)).length,1);
  const feeChange=feeBuy.budget-feeBuy.fee;
  assert.ok(feeChange>0n);
  assert.equal(feeCoin.raw,mode==="address_balance"?feeChange:startingFee-feeBuy.fee);
  assert.equal(created.includes(feeCoin.id),mode==="address_balance");
  assert.equal(before.has(feeCoin.id),mode==="coin_objects");
  assert.ok(coins.some(c=>c.type===coinType(SUI_TYPE_ARG)&&created.includes(c.id)&&c.raw===feeBuy.base));
  assert.ok(coins.some(c=>c.type===coinType(feeBuy.counter)&&c.raw===0n));
  const {full,capped}=await verifyAccountPages(owner,after);
  assert.equal(BigInt(full.data.balances.find(b=>normalizeStructTag(b.coinType)===deep).balance),startingFee-feeBuy.fee);
  assert.equal(full.data.balances.some(b=>normalizeStructTag(b.coinType)===feeBuy.counter),false);
  console.log(JSON.stringify({mode,separateFee:true,feeBudget:String(feeBuy.budget),paidFee:String(feeBuy.fee),
    returnedFee:String(feeChange),refundDestination:mode==="address_balance"?"new_owned_coin":"original_owned_coin",
    ownedBefore:before.size,ownedAfter:after.size,newOwnedCoins:created.length,receivedBase:String(feeBuy.base),
    realDefaultPages:full.pages.length,cappedPages:capped.pages.length,cappedStatus:capped.data.objectScanStatus,ownerMatched:true}));
}
