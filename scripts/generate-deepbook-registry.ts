import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  mainnetCoins,
  mainnetMarginPools,
  mainnetPackageIds,
  mainnetPools
} from "@mysten/deepbook-v3";

const outputPath = resolve("registry/generated/deepbook-mainnet.json");

const registry = {
  generatedAt: new Date().toISOString(),
  network: "mainnet",
  source: "@mysten/deepbook-v3@2.6.4 exported mainnet constants",
  generator: "scripts/generate-deepbook-registry.ts",
  note:
    "This file is local policy/known metadata, not live liquidity, balances, quotes, or final execution truth.",
  packages: mainnetPackageIds,
  coins: mainnetCoins,
  pools: mainnetPools,
  marginPools: mainnetMarginPools
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
process.stderr.write(`Generated ${outputPath}\n`);
