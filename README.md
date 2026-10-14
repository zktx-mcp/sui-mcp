# Sui MCP

Sui MCP is a local-first Sui review and evidence layer for AI clients.

It turns a supported Sui action into an internal Review card where you inspect
verified transaction facts and a PTB graph, then request approval in your own
wallet. The backend builds or verifies the material, binds the reviewed account
and digest, and uses WalletConnect for a sign-only request. It verifies the
wallet's returned bytes and signature before one submission to Sui mainnet.

The AI and card never receive executable transaction bytes or signatures.
Neither a review nor a wallet connection is standing transaction permission.
Only an explicit user action and that transaction's wallet approval authorize
the request. Lost replies are resolved by reading the known digest; they do not
cause another signing or submission request. Request failures and unknown
outcomes are separate from independently observed chain success/failure.

Account, Receipt and Chart cards provide read-only evidence independently of
signing. Connect, Review and Settings also run inside the MCP host. Settings
provides local data controls and explicit connection-service recovery. Human-readable review is not a guarantee of safety or
of complete interpretation of every transaction detail; the raw PTB structure
and addresses remain inspectable.

Users can ask ordinary questions:

- "Can I cover a 1000 dollar payment with my assets?"
- "How much are my USD-denominated assets together?"
- "What is the shortfall?"

