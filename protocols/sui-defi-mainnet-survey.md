# Sui DeFi Mainnet Contract Survey

Status: GitHub-tracked protocol research note. This file is not an npm package
document, not an MCP resource, not a registry allowlist, not a supported-protocol
list, not a live liquidity source, not a quote source, not a route
recommendation source, not signing readiness, and not a safety guarantee.

Use this note only for source provenance behind the implemented transaction-activity
labels. Before any entry is used in a registry,
adapter, signable review path, or user-facing support claim, re-check the
official protocol source, verify the connected chain identifier is Sui mainnet,
inspect the package or object onchain, and compare the result with the pinned
SDK/source that this repository actually uses.

The implemented matching rules and their limits are described in
`protocols/sui-defi-activity-classifier-spec.md`. This file does not set future
adapter, inventory, routing or signing requirements.

## Current Product Boundary

Current transaction activity tools may expose called Move packages, modules,
functions, raw balance changes, object changes, events, gas facts, execution
errors, and conservative `compact.protocolMatches` labels from user-requested
bounded scans. This research note can help a human or agent review the evidence
behind those labels. It does not add wallet position discovery, staked or LP
inventory, route comparison, payment readiness, transaction building, signing,
or execution.

`compact.protocolMatches` is a transaction activity label only. It is not a
supported-protocol list, protocol registry, shared-object verification, wallet
position inventory, P&L, route quality, transaction-building input, signing
data, or signing readiness.

## Source Priority

1. Verified Move Registry name resolution for package at the source snapshot IDs when the
   protocol has an official or otherwise verified MVR name.
2. Official protocol documentation or official dynamic config endpoint.
3. Official Move contract, interface, or SDK GitHub repository.
4. Published SDK constants only when the protocol points developers to that SDK.

When a package at the source snapshot or object address is not exposed by a directly
verifiable source, this note marks the gap instead of filling it from memory.
MVR resolves packages and types; it does not replace shared object verification
for pools, vaults, market objects, registries, caps, or per-user state.

## MVR Resolution Source

Resolution source: direct POST to `https://mainnet.mvr.mystenlabs.com/v1/resolution/bulk`.

| MVR name | Resolved package at the source snapshot | Survey use |
| --- | --- | --- |
| `@deepbook/core` | `0xf48222c4e057fa468baf136bff8e12504209d43850c5778f76159292a96f621e` | Pinned SDK/local registry DeepBook package. The newer Sui docs package remains a conflict until reconciled deliberately. |
| `@deeptrade/deeptrade-core` | `0xc10d536b6580d809711b9bb8eee3945d5e96f92a346c84d74ff7a0697e664695` | DeepTrade Core package at the source snapshot. |
| `@cetuspackages/clmm` | `0x25ebb9a7c50eb17b3fa9c5a30fb8b5ad8f97caaf4928943acbcff7153dfee5e3` | Cetus CLMM package at the source snapshot. |
| `@suilend/core` | `0xe53906c2c058d1e369763114418f3c144d1b74960d29b2785718a782fec09b61` | Suilend current MVR package; the recorded market type package remains separate evidence. |

The same probe did not resolve the guessed names `@deeptrade/core`,
`@aftermath/afsui`, `@aftermath/aftermath`, `@aftermath/staking`,
`@aftermath/liquid-staking`, or `@aftermath-finance/afsui`. Do not add an MVR
name for those surfaces without a verified source or a successful resolution.

## Snapshot Maintenance

This survey records source snapshot status for transaction activity labels only.
It is not a supported-protocol inventory and does not create runtime registry
authority. Treat package addresses below as static reviewed snapshots until a
deliberate refresh compares current MVR resolution, historical package IDs, and
the source material named in each row.

MVR current package resolution is package provenance, not a freshness guarantee
for future labels. Shared objects require separate source or mainnet object
verification because MVR does not verify registries, pools, vaults, markets,
caps, or protocol configuration objects. Changing a package, shared object,
source note, or label claim must be paired with classifier docs/tests before it
is treated as current activity-label evidence.

## Survey Table

### DeepBook V3 and DeepBook Margin

Research sources:

- Sui DeepBook V3 contract information.
- Sui DeepBook Margin contract information.
- MystenLabs DeepBook source.
- The source snapshot accepted for the classifier; current runtime SDK versions are in `docs/SDK_API.md`.

Mainnet addresses recorded in the research snapshot:

