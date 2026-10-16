# Frontend Policy

Account, Receipt, Chart, Connect, Disconnect, Review and Settings use internal MCP Apps cards.
There is no external Settings page. Cards display backend-validated
facts and forward explicit user selections through scoped app-only tools. They
never hold transaction bytes/signatures or call a wallet, Sui RPC, Indexer or
local HTTP endpoint directly. Direct NFT image loading is the display exception.

All seven cards use the same product UI and interaction rules across desktop
Hosts. Equivalent validated data, authority, time, theme and viewport produce
the same information, labels, controls and recovery flow. Qualified transport
formats are normalized at the common integration boundary; Host names do not
select product features or grant authority. Native window chrome and file
pickers belong to the Host. Actual delivery remains a required integration
check; a common error screen does not establish working file delivery.

## Display and review facts

Show what is happening, the relevant asset flow, whether an action is available,
and its consequences before technical details. Backend status and validated
structured facts are authoritative; AI interpretation, local timers and UI
availability do not establish financial truth. Status/error changes must be
textual, keyboard accessible and screen-reader labeled.

Review primary facts include action, selected account, network, send limit
(`up to` where relevant), expected/minimum receive, status and next action.
`assetFlowPreview` display inputs are proposals, never signing quantities.
Use "Minimum received on success" for the conditional minimum and label the
trading fee as an estimate. Distinguish the estimated network fee from its
maximum gas budget; neither is a recorded fee payment.
Show the final ReviewState failed/warning checks beside the decision.
The live Review action row shows only actions available in the current stage.
When permitted, the primary action uses the remaining width beside a
warning-colored `Cancel` button (accessible name `Cancel review`). During
preparation or renewal, show progress rather than unavailable approval or cancel
buttons. A still-relevant action can be disabled briefly during its current
state read, command delivery or graph update; obsolete actions are removed.
Below the row, show the remaining time until this card's original review-input
deadline. Refresh, Retry, visibility changes and state reads never restart that
time. Use the earlier of card and review-session expiry for unsubmitted input;
admitted requests retain their separate observation authority. The View displays
the backend's relative remaining time and never extends a previously confirmed
deadline. It cannot grant authority or declare a backend expiry on its own.
The following feedback area shows a short progress hint during renewal, without
a second countdown to the next condition check. Offer the request only when
current backend facts permit approval. Normal
`review_evidence_stale` renewal uses this progress hint rather than a failure
warning. On an actual calculation failure, offer `Retry review` in the primary position
when the backend permits preparation. Delivery or
read failures use the existing explicit retry or saved-state read in that same
position. Show one primary control, with the reason below it; do not add a second
disabled approval button. These recovery actions never request a signature.
A successful refresh restores the approval request only after the new state is
confirmed; the overall time continues decreasing. These presentation rules
do not change backend checks, expiry, admission or signature authority.
During renewal of the same live review, retain the graph and financial layout
instead of replacing them with a short proposal placeholder. Clearly label
retained material as previous and not current. Before any reviewed amounts exist,
say that amounts have not been checked; do not imply there is an earlier review.
The renderer owns these labels; the lifecycle selects the current or unconfirmed
label without changing permissions. Current action permissions,
progress and failure reasons remain separate from those display facts. Commit
new financial facts together with their graph; do not offer approval while that
replacement is being drawn. Reuse an unchanged graph without resetting its
controls. Never carry this retained presentation across a different session,
plan or account, or use it as the graph of an observed transaction result.
Human-readable evidence-stage explanatory notes precede final checks; retain them
in labelled preparation details rather than presenting them as current failures. Keep raw integer amounts and
pinned decimals; display signed net gas without clamping a rebate to zero.
Review details include quote time, raw min-out policy, gas budget/breakdown,
simulation effects, object/balance changes and a PTB graph from the same revision.
PTB source labels, timestamps and name/address controls are facts,
not safety or venue recommendations. No text-copy buttons or clipboard fallbacks.

External proposals show source, action, recipients/targets, freshness, missing
evidence, user choices, unsupported claims and nonSignableReason. They never
expose a preparation/signature action or silently choose a settlement asset.

## Connect and Review behavior

SQLite owns card permission/revision/deadline, wallet connections, review
revisions and transaction attempts. A View owns only rendering, local resources
and sequential observation. Chat changes, frame recreation and teardown never create a new request or replay an admitted action. A current authenticated live card can continue the same backend-directed preparation after confirming its saved state. With input permission, an initial authenticated DB read
is required regardless of preview rendering success. Without that permission,
read the same card's public saved resource before displaying its current state,
even when the Host replays an older creating snapshot. This restores saved facts,
never input or wallet authority. Missing permission means no business controls;
unconfirmed state disables business actions. Malformed, conflicting or rejected permission is not treated
as absent permission. Response identity and fixed targets must match the card.

Public restoration can perform existing backend expiry and connection/session
reconciliation; read-only does not mean that every database row stays unchanged.
Those evaluations remain backend-owned and do not start another pairing,
preparation, signature, submission or chain observation. Public restoration reads
once and offers an explicit same-card read for unfinished state or a read failure;
it does not start polling or expiry timers. Teardown ignores late replies. A
failed read preserves an already displayed result without claiming current state.

Connect and Disconnect are separate purpose cards. One current connection has one
fixed address per approved requested chain. Settings specifies the next network
scope, initially Sui. Neither card has chain/account selectors or an additional
connection action. A valid single returned address binds automatically; multiple
addresses leave only that chain unavailable. Changing wallet, address or scope
requires disconnection and a new connection.

