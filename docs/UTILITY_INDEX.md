# Utility Index

Utilities are reusable state inspection or reporting surfaces for AI agents, maintainers, and local development.

This document owns manual utility and script boundaries. It distinguishes source-checkout utilities from MCP tools and packaged product commands.

Tool behavior references live in `docs/MCP_TOOLS.md`. Installation and client setup live in `docs/MCP_SETUP.md`.

Rows that name MCP tools describe existing product tools.

Rows that name `npm` commands or `scripts/` files describe manual utility surfaces only.

Source-checkout scripts are not packaged product commands, MCP tools, review-time simulation, transaction builders, signing readiness signals, or wallet authorization evidence.

## Implemented

| Utility | Command / Tool | Status | Notes |
| --- | --- | --- | --- |
| DeepBook registry generation | `npm run generate:deepbook-registry` | Implemented | Generates ignored mainnet metadata from `@mysten/deepbook-v3@2.6.4` constants. |
| MCP server status | `read.get_server_status` | Implemented | Reports package version, evidence policy version, runtime, `implementedToolsCount`, resources, prompts, and implementation limits. |
| Supported protocol list | `read.list_supported_protocols` | Implemented | Reports product support levels. |
| DeepBook pool list | `read.list_deepbook_pools` | Implemented | Reads pinned SDK mainnet pool metadata. |
| DeepBook token list | `read.list_deepbook_tokens` | Implemented | Reads pinned SDK mainnet token metadata, registry pool references, and decimals derived from pinned scalar values. |
| Orderbook inspection | `read.inspect_deepbook_orderbook` | Implemented | Uses pinned DeepBook SDK simulation read methods over Sui gRPC with an internal sender placeholder; `ticks` is capped at 50. |
| DeepBook mid price | `read.get_deepbook_mid_price` | Implemented | Returns pinned SDK pool mid price snapshots. Not a global market price. |
| DeepBook USDC price history | `read.get_deepbook_usdc_price_history` | Implemented | Reads DeepBookV3 official Indexer USDC candle data for a requested official interval. Not a utility script, live quote, USD value, P&L, route recommendation, transaction-building input, or signing readiness. |
| DeepBook USDC price at time | `read.get_deepbook_usdc_price_at_time` | Implemented | Selects the DeepBookV3 official Indexer USDC candle for or nearest to one target UTC time. Not a utility script, live quote, USD value, P&L, route recommendation, transaction-building input, or signing readiness. |
| DeepBook USDC candle chart card | `ui.open_chart` | Implemented | Internal read-only MCP Apps card displaying official DeepBookV3 Indexer USDC-denominated candles through the shared server. Shows the selected pool, requested UTC range and candle limit with the saved result. Not a utility script, live feed, wallet connection, trading interface, fiat USD value, P&L, route recommendation, transaction-building input, or signing readiness. |
| Quote calculation | `read.quote_deepbook_action` | Implemented | Quotes raw integer DeepBook quantities with pinned SDK transaction builders and raw `u64` simulation return values. |
| Display amount quote | `read.quote_deepbook_display_amount` | Implemented | Converts explicit source display amounts through pinned DeepBook token units before quoting; returns exact decimal display quote strings plus raw quote evidence. Quote semantics mark payment coverage and shortfall contribution unavailable. |
| DeepBook account inventory | `read.summarize_deepbook_account_inventory` | Implemented | Reports display-like BalanceManager inventory. Not raw balance or signing readiness. |
| Wallet asset summary | `read.summarize_wallet_assets` | Implemented | Reads Sui coin balances for an explicit address or the active account with Sui gRPC `client.core.listBalances`; adds verified unit/display data when available; use `cursor` when `hasNextPage` is true. |
| Wallet asset classification | `read.classify_wallet_assets` | Implemented | Classifies returned coin balances by balanceStatus and roles. Other asset classes are explicit non-inspected boundaries. |
| Settlement asset group list | `read.list_settlement_asset_groups` | Implemented | Lists supported natural-language settlement asset groups derived from pinned DeepBook mainnet SDK registries. Not live liquidity, route recommendation, fiat cash-out, payment execution, or signing readiness. |
| Intent evidence preview | `read.preview_intent_evidence` | Implemented | Builds `responseSummary` for USD-denominated coverage, shortfall, or settlement-asset balance total. |
| Review activity list | `read.list_review_activity` | Implemented | Lists local Sui MCP review evidence for one account; not complete wallet transaction history. |
| Review funnel summary | `read.summarize_review_funnel` | Implemented | Summarizes local review lifecycle counts, current statuses, sparse-sample warnings, and review timing. |
| Review session detail | `read.get_review_session_detail` | Implemented | Returns a capped detail view of one stored review session with plan, state snapshots, transitions, and execution evidence. |
| Sui transaction digest lookup | `read.inspect_sui_transaction` | Implemented | Looks up one Sui transaction digest and stores normalized facts only when the transaction sender or a returned balance-change owner matches a known local wallet. |
| Sui account activity scan | `read.scan_sui_account_activity` | Implemented | Runs a bounded recent-to-older GraphQL scan with requested-account facts. Not complete history. |
| Live Sui activity scan summary | `read.summarize_sui_activity_scan` | Implemented | Summarizes a live bounded scan without full details. Not P&L, position inventory, or complete history. |
| Sui sent-function activity scan | `read.scan_sui_function_activity` | Implemented | Scans bounded sent transactions for one full `package::module::function`. Not global function history. |
| Live Sui sent-function activity summary | `read.summarize_sui_function_activity_scan` | Implemented | Summarizes bounded sent-function rows. Not P&L, route recommendation, or signing readiness. |
| Stored Sui activity summary | `read.summarize_sui_account_activity` | Implemented | Summarizes stored normalized Sui activity facts, including stored Move call, balance change, object/event, gas, execution error details, and optional protocol activity labels when evidence is available. |
| Stored account asset timeline | `read.get_account_asset_timeline` | Implemented | Builds stored local account asset net-flow bars and optional DeepBook USDC token-denominated candle references. Not held balances, complete wallet history, USD value, P&L, cost basis, route advice, transaction building, or signing readiness. |
| Local settings | `settings.create_local_settings_session`, `settings.get_local_settings` | Implemented | MCP opens an internal Settings card or reads settings. App-only preparation/confirmation owns changes, files and explicit connection-service recovery. Stored endpoints apply after all participating apps restart. |
| Release package check | `npm run release:check` | Maintainer, source checkout | Verifies metadata, tests/build, tarball assets/licenses and installed MCP/Settings startup. Requires network and loopback access; no wallet pairing, signing or publishing. |
| Mainnet read smoke | `npm run smoke:mainnet` | Manual | Runs selected mainnet read paths from built `dist/`. Build first. Not part of CI or `release:check`; see notes below. |
| Sui GraphQL function filter probe | `npm exec -- tsx scripts/sui-graphql-function-filter-probe.ts [--endpoint <mainnet-graphql-url>] [--sample-size <1-50>] [--timeout-ms <ms>]` | Manual, source evidence only | Runs a read-only Sui mainnet GraphQL source-shape probe for function-filter diagnostics; see notes below. |
| Sui CLI transaction diagnostics | `npm exec -- tsx scripts/sui-cli-transaction-diagnostics.ts -- --help` | Manual, source checkout only | Allowlisted local `sui` CLI debug evidence. See notes below. |