| Surface | Address | Source note |
| --- | --- | --- |
| DeepBook V3 MVR package at the source snapshot | `0xf48222c4e057fa468baf136bff8e12504209d43850c5778f76159292a96f621e` | `@deepbook/core`, recorded mainnet MVR resolution. |
| DeepBook V3 package at the source snapshot, version 6 | `0x337f4f4f6567fcd778d5454f27c16c70e2f274cc6377ea6249ddf491482ef497` | Sui docs current version in the recorded source material. |
| DeepBook V3 registry | `0xaf16199a2dff736e9f07a845f23c5da6df6f756eddb631aed9d24a93efc4549d` | Sui docs. |
| DeepBook Margin package at the source snapshot, version 3 | `0xfbd322126f1452fd4c89aedbaeb9fd0c44df9b5cedbe70d76bf80dc086031377` | Sui docs current version in the recorded source material. |
| DeepBook Margin registry | `0x0e40998b359a9ccbab22a98ed21bd4346abf19158bc7980c8291908086b3a742` | Sui docs. |

The accepted classifier snapshot records the `@deepbook/core` package above
and the different documentation package as separate provenance. Current DeepBook
reads use the pinned SDK package; the installed version is listed in
`docs/SDK_API.md`. These records are not a fresh resolution or permission to
change transaction-building packages.

Surfaces identified by the research snapshot:

- DeepBook V3: central limit order book pool, limit order, market order, order
  modification, cancellation, settled amount withdrawal, orderbook read, quote
  quantity read, swap, rebate, referral, permissionless pool creation, flash
  loan entry point in the pinned SDK, governance and staking entry points.
- DeepBook Margin: leveraged position, borrow, margin pool, supplier deposit,
  collateral and risk parameters, interest accrual, conditional order, and
  liquidation mechanism.

### DeepTrade Core

The package and object records below explain only the implemented DeepTrade
transaction-activity label; they do not expose a DeepTrade adapter or inventory.

Research sources:

- DeeptradeProtocol GitHub organization.
- DeeptradeProtocol/deeptrade-core README, examples, and docs.
- DeepTrade web app.
- Direct Sui mainnet object lookup. This was evidence collection only and is not
  a Sui MCP runtime path.

Mainnet addresses recorded in the research snapshot:

| Surface | Address | Source note |
| --- | --- | --- |
| DeepTrade Core package at the source snapshot | `0xc10d536b6580d809711b9bb8eee3945d5e96f92a346c84d74ff7a0697e664695` | `@deeptrade/deeptrade-core`, recorded mainnet MVR resolution; official examples/constants and direct mainnet object lookup. |
| Treasury object | `0xb90e2d3de41817016b7d39f49c724c5b0616bd30f1d5e6383048efafabe6232b` | Shared `::treasury::Treasury`; `allowed_versions=[1]` at lookup time. |
| AdminCap | `0xe92f79ac54409c9eecfd77ce1089edd9b424b87c6cba8aa99c8fedb64d0e0b8b` | README and direct object lookup. |
| UpgradeCap | `0x331c41b3587619223c8ccf44b2aa9ad683fae7b536d6b5ed96fc94fe9a8d4278` | README and direct object lookup. |
| PoolCreationConfig | `0xe6a7158cbbee252f2ef9488663d91b42d84b3933609c3f891937240f4be65086` | Shared `::dt_pool::PoolCreationConfig`. |
| TradingFeeConfig | `0xcb757e55db3a502dc826c40b8ced507d017b41d926c5bf554e69855510bb855e` | Shared `::fee::TradingFeeConfig`. |
| LoyaltyProgram | `0x6a06100001533356fb2e9f68ee299c15565777dfb28c741ec440cb08b168cbff` | Shared `::loyalty::LoyaltyProgram`. |
| LoyaltyAdminCap | `0xdbd798144ab62ec0a47634ca01c53464327f35f04f44a443fbceadfd1ab59b4a` | Shared `::loyalty::LoyaltyAdminCap`. |
| MultisigConfig | `0x1c5ed495552bb63cc46bf513a577b9e63c8f1cc7f9f472109a86f6d0a660e8a4` | Shared `::multisig_config::MultisigConfig`, threshold `3` at lookup time. |
| MultisigAdminCap | `0x28137b5c913874f74615def7237243d066f52d6199dda8672f0e74daafa0951e` | Direct object lookup. |

Surfaces identified by the research snapshot:

- DeepBook order book wrappers: limit order, market order, whitelisted order,
  input-coin-fee order, cancellation, and fee settlement.
- Input coin fee swaps and output coin protocol fee handling.
- DEEP fee abstraction across user DEEP, BalanceManager DEEP, Treasury DEEP
  reserve, and SUI-paid DEEP reserve coverage fee.
- Per-user FeeManager, unsettled maker fees, protocol fee settlement, storage
  rebate claim.
- Dynamic taker and maker protocol fees, loyalty discounts, permissionless
  DeepBook pool creation wrapper, protocol creation fee, multisig, timelock, and
  version allowlist administration.

