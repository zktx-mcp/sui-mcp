# SDK API Verification

This document records the pinned SDK APIs used by the current runtime. Backend
API facts come from the installed SDK source in `node_modules`. Browser
libraries are embedded during the build; their packaged versions are recorded
in the card dependency notices described below.

## Package Versions

- `@modelcontextprotocol/ext-apps`: `1.7.5`
- `@modelcontextprotocol/sdk`: `1.31.0`
- `@mysten/sui`: `2.17.0`
- `@mysten/deepbook-v3`: `1.3.6`
- `@walletconnect/sign-client`, `@walletconnect/types`, `@walletconnect/utils`: `2.23.10`
- `qrcode`: `1.5.4`
- `@zktx.io/ptb-model`: `0.5.0`
- `mermaid`: `11.16.1`
- `katex`: `0.18.2`, pinned by an override scoped to `mermaid@11.16.1`

Mermaid and its KaTeX dependency are build dependencies for the embedded card
resources, not Node server runtime dependencies. Their versions are fixed by
the source-checkout lockfile and included in the generated HTML. Installed npm
dependencies do not apply a dependency package's own overrides.

## Bundled Transaction Diagrams

The backend uses `@zktx.io/ptb-model` to generate a flowchart from verified
review material or a transaction read from Sui. The shared browser renderer
uses Mermaid to display that flowchart in the Review and Receipt cards.
The diagram is display evidence; it does not authorize signing or execution.

`scripts/build-mcp-ui.ts` embeds each card's script and styles in one HTML
resource and records the modules included in that resource. Check
`dist/mcp-app/review.notices.txt` and `receipt.notices.txt`, or the dependency
notices embedded in their HTML, for the actual browser-library versions.
The dependency versions in a new source-checkout build come from
`package-lock.json`. Reinstalling a published package's runtime dependencies
does not replace the libraries already embedded in its card HTML. A browser
dependency update requires rebuilding and distributing the card resources.

## MCP Apps

`@modelcontextprotocol/ext-apps` is pinned to `1.7.5`, with MCP SDK `1.31.0`. The server uses `registerAppTool`, `registerAppResource` and `getUiCapability`; the view uses `App` for host-mediated calls and teardown. Account, Receipt, Chart, Connect, Review and Settings are separate self-contained resources, so an account card does not load the PTB or chart renderer. Settings uses scoped app-only inputs for local actions and file transfer. The server keeps app-only permissions out of model content.

Settings completes a selected upload's verification and restore preparation on
the backend. The card renders the stored `restoreCheck` result and collects one
final restore confirmation; it does not parse backup contents, decide backend
eligibility or apply data automatically. The complete file, preparation and
final input remain bound to their card/operation identity and current revision.
The backend distinguishes unsealed receiving, active checking, a sealed file
needing a new check, a current confirmation and actual rejection. Definite
file/mainnet rejection is independent of local-data confirmation revision and
survives Back until explicit file selection changes. The View's current file-job
progress describes communication only; it cannot grant restoration authority.

Recorded backup locations use backend-native folder and file-name fields;
optional `App.downloadFile` delivery remains separate from local publication.

The shared server uses the pinned MCP SDK Streamable HTTP transport behind authenticated loopback access. Stdio clients forward tool, resource and prompt requests with their original client identity and capabilities. SDK 1.31.0 limits each internal HTTP request body to 4 MiB, including its complete MCP JSON-RPC envelope and metadata. Oversized bodies are refused before tool or card dispatch. Card calls additionally have a 64 KiB envelope budget; ordinary MCP calls do not inherit that smaller limit. Restore uploads retain their 16 MiB file limit and are split into messages within the card budget. The SDK's internal HTTP batch guard does not expose a stdio batch feature.

## WalletConnect Runtime

The backend passes the product identifier from `src/runtime/walletConnectConfig.ts`
to the pinned `SignClient.init`. The shared runtime's configuration identity uses
the same value. There is no user project ID setting or environment override.
Identifier-format validation remains before SDK initialization. Initialization,
restoration and runtime-state failures remain separate from wallet approval and
transaction results; public diagnostics do not include raw SDK error bodies.

## Sui gRPC Client

Verified from `node_modules/@mysten/sui/src/grpc/index.ts`, `client.ts`, `core.ts`, and `node_modules/@mysten/sui/src/client/types.ts`.

