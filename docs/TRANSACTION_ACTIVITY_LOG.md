# Transaction Activity Log

This document owns local transaction activity storage boundaries: what is stored, what is not stored, and which MCP tools can return live or stored activity facts.

It does not define setup steps, tool schemas, complete-history support, P&L, route recommendations, transaction-building input, signing data, or signing readiness.

Sui MCP stores two kinds of local activity evidence:

- Sui MCP review evidence from local review sessions.
- User-requested bounded Sui activity facts that were looked up through GraphQL and matched a known local wallet.

It does not run a background indexer and does not claim complete wallet history.
Activity reads accept an explicit Sui account or use the saved read address.
If that address is absent or cleared, the caller supplies an explicit account;
no wallet connection is required for that read. These filters neither restore
read context nor change a Review's fixed transaction target.

## Stored By Default

Each review session stores its plan, optional sanitized requested intent,
preparation snapshots with review revision, and append-only transitions. The
first authenticated Review-card state read records opened once. Frame count or
model gateway creation does not establish user observation or approval.

Each final signature selection atomically records a `review_requests` attempt,
review/account/digest binding, immutable reviewed evidence, local request status,
timestamps and the session's explicit current-attempt reference. A subsequent
valid review revision can have another attempt; it does not overwrite history.
`review_executions` contains only a verified chain result for an exact attempt.
Its success/failure is distinct from request rejection, stopping or uncertainty.
Neither a lost submit reply nor a missing receipt is stored as chain failure.

