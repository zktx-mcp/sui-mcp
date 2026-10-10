# Local DB Architecture

Sui MCP uses a local SQLite database for durable product state that must survive MCP server restarts. The database stores account read context, Sui MCP review activity evidence, live review and session state shared across local AI clients, and user-requested bounded Sui activity facts. It is not a custody store, background indexer, complete wallet-history store, or raw transaction archive. Private per-request authority records enforce one admitted transaction; they do not grant standing wallet approval or hold the user's signing key.

This document is for maintainers and contributors who change local state, import/export behavior, activity queries, or review evidence storage. Product users normally need only the README and `docs/MCP_SETUP.md`.

## Runtime Boundary

The process that binds the configured loopback port initializes these local components. Other stdio processes authenticate that server and forward their calls; they do not open SQLite:

- a local SQLite store;
- a mainnet guard for the configured Sui gRPC endpoint;
- the shared private HTTP transport on `127.0.0.1`;
- authenticated internal MCP sessions, reached by each client through a stdio forwarder.

The GraphQL endpoint is also mainnet-guarded when it is saved through settings, imported from a local-data backup, or first used by Sui activity tools.

Stdout is reserved for MCP JSON-RPC messages. Logs go to stderr.

## Local Data

The runtime creates a local SQLite file for account read context and Sui MCP review activity evidence. Users do not install a database server separately.

Override the app data directory only when needed:

```bash
export SUI_MCP_DATA_DIR="/path/to/local/app-data"
```

The stored active account is for reading wallet state only. It does not let the toolkit sign transactions on your behalf.

User-requested bounded transaction scans can store normalized facts only when a transaction is related to a known local wallet. This product does not run a background or complete wallet history indexer.

The default Sui mainnet gRPC and GraphQL endpoints are stored in the local SQLite settings table on first run.

To inspect settings or change local data, ask for the internal Settings card. Ordinary MCP creates an unsubmitted card or reads settings; scoped app-only preparation/confirmation owns changes. No external page or Settings HTTP API remains.

Endpoint changes apply after the MCP server restarts.

## Engine

The runtime uses the `better-sqlite3` npm package for normal SQLite file semantics and incremental writes. Users do not install a separate database server.

The package targets Node.js `>=22`. Node 22 or 24 LTS is recommended.

`better-sqlite3` is an npm dependency, not a separate product database installation. The pinned version is `12.9.0`. Standard macOS arm64/x64, Linux arm64/x64, and Windows x64 platforms normally use prebuilt binaries; less common platforms such as Windows arm64 can require a native build toolchain. The release check verifies that the driver can be imported, can create an in-memory database, and also works after installing the packed tarball.

## File Location

The default data directory name is `sui-mcp` on each supported operating
system. Sui MCP uses the `SUI_MCP_DATA_DIR` override and the
`sui-mcp.local-data` backup format identifier. Material source enum values
`sui_mcp_built` and `sui_mcp_verified` identify backend-built or
backend-verified material. Only the current `sui-mcp.local-data` backup format is accepted. This installation
uses its own data directory and does not discover or convert another package's
data. A new installation starts with empty state.


On first start, the runtime creates a SQLite file named `sui-mcp.sqlite` under the operating system's app data directory for Sui MCP.

The optional override is:

```bash
export SUI_MCP_DATA_DIR="/path/to/local/app-data"
```

Product docs, MCP responses, and tool outputs must not reveal a user's absolute database path. Use placeholders in documentation.

## Open Policy

Every database connection applies:

```sql
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;
```

Writes use SQLite's normal file-backed engine. An empty file is initialized to the current schema. An existing file is checked read-only before opening for writes: its format identifier and schema metadata must match the current definitions. The runtime does not migrate, repair or silently reset another format.

Use an empty `SUI_MCP_DATA_DIR` for a new installation. Existing files remain untouched. Product reset is a separate confirmed Settings action.

WAL mode can create companion files next to the main database, such as `sui-mcp.sqlite-wal` and `sui-mcp.sqlite-shm`. Backups and manual moves should keep those files together with the main database while the MCP server is stopped. Avoid placing `SUI_MCP_DATA_DIR` in cloud-synchronized folders such as iCloud Drive, Dropbox, or similar sync roots because WAL companion files can be copied out of order.

## Tables