- Import path: `@mysten/sui/grpc`
- Client: `SuiGrpcClient`
- Constructor input includes:
  - `network`
  - `baseUrl`
  - optional `fetchInit`
  - or custom `transport`
- Runtime construction:

```ts
new SuiGrpcClient({
  baseUrl: "https://fullnode.mainnet.sui.io:443",
  network: "mainnet"
});
```

Confirmed methods:

| Method | Signature Source | Notes |
| --- | --- | --- |
| `client.core.getChainIdentifier()` | `GrpcCoreClient.getChainIdentifier(_options?)` | Returns `{ chainIdentifier: string }`. |
| `client.core.listBalances(options)` | `GrpcCoreClient.listBalances(options)` | `options.owner` is required; `options.cursor` and `options.limit` are available. Returns `{ balances, hasNextPage, cursor }`. |
| `client.core.getCoinMetadata(options)` | `GrpcCoreClient.getCoinMetadata(options)` | `options.coinType` is required. Returns `{ coinMetadata }`; metadata can be `null`. The gRPC implementation resolves type through MVR before calling `stateService.getCoinInfo`; the pinned gRPC implementation catches `getCoinInfo` failures and returns `coinMetadata: null`, so callers cannot distinguish those failures from missing metadata through this method alone. |
| `client.core.simulateTransaction(options)` | `GrpcCoreClient.simulateTransaction(options)` | Accepts `transaction`, optional `include`, optional `checksEnabled`. |

`SimulateTransactionOptions.checksEnabled` defaults to enabled and can be set to `false` for debug/read inspection. Read-only DeepBook SDK methods use simulation internally and must not be presented as signing readiness.

For review-time transaction simulation, use the public gRPC `client.transactionExecutionService.simulateTransaction` with validation checks enabled (`checks: ENABLED`), `doGasSelection: true`, and the complete stored BCS transaction. In the pinned core API, `doGasSelection: false` can let the node inject mock gas for an empty gas payment, changing the simulated digest. Require returned BCS to equal the submitted bytes and require the effects digest to match; selection must not change the reviewed material. Decode transaction facts from the identical returned BCS. Request effects, balance changes and object id/type facts, and require the normalized `effects`, `balanceChanges`, `objectTypes` and `transaction` evidence. Missing required fields must fail closed. Returned BCS is only a private equality check and must not enter public or stored review evidence; raw transaction bytes are not an MCP or review-app output. `commandResults` remains scoped to read-only DeepBook raw quote extraction using `client.core.simulateTransaction`, not swap review simulation evidence. Failed simulations are blocked pre-signing review facts, not wallet rejection, transaction submission failure, or automatic transient retry evidence. A thrown simulation call is refreshable only when it is classified as a transport, RPC, timeout, or endpoint availability failure; malformed transaction material, request-shape bugs, incomplete results, and adapter defects remain blocked.

Only an explicit `effects.status.success: false` reports simulation failure. A missing transaction, effects, status, or boolean success value means the response cannot establish an outcome. Incomplete or inconsistent evidence blocks the review with a fixed explanation; internal validation and JavaScript error messages are not public review facts. A `success: true` response still requires all material and evidence checks above.

During transaction building, the SDK's `SimulationError.executionError` does
not preserve every gRPC error kind. A build error can establish a returned
simulation rejection without establishing a specific funding shortfall. Build
error text is not used to infer insufficient gas or coin balance. Explicit
shortfalls remain available from verified funding reads and the typed error
kinds returned directly by review-time simulation.

## DeepBook Read Methods

Verified from `node_modules/@mysten/deepbook-v3/src/client.ts` and `node_modules/@mysten/deepbook-v3/src/types/index.ts`.

- Import path: `@mysten/deepbook-v3`
- Client: `DeepBookClient`
- Constructor requires:
  - `client`
  - `address`
  - `network`
- Constructor also accepts optional configured `balanceManagers`; Sui MCP uses this only to register a user-supplied `managerAddress` as an ephemeral SDK BalanceManager key for account-bound inventory detail reads.

The `address` is used by the SDK as the transaction simulation sender for read queries. For sender-independent DeepBook orderbook, raw-quantity quote, and display-amount quote reads, Sui MCP supplies an internal mainnet placeholder address. This placeholder is not user identity and must not be represented as wallet authorization.