The three review activity tools use that same distinction for filters, counts,
timing and detail. Totals count sessions; request and execution distributions
use the current referenced attempt. Historical stages are distinct-session
ever counts. First backend signature verification supplies timing, not request
start or RPC submission. Missing result/time remains absent or null. Repeated
reads, duplicate admission and same-state no-ops do not create new attempts or
new funnel events. Detail exposes current request plus capped earlier requests
and explicitly reports truncation. See [MCP Tools](MCP_TOOLS.md#stored-review-activity).

Current-format public backups retain these facts and validate account, plan,
review revision, attempt, digest, time and result relationships. They exclude
private card permissions, SDK secrets, submission authority, raw bytes and
signatures. Imported history is never a live request or management capability.
This is evidence about local Sui MCP reviews, not complete wallet history.

## Stored When Requested

When the user requests a Sui transaction digest lookup or account activity scan, the runtime can store normalized external activity facts only if the transaction is tied to an address already present in the local `accounts` table.

A returned scan row is tied to a known local account only when the sender or a returned balance-change owner matches that account.

Other provider-returned rows can be used for the current response but are counted as skipped for storage.

Stored scan rows include:

- scan id
- scan kind: `digest_lookup`, `account_scan`, or `function_scan`
- known local account
- relationship: `affected` or `sent`
- input digest or bounded scan window
- request and response cursor metadata
- endpoint host and verified chain identifier
- fetched timestamp
- stored/skipped counts
- `hasMore`, `windowComplete`, and incomplete reason such as `ordering_unverified`

Stored transaction rows include:

- known local account
- digest
- relationship
- checkpoint when returned by the provider
- timestamp when returned by the provider
- status: `success`, `failure`, or `unknown`
- known sender account id only when the sender is also a known local account
- first and last scan ids
- first and last fetched timestamps
- normalized detail facts when returned by GraphQL:
  - transaction kind
  - capped Move call targets with package, module, and function
  - raw coin balance changes in `amountRaw` signed integer strings, with the balance owner stored only when it is the known local account
  - object changes with object id, change kind, and before/after object type when available
  - event sequence, package, module, and event type, with the event sender stored only when it is the known local account
  - gas cost summary raw integer string fields, including derived `netGasCostRaw`
  - execution error message and structured abort location when available
  - truncation flags for capped detail lists

`function_scan` is internal provenance for sent-function scans.

It is not a stored function-history query, a function index, or authority to filter stored summaries by function.

Rows without `function_scan` provenance remain `account_scan`. Stored summaries do not infer function targets from `account_scan` rows.

Live scan and live-summary rows expose these fields for requested-account raw balance-change facts:

- `requestedAccountTransactionFacts`;
- `requestedAccount.coinFlows`;
- `transactions[].requestedAccountEffect`.

Use those fields for wallet-specific asset-flow answers.

`requestedAccountTransactionFacts[]` is a flattened account-scoped row surface for AI client summaries.

It repeats the row digest, status, and sender metadata.

It carries account-scoped fields such as:

- `accountBalanceChangeEvidence`;
- `accountBalanceChangeInferencePolicy`;
- `accountBalanceChanges`;
- `accountCoinFlows`;
- `accountEffectLimitations`.

It also includes transaction-level `transactionContext` for calls, events, objects, gas, truncation, and protocol labels.

Live scan and live-summary `transactionContext` intentionally omits transaction-wide balance-change aggregates. This prevents repeated ownerless raw balance-change facts from being mistaken for a requested wallet's balance movement.

A row-level `requestedAccountEffect` has `scope: "requested_account"` plus `role`, `balanceChangeEvidence`, `accountBalanceChangeInferencePolicy`, `coinFlows`, and `limitations` fields for that transaction.

`incomplete_account_balance_changes` and `account_balance_changes_unavailable` are not zero-balance evidence.

Only `no_account_balance_changes_returned` with complete details supports saying no requested-account balance change was returned in that row.

`accountBalanceChangeInferencePolicy: "do_not_infer_from_transaction_context"` means transaction-level context, visible recipient patterns, current wallet balances, compact counts, or aggregate analysis must not be used to infer the requested account's amount.

Activity `quantitySemantics` marks `amountRaw`, `increaseRaw`, `decreaseRaw`, and `netRaw` fields as raw integer facts that require verified decimals or a returned display amount before display conversion.

If `requestedAccount.balanceChangeCompleteness` or a row-level `requestedAccountEffect.balanceChangeCompleteness` is `truncated` or `unavailable`, say the account-specific balance-change evidence is incomplete instead of presenting the returned rows as complete.

Inspect responses and stored-summary rows can expose a derived `compact` view when full or stored details are available.

Activity summary responses expose `transactionDetailAvailability` for the returned `transactions` rows. `transactions[].transactionContext`, `transactions[].compact`, and `transactions[].details` are listed in `userAnswerUse.answerFields` only when every returned transaction row has details. Mixed rows must be described from `transactionDetailAvailability` and row-specific fields, not as an all-row detail guarantee.

`compact.factScope: "transaction"` and `compact.requestedAccountScoped: false` mean compact balance, object, event, and gas fields summarize the transaction, not the requested wallet.

Repeated identical compact balance-change facts can be aggregated with `count`.

`analysis.coinFlows` is a transaction/page aggregate over returned normalized facts, not wallet-specific evidence.

Gas raw values are MIST.

`compact.gasCost.display` and `analysis.gas.netGasCost.display`, when present, are SUI display facts derived with `@mysten/sui MIST_PER_SUI`.

Protocol matches are computed from normalized detail facts at response time and can include `mvrName`/`packageSource` for package-derived evidence.

They are transaction activity labels only, not stored protocol decoder output, wallet position inventory, P&L, route recommendation, transaction-building input, signing data, or signing readiness.

Live and stored summary tools can also expose deterministic `analysis` over returned normalized facts.

That analysis aggregates raw integer coin flows, gas totals, Move call targets, object/event counts, failure details, and protocol counts keyed by `protocolMatches[].protocolId`.

It is not display conversion, P&L, position inventory, route quality, protocol support, transaction-building input, signing data, or signing readiness.

Use `read_inspect_sui_transaction` when a user needs the full normalized facts for a digest.

The runtime does not store non-known party account addresses inside persisted transaction rows or normalized detail facts. If a digest lookup or explicit-account scan is not related to a known local wallet, the result can be returned for the current request but is not persisted.

## Not Stored

This toolkit does not run automatic scans for any account.

It does not store raw GraphQL payloads, transaction bytes, signatures, BCS payloads, private or session material, balance snapshots, price observations, complete gas history, abandoned-reason logs, quote logs, or protocol decoder outputs.

Complete account transaction history is not a product surface of this data.

AI clients may answer questions only from data the listed read tools return.

`read_summarize_sui_activity_scan` summarizes a live bounded scan without full details or transaction-wide balance-change aggregates in row context.

`read_scan_sui_function_activity` and `read_summarize_sui_function_activity_scan` reuse the same requested-account fact, transaction-context, analysis, and protocol label pipeline for transactions the selected account sent that called one full `package::module::function`.

They do not create a function-specific stored history, global function index, affected-object history, or complete dApp history.

`read_summarize_sui_account_activity` summarizes account-level stored normalized facts only.

It can include rows from account scans, digest lookups, or sent-function scans, and the scan kind remains provenance rather than a user query filter.

`read_get_account_asset_timeline` builds stored account asset net-flow bars from the same local normalized facts. Its requested UTC range is half-open: the start timestamp is included and the end timestamp is excluded.

It first checks stored scan coverage for the requested account and UTC range. If no stored scan can support the requested range for a known account, it returns `scan_needed` and points to `read_scan_sui_account_activity`; it does not start a scan by itself. If an explicit account is not a known local wallet in the activity store, it returns `account_not_known` and does not return `scanNeeded`.

Timeline output uses account-scoped raw balance-change facts only. `netFlowBars` are observed inflow/outflow bars, not held balances. The storage model does not store balance snapshots or balance anchors. The timeline response returns `balanceStatus: "unavailable_no_balance_anchor"` and empty `balanceBars`.

Optional `usdcReferences` read DeepBookV3 official Indexer USDC candle evidence for supported USDC-quoted assets. Those references are token-denominated USDC evidence only. They are not fiat USD value, a USDC/USD peg guarantee, P&L, tax, cost basis, route advice, transaction-building input, signing data, or signing readiness.

Provider retention and rate-limit behavior are endpoint/operator properties, not guarantees made by Sui MCP.

Empty pages, bounded pages, and stored local summaries must not be treated as complete history.

When normalized details are missing or capped, use `transactionDetailAvailability` and the returned digest metadata with `read_inspect_sui_transaction` instead of inventing missing fields.

Inspect responses can include live GraphQL detail fields for the current response.

Live scan and live-summary rows point to that digest path through `detailLookup` instead of returning full `details`.

Stored summaries return sanitized normalized details only, omit non-known party account addresses, and may include `lastScanIncompleteReason` when the last scan that touched a row had incomplete or unverified coverage.
