# Wallet Connection

WalletConnect provides approved Sui mainnet account context and a transport for
individual wallet requests. It is not login, proof of address ownership, custody, or standing permission to transact. Frontend behavior is defined in
[Frontend Policy](FRONTEND_POLICY.md); tools are in [MCP Tools](MCP_TOOLS.md).

## Connection and read account

`session.create_wallet_connection` takes an intent: `connect`, `disconnect` or `manage` (the default). A connect-intent card automatically starts one pairing after the View confirms current state with its UI permission, unless a connection or operation already exists. Manage opens connection controls without starting pairing; Connect wallet starts it only after the user clicks. Disconnect opens target-specific confirmation when one connection is available; the user chooses Confirm disconnect or returns with Back. No model-facing call can disconnect or request a signature. Public saved reads never start pairing. QR data stays in UI metadata bound to the exact card, connection and revision; reopening a waiting card preserves that pairing.

Sui MCP uses one wallet connection at a time across all clients sharing a
data directory. That connection can approve several Sui mainnet addresses; other
chains are not supported. The same connection rule controls displayed actions,
restoration, SDK observations and atomic SQLite admission. An unexpired connected wallet, pending approval or pending disconnection
prevents another pairing, including requests from different cards. A competing
card retains its own permission and reports the existing connection; it does not
inherit another card's QR or waiting controls. A failed connection attempt needs
an explicit retry even if the other connection later ends. If multiple valid connections are saved, none is selected for account use,
review preparation or signing. The Connect card shows each exact target for
user-confirmed disconnection. After recorded disconnections leave one valid
connection and no pending connection operation, that connection becomes usable;
with no recorded or SDK-present connection and no pending operation, a new pairing is allowed. Terminal history alone does not
block it. A failed disconnect remains unconfirmed in the wallet app; its SDK
session cannot revive the failed product record.
The current SDK snapshot also gates pairing and account use. A known failed or
disconnected record whose SDK session remains present is a disconnect target
on a new card, not a usable wallet. `manageableConnectionIds` identifies those
exact targets and ordinary connected targets, including expired records.
An unmapped SDK session in a published available run sets
`connectionReconciliationRequired: true` after pending registration/cleanup
ends. An initializing or state_sync memory snapshot does not establish this
diagnosis, and an absent flag does not prove session absence. Pairing, account use, preparation and signing
remain blocked. Remove the retained connection in the wallet app, then confirm
its absence through the current connection service. Settings/Troubleshooting
can explicitly restart the service to inspect it again, but restarting never
promotes an unrecorded or failed session into a usable connection. The card does
not invent a connection ID or report physical SDK failure.
The SDK's availability and a recorded terminal outcome alone do not prove absence.

The backend validates accounts, Sui mainnet namespace, methods and expiry before
recording a connection. A single wallet-approved account can become read context
from an explicit connection; multiple approved accounts require an explicit
selection. The active read account is stored in SQLite until changed or cleared.
SDK restoration and status reads never undo a user clearing that context. The stored selection is separate from its eligibility as a default for current asset reads. Implicit asset reads require a usable current wallet connection for the selected address; disconnection, expiry, pending disconnection, multiple-connection conflict or unavailable wallet state removes that default. Tools with an `account` input may still read an explicit address; connected-account-only tools require connection/account selection or recovery of wallet availability. Explicit-address public reads and saved transaction/activity reads remain available. `session.get_interaction_status.assetReadAccount` supplies that default-account decision alongside `connections` and `walletAvailability`.

| Connection state | Available behavior |
| --- | --- |
| Unsubmitted card | Automatic pairing for connect intent; manual Connect wallet for manage intent; address selection and target-specific disconnect when permitted |
| Multiple valid saved connections | Resolve through target-specific disconnect; no new pairing, address use, review preparation or signature |
| awaiting_approval | Same private QR and approval observation; Stop connecting |
| connected | View approved accounts and expiry; a new card may select another operation |
| rejected / failed / expired / stopped / disconnected | View the recorded outcome; new operations need a new card |

`session.get_interaction_status` reports the last confirmed wallet-service observation and stored connections. SDK events and command checks apply review/request invalidation through the same database owner. An ordinary status read does not wait for a fresh SDK request, change the selected account or start a wallet operation. `walletObservation` identifies the local service run, observation order and check time; it is not proof of the wallet app's current screen or online status. See the [interaction API](MCP_TOOLS.md) for the response contract.

An admitted disconnect is a pending card operation, distinct from the last
confirmed connection state. The same connection cannot be selected for another
operation while disconnection is pending. Cards and wait tools observe its
stored completion or failure; a connected-session update is not completion of
the disconnect. A restart does not replay an unfinished disconnect or restore
that connection as usable. The wallet app may still retain the connection.

