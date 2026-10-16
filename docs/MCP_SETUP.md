# MCP Setup

This is the setup guide for Sui MCP clients. It owns installation, MCP client connection, first-use flow, local settings, and troubleshooting.

It does not define tool field contracts or response wording. Use `docs/MCP_TOOLS.md` for the MCP API reference and `docs/AGENT_BEHAVIOR.md` for the answer playbook.

The README keeps only the short entry path; client-specific setup, restart behavior, and troubleshooting live here.

These instructions target `@zktx.io/sui-mcp@0.8.0`. Package installation requires
that exact version to be published; use the developer checkout instructions when
it is not available. A repository rename or local build does not publish the
package. Changing client settings or rebuilding files does not replace an
already running shared server. Restart all clients using the service and verify
the package identity when switching installations.

## Key terms

- Sui: the mainnet blockchain whose DeFi state this project reads.
- MCP: Model Context Protocol, the tool-calling interface used by AI clients.
- DeepBook: Sui's onchain order book protocol.
- SDK: Software Development Kit, a version-pinned library dependency used by this repository.
- gRPC and GraphQL: Sui SDK transports used by this runtime for mainnet reads.
- WalletConnect: the backend's transport for wallet-approved connections and individual transaction requests.
- stdio: standard input/output, the local transport used by MCP clients to talk to this server.
- `@zktx.io`: the npm package scope. `zktx-mcp` is the GitHub organization. Sui MCP is the product; `sui-mcp` is the MCP server name and executable command.

Each MCP request, including its envelope and metadata, must fit within the
internal transport's 4 MiB request-body limit. Card messages have a separate
64 KiB budget; Restore uploads keep their 16 MiB file limit by sending smaller
messages. See [MCP Tools](MCP_TOOLS.md) for request and error semantics.

## Requirements

- Node.js 22+. Node 22 or 24 LTS is recommended.
- An MCP client that can run a local stdio server.
- Network access to Sui mainnet gRPC for runtime startup validation and to Sui mainnet GraphQL for user-requested activity reads.

## Default Setup

No Sui endpoint setup is required for the default path. The runtime creates a local SQLite database automatically, stores default Sui mainnet gRPC and GraphQL endpoints there on first start, and uses those endpoints for read-only mainnet tools.

If you want a custom Sui gRPC or GraphQL provider, or local data controls, configure them after the MCP server is connected by asking your AI client to create a Settings card:

- "Show my Sui MCP local settings."
- "Open my Sui MCP Settings card."