The DeepTrade app also shows Margin and Earn surfaces. The research snapshot
does not prove those are supported by DeepTrade Core alone; they may require
DeepBook Margin package and registry verification.

### Cetus

Research sources:

- Cetus CLMM contract docs and getting-started docs.
- Cetus CLMM interface GitHub.
- Cetus CLMM SDK GitHub.
- Cetus contracts GitHub.

Mainnet addresses recorded in the research snapshot:

| Surface | Address | Source note |
| --- | --- | --- |
| CLMM package at the source snapshot | `0x25ebb9a7c50eb17b3fa9c5a30fb8b5ad8f97caaf4928943acbcff7153dfee5e3` | `@cetuspackages/clmm`, recorded mainnet MVR resolution; Cetus CLMM docs, MVR version 14. |
| CLMM global config object | `0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f` | Cetus getting-started docs. |
| CLMM pools table object | `0xf699e7f2276f5c9a75944b37a0c5b5d9ddfd2471bf6242483b03ab2887d198d0` | Cetus getting-started docs, mainnet tab. |

Surfaces identified by the research snapshot:

- Concentrated liquidity market maker pool.
- Swap, pool data read, position and liquidity management, fee and reward
  collection, liquidity math, tick math, sqrt price math, and coin amount
  conversion helpers.
- DCA, limit order, farming, vaults, LP burn, dividends, and xCETUS interfaces
  exist in related repositories, but this note does not claim current mainnet
  package addresses for those modules.

### Suilend

Research sources:

- Suilend SDK types reference.
- Suilend contract GitHub.

Mainnet addresses recorded in the research snapshot:

| Surface | Address |
| --- | --- |
| MVR package at the source snapshot (`@suilend/core`) | `0xe53906c2c058d1e369763114418f3c144d1b74960d29b2785718a782fec09b61` |
| Main market object | `0x84030d26d85eaa7035084a057f2f11f701b7e2e4eda87551becbc7c97505ece1` |
| Main market type package | `0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf` |
| Main market owner cap | `0xf7a4defe0b6566b6a2674a02a0c61c9f99bd012eed21bc741a069eaa82d35927` |

Surfaces identified by the research snapshot:

- Money market lending: deposit, withdraw, borrow, repay, liquidation, and
  reward event surfaces.
- Reserve, obligation, obligation owner cap, fee receiver, cToken mint/redeem,
  interest update, isolated asset, and risk configuration.
- SpringSui and STEAMM are separate product surfaces and are not implied by the
  main market addresses above.

### Aftermath Finance

Research sources:

- Aftermath afSUI contract docs.
- Aftermath pool contract docs.
- Aftermath TypeScript SDK GitHub.

Mainnet addresses recorded in the research snapshot:

| Surface | Address |
| --- | --- |
| afSUI liquid staking/events package | `0x7f6ce7ade63857c4fd16ef7783fed2dfc4d7fb7e40615abdb653030b76aef0c6` |
| afSUI package | `0x1575034d2729907aefca1ac757d6ccfcd3fc7e9e77927523c06007d8353ad836` |
| stakedSuiVault object | `0x2f8f6d5da7f13ea37daa397724280483ed062769813b6f31e9788e59cc88994d` |
| stakedSuiVaultState object | `0x55486449e41d89cfbdb20e005c1c5c1007858ad5b4d5d7c047d2b3b592fe8791` |
| afSUI treasury object | `0xd2b95022244757b0ab9f74e2ee2fb2c3bf29dce5590fa6993a85d64bd219d7e8` |
| AMM package | `0xefe170ec0be4d762196bedecd7a065816576198a6527c99282a2551aaa7da38c` |
| AMM interface package | `0x0625dc2cd40aee3998a1d6620de8892964c15066e0a285d8b573910ed4c75d50` |
| Pool registry object | `0xfcc774493db2c45c79f688f88d28023a3e7d98e4ee9f48bbf5c7990f651577ae` |

Surfaces identified by the research snapshot:

- afSUI liquid staking: stake, unstake, exchange-rate read, epoch handling,
  referral, and treasury components.
- The first transaction activity classifier pass uses the afSUI package rows
  only for event/object/package evidence until callable entrypoints are
  verified.
- AMM pool, liquidity provider position, pool registry, protocol fee vault,
  treasury, insurance fund, and LP coin table.
- Routing, DCA, limit order, farm, perpetual, and dynamic gas surfaces require
  separate package and object verification.

## Label Maintenance

Do not add adapters, registry entries, inventory reads or MCP tools from this
source note. A deliberate classifier refresh must verify the relevant source
and mainnet package/object facts, preserve historical attribution separately
from current package claims, and update the matching contract and tests together.