## Release Package Check

`npm run release:check` is a source-checkout maintainer command. Node 22.12+ within
22.x, or Node 24+,
installed development dependencies, npm registry access for a temporary tarball
installation, local loopback sockets, and reachable Sui mainnet endpoints are
required. Native SQLite must work both in the checkout and the installed package.
The source build and tests use Vite, Rolldown and Vitest's common Node ranges; the
installed package's Node runtime requirement is documented in MCP Setup.
The runtime uses its built-in endpoints unless `SUI_GRPC_URL` or `SUI_GRAPHQL_URL`
is supplied; the actual mainnet checks remain enabled.

The command checks metadata, types, tests, builds, package contents and licenses,
then launches the installed package through stdio MCP with a new data directory
and an independent port. It reads the registered tools and resources, creates a
Settings card only in that temporary database, and checks the six internal
HTML resources, app-only tools, scoped status and retired-route rejection. A scoped test card verifies
that Connect rejects retired restart input and opening manage does not pair. The check
verifies the isolated SDK retains exclusive storage ownership until shutdown. It waits
for process termination before removing its installation. A termination failure preserves the temporary files for cleanup
after the process stops. It does not pair, sign, submit, publish, or mutate the
user's data. Success verifies this automated package boundary; real Host and
wallet integration checks remain separate release requirements.

