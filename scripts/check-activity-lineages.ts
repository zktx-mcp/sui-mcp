// Read-only release check for the installed transaction-activity rules.
import { activityPackageFamilies } from "../src/core/activity/transactionActivityLineages.js";
import { DEFAULT_SUI_GRAPHQL_URL, SUI_MAINNET_CHAIN_IDENTIFIER } from "../src/runtime/suiEndpoint.js";
import { mainnetPackageIds } from "@mysten/deepbook-v3";
import { isDeepStrictEqual } from "node:util";

async function query<T>(query: string, variables: Record<string, unknown>) {
  const response = await fetch(DEFAULT_SUI_GRAPHQL_URL, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw Error(`Package provenance HTTP ${response.status}`);
  const result = await response.json() as { data?: T & { chainIdentifier:string }; errors?:unknown };
  if (result.errors || result.data?.chainIdentifier !== SUI_MAINNET_CHAIN_IDENTIFIER) throw Error("Could not verify the mainnet package source.");
  return result.data;
}
type PackagePage = { packageVersions: { nodes:{address:string;version:number}[]; pageInfo:{hasNextPage:boolean;endCursor:string} } };
const generated: Record<string, { checkpoint: number; versions: string[]; types: Record<string, string[]> }> = {};
async function readVersions(name: string, origin: string, checkpoint?: number) {
  let cursor: string | null = null;
  const addresses: string[] = [];
  do {
    const selection = "packageVersions(address:$address,first:40,after:$cursor){nodes{address version} pageInfo{hasNextPage endCursor}}";
    const vars = { address: origin, cursor, ...(checkpoint === undefined ? {} : { cp: checkpoint }) };
    const page: PackagePage | null = checkpoint === undefined
      ? await query<PackagePage>(`query($address:SuiAddress!,$cursor:String){chainIdentifier ${selection}}`, vars)
      : (await query<{ checkpoint: { query: PackagePage } | null }>(
          `query($address:SuiAddress!,$cursor:String,$cp:UInt53!){chainIdentifier checkpoint(sequenceNumber:$cp){query{${selection}}}}`, vars)).checkpoint?.query ?? null;
    if (!page) throw Error(`Historical package data unavailable for ${name} at checkpoint ${checkpoint}`);
    for (const row of page.packageVersions.nodes) {
      if (row.version !== addresses.length + 1) throw Error(`Discontinuous package history for ${name}`);
      addresses.push(row.address);
    }
    const next: PackagePage["packageVersions"]["pageInfo"] = page.packageVersions.pageInfo;
    if (next.hasNextPage && (!next.endCursor || cursor === next.endCursor)) throw Error("Package cursor did not advance.");
    cursor = next.hasNextPage ? next.endCursor : null;
  } while (cursor);
  return addresses;
}
// @mysten/deepbook-v3 2.13.0 targets DeepBook core v9 on mainnet.
const financialPackageVersion = 9;
for (const [name, expected] of Object.entries(activityPackageFamilies)) {
  const origin = expected.versions[0]!;
  const [pinned, addresses] = await Promise.all([readVersions(name, origin, expected.checkpoint), readVersions(name, origin)]);
  if (!pinned.length || !isDeepStrictEqual(addresses.slice(0, pinned.length), pinned)) throw Error(`Mainnet history changed for ${name}`);
  if (name === "deepbook-v3" && pinned[financialPackageVersion - 1] !== mainnetPackageIds.DEEPBOOK_PACKAGE_ID) throw Error("The installed SDK package is different from the approved DeepBook v9 financial target.");
  const { package: pkg } = await query<{package:{typeOrigins:{definingId:string;module:string;struct:string}[]}}>(
    "query($id:SuiAddress!){chainIdentifier package(address:$id){typeOrigins{definingId module struct}}}",{id:pinned.at(-1)});
  const types: Record<string,string[]> = {};
  for (const origin of pkg.typeOrigins) (types[origin.definingId] ??= []).push(`${origin.module}::${origin.struct}`);
  for (const names of Object.values(types)) names.sort();
  generated[name] = { checkpoint: expected.checkpoint, versions: pinned, types: Object.fromEntries(Object.entries(types).sort(([a], [b]) => a.localeCompare(b))) };
  if (!process.argv.includes("--json") && !isDeepStrictEqual(generated[name], expected)) throw Error(`Reconcile the defining type origins for ${name} before release.`);
  if (addresses.length > expected.versions.length) console.warn(`Unclassified mainnet versions for ${name}: ${addresses.slice(expected.versions.length).join(", ")}`);
  console.error(`Verified ${name}: ${expected.versions.length} package versions, ${pkg.typeOrigins.length} type origins.`);
}
if (process.argv.includes("--json")) console.log(JSON.stringify(generated, null, 2));
