# Sui DeFi Activity Classifier Spec

Status: GitHub-tracked research specification. This file is not an npm package
document, not an MCP resource, not a runtime registry, not a registry allowlist,
not a supported-protocol list, not a live liquidity source, not a quote source,
not a route recommendation source, not signing readiness, and not a safety
guarantee.

Use this note to review the first-pass transaction activity classifier that is
derived from already available activity detail facts. Do not add adapters,
registry entries, or MCP tools from this note alone.

## Purpose

The immediate product problem is that users can ask for recent Sui wallet
activity and need the answer grouped by likely DeFi protocol and action type.
The current activity scan stores and returns transaction-level facts such as
Move calls, raw balance changes, object changes, events, gas facts, and
execution errors. Those facts are enough to design conservative protocol
attribution rules. They are not enough to infer wallet positions, portfolio
exposure, P&L, route quality, or signing readiness.

This spec defines the first classifier candidate set and the evidence rules used
by the current pure classifier helper.

## Implementation Status

The first-pass classifier is implemented as a pure core helper at
`src/core/activity/transactionActivityClassifier.ts` and is exposed only through
derived `compact.protocolMatches` fields on transaction activity responses. It
does not read this Markdown file at runtime, does not call network providers,
does not write protocol labels to the local database, and does not change
GraphQL queries, settings, review sessions, wallet identity, or signable action
behavior.

The current implementation is intentionally limited to transaction activity
attribution. It does not promote any protocol to `read_list_supported_protocols`
and does not add protocol-specific read tools.

Current package rules are static mainnet research snapshots. The classifier does
not perform runtime MVR lookups. `mvrName` records the verified name used when
the package snapshot was accepted; it is evidence provenance, not a freshness
guarantee.

Maintenance policy: update package rules only through a deliberate source
refresh. A refresh is required when this classifier adds or changes package
rules, shared-object rules, source provenance, protocol-label claims, or matching
behavior. Refresh work must compare the current MVR resolution with historical
package IDs and keep those two categories separate. A matching behavior change
that can change whether a transaction emits a label, which label it emits, or
which evidence/limitation fields it emits must update docs and tests in the same
change and update `SUI_DEFI_ACTIVITY_CLASSIFIER_VERSION`. A docs-only source note
change that does not alter output may keep the current classifier version.

Shared-object evidence is a separate false-positive boundary. MVR resolves
package and type names; it does not verify shared objects such as registries,
vaults, markets, pools, caps, or protocol configuration objects. A
shared-object-only match must remain `matchBasis: "shared_object"` with no
inferred action type unless a separate reviewed source verifies action-specific
semantics.

## Input Facts

The classifier may use only facts already represented by the transaction
activity detail model:

- Move call target: package, module, function, and command index.
- Balance change: owner when present, coin type, raw integer amount, and
  direction.
- Object change: object id, change kind, input type, and output type.
- Event: event type, sender when present, and sequence number.
- Gas: raw computation, storage, rebate, non-refundable storage, and net gas
  costs.
- Execution error: message and parsed abort location when present.
- Truncation flags.

The classifier must not inspect raw GraphQL payloads, transaction bytes,
signatures, BCS payloads, private keys, session tokens, or provider-only fields
that are not part of the normalized transaction activity detail model.

## Implemented Rule Scopes

The classifier has the following transaction-label scopes:

| Protocol | Activity category | Source scope | Matching boundary |
| --- | --- | --- | --- |
| DeepBook V3 | CLOB / order book | Existing product context and pinned SDK source expose order, swap, settlement, BalanceManager, DEEP fee, and rebate concepts. | Order-book package/module/function labeling without adding signing support. |
| Cetus CLMM | CLMM / AMM | The survey records a CLMM package plus global config and pools table objects. | Pool/table and position-object style signals that are not order-book signals. |
| Suilend Lending | Lending market | The survey records a main market object, market type package, and lending surfaces. | Reserve, obligation, cToken, borrow, repay, and liquidation style signals. |
| Aftermath afSUI | Liquid staking | The survey records afSUI packages, vault objects, treasury, and staking surfaces. | Receipt-token, vault, treasury, event/object, and exchange-rate-adjacent signals; direct stake/unstake labels require callable entrypoint verification. |
| DeepTrade Core | DeepBook wrapper and fee system | Package and object evidence for a wrapper; overlaps the CLOB assetGroup but adds FeeManager, Treasury, loyalty, and reserve coverage signals. | Wrapper-vs-underlying attribution and fee-system evidence. |