## Public npm Availability Before MCP Registry Registration

`node scripts/wait-for-npm-publication.ts` is a read-only source-checkout
maintainer/CI command. It requires Node 22.18 or newer with native TypeScript
support and public npm access; it needs no installed dependencies or npm token.
Run it from the checkout root. It reads `name`, `version` and `mcpName` from
`package.json` and requires matching metadata from that exact public npm version
endpoint before succeeding. It does not install, publish, approve a staged
package, change dist-tags, or call a wallet or Sui endpoint.

The publication workflow runs it after the npm job succeeds and before the MCP
publisher is installed or authenticated. HTTP 404, 429, 5xx and network failures
are retried within a 20-minute CI budget. This reuses the npm job's existing
20-minute allowance; it is not a promise that npm scanning completes in that
time. Checks are 30 seconds apart (at most 40 requests), with a 10-second request
and response-body deadline matching the Registry's npm validator. A longer
`Retry-After` is respected within the overall budget. The Registry job retains
its original 10-minute registration allowance in addition to the wait, for a
30-minute job limit.

Other HTTP errors, invalid JSON and mismatched or missing metadata fail the
check. A timeout also fails without attempting Registry registration. Check npm
availability and retry only the Registry job; re-uploading a version that is
still being scanned can produce a staged-version conflict. The script is not a
packaged command or MCP tool. Re-running an existing GitHub Actions run uses its
original workflow revision, so changes to this gate apply to subsequent releases.

## Mainnet Read Smoke

This is a manual maintainer check for a specific mainnet provider. Normal quickstart use does not require Sui endpoint setup. Run it for people operating releases or debugging mainnet read shape.

```bash
export SUI_GRPC_URL="https://fullnode.mainnet.sui.io:443"
export SUI_GRAPHQL_URL="https://graphql.mainnet.sui.io/graphql" # optional override; default is the built-in mainnet GraphQL endpoint
export SMOKE_SUI_ADDRESS="0x..."
export SMOKE_DEEPBOOK_POOL_KEY="DEEP_SUI"
export SMOKE_QUOTE_AMOUNT="1000000000" # raw integer units; for SUI, 1000000000 = 1 SUI
# Optional: export SMOKE_INSPECT_DIGEST="..."
# Optional: export SMOKE_INSPECT_RANDOM_LATEST="true"
npm run build
npm run smoke:mainnet
```

`SUI_GRPC_URL` must be only scheme, host, and explicit port. Do not include credentials, a path, query string, or fragment.
`SMOKE_SUI_ADDRESS` must be a 32-byte hex Sui address, for example `0x` followed by 64 hex characters.
`SMOKE_INSPECT_DIGEST` is optional. Use a digest whose sender or returned balance-change owner is `SMOKE_SUI_ADDRESS` to exercise the stored digest-lookup path; otherwise the lookup can still return `ok` with `persistence.stored: false`.
`SMOKE_INSPECT_RANDOM_LATEST=true` is optional and only used when `SMOKE_INSPECT_DIGEST` is unset. It samples one digest from the latest GraphQL transaction page and calls `read.inspect_sui_transaction` without passing the smoke address. This checks current transaction-read shape without pinning a specific user address or exercising the stored relation path.

DeepBook orderbook and raw-quantity quote reads use an internal mainnet SDK simulation sender placeholder, not a user's wallet. The display-amount quote path is covered by automated tests, not by this smoke script. This smoke script does not exercise account-bound DeepBook transaction-material build or digest binding; that path needs a separate funded-account material-build smoke before smoke results are treated as product-grade proof for that review stage.