Account-bound DeepBook reads, such as `read.summarize_deepbook_account_inventory`, use the active account address as the simulation sender. The product filters manager detail reads through on-chain `getBalanceManagerIds(owner)` discovery before calling account-bound detail methods; this is active read context, not signing authorization or custody.

Confirmed methods:

| Method | Return Type | Used For |
| --- | --- | --- |
| `midPrice(poolKey)` | `Promise<number>` | Orderbook context. |
| `poolBookParams(poolKey)` | `Promise<PoolBookParams>` | Tick, lot, and min size context. |
| `getLevel2TicksFromMid(poolKey, ticks)` | `Promise<Level2TicksFromMid>` | Bid/ask levels around mid price. |
| `deepBook.getQuoteQuantityOut(poolKey, baseQuantity)` | Transaction builder thunk | Base-to-quote quantity quote. Sui MCP passes positive raw input quantities that fit the SDK `u64` argument and parses the simulated raw `u64` return values directly. |
| `deepBook.getBaseQuantityOut(poolKey, quoteQuantity)` | Transaction builder thunk | Quote-to-base quantity quote. Sui MCP passes positive raw input quantities that fit the SDK `u64` argument and parses the simulated raw `u64` return values directly. |
| `getBalanceManagerIds(owner)` | `Promise<string[]>` | Active-account BalanceManager discovery. |
| `accountExists(poolKey, managerKey)` | `Promise<boolean>` | Gate before account-bound detail reads. |
| `account(poolKey, managerKey)` | `Promise<AccountInfo>` | Display-like account ledger and rebate inventory. Not raw/signable quantity. |
| `lockedBalance(poolKey, balanceManagerKey)` | `Promise<LockedBalances>` | Display-like balances tied to open orders. Not withdrawable/spendable readiness. |
| `accountOpenOrders(poolKey, managerKey)` | `Promise<string[]>` | Open order ID inventory; Sui MCP caps returned IDs in its public response. |

Relevant return shapes:

```ts
type PoolBookParams = {
  tickSize: number;
  lotSize: number;
  minSize: number;
};

type Level2TicksFromMid = {
  bid_prices: number[];
  bid_quantities: number[];
  ask_prices: number[];
  ask_quantities: number[];
};

type QuoteQuantityOut = {
  baseQuantity: number;
  baseOut: number;
  quoteOut: number;
  deepRequired: number;
};

type BaseQuantityOut = {
  quoteQuantity: number;
  baseOut: number;
  quoteOut: number;
  deepRequired: number;
};
```

The pinned SDK accepts `number | bigint` quote inputs. Its high-level quote query objects include an input echo field (`baseQuantity` or `quoteQuantity`) produced with `Number(inputRaw)`, plus display quote fields (`baseOut`, `quoteOut`, and `deepRequired`) produced after scalar division and `Number(...)` conversion. Sui MCP does not use those high-level query objects as the canonical quote source for adapter preparation. It uses the pinned SDK transaction builder quote functions, requests `client.core.simulateTransaction` command results, and parses raw `u64` return values. The simulated public Move entrypoint is `pool::get_quote_quantity_out` for base-to-quote reads and `pool::get_base_quantity_out` for quote-to-base reads; both delegate to `pool::get_quantity_out`, whose official Move source defines the return order as `base_quantity_out`, `quote_quantity_out`, and `deep_quantity_required`. Public `quote` fields are exact decimal display strings derived from those raw values through pinned DeepBook scalars; `rawQuote` carries the raw evidence. `read.quote_deepbook_action` marks the input as raw `u64`, while `read.quote_deepbook_display_amount` marks the input as a source display amount converted to raw `u64`. Raw quote evidence is not an effective price, price-impact calculation, quote-vs-mid slippage calculation, venue comparison, best-route claim, fiat cash-out estimate, external market lookup, USDC/USD peg assumption, P&L, cost basis, final min-out, signing data, or signing readiness. The account-bound DeepBook review may derive a fresh raw quote policy from this evidence and use that derived policy for local unsigned transaction material build, while keeping bytes private to the backend until a scoped user selection admits a WalletConnect request for that reviewed revision. MCP and ordinary review-status outputs still do not contain transaction bytes, signing data, or signing readiness. When the digest commitment stage completes, it is derived from the locally stored transaction bytes through pinned SDK `Transaction.from(...).getDigest()` and remains an internal binding, not a public signing artifact.