A matching rule does not establish protocol support or reduce its evidence
requirements.

## Evidence Hierarchy

Classifier matches must be versioned and evidence-based. The current matching hierarchy is:

1. Direct Move package/module/function match.
2. Event type package/module match.
3. Object type package/module match.
4. Known shared object id match.
5. Balance change asset flow as supporting evidence only.
6. Gas or execution error as supporting evidence only.

Balance changes alone do not identify a protocol. Gas facts alone do not
identify a protocol. Execution error text alone does not identify a protocol.
Shared object use can identify the protocol surface touched by the transaction,
but it does not prove the user's wallet owns a protocol position.

Package rules can be scoped by evidence kind. A package recorded only as a type
package must not create `direct_move_call` matchBasis.

If multiple protocols match, preserve all evidence and choose one primary label
only when a direct wrapper package is present. For example, a DeepTrade Core
Move call should be the primary label even when the transaction also touches
DeepBook dependency objects. The DeepBook evidence should remain attached as an
underlying or related signal, not as a separate unsupported position claim.

## Output Projection

This is the current conceptual shape used by `compact.protocolMatches`; exact
tool output schemas live in the TypeScript source.

```ts
type ProtocolActivityClassifierMatch = {
  classifierVersion: string;
  protocolId: string;
  displayName: string;
  activityCategory: string;
  primaryAction:
    | "order"
    | "swap"
    | "liquidity"
    | "lending"
    | "fee_or_reward"
    | "admin_or_versioning"
    | "unknown";
  matchBasis:
    | "direct_move_call"
    | "event_type"
    | "object_type"
    | "shared_object";
  evidence: Array<
    | {
        kind: "moveCall";
        package: string;
        packageSource?: string;
        mvrName?: string;
        module: string;
        function: string;
        commandIndex: number;
      }
    | {
        kind: "eventType";
        package?: string;
        packageSource?: string;
        mvrName?: string;
        eventType: string;
        sequenceNumber?: string;
      }
    | {
        kind: "objectType";
        objectId: string;
        changeKind: string;
        package?: string;
        packageSource?: string;
        mvrName?: string;
        type: string;
      }
    | { kind: "sharedObject"; objectId: string; label: string }
  >;
  relatedProtocols: Array<{ protocolId: string; reason: string }>;
  limitations: string[];
};
```

Rules for the output:

- `protocolId` is an attribution label for the transaction, not a wallet
  position and not a support claim.
- `primaryAction` is a coarse activity group, not a protocol-specific action
  decoder. When a transaction has multiple matched calls for the same protocol,
  core user-action groups such as order, swap, liquidity, and lending take
  precedence over helper fee/reward or admin/versioning calls.
- `packageSource` and `mvrName` record why the package match is accepted. When a
  verified MVR name exists, include it in the package-derived evidence.
- `amountRaw` values remain raw integer strings. The classifier must not format,
  price, round, or infer token decimals.
- Balance changes, gas, and execution errors can support the human summary in
  `compact`, but the current classifier does not emit them as protocol evidence
  variants by themselves.
- `limitations` must name truncation, package conflicts, wrapper dependency
  evidence, or missing object/event details.

## First-Pass Rule Records

These records shape the first classifier implementation. They are not runtime
registry policy and do not imply support beyond transaction activity labels.

### DeepBook V3

Boundary:

- The survey records a conflict between newer Sui docs and this repository's
  pinned SDK/local registry. A classifier implementation must choose the package
  source that matches the transaction path it actually inspects.
- Current product DeepBook read tools follow the pinned SDK/local registry path.
  Do not infer execution or signing support from that.

Direct Move-call evidence:

- `pool::place_limit_order`
- `pool::place_market_order`
- `pool::modify_order`
- `pool::cancel_order`
- `pool::cancel_orders`
- `pool::cancel_live_order`
- `pool::cancel_live_orders`
- `pool::cancel_all_orders`
- `pool::withdraw_settled_amounts`
- `pool::withdraw_settled_amounts_permissionless`
- `pool::swap_exact_base_for_quote`
- `pool::swap_exact_base_for_quote_with_manager`
- `pool::swap_exact_quote_for_base`
- `pool::swap_exact_quote_for_base_with_manager`
- `pool::swap_exact_quantity`
- `pool::swap_exact_quantity_with_manager`
- `pool::stake`
- `pool::unstake`
- `pool::claim_rebates`
- `pool::borrow_flashloan_base`
- `pool::borrow_flashloan_quote`
- `pool::return_flashloan_base`
- `pool::return_flashloan_quote`
- `balance_manager::deposit`
- `balance_manager::deposit_with_cap`
- `balance_manager::withdraw`
- `balance_manager::withdraw_with_cap`
- `balance_manager::withdraw_all`
- `balance_manager::mint_trade_cap`
- `balance_manager::mint_deposit_cap`
- `balance_manager::mint_withdraw_cap`

Action grouping:

- Order: place, modify, cancel, settle.
- Swap: swap exact base/quote/quantity functions.
- Fee or reward: claim rebate/referral reward functions.
- Liquidity or reserve: BalanceManager deposit/withdraw and open-order balance
  movement. Do not label this as wallet portfolio inventory.
- Admin or versioning: pool creation, admin, governance, version, staking, or
  referral configuration functions.

False-positive controls:

- A pool object or BalanceManager object match without a DeepBook package call
  is `shared_object` matchBasis at most.
- A DEEP balance delta can support a fee/rebate explanation but must not create
  a DeepBook label by itself.
- DeepBook dependency evidence inside a DeepTrade transaction should be related
  evidence when DeepTrade's package call is direct.

### DeepTrade Core

Boundary:

- The implemented DeepTrade rule labels a DeepBook wrapper in normalized
  transaction facts.
- DeepTrade app Margin and Earn surfaces are not classified in the first pass
  unless their concrete package/module/function evidence is separately verified.

Direct Move-call evidence:

- Package:
  `0xc10d536b6580d809711b9bb8eee3945d5e96f92a346c84d74ff7a0697e664695`
- Order module `dt_order`:
  - `create_limit_order`
  - `create_market_order`
  - `create_limit_order_whitelisted`
  - `create_market_order_whitelisted`
  - `create_limit_order_input_fee`
  - `create_market_order_input_fee`
  - `cancel_order_and_settle_fees`
- Swap module `swap`:
  - `swap_exact_base_for_quote_input_fee`
  - `swap_exact_quote_for_base_input_fee`
  - `get_quantity_out_input_fee`
- Pool creation module `dt_pool`:
  - `create_permissionless_pool`

Object and fee evidence:

- Treasury object:
  `0xb90e2d3de41817016b7d39f49c724c5b0616bd30f1d5e6383048efafabe6232b`
- PoolCreationConfig object:
  `0xe6a7158cbbee252f2ef9488663d91b42d84b3933609c3f891937240f4be65086`
- TradingFeeConfig object:
  `0xcb757e55db3a502dc826c40b8ced507d017b41d926c5bf554e69855510bb855e`
- LoyaltyProgram object:
  `0x6a06100001533356fb2e9f68ee299c15565777dfb28c741ec440cb08b168cbff`

Action grouping:

- Order: `dt_order` order placement or cancellation.
- Swap: `swap` input-fee swap calls.
- Fee or reward: fee manager, unsettled fee, Treasury, loyalty, or reserve
  coverage evidence.
- Admin or versioning: multisig, timelock, admin, version, and allowed-version
  evidence.

False-positive controls:

- If both DeepTrade and DeepBook evidence are present, the direct DeepTrade call
  is the primary label and DeepBook is related evidence.
- Treasury or TradingFeeConfig object use without a DeepTrade package call is
  `shared_object` matchBasis at most.
- Do not label Margin or Earn from the web-app surface name. Require concrete
  package/module/function evidence.

### Cetus CLMM

Boundary:

- First pass covers the CLMM package, global config object, and pools table
  object recorded in the survey.
- DCA, farming, limit order, vault, dividends, and xCETUS require separate
  package verification.

Direct evidence:

- CLMM published-at package:
  `0x25ebb9a7c50eb17b3fa9c5a30fb8b5ad8f97caaf4928943acbcff7153dfee5e3`
- Global config object:
  `0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f`
- Pools table object:
  `0xf699e7f2276f5c9a75944b37a0c5b5d9ddfd2471bf6242483b03ab2887d198d0`

Action grouping:

- Swap: direct package calls whose module/function evidence is verified as CLMM
  swap logic.