Connect admits one initial pairing after authenticated UI confirmation. Saving
changed networks closes incompatible unsent Connect cards in the same transaction;
restoring an earlier setting never reopens them. While its
QR is waiting it offers only Stop connecting. A current session, pending pairing
or cleanup prevents another pairing. Disconnect presents the exact target,
networks and affected approvals with Confirm disconnect and Cancel; it does not
include an extra local confirmation stage. Changed target impact requires fresh
confirmation. No card switches from connection to disconnection or vice versa.

Every ended card has an immutable stored result and no business input, automatic
action, polling or state-driven result replacement. Connect and Disconnect results
contain no addresses, QR or account controls, including failed and cancelled
results. They show the outcome, recorded time, wallet name when known and network
approval results. Current addresses belong to `session_get_interaction_status`,
not the ended card. SDK cleanup and same-digest transaction observations continue
in their domain journals independently. A fixed result may say cleanup was pending
at its recorded time; checking current cleanup never updates that result.

Saved-card and ui_read_card return the stored ended snapshot. The wallet get/wait
response returns that `card` separately from the current exact `operation`,
`walletAvailability` and `evaluatedAt`. These reads cannot restore a card's input
or transfer it to another operation. Completed disconnection with pending cleanup
remains completed and prevents another pairing until actual settlement.

Review preparation is separate from final admission. A current card automatically prepares its original fixed account and connection when eligible and renews stale verified material. The backend supplies the typed automatic action; the shared View executes it only with valid UI permission and confirmed state. A complete new review revision preserves failure information. It does not
consume final selection. If a finished computation could not store its outcome,
current reads can record its failed update and restore the existing update/cancel
choices. The View never restarts computation to repair a progress display.
The sign action requires backend-permitted
ready_for_wallet_review, verified transaction review data, a matching live
account and the user's explicit approval request. Show the Review's original
wallet and account; do not offer a target dropdown or use the current read address
as a replacement.
Preparation failure and quote freshness alone do not end the card. Confirmed
loss or replacement of its original connection ends unadmitted input with a
recorded cause; later connection changes do not rewrite that result.
Preparation never grants wallet approval. Only the approval request requires a normal-flow transaction button; failed preparation offers an explicit retry. A Review retains its fixed account and connection when another connection is created, but cannot use that replacement for preparation or signing. A replacement connection requires a new Review. Cancel review beside the primary action explicitly ends this card’s unsubmitted input; it never cancels a submitted transaction. Only the backend sends bytes to the
wallet and verifies its response. A card never reports its own chain result.

Use the backend's `reviewTarget`, current qualification and `allowedActions`;
do not resolve or replace a Review target in the View. Business recovery follows
the backend's `nextStep`, including `none`; missing buttons or a saved preparation
error do not establish a connection problem. Ended Review explanations use the
stored `result.message`. A request's earlier reason is historical information,
not a replacement for the recorded card outcome. The existing `review.error` text labels current wallet availability
guidance and any saved review message separately. Display it
as neutral explanatory text, not as a new failed state. Lifecycle alerts still
report actual command, transport and display failures. Signing an already valid
review and reading an admitted result retain their own backend permissions.

Before submission, show the stored interruption reason without replacing wallet
events with a user-stop explanation. After submission, a connection change or
disconnect request preserves chain progress; only an explicit transaction stop
ends observation. A later wallet event must not restart user-stopped observation.

| Request state | Card behavior |
| --- | --- |
| No request | Show proposal/review; prepare or refresh when permitted, request wallet approval only when valid, or cancel input |
| awaiting_signature | Show wallet wait; user may stop local waiting, which permanently removes submission permission |
| submitting | Show submission in progress; stopping observation cannot cancel the transaction |
| awaiting_chain_result | Show the exact digest and observation state; stop observation when permitted |
| stopped / request_failed | Show reason, without inventing chain failure; a new signature needs a new Review card |
| outcome_unknown | Preserve known digest and uncertainty; ask for a new exact-attempt result card to read the same transaction without resubmitting |
| completed | Show independently verified chain success/failure and receipt facts; no signing input restoration |

Management cards bind an exact reviewSessionId and attemptId. They cannot
change the original deadlines, review selection or submission permission.
A valid saved history is not live management authority. Account/session changes
invalidate pending approval as appropriate; they cannot silently rebind a review.

## Rendering and recovery

Use the shared lifecycle for all cards. A lost action reply reads the same
state once; it never resends the action. Read errors stop automatic observation
and retain previous facts with explicit Check status recovery. This reads the
same stored card; it does not recompute a review or submit a transaction. Rendering failures keep
normal DB observation obligations, preserve previous content, and dispose only
new failed resources. A rendering failure is not a reason to repeat the business
query. QR and graph resources are disposed once. Review and Receipt show their transaction graph first, without an additional card frame. Review uses the current verified material, except for explicitly labelled previous material retained during same-target renewal; completed results use the executed transaction. A missing graph is labelled unavailable, never presented as current by substituting a different revision or a pre-execution graph. Opening details uses the same displayed facts without a new query or action; delayed renders cannot cross transaction identities. Backend-computed remaining
time triggers a state read, not a client-written expiry reason.