This document describes `@zktx.io/sui-mcp@0.7.0`. Confirm that version is
published before using npm installation commands. For a local build, follow
[Developer Checkout Setup](docs/MCP_SETUP.md#developer-checkout-setup).

## Product Scope in Two Layers

- **Implemented:** Sui mainnet read evidence, non-signable external proposal review, and account-bound DeepBook swap review using protocol-agnostic adapters. Six internal cards use the same SQLite state and permission model. The backend verifies stored material, ownership, quote/policy provenance, human-readable facts, simulation and PTB evidence before an explicit user request. WalletConnect carries bytes only between the backend and wallet; ordinary MCP responses expose facts, request status and observed execution results. Settings owns endpoint and read-address controls, local backup/import/reset, and explicit connection-service recovery. Settings operations require scoped user confirmation; ordinary MCP calls only create the card or read settings.
- **Safety boundaries:** no private-key custody, no MCP or AI autonomous execution, no forwarding of opaque external transaction bytes to a wallet, and no peg guarantee. The current product does not silently choose settlement tokens or routes. It does not provide fiat cash-out, P&L, tax or cost-basis support.

DeepBook provides the current scoped Sui conversion, price, and orderbook
evidence through the shared protocol adapter contracts. Wallet and Sui balance reads
describe held assets. They do not define the whole product.

Sui MCP does not custody funds, hold private keys, or autonomously trade
on behalf of users.
By current design, it does not rank venues, choose routes, make best-price
recommendations, or silently choose settlement tokens for users.

Account-bound transaction building, signing requests and chain observation stay
in the local backend. The Review card displays evidence and current permitted
actions. Public review JSON, model-facing card data and backups never contain transaction
bytes, signatures, SDK keys or signing permission. Reopening a card reads its
stored state and never replays a financial request.

The current release flow is:

```text
The user states an intent in natural language.
Sui MCP resolves the supported Sui mainnet evidence surface.
The AI answers only from returned evidence and boundaries.
Supported swap transaction material build is an account-bound review step, not
part of the natural-language intent evidence answer.
```

The current release implements intent evidence for supported Sui mainnet reads.
It can also create a read-only, non-signable local review session from a
structured external payment or Sui action proposal. External proposal ingestion
does not trust external transaction material or send anything for wallet signing.

For setup, see [docs/MCP_SETUP.md](docs/MCP_SETUP.md).
For the MCP API reference, see [docs/MCP_TOOLS.md](docs/MCP_TOOLS.md).
For the AI-client answer playbook, see [docs/AGENT_BEHAVIOR.md](docs/AGENT_BEHAVIOR.md).
For manual maintainer and developer utilities, see [docs/UTILITY_INDEX.md](docs/UTILITY_INDEX.md).

User-question flows for USD-denominated coverage, balance totals, and shortfall answers live in [docs/AGENT_BEHAVIOR.md](docs/AGENT_BEHAVIOR.md). The response fields for those answers live in [docs/MCP_TOOLS.md](docs/MCP_TOOLS.md).

## What Works Today

The current release can run as a local stdio MCP server and expose mainnet Sui DeFi evidence:

- wallet balances with verified display units;
- coin-balance classification;
- USD-denominated settlement asset groups derived from pinned DeepBook SDK registry metadata;
- intent evidence with response summaries for natural-language USD-denominated payment coverage, balance-total, and shortfall questions;
- DeepBook pools, tokens, mid price, orderbook context, raw quotes, display-amount quotes, and account inventory;
- user-requested bounded Sui transaction digest lookup, account activity scans, sent-function activity scans with known-wallet-only persistence, and stored normalized activity summaries;
- read-only external proposal review sessions that display proposed action, asset flow, recipient or target, freshness, missing evidence, user choices, unsupported claims, and non-signable reason;
- local Sui MCP review evidence and review-session status reads;
- account-bound DeepBook review with verified material, digest, ownership, policy, human-readable facts, simulation and PTB visualization, followed by explicit card selection and wallet approval through the backend;
- separately recorded request state and chain success/failure, shown in the Review card and available through ordinary reads;
- a Receipt card for server-read facts about any transaction digest, independent of signing.

It also includes:

- a local review server bound to `127.0.0.1`;
- a local SQLite store for active account read context and review evidence;
- MCP output checks that reject forbidden executable, signing, token, seed, and
  key-material field names from responses.

## Screens

**Wallet connection.** Connect one Sui mainnet wallet and use one of its approved
addresses. A manage card shows Connect wallet when no connection is active;
opening it alone does not pair. A connect-intent card starts pairing after its
View confirms permission and current state. Each disconnection requires the
user to confirm its exact target. Connection is not transaction approval.


**Review and result.** The internal Review card automatically prepares and renews verified conditions for one selected wallet/account. Users inspect its transaction graph, amounts and costs, then choose Request wallet approval and approve in their wallet. One wallet connection is used at a time; choose among its approved addresses when needed. Conflicting saved connections must be resolved through targeted disconnection. Failed preparation has an explicit retry. Receipt and completed Review show the executed transaction graph, actual asset changes and net network fee. Supplementary facts are in one Details slide; earlier estimates in Review remain distinct from actual chain results. Missing graph or receipt data is marked unavailable. Cards use a single document layout without nested card panels.

**DeepBook USDC chart.** `ui_open_chart` opens an internal MCP Apps card with
official DeepBookV3 Indexer candles and volume for one selected USDC pool.
The saved result shows the selected pair, interval, UTC period and source time. Limited and empty results are identified.

## Current Limits

### Not Implemented

External proposal execution is not implemented. Further local analysis views
beyond the current inline review receipt and internal Receipt card are
not implemented. Transaction material review, backend WalletConnect requests under user control,
signature verification, single submission and independent receipt observation
are implemented for the account-bound DeepBook swap review
through a plan-factory registry.

External proposal ingestion is implemented only for read-only local review
sessions. It accepts structured proposal facts, rejects forbidden executable or
signing fields, recognized Sui private-key strings, valid English BIP39
mnemonic phrases, obvious sensitive markers, and suspicious raw secret-like
payloads before storage, and records why the review is non-signable.

A blocked review lacks required evidence for that session. Only a complete
`TransactionReviewData` binds human-readable facts and simulation to the exact
reviewed digest. This is pre-signing evidence, not authority or guaranteed
execution. The backend checks returned bytes and the selected account's
signature before submitting. See [the adapter contract](docs/SIGNABLE_ADAPTER_CONTRACT.md).

Fiat cash-out, P&L, tax, and cost-basis support are not part of the current release.

### Permanent Safety and Correctness Boundaries

These are product boundaries and must not be relaxed by ordinary feature work:

- Sui MCP does not custody funds, hold private keys, or autonomously trade.
- It does not treat USDC, USDT, or any USD-denominated settlement asset as fiat
  USD, a bank cash-out amount, or a USDC/USD peg guarantee.
- It does not turn quote-only conversion candidates into payment coverage, shortfall evidence, funding readiness, payment execution readiness, or signing readiness.

### Out of Scope by Current Design

These product behaviors are out of scope in the current release by design:

- It does not silently choose USDC, USDT, or another settlement token for a
  user. It can report supported settlement asset groups and can use a settlement
  token only when the user selected it explicitly.
- It does not rank venues, choose routes, or make best-price recommendations.

### Quote Response Limits

Quote tools such as `read_quote_deepbook_action` and
`read_quote_deepbook_display_amount` return scoped quote facts and raw quote
evidence only.

Their semantics mark quote output as price evidence, not payment coverage or shortfall evidence. Coverage and shortfall answers come from `read_preview_intent_evidence.responseSummary`.

For quote responses alone, these conclusions are unsupported:

- payment coverage is not available;
- shortfall contribution is not available;
- route-dependent payment support is not available;
- final min-out values are not available;
- route recommendations are not available;
- venue comparisons are not available;
- effective-price claims are not available;
- price-impact calculations are not available;
- quote-vs-mid slippage is not available;
- fiat cash-out estimates are not available;
- external market lookups are not available;
- USDC/USD peg assumptions are not available;
- P&L is not available;
- cost basis is not available;
- actionable signing data is not available.

## Install

Use the checkout setup above for unpublished changes. A local commit or successful
package check does not publish a release.

This release uses npm package `@zktx.io/sui-mcp` and MCP Registry name
`io.github.zktx-mcp/sui-mcp`. Once the requested version is published,
install through your client's registry support or run `npx -y @zktx.io/sui-mcp`.
For per-client configuration (Claude Code, Claude Desktop, Codex, Cursor) and
running from a local checkout, see [docs/MCP_SETUP.md](docs/MCP_SETUP.md).

### Package identity and local data

The npm package is `@zktx.io/sui-mcp`, and its repository is
`zktx-mcp/sui-mcp`. Confirm the requested version is available before changing
your client registration.

Use the full scoped package name: the unscoped `sui-mcp` package is a different
project. Use `sui-mcp` as the default MCP registration name. A client-defined registration
alias is a local label, not server identity or authorization. Compatible
updates preserve the current data directory. Incompatible databases and backups
are rejected without conversion, and files are left in place. Data from a
different package is not discovered or imported. See the
[setup guide](docs/MCP_SETUP.md#switching-the-installed-package) for installation
and shared-server restart instructions.

After the MCP server is connected, use [docs/MCP_SETUP.md](docs/MCP_SETUP.md#first-use-flow) for first-use setup, [docs/MCP_TOOLS.md](docs/MCP_TOOLS.md) for API fields and statuses, and [docs/AGENT_BEHAVIOR.md](docs/AGENT_BEHAVIOR.md) for user-question flow and response wording.

## Mainnet-Only Product Surface

Product docs, registry, AI responses, UX copy, and signable actions are mainnet-only.

Unsupported protocol experiments are not product functionality and are not included in the package docs, MCP resources, registry support lists, UX copy, or signable-action lists.

## MCP Tools

The canonical MCP API reference lives in [docs/MCP_TOOLS.md](docs/MCP_TOOLS.md).

The server also exposes `read_get_server_status`. It returns the package version, evidence policy version, `implementedToolsCount`, and implemented tool list at runtime.

DeepBook pool-price context is exposed through `read_get_deepbook_mid_price`. Use `docs/MCP_TOOLS.md` for the response fields and unsupported conclusions.

Tool names use `domain_verb_object`. Names identify an operation; its schema, card visibility and permission checks define its authority. `action_start_review` returns a `reviewSessionId` and an internal `card`; it does not request a signature, submit a transaction or return executable transaction bytes.

## Documentation Map

The server exposes only a subset of repository documents as MCP resources.

Runtime-facing MCP resources currently include:

- this README;
- `docs/MCP_SETUP.md`;
- `docs/MCP_TOOLS.md`;
- `docs/WALLET_CONNECTION.md`;
- `docs/AGENT_BEHAVIOR.md`;
- `protocols/deepbook-v3.md`;
- `protocols/deepbook-margin.md`.

Protocol resources are explanatory references. Current support is declared by `read_get_server_status`, `read_list_supported_protocols`, concrete tool schemas, and concrete tool responses, not by protocol Markdown alone.

Development-only or release-review documents can define contributor rules and checks.

AI client answer behavior must be mirrored in runtime-facing instructions, resources, prompts, schemas, or returned evidence fields before it is treated as product behavior.

- `README.md`: Public entry document: product purpose, current release boundary, setup path, and documentation map.
- `docs/MCP_SETUP.md`: Setup guide: installation, MCP client connection, first-use flow, settings, and troubleshooting.
- `docs/MCP_TOOLS.md`: API reference: tool contracts, response fields, statuses, follow-up fields, and output boundaries.
- `docs/AGENT_BEHAVIOR.md`: Answer playbook: user-question flows, tool selection, and response wording boundaries.
- `docs/WALLET_CONNECTION.md`: Wallet connection reference: active read context, private SDK ownership and user-approved transaction requests.
- `protocols/deepbook-v3.md`: Protocol reference only; use MCP tool responses and read_list_supported_protocols for current support.
- `protocols/deepbook-margin.md`: Protocol reference only; no margin MCP read tools or signable actions are exposed in this release.
- `docs/TRANSACTION_ACTIVITY_LOG.md`: transaction activity evidence, storage, scan, and summary boundaries.
- `docs/UTILITY_INDEX.md`: manual maintainer and developer utilities. Utility rows are not MCP tools unless they explicitly name an MCP tool, and source-checkout scripts are not packaged product commands.
- `docs/LOCAL_DB_ARCHITECTURE.md`: local SQLite storage boundaries for maintainers.
- `docs/SDK_API.md`: pinned SDK API notes and source-verification boundaries.
- `docs/SIGNABLE_ADAPTER_CONTRACT.md`: wallet-review adapter and PTB visualization contract. It defines the pre-signing review evidence and commitment boundary; wallet signing requires a user card action and approval in the wallet; the backend alone handles bytes.

Contributor references live in the source repository and are not installed MCP
resources or product commands:

- [AGENTS.md](https://github.com/zktx-mcp/sui-mcp/blob/main/AGENTS.md): root repository development contract and non-negotiable product boundaries.
- [docs/AGENT_DEVELOPMENT_POLICY.md](https://github.com/zktx-mcp/sui-mcp/blob/main/docs/AGENT_DEVELOPMENT_POLICY.md): contributor development and review policy.
- [docs/FRONTEND_POLICY.md](https://github.com/zktx-mcp/sui-mcp/blob/main/docs/FRONTEND_POLICY.md): card frontend implementation policy.
- [docs/golden-scenarios/INTENT_EVIDENCE_MATRIX.md](https://github.com/zktx-mcp/sui-mcp/blob/main/docs/golden-scenarios/INTENT_EVIDENCE_MATRIX.md) and [docs/golden-scenarios/BEHAVIOR_MATRIX.md](https://github.com/zktx-mcp/sui-mcp/blob/main/docs/golden-scenarios/BEHAVIOR_MATRIX.md): release-review scenarios; current tool responses define supported evidence.

## Contract Name Registry

The PTB visualization in the Review card can show human-readable labels in place
of raw addresses, with a toggle back to raw addresses. A label is identity display only, not a
safety, trust, route-quality, or signing-readiness signal, and only registered
addresses are relabeled.

Two pinned, context-aware registries in
[`src/core/action/contractNameRegistry.ts`](https://github.com/zktx-mcp/sui-mcp/blob/main/src/core/action/contractNameRegistry.ts)
drive this:

- packages, relabeled only in `<address>::` path position — the DeepBook swap
  package by its Move Registry (MVR) name `@deepbook/core`, and the Sui framework
  packages by their Move aliases (`std`, `sui`, `sui_system`);
- well-known Sui system objects, relabeled only as a bare object id — `Clock`,
  `SuiSystemState`, `Random`, `DenyList`, `CoinRegistry`, and the address-based
  balance `AccumulatorRoot`.

If you maintain a Sui DeFi protocol that has a registered MVR name and want its
package to display that name in the review graph, open a pull request adding your
mainnet package address and MVR name to the package registry. Every unregistered
address keeps its raw form.