## Runtime Boundary

- JSON-RPC client imports are not used.
- Sui gRPC and GraphQL endpoints are resolved from local SQLite settings by default. `SUI_GRPC_URL` and `SUI_GRAPHQL_URL` are advanced temporary overrides and do not mutate stored settings.
- Sui gRPC URLs must include an explicit port and no credentials, path, query string, or fragment.
- Sui GraphQL URLs must use `https` and must not include credentials, query string, or fragment.
- The gRPC endpoint is verified during runtime startup. The GraphQL endpoint is verified when saved, imported, or first used by Sui activity tools.
- `fetchedAt` fields are ISO 8601 UTC strings produced by `new Date().toISOString()`.
- Read-only tools may inspect mainnet state but must not create signable transaction material.

## WalletConnect and signature verification

The SDK child initializes pinned SignClient with its public `storage` injection,
private session persistence, silent SDK logging and telemetry disabled. It uses
`connect`, `session.getAll`, `session_update/session_delete/session_expire` events,
and `request` on chain `sui:mainnet`, method `sui_signTransaction`.
Pinned `session_event` does not update approved namespaces itself: account/chain
selection events explicitly invalidate stored review/submission authority even
when the approved account set stays unchanged. Requests carry
`{ transaction: <stored BCS base64>, address }`; responses require
`{ transactionBytes: <BCS base64>, signature }`. No SDK source patch or automatic
sign-and-execute fallback is used.

The backend reconstructs the returned transaction with `Transaction.from`,
recomputes its digest and calls pinned `verifyTransactionSignature` with the
admitted address and verified Sui client (including schemes requiring online
verification). Submission uses `client.core.executeTransaction` exactly once
per admitted attempt. `waitForTransaction` supplies separately verified chain
facts; its absence/timeout does not prove execution failure.

SDK session storage persists only the pinned connection namespaces. History,
requests and unknown queue keys are volatile. The SDK has no supported complete
in-process disposal; its owner process lifetime bounds callbacks and storage.
The parent uses a fixed packaged Node child entrypoint and private package-bound IPC.
Only the SDK child owns SDK storage. The supervisor fences a terminating run,
sends SIGKILL to its owned child and waits for actual exit. Its explicit
replacement primitive is private infrastructure. Settings/Troubleshooting
owns explicit run/impact preparation, atomic input revocation/admission,
old-child exit, next-run reservation and ready/failure recording. Connect does
not own restart. A new explicit Settings operation can supersede a startup
still pending; known failure and its first timestamp remain immutable.
Late callbacks cannot reopen old authority or submit another transaction.

Snapshots and per-session versions distinguish present, absent and unusable
sessions. Source inspection failure disables the service instead of becoming an
empty session list. `accountsChanged` and `chainChanged` invalidate selection
even if namespace values are unchanged. The final pre-submission session check
runs after asynchronous digest/signature/network checks. Responses from another
SDK run cannot satisfy that check or restore submission authority.
Actual target-wallet acceptance of the serialization is an integration
requirement, not something inferred from these SDK APIs or a rejected request.

## Funding formats in Sui 2.17.0

The pinned Transaction builder first resolves CoinWithBalance intents. With
SuiGrpcClient, the SDK's gRPC resolver then asks the node to resolve transaction
objects, gas payment, and expiration. The common client resolver is a separate
SDK path; testing it alone does not establish the runtime's gRPC behavior.

The source of truth for address-balance withdrawal and gas reservation formats
is Sui mainnet-v1.72.5 `sui-types/src/coin_reservation.rs` and
`transaction.rs`, together with the installed Sui 2.17.0 source. Its
`utils/coin-reservation.ts` helper is not publicly exported. The local read-only
funding verifier uses the SDK's public BCS, base58 and dynamic-field primitives
for the documented reservation format; it does not replace SDK coin selection
or import private package paths. Reservation epochs cover N and N+1.

Address-balance gas uses an empty payment array with ValidDuring replay
protection. A reservation reference can also fund a gas coin together with
actual coin objects. Source reads and checks-enabled review simulation remain
required; protocol feature availability alone does not prove wallet acceptance
or execution success.