A renderer that fails before returning its view owns cleanup of the resources
it already created. The frame cannot dispose an unfinished view it never received.
View disposal is idempotent and prevents late drawing results from being applied.

A failed whole-card display offers Check status even when its UI permission is
present. An accepted current read can retry that display from the stored facts.
A partial asynchronous drawing failure reports its actual local retry capability
to the frame. Explicit Check status confirms the current card before retrying that
same view's failed resource; polls and chat visibility changes do not constitute
consent to repeatedly repaint an unchanged failed QR. Replaced or disposed views
cannot retry their old resources. A QR failure does not disable a permitted Stop
connecting or required observation. Missing private QR data is not a drawing
failure: public saved reads cannot retrieve it, and navigation must not promise
to restore it. None of these display callbacks requests a new pairing, review
calculation, signature or submission, or clears a command's retry/pause state.

A successful state read does not erase a failed command. If automatic-command admission
is still unconfirmed, the View pauses automatic execution and offers Retry connection
or Retry review for the failed action. Each retry starts a fresh read and confirms
the same target and revision before sending once. Retry is disabled during another read; a discarded older response is not confirmation. A changed target requires a new click, not an automatic retry. An admitted
operation is observed instead. Hidden/visible transitions do not clear this pause
or retry a failed read. A rejected expired approval request is never replayed:
after confirming state, only backend-permitted preparation may resume, and the
new conditions require a new Request click.

The common lifecycle owns separate facts for the accepted projection, current
confirmation, in-flight communication, command delivery and relevance, local
automation intent, and presentation failures. One decision supplies business
controls, recovery, observation and notices. A read Promise is not confirmation:
if a required confirmation joins a read started before that requirement, its
successful completion is followed by one serial current read. An actual read
failure requires explicit recovery; it is not retried automatically. A discarded
fresh response retains a scheduled observation or explicit read recovery without
a zero-delay loop. Opening-projection errors clear when the identified card's
valid current read is accepted; they are not command failures or permission
restoration. A missing or conflicting identity remains a rejected boundary.

Command-delivery failure does not suppress state reads at backend expiry
deadlines. When current state confirms that an unadmitted approval's material is
stale, or its review revision has been superseded, the old command no longer
blocks the current permitted preparation. Request absence alone is insufficient;
never transfer an old approval click to new conditions. After failed initial
preparation, Retry review rereads the same card and prepares only its original
fixed account and connection when the backend permits it. A replacement connection
requires a new Review; it cannot become the existing card's retry target. An ended
original connection requires a new Review even when no replacement is connected.
Use `connection.sessionPresence`, current qualification and pending work for this
guidance, not a list of saved status names. A failed or expired connection with a
retained session requires cleanup; confirmed absence requires reconnection and
a new Review. Unconfirmed presence requires a status check, not assumed absence.
Keep the original Review target and transaction-result authority unchanged.
While a card is active, prior connection messages must not override currently
confirmed absence. Ended cards show only their stored result and recorded time.
For Connect, absence also includes a settled attempt without an approved session
or recorded session reference, provided current-run ownership is confirmed, no
connection work remains and no unrecorded SDK session is retained. A pending
response or a missing observation for a recorded session is not that evidence.
If no session exists, explain that fact. A new connection requires a new Connect
card; an ended card has no recovery input. Do not direct
the user to repeat status checks for a confirmed no-session result or create a
transaction Review merely to recover a declined connection. Explicitly cancelled
cards keep their closed result and cannot regain input.
If the original target becomes ineligible during the read, send no preparation.
Bound-account and wallet-change retry rules remain backend-owned.

A read failure remains recoverable even if a delayed action response updates the
display. Preserve the read error and Check status control, with business input
and timers disabled, until an explicit current read succeeds. Validate identity,
fixed inputs and non-regressing revision before clearing that error. Displayed
facts, recovery controls and observation readiness must use the same decision;
an older response or visibility change cannot independently restore authority.

A successful response for the same card with a strictly lower revision is
history, not a read failure. Check stable card identity before discarding it;
validate admission-bound inputs and result targets when adopting a current
snapshot. Equal revisions still require validation and may carry updated live projections
only before closure. A confirmed closed snapshot must match its stored result. A discarded response cannot replace facts, clear errors, extend
deadlines or interrupt required observation. Restore a coalesced poll using the
latest backend hints; an elapsed authority deadline keeps input locked until a
current read is accepted. Do not spin on stale responses. Actual error envelopes
remain errors even when accompanied by an old snapshot.

Failed Cancel review, disconnection or stop-waiting commands
retain their target-specific error after state reads. This View pauses new
automatic preparation and pairing while observing any already admitted work.
Current disconnection is not proof that a lost command was admitted and does not
restart pairing from an earlier connect intent. Existing permitted controls
provide explicit recovery. If Cancel review is unconfirmed and review material
expires, show Continue review for permitted preparation; it uses a fresh target
check and never requests a signature. Do not show this additional control in the
normal automatic flow or restore actions to a cancelled/expired card. Local
automatic pause is renderer context, not a modified backend projection or a
persisted stop in other frames. Reading stored facts cannot clear that pause;
the user must explicitly choose to continue. New frames follow actual DB state.