- `accounts`: normalized Sui account addresses and first/last use timestamps.
- `active_account_context`: a single-row read context. It can point to one active account or be cleared.
- `review_sessions`: review session header, current status, full action plan JSON, and materialized requested intent JSON when present.
- `review_state_snapshots`: append-only account-bound `ReviewState` snapshots with status and reason columns for queryability.
- `review_status_transitions`: append-only review lifecycle timing for funnel and review-timing analysis.
- `review_requests`: admitted attempts, immutable review evidence and independent request status.
- `review_executions`: verified chain success/failure, keyed by `attempt_id` and bound to review session, account, plan and digest. Wallet rejection and uncertainty never create a chain failure row.
- `external_activity_scans`: user-requested digest lookups, bounded account scans, or sent-function scans, including request window, endpoint host, chain identifier, continuation metadata, coverage signals, and internal scan-kind provenance.
- `external_activity_transactions`: normalized Sui transaction facts linked to a known local account and the first/last scan that observed them. The optional detail JSON stores typed facts such as capped Move call targets, raw balance changes, object changes, event summaries, gas raw cost fields, execution errors, and truncation flags when GraphQL returns them. Each stored detail JSON value is capped at 64 KiB.
- `local_settings`: allowlisted local settings. The current key set is `suiGrpcUrl` and `suiGraphqlUrl`, stored as JSON-encoded text and applied after restart.
- `coin_metadata_cache`: account-independent positive cache for Sui coin metadata used only to format wallet balance display amounts. Rows are keyed by normalized coin type and verified mainnet chain identifier, expire after 24 hours, and are excluded from local data export/import. Read or write failures for this cache block affected wallet unit reads with `metadata_cache_unavailable`; they are not reported as unavailable token decimals.