If the SDK disconnect ends but its local completion write fails, current reads
settle the operation once storage recovers. An available SDK with no such session
confirms local disconnection; an unavailable SDK or retained session produces an
unconfirmed failure and wallet-app guidance. Reading never repeats disconnect.
Approval storage failure can also leave a connection in the wallet app. Local
failure or expiry does not prove remote revocation; remove retained connections
in the wallet app. No fixed cleanup period is promised, and an SDK session alone
never restores product authority.

Chat navigation and frame recreation are not transitions. Local stopping does
not claim that a remote wallet dialog closed. A late approval cannot revive a
stopped connection. An unavailable backend wallet service keeps ordinary reads
available and makes connection cards unavailable with an explicit explanation.

The product supplies its public WalletConnect project identifier without user
configuration or an override. Shared Relay service limits can affect connection
availability across installations. An initialization failure does not establish
that the user omitted a setting or that a transaction failed. A failure to
restore saved connections or subscribe to wallet changes disables wallet operations until the wallet service is recovered;
it cannot leave signing available without account/chain change observation.
Stored review, request and verified execution facts remain readable through
session tools and cards as well as ordinary evidence tools. `walletAvailability`
describes the backend wallet dependency; it is not connection approval or
transaction authorization. An unavailable dependency does not erase a saved
result or prove chain failure. Startup diagnostics contain safe failure stages,
not the project ID, SDK error bodies or wallet credentials.

The wallet SDK runs in a separate child process. The parent retains database
authority, transaction verification, submission and chain-result observation.
An unresponsive wallet service does not prevent ordinary reads or access to
stored results. Normal startup is shown as initialization, not as a wallet
rejection. No implicit asset account is offered until the current service run
confirms a usable connection.

Settings owns explicit connection-service restart. Open its Troubleshooting
section, inspect the current run and affected requests, then confirm the
restart. Connect manages connections/approved addresses and retains individual
Disconnect controls for conflicting saved sessions; it does not own global
service controls. A restart waits for old child exit, new run reservation and
complete ready observation. Unsubmitted signing authority is revoked at
admission; late signatures cannot submit. Already submitted transactions keep
their original digest and observation. A new explicit Settings operation may
supersede a still-pending startup without erasing a known failure.

Restart completion does not confirm an interrupted disconnect or remove a
remote session. Check retained connections in the wallet app. If Settings or
the parent is unavailable, fully quit all apps using Sui MCP and reopen them;
closing a peer/window can leave the owner running. Full app restart, rather
than child restart, applies stored endpoints and installation changes.