Command delivery and present relevance are independent. Apply this to connection,
preparation, approval, result reading, cancellation, disconnection
and waiting controls, and to ordinary read-card submission. When the
exact result is observed, display it without retrying a lost reply. When a failed
attempt can no longer be used because its authority or target has ended, retain
it under "Previous" with the specific request, selection or status check and
its original error, not as a current error or a recovery demand. A previous
request label must not imply that cancellation or disconnection succeeded.
For an unadmitted disconnection, compare the attempted connection ID with the
current `connection` and confirmed SDK facts. A changed target is not proof that
the attempted command succeeded. Remember a confirmed end of that View attempt
while displaying current facts. A dedicated Disconnect card remains limited to
its original target. A new user prompt is required for another connection or disconnection operation;
the old card never targets the replacement connection.
Missing target data or wallet unavailability alone is not proof of termination.
An earlier-attempt label does not release a failed automatic command's explicit
retry requirement or a user's local pause. A competing connection card points
to the original waiting card; it never takes its QR or operation permission.
Natural completion does not prove that a failed stop succeeded. Signing-wait
`stopped` and post-submission `observationStopped` are distinct backend facts.
Card authority expiry does not terminate an admitted request or lookup. Preserve
its current observation even when no commands remain allowed. For an unknown
result whose result-reading authority ended, the user can ask for a new management
card for that same attempt; never recreate or resubmit the transaction. A separate
current read failure still needs its own recovery alongside an earlier attempt.

When failed review material becomes invalid, the backend preserves the original
failure and stage history with `evidenceValidity: "invalidated"` and removes its
material-derived facts. Those stages describe the last computation, not current
evidence. This failure does not become an automatic renewal opportunity.

An unadmitted ready Review also uses the backend's `nextStateReadAfterMs` hint
to confirm state at its verified material expiry. Use the earlier positive
interval from that hint and the card authority deadline. Lock business input
until the read resolves; a failed read requires explicit recovery. Countdown
hints do not identify new display content or reset a wallet selection. A stale verified review renews automatically through the same typed preparation action. A failed computation, changed account, missing permission or admitted request does not trigger automatic preparation. Countdown completion never authorizes signing or terminates an admitted request.

Card state, action choices and timing hints come from the same backend
evaluation. A read conflict caused by changed review evidence preserves the
last display and requires explicit state-read recovery, with inputs and timers
disabled. Prefer the safe error message when supplied; a reason code is not
display copy. Do not recreate a business request or continuously retry a conflict.

Only actions permitted by the current backend state are rendered. During an
in-flight action, disable other business actions while preserving display
controls. Preparation/transport failures and display failures have distinct
messages and recovery. Amounts, slippage, target asset and venue are changed
through a new reviewed proposal, not ad hoc frontend edits.

Connect and Review show `walletAvailability` separately from stored business
facts. Wallet unavailability preserves the displayed review and results, removes
wallet-dependent actions, and does not become a rendering error. A connection
that cannot be checked is labelled as the last recorded status with its update
time. Pairing display data must be removed when the backend no longer supplies
it, even if the card revision is unchanged.

The backend derives `observe` from `progress.status === "waiting"`. Unavailable
progress stops automatic polling and offers an explicit same-card state read;
that read cannot reconnect, sign or resubmit. Existing DB expiry wake-ups remain
independent of progress polling. Availability and allowed actions participate in
display identity; remaining-time hints do not reset input selection.

Wallet-service startup is separate from connection and transaction states.
Show normal initialization neutrally in active cards. Connect owns only pairing;
Disconnect owns only its exact session's removal confirmation. Neither contains a
service-restart control. Approved and disconnected results are address-free and
fixed. The current connection's eligibility controls new Review input; a new
connection never replaces an old Review target. A Review displays its immutable `reviewTarget` before preparation
and when its target is unavailable. `assetReadAccount` is a separate read context
and never substitutes the displayed transaction account. Current `canDisconnect`
for a replacement connection is not recovery guidance for the original Review.
If the original connection has ended, explain that the replacement needs a new
Review. Non-signable external proposals do not need a wallet target.

Disconnect uses its own fixed-target card with Confirm disconnect and Cancel.
It has no local confirmation screen or Back step. View recreation, Details and
rendering retries are display operations and cannot send a business command.
Connect, Disconnect and Review render the backend's purpose-specific decision
and `nextStep`; they do not reconstruct wallet eligibility from status names.
The backend reevaluates current facts at admission. Host delivery uncertainty
and display failure remain frontend communication facts, not domain outcomes.

Connection-service recovery belongs to Settings/Troubleshooting and requires
showing the affected SDK run and requests before explicit restart confirmation.
Connect/Review explain that path when recovery is relevant; they do not host
service-restart controls. Normal QR approval or initialization is not a failure
diagnosis. An uncertain command first offers its same-request status check.
If the parent/Settings is unavailable or a parent endpoint/installation change
must apply, explain the setup guide's stop/reopen procedure for the shared parent. Child restart
never implies remote disconnection, connection approval or chain outcome.

Settings separates Address for viewing assets, Wallet networks, Local records
and Troubleshooting from Advanced endpoint controls. Show operation impact and errors in the body;
technical values use the existing Details disclosure. Each card owns one
operation and its stored result. Wallet networks shows the saved and selected
scope and its effect on new connections. One explicit Save networks action
atomically admits and saves that exact selection; there is no second confirmation
screen. Editing checkboxes, Back, chat navigation and state reads do not save it
or start a connection.