- Liquidity: position object create/mutate/delete evidence paired with the CLMM
  package, config, or pools table.
- Fee or reward: fee/reward event or object evidence paired with CLMM package
  evidence.

False-positive controls:

- A position object change without package or object evidence is not enough for
  a Cetus label.
- CLMM package evidence must not imply position inventory, range, fee APR, or
  liquidity valuation.
- If the transaction only has coin deltas, keep it as asset flow with no
  protocol label.

### Suilend Lending

Boundary:

- First pass covers the Suilend main market facts recorded in the survey.
- SpringSui and STEAMM are separate product surfaces and are not included.

Direct evidence:

- Main market object:
  `0x84030d26d85eaa7035084a057f2f11f701b7e2e4eda87551becbc7c97505ece1`
- Main market type package for object or event type evidence only:
  `0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf`
- Main market owner cap:
  `0xf7a4defe0b6566b6a2674a02a0c61c9f99bd012eed21bc741a069eaa82d35927`

Action grouping:

- Lending: deposit, withdraw, borrow, repay, liquidation, and cToken mint/redeem
  calls after module/function verification.
- Fee or reward: reward events or fee receiver evidence after event/object
  verification.
- Admin or versioning: risk config, isolated asset, reserve configuration, or
  owner-cap evidence.

False-positive controls:

- Market object use can indicate Suilend activity but not the user's current
  obligation or health.
- cToken or balance changes must remain raw asset-flow facts unless paired with
  verified action evidence.
- Do not compute health factor, liquidation risk, APY, or P&L in the classifier.

### Aftermath afSUI

Boundary:

- First pass covers afSUI liquid staking packages, vault objects, treasury, and
  staking event package recorded in the survey.
- Aftermath AMM, routing, DCA, limit order, farm, perpetual, and dynamic gas are
  separate surfaces.

Direct evidence:

- afSUI liquid staking/events package for object or event type evidence until
  direct callability is verified:
  `0x7f6ce7ade63857c4fd16ef7783fed2dfc4d7fb7e40615abdb653030b76aef0c6`
- afSUI package for object or event type evidence only:
  `0x1575034d2729907aefca1ac757d6ccfcd3fc7e9e77927523c06007d8353ad836`
- stakedSuiVault object:
  `0x2f8f6d5da7f13ea37daa397724280483ed062769813b6f31e9788e59cc88994d`
- stakedSuiVaultState object:
  `0x55486449e41d89cfbdb20e005c1c5c1007858ad5b4d5d7c047d2b3b592fe8791`
- afSUI treasury object:
  `0xd2b95022244757b0ab9f74e2ee2fb2c3bf29dce5590fa6993a85d64bd219d7e8`

Action grouping:

- The first classifier pass does not emit an Aftermath primary action from Move
  calls because direct callable entrypoints have not been verified.
- Event and object evidence can identify the afSUI surface, but `primaryAction`
  remains `unknown`.
- Future stake, unstake, receipt-token mint/burn, fee, reward, or treasury
  labels require verified callable entrypoints or verified event semantics.

False-positive controls:

- afSUI balance changes can support the label but must not prove exchange rate,
  delayed-unstake availability, validator exposure, or staking recommendation.
- Vault object evidence without package/event evidence is `shared_object`
  matchBasis at most.
- AMM package evidence belongs to a later Aftermath AMM classifier rule, not this
  afSUI rule.

## Conflict And Ambiguity Rules

Use these rules before adding code:

- If the transaction details are truncated for Move calls, object changes, or
  events, classify only the returned facts, preserve their actual `matchBasis`,
  and include the applicable truncation limitations. Missing details do not
  establish that an activity did not occur.
- If a package ID has a conflict between official docs, SDK constants, local
  registry, or onchain lookup, the classifier must name the chosen source in its
  classifier version notes.
- If a verified MVR name exists, classifier package evidence should record the
  MVR name and the resolved current package ID. Keep package records for
  transaction interpretation separate from current package claims.
- If only a shared object id matches, mark the matchBasis `shared_object` and do
  not infer action type unless the object is action-specific and verified.
- If only event type matches, mark the matchBasis `event_type` and preserve the
  event type as evidence.
- If wrapper and underlying protocol evidence both appear, prefer the wrapper as
  primary only when the wrapper package is directly called.
- If a function name is generic, such as `swap`, `deposit`, or `withdraw`, it
  must be scoped by package and module. Function name alone is never a match.
