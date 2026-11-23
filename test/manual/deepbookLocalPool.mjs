// Isolated Sui execution fixture. Run on a disposable loopback genesis with
// its own funded keys and a v9 DeepBook + token bytecode bundle.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { DeepBookClient, OrderDeepPrice } from "@mysten/deepbook-v3";
import { bcs } from "@mysten/sui/bcs";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, SUI_TYPE_ARG } from "@mysten/sui/utils";

export async function createLocalPool(fixtureDirectory, bundlePath) {
  assert.ok(fixtureDirectory && bundlePath, "Specify a disposable genesis directory and its compiled DeepBook fixture.");
  const config = await readFile(resolve(fixtureDirectory, "client.yaml"), "utf8");
  const endpoint = /rpc: "(http:\/\/127\.0\.0\.1:\d+)"/.exec(config)?.[1];
  assert.ok(endpoint && !/https:\/\//.test(config) && config.includes("active_env: localnet"));
  const client = new SuiGrpcClient({ network: "localnet", baseUrl: endpoint });
  const chain = (await client.core.getChainIdentifier()).chainIdentifier;
  assert.notEqual(chain, "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S");
  const keys = JSON.parse(await readFile(resolve(fixtureDirectory, "sui.keystore"), "utf8")).map((key) =>
    Ed25519Keypair.fromSecretKey(Buffer.from(key, "base64").subarray(1)));
  assert.ok(keys.length >= 2);
  const [maker, user] = keys;
  async function execute(tx, signer = maker) {
    if (tx instanceof Transaction) { tx.setSender(signer.toSuiAddress()); tx.setGasBudgetIfNotSet(300_000_000n); }
    const bytes = tx instanceof Transaction ? await tx.build({ client }) : tx;
    const { signature } = await signer.signTransaction(bytes);
    const result = await client.core.executeTransaction({ transaction: bytes, signatures: [signature], include: { effects: true, objectTypes: true } });
    const data = result[result.$kind];
    assert.equal(data.effects.status.success, true, data.effects.status.error?.message);
    await client.core.waitForTransaction({ digest: data.digest, timeout: 20_000 });
    return data;
  }
  function object(result, pred) {
    const id = Object.entries(result.objectTypes).find(([, type]) => pred(type))?.[0];
    assert.ok(id, "Missing local setup object; available types: " + JSON.stringify(Object.values(result.objectTypes))); return id;
  }
  const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
  const publish = new Transaction(); publish.setGasBudget(20_000_000_000n);
  publish.transferObjects([publish.publish({ modules: bundle.modules, dependencies: bundle.dependencies })], maker.toSuiAddress());
  const issued = await execute(publish);
  const admin = object(issued, t => t.endsWith("::registry::DeepbookAdminCap"));
  const pkg = issued.objectTypes[admin].split("::")[0];
  const registry = object(issued, t => t.endsWith("::registry::Registry"));
  const deep = normalizeStructTag(pkg + "::deep::DEEP");
  const create = new Transaction();
  create.moveCall({ target: pkg+"::pool::create_pool_admin", typeArguments:[SUI_TYPE_ARG,deep], arguments:[
    create.object(registry),create.pure.u64(1000),create.pure.u64(100000000),create.pure.u64(100000000),create.pure.bool(true),
    create.pure.bool(false),create.object(admin)] });
  const manager = create.moveCall({target:pkg+"::balance_manager::new"});
  create.moveCall({target:pkg+"::balance_manager::deposit",typeArguments:[SUI_TYPE_ARG],arguments:[manager,create.splitCoins(create.gas,[2000000000n])[0]]});
  create.transferObjects([manager],maker.toSuiAddress());
  create.transferObjects([create.coin({type:deep,balance:100000n})],user.toSuiAddress());
  const setup=await execute(create);
  const poolId=object(setup,t=>t.startsWith(pkg+"::pool::Pool<")), managerId=object(setup,t=>t.endsWith("::balance_manager::BalanceManager"));
  return { maker, user, client, chain, execute, object, bundle, admin, pkg, registry, deep, poolId, managerId };
}

// Fix a base-denominated fee market, its order book, and an independently
// observed fee. Callers can either simulate price changes or inspect outputs.
export async function prepareFeePayingBuy(fixture, deepbookFeeBudget, appendGuardedSwap) {
  const { maker, user, client, execute, object, bundle, admin, pkg, registry, deep, poolId, managerId } = fixture;
  const second = new Transaction();
  second.setGasBudget(20_000_000_000n);
  second.transferObjects([second.publish({ modules: bundle.modules, dependencies: bundle.dependencies })], maker.toSuiAddress());
  const issued = await execute(second);
  const secondAdmin = object(issued, type => type.endsWith("::registry::DeepbookAdminCap"));
  const counter = normalizeStructTag(issued.objectTypes[secondAdmin].split("::")[0] + "::deep::DEEP");
  assert.notEqual(counter, deep);

  async function place(pool, quote, price, isBid, replace = false) {
    const tx = new Transaction(), mgr = tx.object(managerId);
    const proof = tx.moveCall({ target: pkg + "::balance_manager::generate_proof_as_owner", arguments: [mgr] });
    if (replace) tx.moveCall({ target: pkg + "::pool::cancel_all_orders", typeArguments: [SUI_TYPE_ARG, quote],
      arguments: [tx.object(pool), mgr, proof, tx.object.clock()] });
    tx.moveCall({ target: pkg + "::pool::place_limit_order", typeArguments: [SUI_TYPE_ARG, quote],
      arguments: [tx.object(pool), mgr, proof, tx.pure.u64(2), tx.pure.u8(0), tx.pure.u8(0), tx.pure.u64(price),
        tx.pure.u64(500_000_000n), tx.pure.bool(isBid), tx.pure.bool(true), tx.pure.u64(BigInt(Date.now()) + 3_600_000n), tx.object.clock()] });
    await execute(tx);
  }
  const createTarget = new Transaction();
  createTarget.moveCall({ target: pkg + "::pool::create_pool_admin", typeArguments: [SUI_TYPE_ARG, counter],
    arguments: [createTarget.object(registry), createTarget.pure.u64(1000), createTarget.pure.u64(100_000_000n),
      createTarget.pure.u64(100_000_000n), createTarget.pure.bool(false), createTarget.pure.bool(false), createTarget.object(admin)] });
  createTarget.moveCall({ target: pkg + "::balance_manager::deposit", typeArguments: [deep],
    arguments: [createTarget.object(managerId), createTarget.coin({ type: deep, balance: 5_000_000n })] });
  const principal = 200_000n, floor = 99_500_000n;
  createTarget.transferObjects([createTarget.coin({ type: counter, balance: principal })], user.toSuiAddress());
  const targetResult = await execute(createTarget);
  const target = object(targetResult, type => type.startsWith(pkg + "::pool::Pool<"));
  await place(poolId, deep, 1_100_000n, false, true);
  await place(poolId, deep, 900_000n, true);
  const price = new Transaction();
  price.moveCall({ target: pkg + "::pool::add_deep_price_point", typeArguments: [SUI_TYPE_ARG, counter, SUI_TYPE_ARG, deep],
    arguments: [price.object(target), price.object(poolId), price.object.clock()] });
  await execute(price);
  await place(target, counter, 2_000_000n, false);
  const terms = new Transaction();
  terms.setSender(user.toSuiAddress());
  const call = (fn, args) => terms.moveCall({ target: pkg + "::pool::" + fn, typeArguments: [SUI_TYPE_ARG, counter], arguments: [terms.object(target), ...args] });
  call("get_base_quantity_out", [terms.pure.u64(principal), terms.object.clock()]);
  call("pool_trade_params", []);
  call("get_order_deep_price", []);
  call("pool_book_params", []);
  const quote = await client.core.simulateTransaction({ transaction: terms, include: { commandResults: true } });
  assert.equal(quote.$kind, "Transaction");
  const raw = (index, slot) => bcs.U64.parse(quote.commandResults[index].returnValues[slot].bcs).toString();
  const conversion = OrderDeepPrice.parse(quote.commandResults[2].returnValues[0].bcs);
  assert.equal(conversion.asset_is_base, true);
  const base = BigInt(raw(0, 0)), fee = BigInt(raw(0, 2)), lot = BigInt(raw(3, 1));
  assert.equal(base, lot);
  assert.ok(fee > 0n);
  const budget = BigInt(deepbookFeeBudget({ sourceMoveFunction: "pool::get_base_quantity_out", deepRequired:{raw:fee.toString()}, baseOut:{raw:base.toString()},
    inputAmount:{raw:principal.toString()}, poolTerms:{lotSizeRaw:lot.toString(), assetIsBase:true, takerFeeRaw:raw(1,0), deepPerAssetRaw:conversion.deep_per_asset} },
    BigInt((await client.core.getBalance({owner:user.toSuiAddress(),coinType:deep})).balance.balance)).raw);
  assert.ok(budget > (fee * 110n + 99n) / 100n);
  async function buildFor(owner) {
    const localSdk = new DeepBookClient({ client, address: owner, network: "localnet", packageIds: { DEEPBOOK_PACKAGE_ID:pkg },
      coins: { SUI: { type:SUI_TYPE_ARG,scalar:1e9,address:"0x2" }, COUNTER: { type:counter,scalar:1e6,address:counter.split("::")[0] }, DEEP: { type:deep,scalar:1e6,address:pkg } },
      pools: { SUI_COUNTER: { address:target,baseCoin:"SUI",quoteCoin:"COUNTER" } } });
    const tx=new Transaction();tx.setSender(owner);tx.setGasBudget(50_000_000n);
    appendGuardedSwap(tx,localSdk,{poolKey:"SUI_COUNTER",poolId:target,baseType:SUI_TYPE_ARG,quoteType:counter,deepType:deep,account:owner,
      direction:"quote_to_base",principal,minimum:floor,deepBudget:budget});
    return tx.build({client});
  }
  return { target, counter, base, lot, principal, fee, budget, buildFor, place };
}