Address for viewing assets shows the saved Sui read address and one Clear saved
read address action when permitted. Clearing suppresses implicit reads for that
connection; it does not disconnect the wallet, change fixed addresses or cancel
transaction requests. Do not add Review/Save confirmation stages or restore the
address during a state read. If an unused restore upload is invalidated by this
effect, show its cleanup result separately from the completed address change.
Back preserves an eligible selected restore file; changing effect or ending its
use invokes backend-owned invalidation and cleanup, not a frontend file delete.

Selecting an endpoint change, reset or service restart starts its preparation
and leads directly to the concrete impact confirmation. Do not insert an
input-free Continue screen. The final confirmation still displays the exact
endpoint, records to replace, or affected service run and requests before the
user applies the change. Preparation, Back, chat navigation and state reads do
not apply settings, create another file or restart the SDK. A valid sealed
upload remains available for Check backup again after preparation invalidation;
explicit file change uses the backend selection action. Validation rejection
retains the actual current card and a usable correction/selection path. A failed
preparation requires explicit retry; returning to a card does not repeat it.

Local records offers Download backup as one explicit action. Snapshot creation
and verification are internal progress, without a separate creation or
confirmation page. New downloads use one private temporary snapshot. A supported
download does not publish a permanent server backup. Other Settings choices do not appear on
its progress or result page. File delivery uses the standard Host-mediated
request, without hiding the action according to a Host name or download
advertisement. Missing card authority still prevents actions.

If that actual `ui/download-file` request returns method-not-found (-32601),
the same snapshot is saved once in the Sui MCP backup folder. The initial choice
explains this conditional destination. A verified local result shows Backup
saved with a readable, selectable Folder and File name. It offers no second
download action. Missing advertisement, cancellation, denial, invalid parameters,
timeouts and errors from other methods do not select this path. Application
names do not select either path.

An earlier possibly handled attempt requires Save a local copy before local
saving, with a warning that another copy may exist. A local save in progress
offers status observation, not another save, Host retry or cancellation. A failed delivery ends its card. A new delivery-purpose Settings card may offer
Retry save for `not_published` within the original period. An uncertain publication
is checked without attempting publication again. State, authority, expiry,
navigation and controls use the same current projection. Recorded saving and
temporary cleanup remain separate facts, including when cleanup fails.

Results distinguish snapshot preparation, Host-reported delivery, temporary
cleanup and actual user file storage. Suggested file name is not a confirmed
save location. Host acknowledgment ends server retention but is not proof of a
saved file; isError does not classify cancellation, denial or failure. Lost
responses are unconfirmed. A new explicit delivery card retries the same verified snapshot
within its original fixed transfer period and warns when a prior request may already
have been handled. Frame recreation and state reads never download again.
Cancel download ends further transfer and cleans the temporary snapshot; it
cannot close a Host dialog or delete a saved user file. An ended card needs a new user prompt and a new delivery card to retry, and a server restart ends the old transfer. An already-admitted
local save may be settled by verifying its existing artifact after restart;
recovery never creates a missing backup or restores old input permission.

The backend owns a thirty-minute transfer period starting when the snapshot is
physically ready, separately from the original card-input deadline. Reads and
retries do not extend it. The View consumes relative remaining time without
extending a confirmed deadline. Permission, operation, file, attempt and current
state are checked before delivery. The elapsed time of the authenticated
pre-delivery read, including a coalesced read, reduces the remaining period; a
delayed reply cannot grant a fresh transfer period. A corrupt or unavailable snapshot sends no
bytes to the Host. A local save admitted before the deadline finishes its file work and result
settlement; the verified final backup is not subject to the private-file TTL.
Saved local-backup results retain their recorded facts;
their files are not removed by temporary cleanup.

Incomplete cleanup is recorded as of the card result. A new read-only Settings
status card (`operationStatus`) checks the same operation without repeating it. Cleanup includes
settlement of that operation's ended I/O reservation and waits for its actual
file reads/writes to end. A stored result remains readable while settlement is
retried; it does not release another operation's running I/O. Reading a recorded
Host report resolves a lost reply without sending the file again.

Local-data counts describe the backend state at the time they are read. A later
replacement warning must not use a stale count, especially zero, as an assurance
that no unconfirmed transaction records will be deleted. Warn that replacement
can remove those records and cannot cancel a transaction on Sui.
The private connection-service journal remains; Reset does not claim that the
SDK is empty or grant a new pairing. Current cleanup eligibility belongs to
status reads and is separate from the Review's fixed target. Live card recovery
uses the backend `nextStep`. Unrecorded SDK
presence uses conditional Settings recovery guidance after registration ends,
without a synthetic target or global recovery controls in Connect.

Endpoint confirmations name Sui node (gRPC) or Activity data (GraphQL), show the
stored value before the change and the exact value to store. Their result labels
the effective value and source at save time. Explain an active environment
override in the body: restart alone will not apply the stored value while that
override remains. Do not substitute a current configuration read for the saved
result or copy default URLs into the View.

## Internal Read Cards