The tool opens an internal card; use its scoped controls in the chat app. No external URL is returned. Custom endpoint changes apply after the MCP server restarts. Advanced temporary environment overrides are documented in [Advanced Runtime Settings](#advanced-runtime-settings).

DeepBook orderbook, raw-quantity quote, and display-amount quote reads use an internal mainnet SDK simulation sender placeholder.

They do not require wallet connection.

This placeholder is only the sender value required by DeepBook SDK simulation reads. It is not a user's wallet, signing authorization, or fake user liquidity.

Reads that require a current fixed wallet address use `session_open_wallet_connection_card`. Tools with an `account` input also accept an explicit Sui address without a wallet connection.

## Developer Checkout Setup

Use Node.js 22.12 or newer within 22.x, or Node.js 24 or newer, for source builds
and tests. These ranges satisfy Vite, Rolldown and Vitest together. The installed
package's runtime requirement remains Node.js 22 or newer.

Use this path when you download the repository from GitHub and want to test the local build:

```bash
git clone https://github.com/zktx-mcp/sui-mcp.git
cd sui-mcp
npm install
npm run build
```

Generic stdio MCP configuration:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/sui-mcp/dist/runtime/start.js"]
}
```

Do not wrap the MCP stdio command in a shell script that writes ordinary text to stdout.

On native Windows clients that need `cmd`, use the same command through `cmd /c`:

```json
{
  "command": "cmd",
  "args": ["/c", "node", "C:\\absolute\\path\\to\\sui-mcp\\dist\\runtime\\start.js"]
}
```

To delegate local setup to an AI coding agent, tell it:

```text
Register this repository as a local stdio MCP server using the built /absolute/path/to/sui-mcp/dist/runtime/start.js file.
Use the default Sui mainnet endpoint unless I explicitly ask for a custom provider.
```

## Commands

These `npm run` scripts run from a local checkout. They are developer and maintainer scripts, not MCP tools or packaged product commands:

```bash
npm install
npm run typecheck
npm run build
npm test
npm run release:check
npm run generate:deepbook-registry
npm run smoke:mainnet
```

`npm run generate:deepbook-registry` writes `registry/generated/deepbook-mainnet.json`, which is ignored by Git because generated registry data must include provenance and should be regenerated from the pinned SDK.

## Install from the MCP Registry

If your MCP client can install servers from the
[MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=sui-mcp),
find the `io.github.zktx-mcp/sui-mcp` entry and install it through your
client. The resulting stdio server command is equivalent to:

```sh
npx -y @zktx.io/sui-mcp
```

Clients that do not install from the registry use the published-package and
per-client configuration below, which give the exact `command` and `args`.

## Published Package Setup

The npm package for this release is `@zktx.io/sui-mcp`. The commands below
require the requested version to be published; confirm it with
`npm view @zktx.io/sui-mcp@0.8.0 version` before switching. Both installation
methods start the same `sui-mcp` stdio MCP server. Use a local checkout when
working on a version that has not been published.

### Download on demand (npx, tracks the latest release)

```json
{
  "command": "npx",
  "args": ["-y", "@zktx.io/sui-mcp"]
}
```

No install step, and each launch resolves the latest published version. The
trade-off: the first launch (or the first after the npx cache is cleared)
downloads the package and its native dependencies. On a cold cache this can take
long enough to exceed a client's MCP startup timeout, so the client may stop the
server before it connects. If that happens, warm the cache once in a terminal and
then restart the client:

```bash
npx -y @zktx.io/sui-mcp
# after the server binds or a healthy peer is confirmed, stop it with Ctrl-C
```

The startup log reports either an owned shared server or an authenticated healthy
peer. A bootstrap failure instead reports its stage and reason on stderr.

### Install once (global, fastest startup, pinned version)

```bash
npm install -g @zktx.io/sui-mcp
```

```json
{
  "command": "sui-mcp"
}
```

The global `sui-mcp` command starts with no per-launch download, so it
avoids the cold-start timeout, and it stays on the installed version until you
update it explicitly:

```bash
npm install -g @zktx.io/sui-mcp@latest
```

The unscoped npm package `sui-mcp` is unrelated and can provide the same global
command name. Always install the full `@zktx.io/sui-mcp` package and verify
`read_get_server_status.packageName` after starting it. If another installation
owns the global command, use the scoped `npx` configuration instead.

The per-client sections below use the `npx` form. To use a global install
instead, replace the published-package command with `"command": "sui-mcp"`
and drop the `args`. On native Windows clients that need `cmd`, wrap either
command, for example `"command": "cmd", "args": ["/c", "npx", "-y", "@zktx.io/sui-mcp"]`.

## Switching the Installed Package

### Updating an Existing Sui MCP Installation

Confirm that the requested package version is available before changing every
participating client's configuration. A compatible update can retain the current
data directory, backups and private WalletConnect store. Use the same directory
and review port in every participating client. Stop the participating MCP
connections and wait for the shared backend to exit, update
the installed package or configured version, then reopen them and check
`read_get_server_status` in each client. The package name, version and server
name must match the intended installation. Updating the package does not
replace a backend that is already running.

Incompatible databases and backups are rejected without migration. To use a
different database structure, choose a new empty directory and preserve the
existing data and backups. Configure endpoints and read context as needed and
connect through a new card. See
[Local Database Architecture](LOCAL_DB_ARCHITECTURE.md#current-format-and-backups).
Do not reset data or resend a transaction as an update step. Coordinate a safe
restart if a transaction request is still in progress.

### Switching from a Different Package

Use these steps when selecting Sui MCP instead of a different package.
Confirm the requested version is available before changing your client configuration.
Sui MCP starts with a new database and private WalletConnect store in its own
data directory. It does not discover, read, import or convert a previous
package's database or backup. Existing connections, saved cards, transaction
history and endpoint settings are not transferred. Configure endpoints if needed
and connect your wallet through a new card. Existing blockchain transactions
are unaffected and must never be resubmitted as an installation step.

Fully quit every app using the service and wait for its shared backend to exit
before starting the new package. A client using a different service identity,
package version or data directory is refused while that backend owns the port.
If a transaction request is in progress, inspect its state and coordinate a safe
restart first. A previous wallet pairing can remain in the wallet app; remove
an unwanted pairing there rather than assuming new local storage disconnected it.

Replace the old registration instead of adding a second one. Use
`sui-mcp` as the default registration name and select `@zktx.io/sui-mcp@0.8.0`
in its command arguments. A client-defined alias does not change the package,
server identity or permissions. Remove obsolete runtime environment overrides. If you set
`SUI_MCP_DATA_DIR`, choose a new empty directory; never point it at another
package's database or private WalletConnect store. Keep the same new directory
and `SUI_MCP_REVIEW_PORT` in every participating client.

After restarting the clients, call `read_get_server_status` in each. Check
`packageName`, `version` and `serverName`: they must identify the intended npm
package and version, with `serverName` equal to `sui-mcp`. Read `session_get_interaction_status` to confirm the new empty wallet state. This check does not require signing
or submitting a transaction. Prior conversation cards are not current controls;
open cards through the new registration.

### Data and resource identifiers

Sui MCP uses `SUI_MCP_DATA_DIR` and `SUI_MCP_REVIEW_PORT` for local configuration.
The default application directory is `sui-mcp`, the database is `sui-mcp.sqlite`,
and the private WalletConnect store is in that same data directory. These values
select the current installation; no previous-package aliases are supported.
Card addresses use `suimcp://` and `ui://sui-mcp/`; see
[MCP Tools](MCP_TOOLS.md#resources).

## Claude Code

Claude Code supports local stdio MCP servers through `claude mcp add`. Put Claude CLI options such as `--transport` and `--scope` before the server name; the `--` separator starts the command that runs Sui MCP.

Developer checkout:

```bash
claude mcp add --transport stdio \
  sui-mcp \
  -- node /absolute/path/to/sui-mcp/dist/runtime/start.js
```

Published npm package:

```bash
claude mcp add --transport stdio \
  sui-mcp \
  -- npx -y @zktx.io/sui-mcp
```

Claude Code scopes:

- `local`: default; private to the current project.
- `project`: shared through a checked-in `.mcp.json`.
- `user`: private to your user account and available across projects.

Project-scope `.mcp.json` example:

```json
{
  "mcpServers": {
    "sui-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/sui-mcp/dist/runtime/start.js"]
    }
  }
}
```

Verify the server and tool list:

```bash
claude mcp list
claude mcp get sui-mcp
```

Inside Claude Code, use `/mcp` to inspect connected servers. After changing MCP configuration or rebuilding the local runtime, restart the Claude Code session so the stdio process is started from the new command. If startup is slow, launch Claude Code with a larger startup timeout such as `MCP_TIMEOUT=10000 claude`.

## Claude Desktop

Claude Desktop can run local stdio MCP servers through its Developer settings. It does not require a `.dxt` extension for this package.

Open Claude Desktop settings, go to Developer, choose Edit Config, and add a server to `claude_desktop_config.json`.

Common config paths:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Developer checkout:

```json
{
  "mcpServers": {
    "sui-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/sui-mcp/dist/runtime/start.js"]
    }
  }
}
```

Published npm package:

```json
{
  "mcpServers": {
    "sui-mcp": {
      "command": "npx",
      "args": ["-y", "@zktx.io/sui-mcp"]
    }
  }
}
```

On native Windows, use `cmd /c` if direct `npx` or `node` resolution fails:

```json
{
  "mcpServers": {
    "sui-mcp": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@zktx.io/sui-mcp"]
    }
  }
}
```

Save the file and fully restart Claude Desktop. If the server does not appear, check MCP logs:

- macOS: `~/Library/Logs/Claude`
- Windows: `%APPDATA%\Claude\logs`

Claude Desktop writes general MCP connection logs to `mcp.log` and named server stderr logs to files such as `mcp-server-sui-mcp.log`.

## Codex

Codex CLI supports stdio MCP servers and stores MCP settings in `config.toml`; by default this is `~/.codex/config.toml`, and trusted projects can use `.codex/config.toml`.

Developer checkout:

```bash
codex mcp add sui-mcp \
  -- node /absolute/path/to/sui-mcp/dist/runtime/start.js
```

Published npm package:

```bash
codex mcp add sui-mcp \
  -- npx -y @zktx.io/sui-mcp
```

Verify with:

```bash
codex mcp list
```

Inside the Codex TUI, use `/mcp` to see active MCP servers.

Equivalent `~/.codex/config.toml` entry for a developer checkout:

```toml
[mcp_servers.sui-mcp]
command = "node"
args = ["/absolute/path/to/sui-mcp/dist/runtime/start.js"]
startup_timeout_sec = 10
tool_timeout_sec = 60
```

Equivalent `~/.codex/config.toml` entry after npm publication:

```toml
[mcp_servers.sui-mcp]
command = "npx"
args = ["-y", "@zktx.io/sui-mcp"]
startup_timeout_sec = 10
tool_timeout_sec = 60
```

After changing `config.toml`, restart the Codex session so the stdio process is relaunched from the new config.

## Cursor

Cursor supports MCP servers through `mcp.json`.

Configuration locations:

- Project-specific: `.cursor/mcp.json`
- Global: `~/.cursor/mcp.json`

Developer checkout:

```json
{
  "mcpServers": {
    "sui-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/sui-mcp/dist/runtime/start.js"]
    }
  }
}
```

Published npm package:

```json
{
  "mcpServers": {
    "sui-mcp": {
      "command": "npx",
      "args": ["-y", "@zktx.io/sui-mcp"]
    }
  }
}
```

Restart Cursor after changing `mcp.json`. Cursor MCP logs are available from the Output panel; choose the MCP Logs output channel.

## First Use Flow

After the MCP server is connected:

1. Call `read_get_server_status` and record `packageName`, `version`, `evidencePolicy.version`, `network`, and `implementedToolsCount` before running evidence-policy checks. Use the returned numeric `implementedToolsCount` field instead of hand-counting the tool array.
2. Use wallet-free read tools directly when you need market context:
   - `read_list_deepbook_pools`
   - `read_list_deepbook_tokens`
   - `read_get_deepbook_mid_price`
   - `read_inspect_deepbook_orderbook`
   - `read_quote_deepbook_action`
   - `read_quote_deepbook_display_amount`
3. If a read tool accepts `account` and the user supplied a Sui address, pass it directly. When the user wants to connect a wallet for implicit reads, call `session_open_wallet_connection_card`.
4. Open the internal Connect card in an MCP Apps-capable client. Its authenticated view starts its one permitted connection request; there is no operation selector.
5. Scan the card’s pairing QR in a Sui mainnet wallet and approve the connection. This is not approval of a transaction.
6. Read or wait using the returned `cardId`. See [Session Tools](MCP_TOOLS.md#session-tools) for card outcomes and exact-operation reads. The completed connection card contains no addresses or further controls.
7. Call `session_get_interaction_status` to check the connection and `assetReadAccount`. `account_get_active_account` separately reports the saved read address, which is not proof of a usable connection.
   Then call the read tool that matches the user's request:
   - `read_summarize_wallet_assets` for balances.
   - `read_classify_wallet_assets` for coin-balance roles.
   - `read_preview_intent_evidence` for natural-language USD-denominated coverage or settlement-asset balance-total evidence.
   - `read_summarize_deepbook_account_inventory` for DeepBook manager or pool-account inventory.
   - `read_summarize_sui_activity_scan` for a live bounded activity summary.
   - `read_summarize_sui_function_activity_scan` for sent transactions that called one full function target.
   If the selected tool accepts `account` and the user supplied a Sui address, pass it instead of starting wallet connection. DeepBook account inventory has no explicit address input.
8. For local review evidence, use `read_list_review_activity`, `read_summarize_review_funnel`, or `read_get_review_session_detail`.
9. For requested wallet networks, the saved read address, local endpoints or local data controls, ask your AI client to call `settings_create_local_settings_session`, then use the internal card controls. Saved network choices apply to the next wallet connection; endpoint changes apply after the shared parent restarts.

## Wallet Connection Boundary

An active account is read context, not login, ownership proof or transaction
permission. Explicit public-address reads do not set it. Connect and Review use
internal MCP Apps views; there is no external wallet/review page or browser
signer. A client without a card surface can use ordinary reads but cannot start
these UI workflows. See [Wallet Connection](WALLET_CONNECTION.md).

The package includes Sui MCP's WalletConnect project identifier. Wallet
connection requires no project ID setting and offers no project ID override.
The identifier is public, not a wallet credential. Installations share that
project's Relay service limits; service availability is not guaranteed by a
local configuration value. Only the backend owner starts its isolated SDK child, and
clients use the same product identifier when identifying that shared backend.
Do not paste pairing URIs or UI permission values into chat.

Sui MCP allows one current wallet connection across the shared data folder,
with one fixed address per returned requested chain. Settings selects requested
Sui, Ethereum and Solana mainnet networks; financial actions remain Sui-only.
Change wallet, address or approved scope by disconnecting and reconnecting.
An unexpected SDK session is not adopted or listed as another product choice.
Remove it in the wallet app and check status before new pairing or financial input.
The product never silently chooses or remotely removes an unexpected session.

Connection service restart belongs to Settings, not Connect. If an operation
is unresponsive or the service is unavailable, ask to open Settings and use
Troubleshooting. Inspect the affected run/requests and confirm Restart
connection service. The backend waits for its old SDK child to exit and a new
run to become ready; it does not restart the parent or another app. If startup
itself remains pending, open a new Settings card for another explicit restart;
the prior pending startup is recorded as superseded. A known failure stays a
failure. No read, timeout or reopened frame initiates another restart.

If Settings or the parent service cannot be reached, fully quit all apps using
Sui MCP, then reopen them. Closing a peer or window can leave the owner alive.
Stop the participating MCP connections and wait for the shared parent backend
to exit before applying stored endpoint or installation changes. Client disable
and refresh controls can be used when they release every participating process;
otherwise fully quit the apps. Closing a peer or window alone can leave the
owner running. Reopen the connections and verify the intended server identity.
Restart connection service replaces only the SDK child and does not apply parent
configuration.

Restarting does not cancel a transaction on Sui or confirm remote disconnection.
Check retained connections in your wallet app. Saved results and the known
digests of submitted transactions remain available after restart. An
unsubmitted approval needs a fresh review and explicit wallet approval; nothing
is resent automatically. Normal initialization is not a failure warning.

All clients sharing a data folder must use the same package release. Private
parent/child and peer authentication bind that package identity; there is no
separate internal API or database version counter. Stop the old MCP connections and confirm the backend has exited before
starting the updated installation; an incompatible owner is refused.
The runtime checks the current product and private SDK storage structures directly; neither has a separate numeric version.

Review requires an explicit card action and individual wallet approval. The
backend uses Sui sign-only requests, verifies returned bytes/digest/signer and
submits once. Wallet support must be confirmed through its normal sign-only
flow; an advertised namespace or rejected request is not sufficient. Account,
Receipt and Chart do not sign or submit.

## Internal read cards

Ask the AI client to show an account asset card, a transaction result card, or a DeepBook USDC chart. The corresponding tools are `ui_open_account`, `ui_open_receipt`, and `ui_open_chart`. Claude Desktop and Codex desktop use their internal MCP Apps view. A client without that UI receives `ui_unavailable`; ordinary read tools still provide evidence.

A card accepts one read selection. Moving between chats or recreating its frame does not close valid unsubmitted input. After the server accepts the selection or its input period expires, the original input stays closed. Request a new card for a different selection. A server restart ends unfinished cards without repeating their queries; completed results remain readable. If a reply is lost, use the same card’s saved-state recovery before starting another request. These read cards do not connect a wallet, sign or submit transactions. Cards do not provide clipboard or copy-button features.

## Local data format

Start this runtime with an empty `SUI_MCP_DATA_DIR` or a database already in its current format. A mismatched existing database is refused before writes; incompatible databases and backups are not migrated or converted. A database with different table, constraint or field definitions requires a new empty data folder, preserving the existing folder. Databases and backups do not carry a separate numeric schema version. With a new empty folder, configure the required account context and endpoints. Existing files are left in place, and environment overrides keep their existing precedence. See [Local DB Architecture](LOCAL_DB_ARCHITECTURE.md) for the current format, backup scope and card-result retention. Card results do not expire with the input period and can increase DB size. Reset/import removes them along with the affected local data; it is not a card-only space cleanup operation.

## Local Settings

Beginner setup uses the built-in Sui mainnet gRPC and GraphQL endpoints. You do not need to copy an endpoint into Claude, Codex, Cursor, or another MCP client.

To inspect settings or change stored endpoints, ask your AI client:

- "Show my Sui MCP local settings."
- "Open my Sui MCP Settings card."

Settings groups Address for viewing assets, Wallet networks, Local records,
Troubleshooting and Advanced settings. Each card lets you make one change and
keeps its result:

- clear the saved Sui address used for implicit reads, without disconnecting the
  wallet, changing its fixed addresses or cancelling transaction requests;
- choose Sui, Ethereum and/or Solana mainnet networks for new wallet connections;
- back up records saved on this computer;
- restore a Sui MCP backup, replacing the current local records and settings;
- delete local records and saved settings;
- check or restart the wallet connection service;
- select a custom Sui network address or return to a built-in default.

Backups include chain-qualified address history, reviews, transaction and activity
records, requested wallet networks and Sui endpoint settings. They do not contain
the current connection, an active-account selection, read-address suppression or
wallet approvals. Restoring records does not reconnect a wallet or activate a
saved address. Transactions on Sui are not cancelled by a restore or reset.
Internal request IDs and file hashes appear in Details. Advanced settings names
the Sui node connection as gRPC and the activity-data connection as GraphQL.
Network addresses set in the app launch configuration take priority over values
saved in Settings; remove the relevant launch setting before restarting to use
the saved value.

Settings validation rules:

- Choose a backup file no larger than 16 MiB. The card shows file transfer and Checking backup while Sui MCP checks it automatically, then shows Restore available or Cannot restore with the reason. A file still being received is not a failed backup. These initial checks do not contact network addresses from the backup.
- Restore local records is your final confirmation. Sui MCP then checks the backup's network addresses before changing any data. Back from the confirmation clears that preparation and keeps a valid complete file. Returning from an input page to a section and using Resume preserves the selection and file. A change to local records requires a fresh check. Check backup again checks that same file when needed; Change backup file lets you choose another. Choosing or checking a file never restores it automatically.
- If Sui MCP rejects the backup's format or mainnet network settings, use Change backup file. Back and Check backup again cannot clear that rejection. If a network service is temporarily unreachable, you can check the backup again and make a new restore confirmation; network access is still checked before any records change.
- If another Settings operation or an unsettled wallet request temporarily blocks the change, Check status reads the same card again without repeating its action.
- Restoring or resetting can delete records whose transaction results were not confirmed and cannot cancel a transaction on Sui. It remains blocked while a wallet/transaction response is pending or the initial transaction-result waiting period has not ended, including after automatic result checks are stopped.
- Choose Download backup in Local records once. Sui MCP prepares and checks the backup internally, then asks the app to save it. There is no separate Create backup step. For supported downloads, the app controls the destination and Sui MCP keeps no permanent extra copy; Suggested file name is not a confirmed save path.
- If the download function explicitly reports that it is unsupported, the same backup is saved in `<SUI_MCP_DATA_DIR>/backups/` instead. Backup saved shows its actual Folder and File name. This file remains after restarting or replacing local data; temporary cleanup does not delete it. This choice depends on the function response, not the app name. Other errors do not silently change the destination.
- If an earlier attempt may already have saved a copy, a new delivery card offers Save a local copy with that warning. Retry save needs a new delivery card and a proven `not_published` failure. While saving or checking an uncertain result, Check status checks the same request without creating another file.
- An accepted download request does not prove that the file was saved. If delivery fails or cannot be confirmed, ask for a new delivery card for that backup. Its Retry download sends the same snapshot within the original thirty-minute period; the ended card has no retry controls. An unconfirmed earlier request may already have saved a copy. Cancel download stops further transfer and cleans the temporary snapshot; it does not close a save dialog or delete a saved file. Reopening a card never starts another download automatically.
- The thirty-minute transfer period starts when the snapshot is ready and is not extended by reads or retries. App acknowledgment, cancellation, expiry, server restart or local-data replacement ends private retention. A local save admitted before the deadline finishes its file work and records the result before cleanup; a restart can verify an already published file but never create a missing one. If temporary cleanup was not confirmed at completion, ask for a new Settings status card for that operation. It checks current cleanup without repeating the action, and the original result stays fixed. Existing saved local backup files are left intact. A backup larger than the 16 MiB restore limit is identified as such and is not silently truncated.
- Import accepts only the current backup format and required field structure. Required settings and activity fields must be present; missing fields are not filled from defaults.
- Current-format backups can contain `function_scan` provenance. Unsupported formats and scan-kind values are rejected rather than partially imported.
- Endpoint chain-identifier verification runs only when the user confirms the replace-only import.
- A custom gRPC endpoint must be an `http` or `https` URL with an explicit port and no credentials, path, query string, or fragment.
- A custom GraphQL endpoint must be an `https` URL with no credentials, query string, or fragment.
- The runtime verifies custom endpoints report the expected Sui mainnet chain identifier before saving them, including when an endpoint comes from an imported local data backup. The GraphQL endpoint is also verified lazily on first Sui activity tool use after process start.
- Endpoint changes apply after the shared parent server exits and restarts; use the connection stop/reopen procedure above.

## Advanced Runtime Settings

`SUI_MCP_GRPC_URL` and `SUI_MCP_GRAPHQL_URL` are advanced temporary overrides for operators and smoke tests. They win over the stored local setting for the current process and do not mutate SQLite:

```bash
SUI_MCP_GRPC_URL="https://fullnode.mainnet.sui.io:443" node /absolute/path/to/sui-mcp/dist/runtime/start.js
```

```bash
SUI_MCP_GRAPHQL_URL="https://graphql.mainnet.sui.io/graphql" node /absolute/path/to/sui-mcp/dist/runtime/start.js
```

Use this only when you need a one-run override or need to recover from a stored custom endpoint that no longer starts.

After the MCP server starts with the override:

1. Open the Settings card.
2. Restore the default endpoint or save a new endpoint.
3. Remove the environment override.
4. Restart the client.

Restoring default returns the stored endpoint to the built-in default.

If the custom provider is only temporarily unavailable, keep using the environment override or save a new custom endpoint instead.

`SUI_MCP_DATA_DIR` stays outside SQLite because the database path must be known before the database opens:

```bash
SUI_MCP_DATA_DIR="/path/to/local/app-data" node /absolute/path/to/sui-mcp/dist/runtime/start.js
```

To reset local product data files, stop the MCP server and delete `sui-mcp.sqlite`, `sui-mcp.sqlite-wal`, and `sui-mcp.sqlite-shm`, or use a new `SUI_MCP_DATA_DIR`.

Resetting, importing or replacing that database does not disconnect approvals
in your wallet app. Private SDK sessions are stored separately, and the backend
does not restore a connection without its product database record. If an old
connection is no longer listed in Sui MCP, remove it from the connected-app
list in your wallet app. Removing local data cannot cancel a transaction on Sui.

### Fixed review server port

`SUI_MCP_REVIEW_PORT` selects the authenticated shared backend port
(1–65535, default 8765). Clients for the same data folder must use the same port
and configuration. A second runtime owner for that folder is refused even on a
different port. No client forces a peer backend to stop. The parent can end only
its own SDK child, whose separate storage lease prevents overlapping SDK writers.
The port is not a browser-wallet authorization origin.

## Packed Package Testing

`npm run release:check` checks synchronized release metadata, typechecks, tests,
builds, and verifies the actual npm tarball and bundled licenses. It installs the
tarball in a temporary directory and runs that installed binary to check MCP
initialization, tools, document/card resources, the internal Settings card and
assets, and the isolated SDK child. It confirms that Connect rejects restart
input, ordinary model calls start no pairing, and the SDK keeps its exclusive
storage lease until shutdown. Runtime startup requires reachable Sui mainnet endpoints; a startup
failure leaves dependent checks unverified. The check uses an isolated data
directory and port, ends the child process before cleanup, and does not use your
stored wallet sessions, pair a wallet, sign, submit, reset data, or publish to npm.
See [Utility Index](UTILITY_INDEX.md#release-package-check) for prerequisites.

## Current Release Limitations

- Product-facing behavior is mainnet-only.
- Current asset reads without an explicit address require the saved Sui read address to belong to a usable current wallet connection. An explicit address works only for tools that accept `account`; DeepBook account inventory instead needs the saved Sui read address and a usable current connection. Saved result reads remain available.
- Account-bound DeepBook review requires all evidence stages. The internal
  Review card then allows an explicit WalletConnect request under user control.
  Requests and observed chain results are separate; missing results remain
  unknown and are not resubmitted automatically.
- External proposals remain non-signable. `blocked` refers to that review's
  unmet evidence requirements, not to a hidden fallback signing path.
- The `npx` and global-install client configs require a published version of
  `@zktx.io/sui-mcp`. A developer checkout or packed tarball tests local
  changes; its existence does not establish public package availability.

## Mainnet Read Smoke

Run this optional manual check when a release or provider diagnosis needs mainnet read evidence; it is not a mandatory predecessor of `release:check`. Normal setup does not require setting `SUI_MCP_GRPC_URL`; this environment variable is an operator override for the smoke process.

```bash
export SUI_MCP_GRPC_URL="https://fullnode.mainnet.sui.io:443"
export SUI_MCP_GRAPHQL_URL="https://graphql.mainnet.sui.io/graphql" # optional override; default is the built-in mainnet GraphQL endpoint
export SUI_MCP_SMOKE_ADDRESS="0x..."
export SUI_MCP_SMOKE_DEEPBOOK_POOL_KEY="DEEP_SUI"
export SUI_MCP_SMOKE_QUOTE_AMOUNT="1000000000" # raw integer units; for SUI, 1000000000 = 1 SUI
# Optional: export SUI_MCP_SMOKE_INSPECT_DIGEST="..."
# Optional: export SUI_MCP_SMOKE_INSPECT_RANDOM_LATEST="true"
# Optional: export SUI_MCP_SMOKE_FUNCTION_TARGET="0x...::module::function"
npm run build
npm run smoke:mainnet
```

The smoke script calls read-only MCP tools against mainnet:

- wallet assets;
- DeepBook orderbook;
- raw-quantity DeepBook quote;
- `read_scan_sui_account_activity` for `SUI_MCP_SMOKE_ADDRESS` with limit 5;
- `read_summarize_sui_activity_scan` for the explicit `SUI_MCP_SMOKE_ADDRESS` with limit 5.

When `SUI_MCP_SMOKE_FUNCTION_TARGET` is set to a full `package::module::function`, it also calls:

- `read_scan_sui_function_activity` for `SUI_MCP_SMOKE_ADDRESS` with limit 5;
- `read_summarize_sui_function_activity_scan` for the explicit `SUI_MCP_SMOKE_ADDRESS` with limit 5.

All four activity calls supply the address explicitly and require
`accountSource: "explicit_filter"`. They do not use or establish saved read context.

The raw-quantity DeepBook quote smoke path does not call the display-amount quote.
Without the complete optional swap input group, account-bound transaction-material
computation is not run. The optional account-bound review smoke uses the same
producer and records its actual evidence stages; read-only smoke success alone
does not prove that stage ran or that a wallet will accept the transaction.

Empty account or function activity pages are valid smoke outcomes. They are recorded with `rowCount: 0` and `emptyAccepted: true`.

When `SUI_MCP_SMOKE_FUNCTION_TARGET` is unset, function activity smoke is recorded as not run with `notRunReason: "missing_env"`.

The smoke result file records tool names, environment-variable presence, activity status, row counts, source method, window/order flags, persistence status, whether a function target was present, and evidence-boundary metrics.

Recorded metrics include:

- `fullDetailsReturned`;
- `compactReturned`;
- `compactBalanceChangeRowCount`;
- `compactAggregatedBalanceChangeRowCount`;
- `transactionContextCount`;
- `requestedAccountTransactionFactCount`;
- `requestedAccountTransactionFactBalanceChangeRowCount`;
- `requestedAccountEffectBalanceChangeRowCount`;
- `requestedAccountEffectTruncatedTransactionCount`;
- `requestedAccountCoinFlowCount`;
- `analysisCoinFlowCount`.

The result file does not store raw GraphQL payloads, transaction bytes, signatures, raw transaction details, or compact transaction aggregates.

Activity scan and summary smoke paths fail if full transaction details or compact transaction aggregates are returned.

It does not call DeepBook account inventory tools.

If `SUI_MCP_SMOKE_INSPECT_DIGEST` is set, it also calls `read_inspect_sui_transaction` for that digest and the smoke address.

If `SUI_MCP_SMOKE_INSPECT_RANDOM_LATEST=true` is set and `SUI_MCP_SMOKE_INSPECT_DIGEST` is unset, it samples one digest from the latest GraphQL transaction page and inspects that digest without an account argument.

It is not part of CI or `release:check`.
`SUI_MCP_SMOKE_ADDRESS` must be a 32-byte hex Sui address, for example `0x` followed by 64 hex characters.
`SUI_MCP_SMOKE_FUNCTION_TARGET` is optional. When set, it must be a full Sui function target in `package::module::function` form; package-only, package-and-module-only, bare function names, and generic/type-argument forms fail the optional function activity smoke path.
`SUI_MCP_SMOKE_INSPECT_DIGEST` is optional. Use a digest whose sender or returned balance-change owner is `SUI_MCP_SMOKE_ADDRESS` to exercise the stored digest-lookup path; otherwise the lookup can still return `ok` with `persistence.stored: false`.
`SUI_MCP_SMOKE_INSPECT_RANDOM_LATEST=true` checks current transaction-read shape without pinning a specific user address and without exercising the stored relation path.

## Troubleshooting

### Server does not appear in the client

- Confirm the command uses absolute paths for local checkout setup.
- Confirm `npm run build` has completed after source changes.
- Restart the MCP client so it relaunches the stdio process.
- Run the configured command directly in a terminal and check stderr.
- For Claude Desktop, check the MCP logs under `~/Library/Logs/Claude` or `%APPDATA%\Claude\logs`.

### Runtime exits on startup

A bootstrap failure exits with code 1 and a `fatal runtime error` diagnostic on
stderr, including a safe stage and reason. An MCP initialization response alone
does not mean backend startup succeeded. A foreign or incompatible port owner,
private data ownership/permission failure, and mainnet endpoint failure are
reported separately. Use the same installed runtime and configuration in all
clients; the runtime does not replace an incompatible listener automatically.
Normal client input closure exits with code 0 after cleanup. SIGINT/SIGTERM keep
codes 130/143. Cleanup failure is reported and makes a normal closure fail; it
cannot erase an earlier fatal or signal exit. SDK service unavailability is a
separate condition and does not by itself shut down the parent read service.

- If a stored custom endpoint fails, temporarily start with `SUI_MCP_GRPC_URL`, open the Settings card, restore the default Sui gRPC URL or save a new endpoint, remove the override, and restart.
- If an environment override is present, confirm it has scheme, host, and explicit port only.
- If the startup chain identifier guard fails, use a Sui mainnet gRPC endpoint. If a Sui activity tool fails its GraphQL chain identifier guard, use a Sui mainnet GraphQL endpoint.

### Tool calls return `active_account_not_set`

For tools with an `account` input, provide an explicit Sui address in chat. DeepBook account inventory has no address input and needs the current connected Sui address. When a new connection is wanted:

1. Open a Connect card using `session_open_wallet_connection_card` with empty input.
2. The card prepares the QR after confirming current state.
3. Scan it and approve the Sui mainnet connection in your wallet.
4. Read or wait on that `cardId`, then inspect current addresses through `session_get_interaction_status`. See [Session Tools](MCP_TOOLS.md#session-tools) for exact-operation reads and [Wallet Connection](WALLET_CONNECTION.md#one-connection-fixed-addresses) for fixed network results.
5. Confirm connection availability with `session_get_interaction_status`. Stored read context alone is not sufficient for current asset reads. If Settings cleared the read address, that does not mean the wallet disconnected; the same connection does not automatically restore the address.

If the user supplied a specific Sui address for `read_summarize_wallet_assets` or `read_classify_wallet_assets`, pass that address as `account` instead of creating a wallet connection session.

### NPM command returns 404

A 404 means the requested package or version could not be retrieved from the
selected registry. Confirm the exact name and version, for example with
`npm view @zktx.io/sui-mcp@0.8.0 version --registry=https://registry.npmjs.org`.
A new version may not have been published or become visible yet; a mistyped name
or an alternate/private registry can also explain the response. Check the
publication result and registry configuration before retrying. Do not assume
that the package exists solely because a local checkout builds successfully.
Developer Checkout Setup or `npm run release:check` can test local changes;
neither substitutes for public publication.

## Client Snippets

The Claude Code, Claude Desktop, Codex, and Cursor snippets above were checked against official client documentation current to this repository update. If a client changes its MCP config format, prefer that client's official documentation over this file and update this file in the same change.

### Optional account-bound review smoke

Set `SUI_MCP_SMOKE_SWAP_PROTOCOL`, `SUI_MCP_SMOKE_SWAP_FROM_SYMBOL`, `SUI_MCP_SMOKE_SWAP_TO_SYMBOL` and
`SUI_MCP_SMOKE_SWAP_AMOUNT_DISPLAY` together to opt into read-only account-bound review
computation. Protocol is explicitly `deep`; the smoke does not silently select a protocol.
A partially configured group is an error. `SUI_MCP_SMOKE_SWAP_MAX_SLIPPAGE_BPS` keeps the
existing explicit override. The script uses the same runtime review composition,
material store and evidence validation as the product, and records whether
transaction review data was emitted. This can involve mainnet simulation but
never wallet pairing, signing or submission. The temporary database supplies
known-account history for that explicit address; it does not create a current
wallet connection, saved read context or proof of ownership. Without the complete
optional group, the result records that review computation was not run.