A new owner records interrupted connection approval as stopped and unconfirmed
disconnection as failed. It does not repeat either request or restore their
wallet authority. Already submitted transactions remain readable by their digest.
Historical service-recovery cards retain their recorded outcomes; they grant
no new restart input. See [setup troubleshooting](MCP_SETUP.md#wallet-connection-boundary).

An interrupted wallet operation reports `progress.status: "unavailable"` and a
bounded wait returns `waitOutcome: "unavailable"` with the recorded facts. It does
not pretend that the operation completed or the wait timed out. A completed
request returns its saved result immediately. The backend can still verify the
known digest of an already submitted transaction without WalletConnect. No
financial request is replayed when reading or recovering results.

A failed disconnect means disconnection was not confirmed. Inspect the connection
in your wallet app and remove it there if it remains listed. Local service
recovery does not verify remote removal. A card for an earlier successful
connection may show that the connection is now unavailable; that is not proof
that its original pairing failed.

Initialization is described neutrally. A pending card command shows that its
response has not arrived yet; a pending disconnection can show the app-restart
procedure without declaring a timeout or failure. These notices do not diagnose a hung service,
assert admission, or automatically send another command. The same-request check
takes priority when a signing request's delivery is uncertain. Review messages
preserve whether preparation was invalidated by wallet selection, a requested
disconnect, multiple-connection conflict, or service loss. Historical messages
retain their original cause.

## Transaction approval

A default address is qualified by the connection through which it was selected.
If that connection ends and another connection approves the same address,
choose Use address in the remaining connection's card before using it as the
default or preparing a new review. The saved address remains readable history.
A restored connection with the same ID retains its selection; a cleared or
source-less selection is never inferred from matching addresses. New explicit
connections that approve one address still select it automatically.

The backend publishes the current usable connection and default-address
eligibility. A recorded connection whose expiry has passed is not an additional
usable wallet, even before the next SDK observation updates its record.
Recorded targets remain available for appropriate disconnection; they do not
block the sole usable connection's address selection or review choices.

A single available wallet/account is displayed without a selection dropdown.
A permitted live Review card automatically prepares and renews verified conditions for that target. Multiple valid wallet connections block preparation and signing; resolve the conflict in Connect. Several approved addresses inside the single wallet require address selection there. A failed computation offers Retry review rather than repeating automatically. The explicit approval button selects the displayed transaction revision; automatic preparation never requests a signature. Backend
account, connection, revision and material checks remain authoritative.

An existing review keeps its original account binding. Preparing or updating it
requires that account to be the selected read account as well as an approved
account on the chosen connection. If read context changes from A to B, select A
again to update the same review, or request a new review for B. The card explains
the current selection restriction separately from saved review messages, which
can record a preparation failure or connection change. A refused incompatible
selection starts no preparation and records no failed review. Read context alone does not revoke already verified A signing
evidence or alter an admitted request.

Preparation execution and its stored outcome are separate. If execution has
ended but both success and failure writes failed, the next current-state read
records the failed update once storage recovers. It does not recompute evidence;
another update requires an explicit user action. A still-running computation is
not failed merely because its result is not yet available.

Review cards display account-bound verified evidence. Only a current review,
matching live wallet account and explicit user action may admit a signing
request. The backend uses `sui_signTransaction` with the stored BCS transaction
encoded as base64, checks the returned bytes' digest and signature against the
admitted account, then submits once. No browser signer, sign-and-execute fallback
or automatic retry is used. A wallet lacking that method cannot sign through
this path. Actual compatibility requires that wallet's successful normal flow;
namespace advertising alone does not prove it.

The backend verifies the stored material and rechecks its exact identity,
review revision, bytes and expiry in the admission transaction. A displayed
signature choice cannot extend the quote's validity. If the material expires
before admission, update the review; no signature request is sent. Once admitted,
the transaction remains fixed and the saved signing deadline applies. Reading
or recovering an admitted attempt does not require a fresh quote or send it again.

Wallet account/chain selection changes and connection conflicts invalidate affected unadmitted review
data and pending submission permission in the same connection-change transaction.
If that write fails, wallet operations are disabled until service recovery; a late
signature cannot continue under an unrecorded old permission.
Before submission, an explicit user stop, an SDK connection change and a
requested disconnect record distinct reasons. A disconnect request does not
claim completed disconnection. The first terminal reason is retained.
After submission, connection updates and disconnect requests do not stop
independent chain observation, including a lookup that has not started yet.
Only the explicit transaction `stop_waiting` action stops that observation;
later connection events neither resume it nor extend its deadline. An explicit
result read can still inspect the same digest. No event resends the transaction.
Callbacks already dispatched to submit or read a transaction may still record
verified facts and settle their own pending flags while the same DB owner is
valid. Wallet failure alone does not end an SDK promise. Server shutdown, owner
replacement and data-generation changes still reject stale continuations.

A request records one of `awaiting_signature`, `submitting`,
`awaiting_chain_result`, `stopped`, `request_failed`, `outcome_unknown`, or
`completed`. Only completed requests contain a separately verified chain
success/failure result. Timeout, wallet rejection and lost RPC replies do not
prove chain failure. Result reads observe the same digest. Management requires
an exact review session and attempt and cannot refresh or sign a new review.

The stored `submitting` state already identifies an admitted submission attempt.
It remains observable and protected during the original observation window even
if the post-submission write fails. Observation can finish before the submission
callback returns. A late callback cannot reopen a completed or unknown outcome,
extend that window, or submit again. Actual pending callbacks continue to protect
data replacement even after a result is recorded.

## Ownership and persistence

One backend owns a data directory and its WalletConnect SDK. Authenticated local
clients share that owner. A second owner is refused even on another port.
Private SDK connection/session keys reside in an OS-user-only store separate
from public activity backup. Request history, pending messages and unknown
resend namespaces are volatile. The SDK storage stays alive until the owner
process exits; no unsupported complete in-process SDK disposal is assumed.

A new owner preserves completed facts, expires old unsubmitted input, and marks
interrupted requests outcome_unknown without replaying them. Known approved
SDK sessions may be reconciled with existing connection records; abandoned
pairings and financial requests are not replayed. An unknown outcome may later
be resolved by reading the known transaction digest.

Data replacement is refused while signature/submission callbacks or initial
chain observation remain unsettled. Removing finished local records cannot
cancel or reverse an on-chain transaction. Public export/import never restores
card permissions, SDK secrets, private request authority or live pending work.
Local data replacement does not revoke the wallet app's connection approval.
If a connection is no longer present in the product database, remove it in the
wallet app; see [local data setup](MCP_SETUP.md#local-data-format).

## Balance forms in a swap review

A wallet can hold tokens as coin objects, address balances, or both. The backend
uses the supported adapter's SDK to construct the transaction and verifies the
funding form present in the stored material. Review details identify whether gas
uses SUI coin objects, address balance, or an address-balance reservation with
coin objects. A reservation is a limit, not a completed debit.

The selected account must fund both the swap and its gas. A positive total wallet
balance does not by itself prove that a particular withdrawal is covered. Source
read failures and unsupported funding are not reported as confirmed insufficient
funds. Balances can change after review; simulation and successful connection do
not guarantee that the wallet will accept or the chain will execute a transaction.
Every signature still requires the user's explicit card action and wallet approval.