Account and Receipt targets are established in chat, without card input forms. Missing targets produce a concise input-required message with no card record, source request, permissions or polling. The Account card shows SuiNS when available, the actual query address, coin totals, Display NFTs, an omitted-object count, fetched time and enumeration limits for an explicit or connection-qualified default address. The Receipt card shows execution outcome, balance changes, net gas, sender, digest and fetched time. The transaction graph is visible above the result. Technical input, object, call, event, identifier and timing facts are in one Details slide. Review uses the same observed-result layout and places earlier reviewed conditions in a separately labelled section of that slide, without nested disclosures. Reviewed estimates remain distinct from actual chain results. Internal request IDs, revisions and raw JSON dumps are not display requirements. Important failures, warnings and missing choices remain beside the active decision. The Chart card shows one selected DeepBook USDC pair with official intervals, the UTC period and any result-limit notice. When the pair is missing, optional interval/range choices are in Time range & interval, with an instruction to set them before choosing the pair; choosing the pair submits the complete valid query without a second Show chart button. Supplied pairs query directly. Detailed candle numbers are in an accessible disclosure. Candle count is not a form field; supplied limits, defaults and shortcut query values remain unchanged. Its initial time axis uses the saved request boundaries; omitted boundaries use available candle times, and a request without either boundary fits the returned candles. Boundary whitespace carries no price or volume. Empty results show the requested range and an explicit no-candles message. These are read-only views; they create no wallet connection, review approval, trading authority, P&L or fiat valuation.

All read cards use one SQLite-backed input lifecycle and one View lifecycle. The View inserts a result node before invoking its mount callback. Size-dependent renderers wait for positive layout dimensions, ignore hidden zero-size layouts, and release observers and drawing resources on disposal. Chart resizing preserves the current viewport rather than reapplying the initial query range. Initialization reads the same card record. Chat navigation, frame recreation and teardown do not close input or cancel work. A valid unsubmitted selection remains available; admission or backend expiry ends that original input. A read may finish after its View closes. Completed results are static, remain stored until local data replacement/reset, and do not repeat the source query. A different selection after admission needs a new card.

Static presentation may read the same saved result, missing details, or the state of an admitted operation when needed. Such reads do not restore controls or start a new business operation. Polling is sequential, uses the server-provided interval, and stops on completion, view closure or read error. Keep an already displayed result when a later read fails.

The view uses MCP Apps host-mediated tool/resource calls. It does not fetch local HTTP endpoints, Sui RPC or the Indexer directly. App-only permissions travel in UI metadata and never appear in ordinary model content or saved resources. The backend checks permission, card, server expiry and expected revision and admits the selection atomically in SQLite. Identical duplicates return the stored request; conflicting input returns an authenticated current snapshot and an error. Lost replies require a same-card state read, never automatic resubmission.

The View timer uses backend-computed remaining input time and asks for current state at expiry; it does not write an expiry or close reason. Teardown only disposes local observers, timers and rendering resources. Missing UI permission or a failed current-state read keeps input disabled without inventing a terminal state. Preserve previously displayed facts and expose recovery through a saved-state read. Server restart invalidates unfinished input/work without replaying it and preserves completed DB results.

Receipt input values and their PTB graph use a typed UI-only metadata channel bound to card ID, transaction digest and revision. Model text, structured content and public saved resources omit those display details. A view displaying private receipt details must mark missing details as unavailable, not as an absence of transaction inputs. Receipt and completed Review expose those technical sections only in their Details slide. Missing private metadata cannot be recovered by weakening the public saved-resource boundary. Rendering uses the validated receipt. NFT image loading remains the permitted direct external-display exception; business queries still go through the backend.

Internal cards provide no clipboard actions, copy buttons, or clipboard fallback controls. Preserve readable facts and ordinary text selection; where a PTB graph is shown, preserve its name/address controls and pan/zoom. NFT images retain no-referrer behavior and a failed-image placeholder. Theme follows the host. Card view cleanup ends timers, subscriptions and rendering observers without cancelling an already admitted server operation.

All seven cards, including Review management, adapt to the embedded frame width.
Forms wrap, narrow fact rows stack their label above the value, and long addresses,
amounts, names and records remain readable without widening the document. QR,
chart and PTB drawing areas stay within the card; resizing changes presentation
without repeating a business query or changing stored state. Responsive rules
for shared atoms remain in the shared stylesheet.

## Language

Use short, direct, non-promotional copy. Stable cards do not repeat generic
"Saved result" or "Stored request state" labels above their actual facts.
Lifecycle messages describe opening, unavailable current state and recovery;
renderers describe business facts. Show times in UTC with exact values available.
Unknown token decimals mean the display amount is unavailable; do not present
raw integers as user token quantities.

Do not say:

- safe
- recommended
- best
- guaranteed
- approved by AI

Prefer:

- ready for your review
- review needs updating
- review blocked
- expected to receive
- minimum received on success
- data retrieved

Source fields keep their defined names and meanings. Use Data retrieved for
`fetchedAt`; it is not the transaction's execution time. Use Estimates checked at
and Estimates expire for review evidence, Connection expires for wallet-session
expiry, and Request updated for request state changes. The overall Review expires
in timer remains distinct from the shorter estimate validity period.

Across cards, use these distinctions rather than treating similar words as
interchangeable:

| Card wording | Technical source | Meaning |
| --- | --- | --- |
| Sui mainnet | Verified network/chain facts; proposal `network` is a declaration | Product network; Declared network in an external proposal remains untrusted input |
| Account address / Account to review / Reviewed account / Sender / Receiving account / Affected account | Query `account`, saved read context, immutable `reviewTarget`, `review.account`, receipt `sender`, recipients and balance-change addresses | Query target, saved read address, fixed review target and transaction roles; none is wallet authorization |
| Ready for your review / Review needs updating / Review blocked | `ready_for_wallet_review` / `refresh_required` / `blocked`, displayed through `REVIEW_UI_LABELS` | Computed review information, not current permission to request a signature |
| Transaction succeeded/failed on Sui | Verified `execution.status` / receipt `effectsStatus` | Independently observed chain outcome, not a completed tool call or wallet response |
| Check status / Retry review / Check transaction result | `ui_read_card` or public saved resource / `prepare_review` / `read_result` | Read this card, recompute permitted review details, or observe the existing transaction; none requests a signature |
| Connect wallet / Request wallet approval | `connect` / `request_signature` | One permitted connection request or a permitted request for wallet approval; actual wallet approval is still required |
| Continue review | `prepare_review` after the View's local pause and a fresh target check | Explicitly continue review updates; it does not authorize signing |
| Stop connecting / Stop approval request / Stop checking result | `stop_connection` / `stop_waiting` in `awaiting_signature` / `stop_waiting` once submission has started | End pairing, remove this approval request's submission permission, or stop result observation; the last cannot cancel a submitted transaction |
| Cancel review | `cancel` | End this unsubmitted Review card without changing a submitted transaction |
| Estimated network fee / Network fee | Review `netGasMist` / receipt `gas.totalMist` | Simulated versus independently observed net gas after the storage rebate |
| Network fee limit (gas budget) | `transactionReviewData.gas.gasBudgetRaw` / receipt `gas.budgetMist` | Transaction network-fee spending limit, distinct from an estimated or observed charge |
| Earlier review message | `review.error` quotes the session's stored `preparationError` | A saved preparation failure or connection change, not proof of a previous computation attempt |
| External proposal — view only | `ProposalReviewModel.nonSignableReason` and unsupported capabilities | Declared proposal information with no wallet approval or execution |
| Transaction being reviewed / Executed transaction | Review PTB / receipt PTB | Candidate material versus the observed transaction; neither graph is a safety verdict or authorization |

These are display-to-contract mappings, not wire-name aliases. Keep SDK method
names, action/status enum values and persisted field names unchanged. The API
reference owns response meanings and the local database architecture document
owns storage meanings. `CardStore.readSaved` reads the persisted card projection
with existing evaluation; its name does not promise a raw row read or permission
recovery. Receipt code names refer to chain receipts even when the screen title
is Transaction result.

Advanced details retain exact gas, object, Move, event, raw-unit and protocol
terms. Display labels must not rename public state enums, hide original failure
causes or change their recovery actions.

Ready for your review means that review details are available to inspect. It
does not promise that wallet approval can currently be requested; read-only
cards can show the same details without any action permission. Review needs
updating describes out-of-date details, not a failed transaction. Updating review
means preparing new review details; Checking status reads the existing card.
Continue review changes this View's paused-update intent, so it is not renamed
as a routine retry. Network fee amounts are after the storage rebate and may be
negative; Network fee limit (gas budget) is a spending limit, not a fee estimate.

Message producers describe confirmed facts without prescribing a View action.
The View owns current guidance and names only controls that are available there,
or a specific request the user can make in chat. A public or expired card must
not tell its reader to click an unavailable update or approval action. Uncertain
approval delivery and existing transaction results refer to the same request,
never to sending another transaction. Past messages are quoted as messages from
the earlier action, with its original phase and reason preserved. They are not
current instructions or proof that cancellation or disconnection succeeded.
External error text and known diagnostic codes retain their source meaning;
unknown messages must not be translated into an invented cause. Display plain
explanations of known Chart reason codes, with the original code in Details.

Renderers describe their actual selection UI and domain next step; the common
frame combines those facts with its current confirmation and recovery decision.
The presence of a workflow button is not a proxy for an editable Chart form.
An unadmitted Chart selection remains usable after a delivery failure, whereas
an admitted query's result or source failure requires a new card for a new query.
A confirmed expired review session needs a new-review instruction even when its
later-created card record is still ready. Local timer expiry alone is not that
confirmation. Connection instructions distinguish the recorded current connection,
pending work and unavailable wallet state; a missing record during unavailability
does not establish that connecting is currently possible. Show each current
next step once, separately from the quoted earlier-attempt message.

Frontend labels stay in English. Localization must preserve protocol names, token symbols, object IDs, package IDs, and reason enums without translation.

## Shared UI And Design Principles

The card views share one design-token set and one set of atomic UI
components: vanilla TypeScript DOM helpers in `review-app/src/ui` plus the shared
stylesheet `review-app/public/ui.css`, bundled into each self-contained card HTML. There is
no React, Vue, Svelte, or client router. Views compose the shared atoms and keep
only their own layout, container, third-party-sizing, and composition CSS. The
shared atoms are addressed by `ui-` prefixed classes that only the shared
stylesheet declares; a page stylesheet declares no `ui-` class rule and no bare
button, input, select, or textarea rule.

The shared UI follows these durable principles:

1. Always-actionable controls: every actionable control shows hover, active, and
   keyboard-focus feedback. Controls are inert only during the deliberate,
   clearly-signaled async lock. Status and errors are conveyed as text, not color
   alone.
2. One consistent system: cards share one lifecycle, one component set, and the
   same element positions. Cards have no cross-page navigation.
3. Cards show the current step and next permitted action without permanently
   listing every earlier step. A completed transaction leads with its observed
   result; stored request state is not a second outcome. Settings saves network
   selection directly and confirms the concrete impact of endpoint changes,
   replacement and service recovery.