- If a transaction has no protocol evidence, return no classifier match. Do not
  invent an "unknown DeFi" label.

## Fixture Requirements Before Implementation

Before extending the classifier, gather fixture transactions or synthetic
fixtures from the normalized detail model for:

- One direct DeepBook order or swap.
- One DeepTrade wrapper action that also has DeepBook-related evidence.
- One Cetus CLMM swap or liquidity action.
- One Suilend deposit, borrow, repay, or liquidation-like action.
- One Aftermath afSUI event/object evidence case. Add a separate direct
  stake/unstake fixture only after callable entrypoints are verified.
- One no-match transfer with only balance changes.
- One ambiguous shared-object-only case.
- One truncated-details case.

The fixtures must assert that the classifier does not produce:

- wallet positions,
- P&L,
- tax labels,
- route quality,
- liquidation advice,
- staking recommendation,
- transaction building inputs,
- signing readiness,
- or protocol support claims.

## Implementation Boundary

The current code is a pure classifier over existing transaction activity
details. It must not change GraphQL queries, local database schemas, MCP tool
authority, settings, review sessions, wallet identity, or signable action
behavior unless a separate plan closes those boundaries.

The code home is a core activity helper used by the existing transaction
activity output path. The helper takes normalized detail facts and returns
versioned matches. It does not call network providers and does not read static
Markdown files at runtime.

## Function Activity Source Boundary

This section records the source evidence and limits for the implemented
`read_scan_sui_function_activity` and `read_summarize_sui_function_activity_scan`
tools. Their current input and output contracts are in
[MCP Tools](../docs/MCP_TOOLS.md#read-only-tools).
They use only the accepted sent-address combinations listed here. Broader
function diagnostics are outside the current boundary.

The pinned generated GraphQL schema exposes `TransactionFilter.function`,
`sentAddress`, `affectedAddress`, `affectedObject`, `kind`, `atCheckpoint`,
`afterCheckpoint`, and `beforeCheckpoint` as independent filter fields. It also
defines `TransactionKindInput` as `PROGRAMMABLE_TX` or `SYSTEM_TX`. That schema
shape does not prove which combinations the live mainnet GraphQL service
accepts. Treat network failures, mainnet guard failures, missing samples, and
unexpected provider shapes as inconclusive, not as unsupported filter
combinations.

The same pinned schema accepts `package`, `package::module`, and
`package::module::function` forms for `TransactionFilter.function`. The first
function-diagnostics product slice must use full `package::module::function`
identifiers only. Less granular package or module forms are out of scope because
they broaden matches across unrelated functions and weaken result
interpretation.

For interpreting the recorded source probe, both `accepted_with_rows` and `accepted_empty`
mean the live GraphQL endpoint accepted the filter combination at the probe
date. `accepted_empty` does not prove matching activity exists for the sampled
values, does not prove no matching activity exists globally, and must not be
treated as complete dApp history.

The recorded probe against `graphql.mainnet.sui.io` shows that the live service
accepted `function`, `function + sentAddress`,
`function + atCheckpoint`, `function + sentAddress + atCheckpoint`, and
`function + sentAddress + afterCheckpoint + beforeCheckpoint`. The same probe
rejected `function + affectedAddress`, `function + affectedObject`,
`function + kind: PROGRAMMABLE_TX`, `function + kind: SYSTEM_TX`,
`function + affectedAddress + atCheckpoint`, and
`function + affectedAddress + afterCheckpoint + beforeCheckpoint`, returning
`Failed to parse "TransactionFilter": At most one of [affectedAddress,
affectedObject, function, kind] can be specified`. Treat this as source
evidence, not a permanent API guarantee; re-probe the affected combinations when
the SDK, schema, endpoint, or provider behavior changes.

Less granular `package` and `package::module` forms remain out of scope until a
separate package/module diagnostics plan closes the broader match
interpretation, docs, tests, storage, and privacy boundary.

Function activity diagnostics should reuse the existing transaction detail
fragment, compact facts, deterministic analysis, and protocol label rules unless
a separate plan provides verified evidence for a different source and closes the
affected docs/tests/storage boundary. Function-only or global scans must not
persist results by default. Sent-address scoped reads are the only persistence
candidate from the current probe evidence, and only under known-wallet storage
rules. A separate plan is required before any broader storage or privacy
boundary changes.
