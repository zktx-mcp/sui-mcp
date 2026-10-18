# MCP Setup

This is the setup guide for Sui MCP clients. It owns installation, MCP client connection, first-use flow, local settings, and troubleshooting.

It does not define tool field contracts or response wording. Use `docs/MCP_TOOLS.md` for the MCP API reference and `docs/AGENT_BEHAVIOR.md` for the answer playbook.

The normal path is **install once with npm → register the command in each app → ask your first question**. No source checkout or special installation folder is required.

These instructions describe `@zktx.io/sui-mcp@0.8.1`. The npm commands work only after that exact version is published. A repository commit, local build or successful package check does not publish it. Do not substitute an older release and assume it has the behavior described here.

Already using Sui MCP? Follow [Updating an Existing Sui MCP Installation](#updating-an-existing-sui-mcp-installation) before replacing a running installation.

- [Install with npm](#published-package-setup)
- Register: [Codex](#codex), [Claude Desktop](#claude-desktop), [Claude Code](#claude-code), or [Cursor](#cursor)
- [Try it without a wallet](#first-use-flow)
- [Use several apps together](#using-multiple-apps)
- [Troubleshooting](#troubleshooting)

## Requirements

- Install Node.js 22 or newer; Node 24 LTS is a suitable choice. The [Node.js download page](https://nodejs.org/en/download) provides installers that include npm.
- Install the AI app you want to use. It must support running a local MCP server. MCP (Model Context Protocol) lets the app call Sui MCP's tools.
- Allow network access to npm for installation and Sui mainnet services for reads. Default Sui endpoints are built in; no API key or endpoint configuration is needed for the default path.

Open Terminal on macOS/Linux, or PowerShell on Windows, and check:

```sh
node --version
npm --version
```

Node must report `v22` or newer, and npm must print a version. If either command is missing, install Node.js and reopen the terminal before continuing. You can run the installation commands from any folder.

Interactive cards require the app's MCP Apps support. A local stdio connection alone does not establish card support. Clients without it can use ordinary read tools, including public-address reads, but cannot run Connect, Disconnect, Review or Settings workflows. The wallet-free text example below works without cards.

## Published Package Setup

### Install once with npm

Check that the version described by this guide is available:

```sh
npm view @zktx.io/sui-mcp@0.8.1 version
```

The result must be `0.8.1`. If the version is unavailable, stop here; see [NPM command returns 404](#npm-command-returns-404). Wait for publication, use the documentation for an available release, or deliberately choose the optional [developer checkout](#developer-checkout-setup). Dropping the version from the install command can install a different release.

Install the published package:

```sh
npm install -g @zktx.io/sui-mcp@0.8.1
```

Install once in the Node/npm environment your apps use, then register each app separately. `-g` makes the executable available across projects; it does not automatically configure every app or grant access to other operating-system users. The installed version stays in place until you explicitly update it.

Use the full scoped name `@zktx.io/sui-mcp`: the unscoped npm package `sui-mcp` is a different project that can expose the same executable name. The package supplies a command named `sui-mcp`; use that command in the app configurations below. No runtime arguments, environment variables, repository path, database installation or WalletConnect project ID are needed for default setup.

If installation reports a permission error, see [Global installation permission error](#global-installation-permission-error). If the app cannot find the installed command, see [Command not found](#command-not-found).

## Codex

Codex Desktop, CLI and IDE integrations on the same Codex host share MCP configuration. You can configure the desktop app without installing the CLI separately.

1. Open `~/.codex/config.toml` in a plain-text editor; create the folder/file if it does not exist. On macOS, Finder → Go → Go to Folder accepts `~/.codex`. On Windows, the default file is `%USERPROFILE%\.codex\config.toml`.
2. Add the following table. If it already exists, update it instead of adding another one. Keep unrelated configuration in the file.

```toml
[mcp_servers.sui-mcp]
command = "sui-mcp"
```

3. If the server was previously disabled, enable its entry in MCP settings. Save the configuration and fully restart Codex once to load it; an additional Refresh is not needed after that restart. Do this between tasks because restarting or refreshing can interrupt an active session.
4. In a new chat, use the [first question](#first-use-flow) below to confirm the running package and version. Seeing a configuration entry alone does not confirm that the server started.

If you already use Codex CLI, this command is an alternative to editing TOML, not an additional step:

```sh
codex mcp add sui-mcp -- sui-mcp
```

Run `codex mcp list` or use `/mcp` inside the terminal UI to inspect configured servers. No custom timeout values are required for the normal global-install configuration. See the [official Codex MCP guide](https://developers.openai.com/codex/mcp) for configuration options.

## Claude Desktop

1. Open the desktop app's Settings → Developer → Edit Config. This is the desktop app configuration, not the web account settings.
2. Add `sui-mcp` under `mcpServers` in `claude_desktop_config.json`. For an otherwise empty configuration, use:

```json
{
  "mcpServers": {
    "sui-mcp": {
      "command": "sui-mcp"
    }
  }
}
```

If `mcpServers` already contains other entries, add only the `sui-mcp` member and a comma between members. Keep other servers and settings; do not replace the entire file. JSON does not allow comments or trailing commas.

The configuration file is normally at:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

3. Save the file, fully quit Claude Desktop and reopen it.
4. Start a new chat and use the [first question](#first-use-flow) below. The app may ask you to allow tool use. A successful server-status response confirms the connection.

If the server does not appear, the MCP logs are normally at `~/Library/Logs/Claude` on macOS or `%APPDATA%\Claude\logs` on Windows. General connection logs use `mcp.log`; the server's stderr is in `mcp-server-sui-mcp.log`. The [official local-server walkthrough](https://modelcontextprotocol.io/docs/develop/connect-local-servers) illustrates the Developer configuration screen.

## Claude Code

With Claude Code installed, run this in a terminal:

```sh
claude mcp add --transport stdio --scope user sui-mcp -- sui-mcp
```

The user scope makes this registration available across your projects. Use `--scope local` for only the current project, or `--scope project` to share a `.mcp.json` registration with a project. Choose one scope; do not register duplicate copies for normal setup. CLI options precede the server name; `--` separates them from the server command.

Start a new Claude Code session. Use `/mcp` to inspect the connection, then ask the [first question](#first-use-flow). You can also inspect the registration with:

```sh
claude mcp get sui-mcp
```

After a configuration change, restart the session so it starts the new command. See the [official Claude Code MCP guide](https://code.claude.com/docs/en/mcp) for scope and connection details.

## Cursor

1. Open or create `~/.cursor/mcp.json` for a user-wide registration. On Windows, this is normally `%USERPROFILE%\.cursor\mcp.json`. For only one project, use that project's `.cursor/mcp.json` instead; you do not need both.
2. Add this configuration, preserving any other members already in `mcpServers`:

```json
{
  "mcpServers": {
    "sui-mcp": {
      "type": "stdio",
      "command": "sui-mcp"
    }
  }
}
```

3. Save and restart Cursor. Open its MCP management view (Customize → MCP in current versions), check that `sui-mcp` is enabled, and allow the connection if prompted.
4. Start an Agent chat and ask the [first question](#first-use-flow). A returned server status confirms startup. If it fails, inspect the server's error in the MCP management view or the MCP Logs channel in Output.

See the [official Cursor MCP guide](https://cursor.com/docs/mcp) if your version presents these settings differently.

## First Use Flow

### 1. Confirm the running server

After registering your app, paste this into a new chat, not a terminal:

```text
Use Sui MCP to show its package name, server name, version and network.
```

The app should call `read_get_server_status`. Confirm `packageName` is `@zktx.io/sui-mcp`, `serverName` is `sui-mcp`, `version` is `0.8.1` and `network` is `mainnet`. These are the expected identifiers, not a sample observation. If the version differs, use [Updating an Existing Sui MCP Installation](#updating-an-existing-sui-mcp-installation) rather than assuming the new installation replaced a running server.

### 2. Try a read without connecting a wallet

```text
Use Sui MCP to list the available DeepBook pools on Sui mainnet.
```

The app should call `read_list_deepbook_pools` and return pool names and trading assets. Results can change; no fixed pool count or price is required. This request needs no wallet, funds, card, signature or transaction. A successful status response followed by this read confirms that the app can reach Sui MCP and use a mainnet read tool. If a network read fails, use the returned reason and [Troubleshooting](#troubleshooting); do not connect a wallet to fix it.

If you want to try an interactive read card in an MCP Apps-capable app, ask:

```text
Show a DeepBook SUI/USDC price chart in Sui MCP.
```

Expect a read-only Chart card with candle data, or an explicit source/availability result. A chart-data failure is separate from installation failure. No wallet connection or signing is involved. An app without the required card support can still use the text read above.

### 3. Optionally connect your wallet for asset reads

This is separate from installation. Use an app that can display MCP Apps cards and a wallet that supports WalletConnect for the requested networks.

The initial network selection is Sui. To request Ethereum and/or Solana addresses as well, first ask "Open my Sui MCP Settings card", choose Wallet networks, select the networks and choose Save networks. These choices apply only to the next connection. Other-chain addresses do not enable other-chain financial actions.

Then ask:

```text
Connect my wallet using Sui MCP.
```

The internal Connect card checks current state and displays a QR for its one request. Scan it with your wallet and approve the connection. This is connection approval, not transaction approval. A completed card shows its fixed result without addresses, QR or further controls.

Ask "Show my current Sui MCP connection and wallet balances". The agent reads `session_get_interaction_status` and, when its Sui read context is usable, `read_summarize_wallet_assets`. A wallet can approve only a subset of requested networks; only valid returned addresses are usable. Change wallet, address or approved networks by asking to disconnect, confirming the separate Disconnect card, and requesting a new connection.

You can instead supply a Sui public address for a tool that accepts `account`; connecting a wallet is not required for that explicit-address read. DeepBook account inventory requires the current connected Sui read address and does not accept an explicit address input.

### For agents

Use the user's request to select subsequent read tools; do not run a tool checklist as installation work. `read_classify_wallet_assets` classifies coin balances, `read_preview_intent_evidence` handles supported USD-denominated questions, `read_summarize_deepbook_account_inventory` reads connected-account inventory, and the Sui activity tools provide bounded activity reads. For saved review evidence, use `read_list_review_activity`, `read_summarize_review_funnel` or `read_get_review_session_detail`.

Before evidence-policy checks, record `packageName`, `version`, `evidencePolicy.version`, `network` and the returned numeric `implementedToolsCount` from `read_get_server_status`; do not hand-count the tool array. Use `session_get_interaction_status.assetReadAccount` to determine whether implicit asset reads are usable; `account_get_active_account` alone reports stored read context, not a usable connection. Read/wait on a connection card only by its returned `cardId`. Settings and wallet changes require the user's scoped card actions. Follow [MCP Tools](MCP_TOOLS.md) and [Agent Behavior](AGENT_BEHAVIOR.md) for exact contracts and question flows.

## Using Multiple Apps

You can use Sui MCP from several local apps at the same time, for example Codex and Claude Desktop on the same computer under the same operating-system user. Install the npm package once and register `sui-mcp` in each app; you do not need a separate server installation or wallet pairing per app.

With default settings, the apps automatically use the same local backend, data folder, saved settings and one current wallet connection. A connection made or disconnected in one app affects the current connection seen by the others. There is still only one connection with one fixed address per approved chain, not one wallet connection per app. Completed cards keep their original results; another app's actions do not reopen or rewrite them. Transaction approval is required for every transaction.

All participating apps must use the same package release and configuration. If you deliberately override `SUI_MCP_DATA_DIR` or `SUI_MCP_REVIEW_PORT`, use the same values in every app; these overrides are not needed for normal setup. An incompatible running backend is refused rather than replaced. This sharing is local to the computer/user, not a remote or cloud connection.

When updating the package or applying stored endpoint changes, stop Sui MCP in all participating apps and let the shared backend exit before reopening them. Closing one chat or one app may leave the backend running for the others. Follow [Updating an Existing Sui MCP Installation](#updating-an-existing-sui-mcp-installation); an ordinary second-app registration does not require reinstalling the package or repeating a completed connection test.

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

## Developer Checkout Setup

Use Node.js 22.12 or newer within 22.x, or Node.js 24 or newer, for source builds
and tests. These ranges satisfy Vite, Rolldown and Vitest together. The installed
package's runtime requirement remains Node.js 22 or newer.

This is optional for contributors and unpublished source builds. Normal npm installation does not require Git, a repository checkout, build commands or a custom runtime path. Install Git as well as Node.js before using this path:

```bash
git clone https://github.com/zktx-mcp/sui-mcp.git
cd sui-mcp
npm install
npm run build
```

After building, use the app-specific registration instructions above, but replace the global command with `node` and the absolute path to the built file. Replace the example path with your checkout location; no particular checkout folder is required:

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

This is an alternative to the global-install path. If your client supports the [MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=sui-mcp), choose `io.github.zktx-mcp/sui-mcp` and check that the offered package is `@zktx.io/sui-mcp` at version `0.8.1`. Do not assume the registry entry already offers an unpublished release. Check the running identity through the first-use flow after registration.

## Download on demand (npx)

Use this alternative if you do not want a global install. Replace the global command in your app registration with this exact-version launch configuration:

```json
{
  "command": "npx",
  "args": ["-y", "@zktx.io/sui-mcp@0.8.1"]
}
```

For Codex, the equivalent is:

```toml
[mcp_servers.sui-mcp]
command = "npx"
args = ["-y", "@zktx.io/sui-mcp@0.8.1"]
```

This downloads the requested published package as needed. A cold cache can exceed the app's startup timeout; the global install avoids per-launch package resolution. Keep the exact version in every app's configuration. Neither an unversioned package name nor `@latest` guarantees the version described by this guide.

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

Closing a chat or app window can leave its MCP process running in the
background. Disable Sui MCP in each participating app or fully quit those apps,
and confirm the shared backend has exited before replacing the package. With
a global installation, keep the existing `command = "sui-mcp"` or JSON
`"command": "sui-mcp"` registration; updating the package does not require a
new executable path.

This is a pre-release. Local data compatibility between releases is not
guaranteed, and migration is not provided. An incompatible database is rejected
before writes; an npm update or reinstall does not convert or remove it.
If startup reports a database format mismatch, follow [Database format mismatch](#database-format-mismatch).
You may keep the old files and select a new empty directory, or explicitly
choose to discard the old local data and settings and restart with defaults.
Neither the runtime nor an installation agent may make that deletion choice
for the user. A compatible update does not require a reset.
Never resend a transaction as an update step. Coordinate a safe restart if a
transaction request is still in progress. See
[Local Database Architecture](LOCAL_DB_ARCHITECTURE.md#current-format-and-backups)
for the storage and backup boundary.

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
`sui-mcp` as the default registration name. Install `@zktx.io/sui-mcp@0.8.1`
globally and register the `sui-mcp` command, or use the exact-version
[npx alternative](#download-on-demand-npx). A client-defined alias does not change the package,
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

First-time installations automatically create the default data folder and database with built-in mainnet endpoints and initial Sui connection scope. No data-directory override or custom endpoint is required. Wallet-dependent features require a connection; public-address reads do not.

A mismatched existing database is refused before writes; incompatible databases and backups are not migrated or converted. A database with different table, constraint or field definitions requires an empty data folder. Startup leaves existing files in place. Follow [Database format mismatch](#database-format-mismatch) to preserve the old files or explicitly choose a fresh start. Databases and backups do not carry a separate numeric schema version. Environment overrides keep their existing precedence. See [Local DB Architecture](LOCAL_DB_ARCHITECTURE.md) for the current format, backup scope and card-result retention. Card results do not expire with the input period and can increase DB size. Reset/import removes them along with the affected local data; it is not a card-only space cleanup operation.

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

For local-data changes during normal operation, use the confirmed Settings
actions. For incompatible-data startup recovery or an explicitly chosen empty
profile, follow [Database format mismatch](#database-format-mismatch). Installing
or updating the package does not authorize deleting local data. Do not remove
database files while the shared backend is running or a transaction request is
unresolved.

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

### Global installation permission error

An `EACCES` or administrator-permission error means npm cannot write to its global installation directory. On macOS/Linux, if that directory is administrator-owned and you intend to install there, run the installer with administrator authorization:

```sh
sudo npm install -g @zktx.io/sui-mcp@0.8.1
```

Enter the administrator password only in your terminal, never in chat. Launch the AI apps normally afterward; running Sui MCP does not require administrator privileges. If you cannot authorize that installation, follow npm's [global installation permission guidance](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally). This step is only for a permission failure, not an extra installation step for everyone.

### Command not found

If the app reports that `sui-mcp` cannot be found, fully reopen it after installing Node.js and the package. Apps must be able to find Node.js and npm's global executables in their `PATH` (the list of folders used to locate commands).

Find the installed executable in a terminal:

```sh
# macOS / Linux
command -v sui-mcp
```

```powershell
# Windows PowerShell
where.exe sui-mcp
```

If no path is returned, check `npm list -g @zktx.io/sui-mcp --depth=0` in the Node/npm environment used for installation. If the terminal finds it but the app does not, use the returned absolute executable path as the registration's `command` and ensure the app can also find Node.js. This is an environment repair, not a required custom installation location. See [npm's executable location rules](https://docs.npmjs.com/cli/v11/configuring-npm/folders#executables).

On native Windows, if the app cannot launch the npm command shim directly, use `cmd /c`. Inside a JSON server entry, use:

```json
{
  "command": "cmd",
  "args": ["/c", "sui-mcp"]
}
```

The corresponding Codex table is:

```toml
[mcp_servers.sui-mcp]
command = "cmd"
args = ["/c", "sui-mcp"]
```

If another package owns the global `sui-mcp` command, use the scoped, exact-version [npx alternative](#download-on-demand-npx) instead. Confirm the package identity through `read_get_server_status`; the executable name alone is not proof of which package is running.

### Server does not appear in the client

- Confirm the registration uses the configuration format and file location for your app, and that its server entry is enabled.
- For the global npm install, follow [Command not found](#command-not-found) if the app cannot launch the executable. No source build is needed.
- Only for a developer checkout, confirm the command uses the absolute built file path and that `npm run build` completed after source changes.
- Restart the MCP client so it relaunches the stdio process.
- Read the app's MCP error or server stderr to distinguish a missing executable from a runtime startup failure.
- For Claude Desktop, check the MCP logs under `~/Library/Logs/Claude` or `%APPDATA%\Claude\logs`.

### Runtime exits on startup

A bootstrap failure exits with code 1 and a `fatal runtime error` diagnostic on
stderr, including a safe stage and reason. An MCP initialization response alone
does not mean backend startup succeeded. An app may show only `Server
disconnected` or `Transport closed`; read its MCP server log for the diagnostic
reason. A foreign or incompatible port owner,
private data ownership/permission failure, and mainnet endpoint failure are
reported separately. Use the same installed runtime and configuration in all
clients; the runtime does not replace an incompatible listener automatically.
Normal client input closure exits with code 0 after cleanup. SIGINT/SIGTERM keep
codes 130/143. Cleanup failure is reported and makes a normal closure fail; it
cannot erase an earlier fatal or signal exit. SDK service unavailability is a
separate condition and does not by itself shut down the parent read service.

- If the reason says the review port is held by a foreign or incompatible runtime, identify the process using that port. If it is an older Sui MCP instance, disable its MCP connection or fully quit the app that owns it, then reopen the participating apps with the same package release, data directory and port. Closing a window alone may not stop that instance. If another application owns the port, use an available shared port in all participating Sui MCP clients. Do not delete local data or assign a different port to each app to bypass the conflict.
- If a stored custom endpoint fails, temporarily start with `SUI_MCP_GRPC_URL`, open the Settings card, restore the default Sui gRPC URL or save a new endpoint, remove the override, and restart.
- If an environment override is present, confirm it has scheme, host, and explicit port only.
- If the startup chain identifier guard fails, use a Sui mainnet gRPC endpoint. If a Sui activity tool fails its GraphQL chain identifier guard, use a Sui mainnet GraphQL endpoint.
- If the reason says `Local database format does not match this runtime`, use [Database format mismatch](#database-format-mismatch).

### Database format mismatch

This recovery applies to an existing installation with incompatible local data.
It is not an extra step for a first-time installation. The diagnostic
`Local database format does not match this runtime` means the database was
rejected before writes. The runtime does not migrate, repair or automatically
delete it. Reinstalling the npm package alone will not resolve this mismatch.
The Settings card cannot perform the recovery while startup is blocked.

Choose how to handle the old data:

- **Keep the files:** Leave the existing folder untouched and set
  `SUI_MCP_DATA_DIR` to a new empty folder in every participating app. Use the
  same folder for all apps; see [Advanced Runtime Settings](#advanced-runtime-settings).
  Old-format backups cannot be restored into the new format.
- **Start fresh with default settings:** Explicitly choose to delete the old
  Sui MCP data folder, then follow the steps below. This removes local activity
  and saved card results, stored addresses, network and endpoint settings, and
  private WalletConnect sessions and keys. An agent must obtain that choice;
  a request to install, update or fix startup is not permission to delete data.

For an explicitly chosen fresh start:

1. Stop Sui MCP in every app and wait for the shared backend to exit. Do not
   delete data while a transaction request is unresolved; resolve the existing
   request's digest or coordinate recovery first.
2. Locate the active Sui MCP data folder. With default settings, use your file
   manager's Go to Folder or address bar with the location below, then delete
   only the `sui-mcp` folder after confirming the fresh-start choice.

   | Platform | Default Sui MCP data folder |
   | --- | --- |
   | macOS | `~/Library/Application Support/sui-mcp` |
   | Windows | `%APPDATA%\sui-mcp` |
   | Linux | `$XDG_DATA_HOME/sui-mcp`, or `~/.local/share/sui-mcp` when `XDG_DATA_HOME` is unset |

   If `SUI_MCP_DATA_DIR` is configured, it selects the active folder instead.
   Remove an obsolete override from each app to return to the default path.
   Preserve other app settings and MCP registrations; do not delete a parent
   directory or another server's data.
3. Keep the global `sui-mcp` command registration and reopen the MCP connections.
   The runtime creates a new database with built-in defaults automatically.
   Ask for the package name, version and network using the [first-use status check](#1-confirm-the-running-server).
   A new wallet connection is needed only when you want wallet-dependent features.

Deleting local files does not reverse blockchain transactions or remove a
pairing still shown in your wallet app. Remove an unwanted pairing in the wallet
itself. Do not resend a transaction to reconstruct local history. Backups stored
outside the deleted folder remain untouched, and incompatible backups still
cannot be imported.

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
`npm view @zktx.io/sui-mcp@0.8.1 version --registry=https://registry.npmjs.org`.
A new version may not have been published or become visible yet; a mistyped name
or an alternate/private registry can also explain the response. Check the
publication result and registry configuration before retrying. Do not assume
that the package exists solely because a local checkout builds successfully.
Developer Checkout Setup or `npm run release:check` can test local changes;
neither substitutes for public publication.

## Client Snippets

The registration formats follow the official [Codex MCP guide](https://developers.openai.com/codex/mcp), [Claude Desktop walkthrough](https://modelcontextprotocol.io/docs/develop/connect-local-servers), [Claude Code MCP guide](https://code.claude.com/docs/en/mcp), and [Cursor MCP guide](https://cursor.com/docs/mcp). App menu labels can vary by version; use the official guide for your installed version. These configuration examples do not claim that every app supports the same card or file functions. Sui MCP uses the actual connection's capabilities and function responses.

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