4. Primary result regions keep their position across data availability and show
   an explicit empty or unavailable state. Technical sections intentionally omitted
   from a summary do not require placeholder regions; the Account summary reports
   omitted-object counts only when there are such objects or an enumeration limit.
5. Time-based progress and quantitative completeness use different components: a
   progress bar only when a real value advances it, an indeterminate overlay for
   an unknown-duration wait, and a count plus checklist for an already-known
   "N of M".
6. An action's result or error is tied to that action, stays visible, and carries
   enough detail to diagnose afterward.
7. Restraint: each page shows only the information it needs, with generous spacing.
8. Information depth by importance: each page ranks its information and renders the
   user task first and most prominent. Internal cards are one document: plain sections, rows and whitespace replace nested cards. Supplementary facts use one closed Details slide with plain sections inside, never nested disclosures. Do not repeat summary values or status in another panel. Review and Receipt place the correct transaction graph above their concise decision/result. Important errors and costs remain visible. Settings uses the same plain sections/rows and one Details disclosure.

All cards follow Host light/dark theme through the document's `data-theme`
attribute and shared CSS tokens. They do not persist a separate theme choice.
Use inline SVG icons or bundled assets, never an icon font/CDN or retired
`/review-assets/` route.

## Navigation

Read cards open from purpose-specific MCP tools. They contain their own result and error states and do not link to removed Account, Receipt, Chart, home or HTML not-found pages. Cards have no cross-page navigation or linked brand exit.

## Security

Tokens must not be accepted in query strings. Wallet addresses must not be written to local event logs in plaintext. Private keys, signatures, transaction bytes, and arbitrary Move calls must not appear in frontend state.

Cards bundle script/style locally with the declared Host CSP and no external execution chunks. There is no external page/asset or HTTP mutation fallback. Shared private HTTP transport retains Host/Origin and transport authentication checks. App-only tools require scoped UI permission, target and revision checks.

Wallet and review screens must be keyboard reachable and screen-reader labeled. Status and error changes must be exposed as text, not color alone.

Native push notifications are out of scope. A frontend may use low-authority browser affordances such as document title changes for off-tab terminal results, but only after server status changes.

Each card has its own scoped input; live review and session state is shared in SQLite (see LOCAL_DB_ARCHITECTURE.md). Views never share mutable business state directly.

## Out Of Scope

The frontend must not add:

- additional live trading/chart dashboards beyond the read-only Chart card
- portfolio dashboards
- AI chat
- trading recommendations
- alerts
- automatic transaction history dashboard pages
- multi-wallet comparison
- saved plans or bookmarks
- arbitrary strategy controls

The exclusions above target automatic, background-indexed, or
recommendation-style surfaces. User-requested local record views are allowed
only inside their narrow surfaces: the Account card shows a wallet
asset snapshot at a fetched timestamp for an address from public on-chain reads,
and the Receipt card shows server-read on-chain receipt facts
for one transaction digest. Summaries of locally stored review and activity records are available through the MCP read tools. These views
must not add P&L, valuation, performance, tax claims, or route ranking. They
must not add background indexing.

Authenticated automatic actions stop on hidden views, teardown, read errors and unavailable permission. Resuming confirms current state first; it never restarts a completed or invalidated request. SQLite admits at most one preparation at the current revision across frames. `review_evidence_stale` identifies formerly verified material that needs renewal; `quote_stale` from a failed computation requires explicit retry instead of an automatic loop. The visible countdown displays the original review-input lifetime, not financial completion percentage. Backend-directed condition checks continue independently. No automatic path requests a signature or resubmits a transaction.

## State-appropriate controls

The shared stylesheet enforces the HTML `hidden` attribute across component
display styles. Elements that only reserve layout space use an explicit
presentation class instead of redefining `hidden`.

Connect never becomes a wallet overview or a Disconnect card. Stop connecting
appears only while that card's admitted request can be stopped. Every terminal
wallet card shows its recorded result without addresses, QR material or business
controls. Cleanup continues separately and cannot change the result or start a
new connection. Current addresses and settlement belong to their read-only
status responses. A retained session requires a new, exact Disconnect request;
after confirmed absence and settlement, a new Connect request may proceed.

After the user stops transaction result observation, close that card's business
input and remove both Stop checking result and Check transaction result. A new
management card can explicitly check the same digest without resubmission. While a download and its result
report are active in this frame, omit Retry download; retain permitted cancellation
and later explicit recovery. Once a read-card selection has been admitted, retire
its input controls and show read progress until the result arrives. Unconfirmed
commands and failed reads preserve their prior information and explicit recovery.

Explicit cancellation ends that card's business input, including Stop connecting
and Stop approval request/result checking. Completion of already-admitted I/O
may record facts but cannot overwrite the cancelled card state or admit another
action. Exact duplicate stops only return saved facts. Read-only status recovery
and disclosure controls remain distinct from a new wallet or transaction action.

Purpose-specific live data contains only that card's operation. Connect has its
fixed requested networks and operation; Disconnect has its fixed target and
operation; Review has its fixed review/request facts. Current read-address and
connection-overview fields belong to status reads, not each card.
A closed wallet result never includes the transient operation copy. Optional
`result.pendingWork` records an outstanding original approval response, a known
unaccepted session requiring removal, or unconfirmed removal at the result time.
Successful approval or disconnection does not require recovery merely because
callback bookkeeping has not settled. Current settlement remains in exact-operation
get/wait responses; it cannot alter the closed result.
