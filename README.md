# Sui MCP

Use your AI app to look up balances for a public Sui address, inspect a transaction receipt, or open a DeepBook price chart. All three work without connecting a wallet.

For a supported DeepBook swap, the Review card shows your account, how much you expect to spend and receive, the minimum you would receive on success, and fees. You choose **Request wallet approval** on the card and approve that transaction in your own wallet through WalletConnect. Your assistant can read the result. If the submission reply is lost, Sui MCP checks the same transaction on Sui mainnet.

## Install

> **Upgrading from 0.8.2?** The database format changed in 0.9.0. If the server opens the old database, it stops at startup and your app may show no Sui MCP tools. Resolve pending wallet requests or unconfirmed transactions first, then stop Sui MCP in every app.
>
> To keep your old records, move the entire old Sui MCP data folder aside. If you choose to discard them, delete only that old folder. When you restart with default settings, Sui MCP creates its data folder automatically. No version-named folder or app configuration change is required for a default installation. [Find your data folder and review what deletion removes](docs/MCP_SETUP.md#database-format-mismatch).
>
> Fresh installs and working 0.9.0, 0.9.1, or 0.9.2 installations can skip this step.

**If your assistant cannot find `read_get_server_status`:** An empty tool list alone does not explain why. Check the app’s existing local registration and its Sui MCP startup log. The message `Local database format does not match this runtime` confirms a database mismatch. If the assistant cannot see the log, it should ask for the startup error line before suggesting a fix. [Troubleshoot a missing server](docs/MCP_SETUP.md#server-does-not-appear-in-the-client)

**Choose your version first.** This README describes **0.9.3**. Run the following in Terminal or PowerShell to see the stable version on [npm](https://www.npmjs.com/package/@zktx.io/sui-mcp):

```sh
npm view @zktx.io/sui-mcp@latest version
```

- If it returns **0.9.2**, follow the [published 0.9.2 setup guide](https://github.com/zktx-mcp/sui-mcp/blob/v0.9.2/docs/MCP_SETUP.md).
- For a new **0.9.3** installation, use [Node.js 24 LTS with npm](https://nodejs.org/en/download), then run the command below once. If npm reports another version, choose the guide for that release.

```sh
npm install -g @zktx.io/sui-mcp@0.9.3
```

### Connect your app

Register the installed command `sui-mcp` once in each app. The npm package name includes the scope `@zktx.io/`; the unscoped npm package belongs to another project. For a new global installation, leave arguments and environment variables empty. Your app starts the server. The package includes its WalletConnect project ID and default Sui mainnet endpoints.

| Where you use Sui MCP | Where to register it |
| --- | --- |
| [Codex Desktop or CLI](docs/MCP_SETUP.md#codex) | Use MCP settings in the desktop app, the CLI, or your Codex configuration file. |
| [Claude Desktop](docs/MCP_SETUP.md#claude-desktop) | Open **Settings → Developer → Edit Config**. |
| [Claude Code](docs/MCP_SETUP.md#claude-code) | Use `claude mcp add` in a terminal. |
| [Cursor](docs/MCP_SETUP.md#cursor) | Add it to `mcp.json` and enable it for your local Agent. |
| [Antigravity App](docs/MCP_SETUP.md#antigravity-app) | Add the local command to the MCP configuration, then refresh it under **Installed MCP Servers**. |

If a coding agent is setting this up for you, use the [installation request for an agent](docs/MCP_SETUP.md#ask-an-agent-to-set-it-up). You can use several apps on the same computer under the same OS user. They share one backend and one current wallet connection when configured with the same release, data directory and port. [Using multiple apps](docs/MCP_SETUP.md#using-multiple-apps)

### Try it without a wallet

1. In a new chat, ask **“What Sui MCP package, version and network are you using?”** The response should identify `@zktx.io/sui-mcp`, server `sui-mcp`, the version you installed, and `mainnet`.
2. Ask **“List the DeepBook pools available in Sui MCP.”** Expect pool names and trading assets in chat. These come from the registry packaged with the SDK.
3. To try an interactive card, ask **“Open the SUI/USDC price chart in Sui MCP.”** In an app with card support, look for the Chart inside the app. It can show progress while reading the market or report that data is unavailable. A text response alone confirms only tool access. [First-use walkthrough](docs/MCP_SETUP.md#first-use-flow)

## What happens during a review?

For a DeepBook swap, the local backend builds the transaction for the connected Sui account and checks its inputs, ownership, quoted amounts, limits and simulation. The Review card shows the amounts and a graph of the programmable transaction block (PTB), so you can inspect its steps and addresses. A review cannot guarantee that a transaction is safe.

Only your action on the Review card and approval in your wallet authorize that swap. The backend verifies the signed transaction's digest (its identifier) and signer before submitting it once. The assistant and card never receive executable transaction bytes or signatures. The Receipt shows the observed chain outcome. Reopening a card reads its stored state.

An external payment or action proposal can also be opened for inspection. It has no signing action. For local data, endpoints and connection recovery, open Settings and confirm the change there.

For tool names and responses, see [MCP Tools](docs/MCP_TOOLS.md). For guidance on answering questions such as “Can I cover a 1000 dollar payment with my assets?”, see the [AI-client answer playbook](docs/AGENT_BEHAVIOR.md).

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
- account-bound DeepBook swap review through protocol-agnostic adapter contracts that define the evidence a Review needs from any supported protocol;
- separately recorded request state and chain success/failure, shown in the Review card and available through ordinary reads;
- a Receipt card for server-read facts about any transaction digest, independent of signing.

It also includes:

- a local review server bound to `127.0.0.1`;
- a local SQLite store for chain-qualified address history and review evidence;
- MCP output checks that reject forbidden executable, signing, token, seed, and
  key-material field names from responses.

## Screens

**Wallet connection.** One WalletConnect connection provides one fixed address
per approved chain. Settings chooses networks for the next connection, defaulting
to Sui. The wallet may return a subset. Sui, Ethereum and Solana mainnet addresses
are supported; financial actions remain Sui-only. A chain returning multiple
addresses is unavailable for that connection; there is no account selector.
Changing the wallet, address or network scope requires disconnecting and connecting
again. Connect and Disconnect are separate purpose cards. Connect starts one
pairing after authenticated View confirmation; Disconnect asks for one exact-target
confirmation. Ended cards show a fixed address-free result and accept no further
operation. Current addresses are available through read-only connection status.
Connection is not transaction approval.

**Review and result.** The Review card prepares and renews verified conditions for
its fixed Sui account and connection. Disconnecting and reconnecting cannot retarget an
existing review. A replacement connection requires a new review. Users inspect the graph,
amounts and costs, then choose Request wallet approval and approve in their wallet.
Failed preparation has an explicit retry. Receipt and completed Review show the
executed graph, observed asset changes and net network fee. Details supplements
the same facts. Missing graph or receipt data is marked unavailable.

**DeepBook USDC chart.** `ui_open_chart` opens an internal MCP Apps card with
candles and volume for one USDC market. A market name or a selection from the menu uses DeepBook Indexer when listed. An explicit pool ID uses onchain fills. With no time range, it shows up to 500 candles from the past seven days.
The saved result shows the selected pair, interval, UTC period and source time. Limited and empty results are identified.

## Current Limits

### Not Implemented

External proposal execution is not implemented. Further local analysis views
beyond the internal Account and Chart cards, inline review receipt and internal Receipt card are
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