The following live session tables hold runtime session state in the shared database so any one review server can serve a session another client created (see [Shared local server](#shared-local-server)):

- `live_review_sessions`: the live review session record — status, bound
  account, preparation/connection revision, current attempt reference,
  plan/review-state JSON, timestamps, revision and write-contract marker —
  keyed by session id.
- `live_private_review_artifacts`: per-session private review evidence (the transaction-material handle, its digest commitment, and derived evidence), cascade-deleted with its review session.
- `live_transaction_materials`: locally built unsigned transaction bytes stored as a BLOB behind a redacted handle, with a TTL; retained for the admitted request. Terminal request cleanup removes only material still owned by that revision, preserving newer preparation. Owner replacement deletes old private material while retaining immutable review and chain-result evidence.
- `live_wallet_connections`: verified connection facts, private topic and callback state.
- `live_read_cards`: public card state with private permission hash, scope, operation and CAS revision.
- `settings_operations`: one draft/upload/preparation/admission/result identity per Settings card, with owner/data epoch, user-data revision, fingerprint and SDK supersession/checkpoint facts. A download stores its typed snapshot lifetime and per-attempt delivery reports in private `preparation_json`, separately from the immutable result. Updating delivery never reserializes a terminal `result_json`.
- `settings_files`: private file identity, original operation, upload/export role, generated paths, lengths/hash, chunk reservation and seal/invalidation/cleanup state. `cleanup_operation_id` separately names the operation responsible for cleanup; replacement can transfer that responsibility without changing the file identity, public path or input eligibility.
- `settings_control`: current data epoch/user-data revision, one final-operation slot, one file-I/O reservation and the SDK input block owner. These are semantic state/authority facts, not release-version counters.

These live tables are distinct from the append-only review evidence tables above: the evidence tables remain the durable activity/audit record, while the live tables hold the in-flight session state that the review server serves.

Database columns use snake_case. MCP and HTTP JSON fields use camelCase, so the database `review_session_id` column stores the same review-session identity exposed as `reviewSessionId` in API responses.

Table relationships:

- `active_account_context.account_id` and `review_sessions.account_id` point to `accounts.id` when an account is present.
- `review_state_snapshots`, `review_status_transitions`, and `review_executions` point to `review_sessions.id` through `review_session_id` and can also point to `accounts.id` through `account_id`.
- `external_activity_scans.account_id` points to `accounts.id`. It records which known local account the user-requested lookup or scan was scoped to.
- `external_activity_transactions.account_id` points to `accounts.id`, and `first_scan_id` / `last_scan_id` point to `external_activity_scans.scan_id`. `known_sender_account_id` points to `accounts.id` only when the sender is also a known local account. Non-known party account addresses are not stored; normalized detail JSON keeps account-owner and event-sender fields only when they match the known local account.
- `coin_metadata_cache` is account-independent and is keyed by coin type plus chain identifier.
- `local_settings` is independent local configuration and does not point to account or review rows.

The database does not create background transaction indexing tables. Complete external transaction history, raw GraphQL payloads, transaction bytes, signatures, BCS payloads, non-known party account addresses, and arbitrary transaction payloads are not product surfaces of this database. Server-read chain receipt evidence is normalized execution-result JSON for a reviewed signed transaction digest; it is not raw BCS, transaction bytes, wallet signatures, or a complete transaction-history index.

`external_activity_scans.kind` records the lookup category as `account_scan`,
`digest_lookup`, or `function_scan`. Stored scan rows keep their recorded kind;
the database does not infer missing function targets from `account_scan` rows.

The `live_review_sessions` table stores a monotonically increasing `revision`
and `write_contract_version: "shared_sqlite_review_session_v1"`. Insert and
update triggers reject revision-unaware writers: inserts must use
`revision = 0` and the current write-contract marker, and updates must increase
the revision by exactly one and keep the current write-contract marker.

Reset/import are explicitly confirmed Settings operations. They validate the
current backup shape and imported mainnet endpoints, check current prepared
impact and reject unsettled wallet/transaction work. One SQLite transaction
replaces user data, clears coin metadata and other live authorities, advances
data epoch and preserves the applying operation's read-only card/result. It
never recreates that result from a callback after deleting it. Rollback
preserves the prior data, permissions and admission state.
The private `live_wallet_connections` service journal remains because replacing
user data does not end SDK sessions. It cannot restore old card permissions or
transaction authority and is not imported from a backup. Reset clears the
default address; an imported default still needs its exact current connection
ID and approved address. Outstanding connection SDK callbacks also block replacement.

User-data and wallet/request writers invalidate affected preparations and
increment their card revision in the same transaction. The trigger and `settings_back`
reuse one SQL transition: a complete, sealed, non-invalidated upload belonging
to that operation returns to sealed; other preparations return to draft. Old
confirmations cannot apply. Backup checking and final I/O still verify physical content;
a manifest alone is not proof of a valid file.

A `download_backup` admission consumes one card input and captures one local-data
snapshot in the same SQLite transaction. The export role and exact generated
`.settings-staging/<fileId>.download` namespace identify its private file; an
export role or display name alone is insufficient. File bytes are not stored
in operation JSON or public backups. Physical write, fsync, length and SHA checks
finish before the snapshot becomes available. `result` is immutable preparation
evidence; delivery reports have separate typed state and atomic attempt identity.

The fixed thirty-minute transfer period begins at physical readiness, independently
of the original input expiry. The owner schedules its earliest live transfer
deadline; current DB time, owner and epoch decide expiry. An abandoned frame does
not own cleanup. A failed already-due journal cannot create a zero-delay loop or
cancel another snapshot's future deadline. Status reads and owner recovery can
retry cleanup. Current-generation access rejects stale callbacks after replacement.

Private staging files survive as cleanup journal entries when cards are
invalidated. Reset/import invalidate uploads and private downloads and transfer
cleanup ownership without changing file identity. Existing public backup files
remain unchanged. Acknowledgment, explicit cancellation, expiry, source failure
or owner restart ends private retention. Active descriptor reads/writes finish
before deletion; new ranges and retries are refused once authority ends.
`temporaryFileCleanup` includes physical cleanup and settlement of the operation's
ended I/O reservation. Stored results remain readable during pending cleanup,
including when expiry persistence fails; input remains closed and the failed
cleanup stays visible. Another operation's reservation is never released.

An explicit same-result read may finish its cleanup or verify an existing
published export, never regenerate a backup, repeat Host delivery, reapply data
or replace an SDK run. Files/permissions/SDK credentials/private transaction
material are excluded from public backups. Clearing the default address does
not invalidate account-independent coin metadata or disconnect the wallet.

Non-terminal review session expiry is recorded lazily when the session is read or mutated after its TTL. Review-session expiry has no background worker; private download retention uses the separate owner timer described above.

## Shared local server

Exactly one parent runtime owner per data directory binds the configured loopback port and creates the shared product services and SQLite stores. Other clients authenticate the listener before sending control credentials and forward MCP messages to it. The authentication covers database identity, the package release version, configuration (including WalletConnect project configuration) and server instance. Proof and subsequent dispatch use the same TCP connection. Host/Origin validation is separate from authentication; neither protects against a malicious process running as the same OS user.

The private `runtime-control.key` file is separate from UI permissions and wallet credentials and is excluded from product backups. Stdio closure and process signals close the owned server. No client signals a peer backend. The parent may terminate only its own SDK child. A peer can acquire the port after it becomes free. Failed calls are not replayed automatically. MCP framing, cancellation and EOF handling start before backend acquisition; wallet SDK readiness does not block parent service startup.

All state-writing MCP callers use this owner, including reads that save activity, metadata or chain results. An asynchronous operation carries the current data generation. Access after replacement or shutdown is refused, preventing a late response from writing into replacement data. Live review transitions retain revision/CAS and SQLite transactions. No network wait is held inside a database transaction.

### Read cards

`live_read_cards` owns the card kind (account, receipt, chart, connect or review), permission hash, backend owner, revision, original/accepted input, state/reason and saved result or scoped workflow operation reference. Business request status is not copied into a separate card state machine. Admission and result writes use conditional updates. Expiry is applied by the backend to unsubmitted input; a View timer only requests state. Frame recreation and chat navigation perform no close transition. The backend rejects late writes after local data replacement or owner changes, and recovery closes unfinished cards without repeating their source query.

The same record contains a model-safe result and, for receipts, separately validated UI-only input values and PTB display data. They are projections of one source read. They are not activity evidence or serialized signing material. Public saved resources exclude the private partition, and product backups exclude card records and permission hashes entirely.

Input TTL is not a result-retention deadline. Completed results survive restart and remain until explicit local data reset/import; there is no automatic age-based deletion or per-card size cap. Existing query limits still apply. DB size can therefore grow with usage. Reset/import affects other local data too and must retain its explicit confirmation and failure-atomicity contract.

### Wallet and request ownership

The same product DB stores `review_requests` per attempt, with a unique review
session/revision admission, immutable reviewed state/account/digest, request
status and signature/submission timestamps. `review_sessions.current_attempt_id`
selects the current attempt explicitly. `review_executions` is keyed by attempt,
contains only verified chain success/failure, and cannot stand in for wallet
rejection or an unknown outcome. Public history and live request transitions
commit together with card admission or closure. Old attempts remain readable.

`live_request_authority` holds owner, wallet connection revision, submission
permission, pending callback flags and backend deadlines. `live_wallet_connections`
holds verified public connection facts and a private SDK topic reference.
`live_execution_details` holds optional receipt display details separately from
public history. `live_review_sessions` binds preparation to a connection revision;
a connection change invalidates unadmitted review data. None of these private
live tables is exported or restored by public backup.

`live_transaction_materials` contains private unsigned bytes bound to the review.
Admission freezes the transaction for that request; delayed signatures cannot
substitute a later quote or material. The backend rechecks digest and signer
before submission. Card/model results and public activity never include bytes
or signatures. The OS-user-only data directory is 0700 and DB files are 0600.

A separate `runtime-owner.sqlite` holds a process-lifetime SQLite exclusive lock,
so two ports cannot create two product database owners for one data directory.
The SDK child separately holds `walletconnect/runtime-owner.sqlite`; another SDK
writer cannot start until the prior process exits and releases that lock. Private
SDK sessions/keys use `walletconnect/sessions.sqlite` with a current-only format.
Pinned SDK request/history/message queues and unknown namespaces are volatile.
Neither file is part of public data backup. SDK state is not business authority;
restore reconciles only existing known connection records and never replays a
financial request or restores cleared read context.

SDK execution has a separate `walletRunId`. Every wallet command, observation
and response binds that run, an operation and the parent's data generation.
Typed private IPC carries transaction bytes and signatures only between backend
processes. The child opens only SDK storage and performs wallet transport calls;
product database access, verification and submission stay in the parent. This
process split isolates failures; it is not an OS security sandbox.
Ordinary reads use the last confirmed SDK snapshot; wallet-dependent commands
perform a current session check. After digest, signer and mainnet verification,
the parent performs a final session check before the synchronous submission CAS
and dispatch. A later remote event is not presumed already known.

Historical service-recovery results in `live_read_cards` remain readable;
Connect accepts no new service-restart input. Parent recovery closes unfinished
cards as `server_restarted`. SDK callback flags remain pending until actual
child exit, while parent verification, submission and lookup flags remain until
their own work ends. SDK readiness does not clear those independent guards.

Initial SDK restoration considers the entire known connection set, including
prior-owner records, before publishing current eligibility. Confirmed known
connected records transfer to the new owner. Known terminal records with a
present SDK session transfer management metadata without changing their outcome.
Multiple known occupied connections are management targets, not usable wallet
choices: `connectionConflict` is derived from the journal and current supervisor
snapshot, with no additional table. Targeted disconnection remains
available while new pairing, account use, review preparation and signing are
blocked. The final submission transaction applies the same single-connection
rule. Failed/stopped records and unknown SDK sessions do not restore authority.

`active_account_context.wallet_id` preserves the connection through which the
default address was selected. Current eligibility requires that exact ID and
an approved address in the sole unexpired connection, with no pending connection
operation. Missing source IDs remain valid historical/import data but require
explicit selection before current default use. Eligibility is derived at the
database evaluation time and published to cards as `usableConnectionId` and
`assetReadAccount`; Views do not recount recorded connections. This adds no
table or expiry writer. Stored status, disconnection outcomes and historical
account records retain their separate meanings.
The store reads the current run's private supervisor snapshot inside evaluation
and immediate admission. Missing inspection does not mean an empty service.
`manageableConnectionIds` names exact nonpending recorded disconnect targets,
including known terminal records whose SDK sessions remain present. They are not
usable account choices. `connectionReconciliationRequired: true` means a present
SDK session has no journal target after ordinary registration/cleanup has ended;
it blocks pairing, account use and unsubmitted signing until the user removes the
retained connection in the wallet app and a complete current-run observation
confirms absence. Settings can explicitly restart the service to inspect it
again; restart alone does not resolve retained presence. Topics remain private. A pending registration
is not reported as a reconciliation failure.

An admission that changes connection eligibility or targets also publishes the
owner's ready Connect/Review card revisions in that same transaction, after
consuming its own input. A competing admission after the confirmation read
therefore invalidates the earlier revision even before the SDK returns a QR or
approval. Publication failure rolls back admission; no SDK operation starts.

Service-loss authority revocation is retained against its SDK run and data
generation until it commits. Current wallet-state reads retry that database
write; they do not start another SDK process. Repeated reads after a successful
repair do not repeat the transition. Unrelated stored transaction results and
already dispatched chain observation remain independent of that write.
The supervisor's explicit replacement primitive requires fencing and actual
child exit before a new run. Its user entry point is a scoped, explicitly
prepared and confirmed Settings card; ordinary model calls cannot replace it.

If a completed callback's flag write fails, the owner retains its exact operation
identity as completion evidence. A current state read can retry that database
write without another network request. Connection cleanup also checks the
admitted card/run, so a late pairing cleanup cannot clear a later disconnect's
flag. Data replacement discards old completion evidence; it cannot be applied to
replacement records. A genuinely unfinished callback is never treated as ended
merely because a service restart or deadline was observed.

Review reads bind their target before asynchronous inspection and check it again
inside SQLite evaluation. Management cards bind their explicit attempt, consumed
Review cards bind their admitted operation, and ID-only tools bind the session's
current attempt. Live review input still requires current wallet eligibility.
Saved request reads do not advance unrelated request deadlines or connection
expiry, or require other operations' callback repairs. Their own completed
callback repair may remain pending without hiding recorded results. A new chain
lookup requires its own prior lookup callback to be settled; account-busy and
data-replacement guards retain all pending flags until their actual work ends.
The target session/card's own required expiry writes still propagate errors.
This is not availability during an unreadable database or a bypass of authority
revocation failures.

Connection facts and workflow maintenance have separate internal contracts.
`readConnectionFacts(at)` collects recorded connections, current-run SDK presence,
pending work and read-address provenance from one SQLite read snapshot. The
shared selector and qualification projection compute eligibility from those
facts; they do not update requests, expire connections or repair callbacks.
Settings general facts use this diagnostic path and stored counts, so another
request's refused deadline write does not prevent opening or reading Settings.
Creating a card and checking its own permission, input expiry or cleanup retain
their own writes. Stored counts are not a promise about a later deletion impact.

`reconcileAndEvaluate` requires a current-wallet or server-bound review purpose.
Current wallet consumers use `reconcileConnectionContext`; exact request reads
retain their narrower target. Reset/import preparation and final admission still
settle deadlines and compare the current impact in their transaction. Snapshot
memory may precede its DB publication: initializing/state_sync does not grant
account use or establish an unrecorded-connection removal diagnosis. Only a
published available run can qualify that guidance; missing guidance does not
prove that the SDK is empty.

Successful reset/import invalidates pending SDK startup or recovery in the old
data generation and ends that child without automatically starting another.
Rejected or rolled-back replacement does not change the run or generation.
Existing financial pending guards apply before replacement. SDK sessions whose
product records were removed, failed or stopped cannot restore authority.

Stored snapshot readers do not reconcile expiry, call the wallet or observe the
chain. Current-state operations bind asynchronous evidence verification to the
review revision, material identity and exact verified bytes. A short synchronous
transaction samples its decision time, reconciles expiry and collects related
card, account, connection and request facts together. Projections consume that
evaluated state without a clock or I/O. Changed evidence requiring another
verification ends the read with a conflict; it is not retried in an internal
loop. Wallet availability is runtime information, not a persisted request state;
public backup and funnel counts exclude it.

Both `submitting` and `awaiting_chain_result` retain the initial observation
window in the session, account-busy and data-replacement guards, even when all
callback flags are clear. A failed post-submission write cannot strand the
known digest. Callback completion and chain completion remain separate facts.
Current Review evaluation also reads whether an unconsumed, unexpired original
input exists. Historical review status alone does not make an interaction pending.

Preparation IDs in the workflow execution set describe only currently running
computations; they hold no results or authority. If a current owner's stored
preparation has no running computation, current reads use the existing failure
writer to settle it. Pending disconnect cards with a settled SDK callback are
reconciled from the available SDK session or closed as unconfirmed failures.
These reads never repeat preparation, connection, signing or submission. Raw
history/export readers do not perform this reconciliation.

`ReviewSession.preparationId` identifies an admitted preparation awaiting a
stored outcome; the field alone does not prove that computation is still
running. `ReviewSession.preparationError`, stored in `live_review_sessions.preparation_error`,
is a saved review message: it can record a failed preparation or invalidation
caused by a wallet connection change. Its presence does not prove that a
computation ran. The View labels it Earlier review message and keeps it distinct
from current account-selection guidance and a command delivery failure. These
fields describe different facts; none grants action or retry authority.

Signature admission independently checks the current material handle, expiry,
bytes, digest and review binding inside its transaction. Displayed actions are
not admission authority. An admitted attempt keeps its fixed review facts and
request deadlines; subsequent quote expiry does not cancel that request.
Revision-specific evidence validity does not remove session/account pending-work
or data-replacement protections. Mandatory activity rows commit with the state;
optional event-log failures do not roll back that commit or repeat an operation.

Review preparation also checks the immutable bound account against current read
context and the selected account before writing preparation state. The same pure
account rule supplies evaluated choices. A selection mismatch is a current
restriction, not a stored preparation error or an activity transition.

Request interruption consumes both its internal origin and the request phase.
Before submission, user stopping, wallet change and requested disconnection
record distinct safe reasons with the terminal transition. After submission,
only explicit user stopping sets `observation_stopped`; wallet changes and
disconnect requests preserve that flag, the lookup deadline and pending work.
They cannot silently release account-busy protection or restart an observation
the user stopped. Existing deadline, owner-recovery and data-replacement rules
remain separate. Stored reasons flow unchanged to cards, model results, activity
and public backup; earlier recorded reasons are not rewritten speculatively.

Wallet dependency failure keeps guarded DB reads, local deadline reconciliation
and independent receipt observation available. Only a healthy wallet dependency
can admit new wallet work or continue a signature toward submission. After
dispatch, result recording and pending-flag settlement require the current DB
generation, owner and exact operation, not a working wallet SDK. Pending flags
remain set until the corresponding asynchronous work actually settles. A DB
failure is reported as a storage failure, never as an empty successful snapshot.

Reset/import checks SDK/signature/submission/initial-observation settlement
inside the same DB transaction as replacement, including after asynchronous
endpoint verification. Rejection preserves data and authority. Completed local
unknown-outcome records may be removed after the explicit warning; removing
records cannot cancel a transaction. A generation change rejects late writes.

The wallet store advances expired signature and initial-observation deadlines
through the same request transition writer used by the workflow. Explicit
current-wallet reconciliation settles current wallet work. A server-bound review
read settles its own request target unless it depends on current wallet work;
it does not use an unrelated completed request as a reason for global maintenance.
Reset/import preparation settles deadlines before calculating its impact, and
final admission settles them again and compares the current impact in the same
transaction as replacement, even when no View is open.

General Settings facts and stored local-data counts use the diagnostic read
contract; they do not advance live requests. Creating or reading a card still
checks that card's own permission, input expiry and operation cleanup. Expiry
does not clear pending SDK/submission/lookup callbacks. Stored activity queries
and public backup export also read recorded facts without advancing live
requests or treating imported history as authority. Replacement warnings do not
claim an earlier stored-counts snapshot is the number being deleted now.

Disconnect progress is the existing running Connect card's accepted disconnect
action and connection reference. Connection updates preserve that operation
until its result is recorded; no additional persisted connection status is used.

### Current format and backups

The runtime accepts one current SQLite structure, checked against its table, column, constraint, index and trigger definitions before writes. There is no separate database version counter, migration registry or older-format decoder. All clients sharing a data directory must use the same package release.

A current backup carries `format`, `network`, `exportedAt` and its product data. It has no numeric schema version. Import rejects a different format, unknown or missing fields, invalid references or invalid raw quantities. Missing settings or activity arrays are not filled from defaults. Supported `function_scan` provenance remains part of the current format. Validation failure leaves current data intact.

New installations do not inherit older local review records, activity scans, known/active accounts or stored endpoints. Users configure the required context again; environment overrides retain their existing precedence. Empty local history does not imply an absence of on-chain transactions. Existing DB and backup files are not deleted by startup.

## Boundaries

The active account is a read context only. It is not signing authorization, login, authentication for transactions, custody, permission for transactions, or proof of ownership. It stores at most one address per database file; setting a new active account replaces the previous one without revoking anything onchain.

NDJSON event logs remain optional audit/debug logs. They are not the product activity source of truth. User-facing activity summaries read from SQLite. Event log write failures do not fail product session transitions or SQLite evidence writes.

Raw session tokens are not stored in SQLite. Live session records store token hashes for validation; this private state is separate from activity evidence and product backups. The activity-store evidence input types do not accept session token material, and review evidence JSON is checked with the same forbidden-field-name policy used for MCP output. Transaction bytes, signatures, serialized signing material, token-hash/session-token-like fields, seeds, mnemonics, and private-key-like field names are rejected before write. External proposal ingestion also rejects recognized Sui private-key strings, valid English BIP39 mnemonic phrases, obvious sensitive markers, and suspicious raw secret-like payloads before storing the sanitized requested intent. Generic asset metadata such as token symbols remains allowed.

The local settings table is not a secret store. It stores only allowlisted local preferences such as the Sui mainnet gRPC and GraphQL endpoints. It must not store database paths, tokens, credentials, private keys, mnemonics, seeds, or arbitrary API keys. Environment overrides such as `SUI_GRPC_URL` and `SUI_GRAPHQL_URL` can temporarily supersede stored endpoints without mutating the database.

Review intent capture follows one adapter convention: if an adapter wants the original requested intent materialized for activity queries, it must place that object at `ActionPlan.adapterData.requestedIntent`. The full `plan_json` remains the canonical action plan, and `intent_json` is only the query-friendly copy of that adapter-supplied intent.

### Private funding evidence

Ownership and simulation private artifacts use their v2 evidence formats to
bind transaction funding to the stored material. They cover real coin objects,
address withdrawals, gas reservations, and their observed balance/epoch facts.
They are deeply copied and revalidated before admission, and are excluded from
public backup. They introduce no table, column, or DB format migration.

Old private evidence is not upgraded into funding proof. Existing owner recovery
removes private material; a new review recomputes it. Historical public reviews,
admitted request facts, chain results and backup remain readable. Reading history
does not re-query funding or confer new signing authority.