Wallet and activity reads use an explicitly synthetic active-account context in a temporary SQLite database. The script never creates a wallet connection, a review URL or an HTTP wallet result. Wallet approval is checked separately. This smoke script does not record raw GraphQL payloads, transaction bytes, signatures, raw transaction details, or compact transaction aggregates.

## Mainnet Read Smoke Notes

Run `npm run build` first because `npm run smoke:mainnet` executes `dist/runtime/smokeMainnetRead.js`.

The smoke command calls:

- wallet assets;
- DeepBook orderbook;
- raw-quantity DeepBook quote;
- `read.scan_sui_account_activity` for `SMOKE_SUI_ADDRESS` with limit 5;
- `read.summarize_sui_activity_scan` through active account context with limit 5;
- `read.inspect_sui_transaction` when `SMOKE_INSPECT_DIGEST` is set;
- sent-function activity tools when `SMOKE_FUNCTION_TARGET` is set to a full `package::module::function`.

Empty activity pages are valid smoke outcomes. They are recorded with `rowCount: 0` and `emptyAccepted: true`.

The result file records tool names, environment-variable presence, activity status, row counts, source method, window/order flags, persistence status, function-target presence, and evidence-boundary metrics.

It does not store raw GraphQL payloads, transaction bytes, signatures, raw transaction details, or compact transaction aggregates.

Activity scan and summary smoke paths fail if full transaction details or compact transaction aggregates are returned. The optional digest verifies storage only when its sender or returned balance-change owner is `SMOKE_SUI_ADDRESS`.

If `SMOKE_INSPECT_RANDOM_LATEST=true` is set and no digest is provided, the script samples one latest GraphQL transaction digest and inspects it without an account argument.

This smoke path does not call display-amount quote, DeepBook account inventory,
account-bound DeepBook transaction-material build, or internal digest binding. A
funded-account material-build smoke is a separate operator check before this
read smoke can be used as product-grade proof for the DeepBook review material
stage.

## Sui GraphQL Function Filter Probe Notes

The GraphQL function filter probe is read-only source-shape evidence for function-filter diagnostics.

It verifies the endpoint chain identifier, samples recent public mainnet transaction details to obtain redacted filter values, and probes `TransactionFilter.function` combinations with account, object, kind, and checkpoint axes using `last: 1`.

It writes an ignored local source-probe note with:

- endpoint host;
- chain identifier;
- repository revision;
- git worktree state;
- Node version;
- pinned `@mysten/sui` version;
- schema hash;
- probe script hash;
- filter-key matrix;
- result classifications;
- capped row counts.

The output redacts sampled digests, addresses, objects, and functions.

It does not store raw GraphQL payloads, transaction bytes, signatures, raw transaction details, wallet position inventory, route quality, P&L, transaction-building inputs, signing data, or signing readiness.

Network failures and mainnet guard failures are inconclusive evidence, not unsupported filter-combination findings.

It is not an MCP tool, not packaged product functionality, not CI, and not a function diagnostics implementation.

## Sui CLI Transaction Diagnostics Notes

The Sui CLI diagnostics utility can inspect a digest with allowlisted read/debug commands:

- `tx-block`;
- optional object inspection;
- optional local replay traces;
- optional gas profiles.

Run `npm exec -- tsx scripts/sui-cli-transaction-diagnostics.ts -- --help` for the full flag list.

Common flags include:

- `--object <objectId>`;
- `--gas-profile`;
- `--read-timeout-ms <ms>`;
- `--replay-timeout-ms <ms>`;
- `--analyze-timeout-ms <ms>`.

`--mainnet` selects exactly one existing Sui CLI env alias whose recorded chain id matches mainnet.

`--client-env` can select an explicit existing alias.

Both modes are read-only and do not switch or mutate CLI config.

CLI env aliases must not contain redaction marker word forms for private key, mnemonic, signature, signed transaction, transaction bytes, or `suiprivkey`-style markers using `-`, `_`, a space, or no separator.

