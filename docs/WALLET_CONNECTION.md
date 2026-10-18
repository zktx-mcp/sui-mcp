# Wallet Connection

WalletConnect provides approved mainnet account context and a transport for
individual Sui wallet requests. It is not login, proof of address ownership, custody, or standing permission to transact. Frontend behavior is defined in
[Frontend Policy](https://github.com/zktx-mcp/sui-mcp/blob/main/docs/FRONTEND_POLICY.md)
in the source repository; tools are in [MCP Tools](MCP_TOOLS.md).

## One connection, fixed addresses

Settings → Wallet networks specifies the networks requested on the next connection.
The default is Sui. Supported address networks are Sui (`sui:mainnet`), Ethereum
(`eip155:1`) and Solana (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`), all mainnet.
Only Sui supports asset reads, transaction review, signing and submission. Address
support on another chain is not bridge execution or other-chain signing.

There is one current product connection. It supplies at most one fixed address
per chain. Change the wallet, account, address or approved network scope by
disconnecting, waiting for confirmed removal and connecting again. Historical
connection records are retained for existing transaction references; they are
not simultaneous connections or account choices. Connect contains no chain or
account selectors and offers no additional-connection action.
Connect and Disconnect are separate one-purpose cards. `session_open_wallet_connection_card`
opens a connection request with no intent selector. Its initial authenticated UI
confirmation admits one pairing request. `session_open_wallet_disconnection_card`
opens a confirmation for the exact current session. Ordinary calls never apply
these effects. If there is no current session to disconnect, the gateway returns
`no_session_to_disconnect` without creating a card or wallet operation.
Disconnection does not revoke onchain permissions.

Every ended Connect or Disconnect card contains its recorded result, time,
wallet name when available, and network approval results. It contains no addresses,
QR code or further operation controls. The result does not claim that a past
approval is still a current connection. Read current fixed addresses through
`session_get_interaction_status`; saved history and transaction targets keep their
own exact addresses. Changing current state never rewrites an ended card.

The request uses saved networks as optional namespaces. Sui requests
`sui_signTransaction`, `accountsChanged` and `chainChanged`; Ethereum and Solana
request addresses with no financial methods. An empty saved network set disables
new requests. Changing Settings affects only future connections, not a request
already admitted or an approved connection. Saving a changed scope ends unsent
Connect cards that captured different networks; they never reopen when the setting
returns to its earlier value.

Only requested, valid returned accounts are used. Each requested chain records
one immutable result: a bound address, not approved, multiple accounts, or invalid
response. One valid distinct address binds automatically. Multiple distinct
addresses make only that chain unavailable; none is chosen silently. Other valid
returned chains remain usable. A later grant update cannot replace a fixed
address or fill a missing result. To obtain a different result, reconnect.
An omitted chain is not proof of permanent wallet non-support.

Each card admits at most one fixed operation and keeps one final result. SDK
settlement is a separate current fact; it does not reopen or rewrite that result.
Use the [Session Tools API](MCP_TOOLS.md#session-tools) for exact card/operation
reads and bounded waits. Opening a model-facing gateway grants no wallet effect;
the authenticated UI initiates the permitted operation. Frame recreation never
repeats pairing. QR credentials remain private UI metadata.

Cancel or Stop permanently ends that card's input and hides its QR. SDK cleanup
continues independently; late approval cannot create address or signing authority.
Cleanup completion never reopens the card or starts a new request. A new user
request needs a new card. A timeout, SDK exit or late response is not user
cancellation. Failed disconnection does not prove remote removal; a retained
session can still be explicitly disconnected from a new exact-target Disconnect card.
Recovery uses current session evidence separately from that recorded failure.
A settled attempt without approval or a recorded session reference has no
session when current-run ownership is confirmed, no connection work remains and
no unrecorded SDK session is retained. It does not require repeated status checks.
Pending approval or cleanup, a missing observation for a recorded session, and
unavailable service remain unconfirmed. Once absence is confirmed and pending
cleanup ends, the user can request a new Connect card. An ended card never regains
input. An existing Review tied to the ended
connection needs a new Review after reconnection; a declined connection alone
does not require a transaction Review.

Disconnect confirmation binds the exact connection, networks and affected
pending approvals. Changed impact requires fresh confirmation. Pending connection
or cleanup I/O blocks another Connect even if the stored result is stopped,
failed or expired. Only current-run absence confirmation plus settled I/O releases
that constraint. An idle or historical row alone cannot establish absence.

`session_get_interaction_status` exposes singular `connection`, `requestedChains`,
`canDisconnect` and the last `walletObservation`. `assetReadAccount` describes
whether the fixed Sui address is currently available for implicit asset reads.
`account_get_active_account` reports its saved read context, not live eligibility
or signing permission. Explicit-address reads remain public and do not select
an account. Settings can clear the saved read address without changing the wallet,
fixed addresses or transaction targets; this suppression survives restart of the
same connection. A fresh explicit connection can supply a new read address.

Current service availability, exact session presence, data generation, fixed
address and per-chain grant must all match for new financial input. Chain-local
changes invalidate that chain's old authority irreversibly; another chain's change
does not invalidate an unchanged Sui grant. A Review remains bound to its original
connection and account after reconnection. A new wallet needs a new Review.

An unrecorded SDK session is never adopted by address, order or recency. It blocks
new connection and financial input while saved facts remain readable. Remove
unwanted retained sessions in the wallet app and check status. An already admitted
transaction retains its own exact grant and submission checks. Restarting does not
approve an unrecorded session or prove its removal.

The backend owns the WalletConnect SDK in a child process with private session
storage. The parent owns SQLite admission, verification, submission and chain
observation. An initialization or observation failure disables affected wallet
operations, not saved result reads, and is never reported as wallet rejection or
chain failure. Startup diagnostics omit credentials and SDK error bodies.
The product supplies its public project identifier without user configuration;
shared Relay limits can affect availability.

Settings → Troubleshooting owns explicit connection-service restart. The user
confirms the run and affected requests. Restart waits for actual old-child exit,
new-run reservation and a ready observation. It revokes unsubmitted signing
authority; late signatures cannot submit. Submitted transactions keep the same
digest and result observation. A new Settings operation may supersede a pending
startup without erasing a known failure.

Recovery reconciles only the retained current topic. A missing snapshot entry is
checked through the existing SDK session check; it is not assumed absent. A normal
approved connection in the current data generation can regain usage after a new
ready run. A stopped, terminal or older-generation connection receives cleanup
ownership only. Its original result, fixed addresses and read-address suppression
remain unchanged. Confirmed absence releases stale occupancy, including records
from an earlier owner; it does not replay a connection or financial effect.
An unadmitted purpose card is not ended merely by an SDK run change; its original target and input deadline remain fixed. Ended cards are not reevaluated.

An approved SDK response is first retained privately for exact-session cleanup.
That retention alone creates no usable connection, address history or signing
authority. The connection and its fixed addresses become usable only after the
success result commits. If that publication fails, the session is cleaned up or
retained for explicit Disconnect; later reads do not retry the failed connection
as a success or repeat remote disconnection. A duplicate response for the same
already completed approval preserves that result and does not disconnect it.

A new owner stops interrupted connection approval and records unconfirmed
disconnection as failed. It expires old input and never replays financial work.
Pending SDK cleanup remains visible separately from immutable results. Bounded
waits report actual progress, including unavailable service, rather than implying
completion or remote cancellation. Known submitted digests remain readable without
WalletConnect. If Settings or the parent cannot be reached, stop all participating
MCP connections so the shared parent exits before reopening; a peer/window closing
alone may leave it alive. See [setup troubleshooting](MCP_SETUP.md#runtime-exits-on-startup).

## Transaction approval

The current fixed Sui address must have a usable exact connection for a new
Review. Clearing its saved read context does not change that transaction target.
SDK restoration can recover the same approved current-generation connection;
backup restore cannot activate an account or restore wallet authority.

A new Sui review uses the one current fixed account and connection, with no
public account/connection selector. An unavailable target is reported before
creating an empty review. The initial card already fixes the account and
connection before preparation. Its target remains visible through preparation
failure, read-address clearing and temporary unavailability. Disconnecting and reconnecting cannot move that review to the
replacement connection, even for the same address. Start a new Review instead.
The normal card shows its target without a selector and prepares or renews
evidence when permitted. Only Request wallet approval and approval in the wallet
authorize the transaction.

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

Changes to the target Sui grant or connection lifecycle invalidate affected
unadmitted review material and pending submission permission atomically. Other
chain grants, display metadata and list order do not invalidate Sui authority.
Per-chain revisions remain monotonic even if a grant changes and later returns
to the earlier value. Unknown event scope invalidates the entire connection.
If that write fails, wallet operations are disabled until service recovery; a late
signature cannot continue under an unrecorded old permission.
Before submission, an explicit user stop, an SDK connection change and a
requested disconnect record distinct reasons. A disconnect request does not
claim completed disconnection. The first terminal reason is retained.
After submission, connection updates and disconnect requests do not stop
independent chain observation, including a lookup that has not started yet.
Only the explicit transaction `stop_waiting` action stops that observation;
later connection events neither resume it nor extend its deadline. An explicit
result read through a new management card can still inspect the same digest.
An ended card cannot resume observation. A new exact-attempt result card can
perform one lookup; its final recorded result also stays fixed. No event resends the transaction.
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

Data replacement is refused while admitted management operations, their SDK
cleanup, signature/submission callbacks or initial chain observation remain unsettled. Removing finished local records cannot
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