Artifact paths must not contain `suiprivkey`-style markers; other redaction markers in paths are accepted and redacted in output.

The utility records source-versioned summaries, bounded redacted CLI-derived strings, artifact paths, and limitation provenance. It does not record raw CLI payloads.

It reports a limitation when the installed CLI version differs from the source-checked parser baseline.

It is not an MCP tool, not a CI check, not packaged product functionality, not review-time simulation, not wallet authorization, not signing readiness, not onchain transaction submission/execution, not route analysis, not P&L, and not complete-history evidence.

## Rules

- Utility output should be JSON-first.
- Read-only utilities come before write/signable actions.
- Generated registry files are local policy/metadata, not live liquidity or execution truth.
- DeepBook token lists are pinned SDK registry metadata, not live token discovery or a complete Sui token list.
- Live read outputs include `fetchedAt` as ISO 8601 UTC.
- DeepBook mid-price outputs are pool snapshots. For `SUI_USDC`, the price is USDC per SUI.
- DeepBook mid prices are not fiat USD cash-out estimates, external market lookups, USDC/USD peg assumptions, effective quote prices, quote-vs-mid slippage, price-impact calculations, venue comparisons, best-route claims, P&L, cost basis, or route recommendations.
- DeepBook USDC price-history output reads DeepBookV3 official Indexer candle data for the requested official interval. It is MCP tool evidence, not a source-checkout utility, on-demand chain-history scan, live quote, historical mid price, global market price, USD value, user-account history, P&L, cost basis, route recommendation, transaction-building input, or signing-readiness signal.
- `ui.open_chart` opens an internal read-only DeepBook USDC candle card. The server queries the official Indexer; the view does not fetch it directly. This is not a utility script, persistent price database, auto-refresh feed, live quote, trading interface, fiat USD value, user-account history, P&L, cost basis, route recommendation, transaction-building input or signing-readiness signal.
- USDC in DeepBook USDC price-history output is a token-denominated quote asset, not fiat USD and not a USDC/USD peg guarantee.
- `read.quote_deepbook_action` amounts are raw integer quantities that fit the SDK `u64` quote input, not decimal display amounts. Quote responses include `rawQuote.kind: "deepbook_quote_raw_u64"` from simulated raw `u64` return values.
- `rawQuote.sourceMoveFunction` names the simulated public entrypoint. `rawQuote.returnValueSourceMoveFunction: "pool::get_quantity_out"` names the official Move function that defines the return-value order.
- `read.quote_deepbook_display_amount` accepts only source-side display input amounts that convert to SDK `u64` quote inputs.
- Display quote public `quote` fields are exact decimal display strings derived from raw evidence. `rawQuote.directionalOutput.raw` is the direction-specific quote output before slippage policy.
- Quote `quantitySemantics` marks payment coverage, shortfall contribution, and route-dependent payment support unavailable and points coverage questions back to intent evidence.
- DeepBook account inventory quantities are display-like SDK `number` values and must not be used as raw amounts, funding sources, route liquidity, withdrawal readiness, transaction-building inputs, signing data, or signing readiness.
- Wallet balance display amounts are presentation-only and must come from returned `display` fields. Do not infer token decimals from symbols.
- Wallet balance reads are current coin-balance snapshots only. They are not transaction history, receipt proof for a specific digest, acquisition source, object provenance, P&L, cost basis, or signing data.
- `uninspectedAssetClasses` entries are explicit classifier-uninspected boundaries.
- They are not zero-balance claims, spendable asset facts, funding sources, route liquidity, payment readiness, portfolio completeness, transaction-building inputs, signing data, or signing readiness.
- Intent evidence previews map natural-language USD-denominated targets to pinned SDK settlement asset groups and current wallet balance snapshots.
- Use `userAnswerUse.answerFields` for intent evidence answers. Settlement-asset-only coverage, shortfall, or current-total answers use `responseSummary`; selected-target answers also use the selected-target fields listed in the response. Direct pool quote evidence is supported only when the same intent-evidence response lists `direct_pool_quote_evidence` in `responseEvidence.supportedResponseClaims` and `direct_pool_quote_evidence_for_user_selected_target` in `userAnswerUse.canAnswer`. Intent evidence previews do not choose settlement assets, quote best routes, evaluate gas reserve, execute payments, or create signing material.
- DeepBook read outputs identify SDK simulation reads through `source.simulation`.
- Review activity tools analyze local Sui MCP review evidence only. The optional `account` input is a read filter and does not change active account context.
- Sui activity scan tools are user-requested bounded reads. They store only normalized facts tied to known local wallets.
- Sui activity scans do not store raw provider payloads or non-known party account addresses. They do not claim complete wallet history, complete dApp history, P&L, signing readiness, transaction building, or route recommendations.
- Stored account asset timeline output reads only local normalized facts. It is an MCP tool response, not a source-checkout utility, background scanner, held-balance history, complete wallet history, USD value, P&L, tax, cost basis, route recommendation, transaction-building input, or signing-readiness signal.
- Activity `quantitySemantics` marks balance `amountRaw` and `*Raw` fields as raw integer facts requiring verified decimals or returned display amounts before display conversion.
- Account effect rows include `accountBalanceChangeInferencePolicy` so truncated or unavailable requested-account evidence cannot be filled from transaction-level context, visible recipient patterns, or current wallet balances.
- Gas display facts, when returned, use `@mysten/sui MIST_PER_SUI`.
- Optional protocol activity labels are derived from normalized detail facts and are not a supported-protocol list or wallet position inventory.
- Sent-function activity tools are sender-scoped only: they report transactions the selected account sent that called one full `package::module::function`, not recipient-only activity, affected-object history, or global function history.
- `read.summarize_sui_activity_scan` and `read.summarize_sui_function_activity_scan` summarize live bounded scan results. `read.summarize_sui_account_activity` summarizes stored local SQLite facts only.
- Sui GraphQL function filter probe output is source-shape evidence for function-filter diagnostics only.
- Do not treat the probe as a supported function diagnostics surface, complete dApp history, route quality evidence, wallet position inventory, transaction-building input, signing data, or signing readiness.
- Sui CLI transaction diagnostics can be compared with `read.inspect_sui_transaction` only at the fact category level.
- Comparable categories include digest/status/checkpoint/timestamp, Move call targets, object ids/types, event type strings, raw gas summary, and optional replay/trace-derived debug artifacts.
- Sui CLI transaction diagnostics are debug cross-check sources, not replacements for MCP normalized transaction facts and not review-time simulation.
- Sui CLI transaction diagnostics are source-checkout debug utilities only. They must stay allowlisted and read/debug-only.
- Local replay output is debug evidence only. The utility is not an MCP tool, review-time simulation, wallet authorization, signing readiness, or onchain transaction submission/execution.
- When a review activity output has `lowSampleWarning: true`, report raw counts and avoid inferring behavior patterns.
- For review activity list output, `dataScope.recordCount` is the full matching local review count. The returned `activities` array can be shorter when `truncated.activities: true`.
- Settings card actions require scoped permission and explicit confirmation. They change local settings/data or recover the connection service without authorizing a new transaction, signing or custody. Ordinary MCP opens the card or reads settings; app-only file transfer never exposes raw backup bytes to the model.

### Optional account-bound review smoke

Set `SMOKE_SWAP_PROTOCOL`, `SMOKE_SWAP_FROM_SYMBOL`, `SMOKE_SWAP_TO_SYMBOL` and
`SMOKE_SWAP_AMOUNT_DISPLAY` together to opt into read-only account-bound review
computation. Protocol is explicitly `deep`; the smoke does not silently select a protocol.
A partially configured group is an error. `SMOKE_SWAP_MAX_SLIPPAGE_BPS` keeps the
existing explicit override. The script uses the same runtime review composition,
material store and evidence validation as the product, and records whether
transaction review data was emitted. This can involve mainnet simulation but
never wallet pairing, signing or submission. The temporary active-account
fixture is not proof of a wallet connection or ownership. Without the complete
optional group, the result records that review computation was not run.
