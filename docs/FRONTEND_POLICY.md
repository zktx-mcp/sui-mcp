# Frontend Policy

Account, Receipt, Chart, Connect, Review and Settings use internal MCP Apps cards.
There is no external Settings page. Cards display backend-validated
facts and forward explicit user selections through scoped app-only tools. They
never hold transaction bytes/signatures or call a wallet, Sui RPC, Indexer or
local HTTP endpoint directly. Direct NFT image loading is the display exception.

All six cards use the same product UI and interaction rules across desktop
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
The live Review action row gives roughly 70% of its width to the primary action
and 30% to a warning-colored `Cancel` button (accessible name `Cancel review`).
The primary action keeps the label `Request wallet approval` during renewal.
Below the row, show the remaining time until this card's original review-input
deadline. Refresh, Retry, visibility changes and state reads never restart that
time. Use the earlier of card and review-session expiry for unsubmitted input;
admitted requests retain their separate observation authority. The View displays
the backend's relative remaining time and never extends a previously confirmed
deadline. It cannot grant authority or declare a backend expiry on its own.
The following feedback area shows a short progress hint during renewal, without
a second countdown to the next condition check. Keep the request
disabled until current backend facts permit approval. Normal
`review_evidence_stale` renewal uses this progress hint rather than a failure
warning. On an actual calculation failure, replace the unavailable approval
button with `Retry review` in the same primary position. Delivery or
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
new financial facts together with their graph; keep approval disabled while that
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

Connect shows wallet state and the selected account. The connected-wallet overview omits the separate Close action; Back in disconnection confirmation returns to the overview without sending a command. A connect-intent card prepares its QR automatically after authenticated state confirmation; manage pairs only after an explicit Connect wallet click; disconnect intent does not pair. It hides additional pairing while unexpired connected wallets or pending connection operations exist, and uses an in-card target-specific Confirm disconnect/Back step for disconnection. Confirmation is discarded when the card revision or target changes. Connect shows approved accounts and read context. An explicit connection with
one approved account can set read context; multiple accounts require selection.
The stored read context persists separately from default asset-read eligibility. An implicit asset read requires a usable current connection for the selected account; explicit-address reads and stored result reads do not. Clearing read context is not wallet disconnection. Reconciliation alone never
sets it again. A waiting Connect card displays only the same live pairing QR
from metadata bound to card/connection/revision. Missing metadata is shown as
unavailable and never triggers new pairing. Terminal connections cannot be
reactivated by late approval; another operation uses a new card.

Connection facts and the current card operation are separate. A pending
disconnect is projected from the stored accepted action, target and running
card. Show its progress while retaining the last confirmed connection facts,
exclude that connection from new selections, and observe until stored completion
or failure. Do not end observation merely because the last connection status is
connected. Frame recreation reads the same operation without sending it again.
Current reads can recover completion after a storage failure; SDK unavailability
must not be rendered as proof that the remote wallet connection was removed.

Review preparation is separate from final admission. A current card automatically prepares a uniquely determined account/connection and renews stale verified material. The backend supplies the typed automatic action; the shared View executes it only with valid UI permission and confirmed state. A complete new review revision preserves failure information. It does not
consume final selection. If a finished computation could not store its outcome,
current reads can record its failed update and restore the existing update/cancel
choices. The View never restarts computation to repair a progress display.
The sign action requires backend-permitted
ready_for_wallet_review, verified transaction review data, a matching live
account and the user's wallet selection. With exactly one current candidate,
show its wallet and account and use the explicit action button as that selection;
do not require a dropdown. Multiple valid connections block preparation and signing; show the reason and direct the user to resolve them in Connect.
Preparation never grants wallet approval. Only the approval request requires a normal-flow transaction button; failed preparation offers an explicit retry. Several approved addresses require selection within the single wallet connection. Cancel review beside the primary action explicitly ends this card’s unsubmitted input; it never cancels a submitted transaction. Only the backend sends bytes to the
wallet and verifies its response. A card never reports its own chain result.

Use the backend's preparation choices for account compatibility; do not recreate
that rule in the View. The existing `review.error` text labels current account
selection guidance and any saved review message separately. Display it
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
| awaiting_chain_result | Show the exact digest and observation state; stop/resume observation when permitted |
| stopped / request_failed | Show reason, without inventing chain failure; a new signature needs a newly reviewed revision |
| outcome_unknown | Preserve known digest and uncertainty; read the same transaction without resubmitting |
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
preparation, a changed current account or connection is shown before an explicit
Retry, which rereads and sends that displayed target once. A target change during
that read requires a new click. Bound-account and wallet-change retry rules remain
backend-owned.

A read failure remains recoverable even if a delayed action response updates the
display. Preserve the read error and Check status control, with business input
and timers disabled, until an explicit current read succeeds. Validate identity,
fixed inputs and non-regressing revision before clearing that error. Displayed
facts, recovery controls and observation readiness must use the same decision;
an older response or visibility change cannot independently restore authority.

A successful response for the same card with a strictly lower revision is
history, not a read failure. Check stable card identity before discarding it;
validate admission-bound inputs and result targets when adopting a current
snapshot. Equal revisions still require validation and may carry updated
projections. A discarded response cannot replace facts, clear errors, extend
deadlines or interrupt required observation. Restore a coalesced poll using the
latest backend hints; an elapsed authority deadline keeps input locked until a
current read is accepted. Do not spin on stale responses. Actual error envelopes
remain errors even when accompanied by an old snapshot.

Failed Cancel review, disconnection, account selection or stop-waiting commands
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
preparation, approval, result reading, cancellation, disconnection, account
selection and waiting controls, and to ordinary read-card submission. When the
exact result is observed, display it without retrying a lost reply. When a failed
attempt can no longer be used because its authority or target has ended, retain
it under "Previous" with the specific request, selection or status check and
its original error, not as a current error or a recovery demand. A previous
request label must not imply that cancellation or disconnection succeeded.
For unadmitted disconnection or account selection, identify the exact target in
`connections`; the current card's `connection` describes an admitted operation.
Target removal and account-list removal do not prove that the attempted command
succeeded. Remember a confirmed end of that View attempt if the target returns,
while displaying current wallet facts and allowing a new explicit selection.
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
Show normal initialization neutrally. Connect owns connection, approved-address
selection and exact-target disconnection; it has no Wallet service help section
or service-restart control. Normal disconnected manage shows Connect wallet;
opening manage never starts pairing. In `connectionConflict`, show each target
and its Disconnect control in the main content, including enough identity to
distinguish equal names or addresses. Hide account-use and review/signing
controls until the backend reports a unique usable connection.

The local confirmation stage describes presentation, not authority. Inform the
common lifecycle when opening or leaving a disconnect confirmation so it applies
current guidance and input locks to the new controls. Back cannot cancel a sent
command, unlock another action, discard its error or resend it. Preserve the
same View and opened Details during unchanged state reads; disposed callbacks
cannot alter its replacement. Normal display changes do not postpone required
backend state reads.

Connection-service recovery belongs to Settings/Troubleshooting and requires
explicit user preparation/confirmation of the affected SDK run and requests.
Connect/Review explain that path when recovery is relevant; they do not host
service-restart controls. Normal QR approval or initialization is not a failure
diagnosis. An uncertain command first offers its same-request status check.
If the parent/Settings is unavailable or a parent endpoint/installation change
must apply, explain the setup guide's stop/reopen procedure for the shared parent. Child restart
never implies remote disconnection, connection approval or chain outcome.

Settings separates ordinary Read address, Local records and Troubleshooting
from Advanced endpoint controls. Show operation impact and errors in the body;
technical values use the existing Details disclosure. Each card owns one
operation and its stored result. Preview, Back, chat navigation and state reads
do not apply settings, create another file or restart the SDK. A valid sealed
upload remains available for a new Preview after preparation invalidation;
explicit file change uses the backend selection action. Validation rejection
retains the actual current card and a usable correction/selection path.

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
offers status observation, not another save, Host retry or cancellation. A
failure recorded as `not_published` can offer Retry save within the original
period; an uncertain result offers only Check status. State, authority, expiry,
navigation and controls use the same current projection. Recorded saving and
temporary cleanup remain separate facts, including when cleanup fails.

Results distinguish snapshot preparation, Host-reported delivery, temporary
cleanup and actual user file storage. Suggested file name is not a confirmed
save location. Host acknowledgment ends server retention but is not proof of a
saved file; isError does not classify cancellation, denial or failure. Lost
responses are unconfirmed. An explicit retry uses the same verified snapshot
within its fixed transfer period and warns when a prior request may already
have been handled. Frame recreation and state reads never download again.
Cancel download ends further transfer and cleans the temporary snapshot; it
cannot close a Host dialog or delete a saved user file. A new frame needs an
explicit retry, and a server restart ends the old transfer. An already-admitted
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
Existing saved backup results retain their recorded facts;
their public files are not removed by temporary cleanup.

Incomplete cleanup offers Check status for the same operation. Cleanup includes
settlement of that operation's ended I/O reservation and waits for its actual
file reads/writes to end. A stored result remains readable while settlement is
retried; it does not release another operation's running I/O. Reading a recorded
Host report resolves a lost reply without sending the file again.

Local-data counts describe the backend state at the time they are read. A later
replacement warning must not use a stale count, especially zero, as an assurance
that no unconfirmed transaction records will be deleted. Warn that replacement
can remove those records and cannot cancel a transaction on Sui.
The private connection-service journal remains; Reset does not claim that the
SDK is empty or grant a new pairing. Connect controls use backend
`manageableConnectionIds`, separately from `usableConnectionId`. Unrecorded SDK
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

All six cards, including Review management, adapt to the embedded frame width.
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
| Account address / Selected account / Reviewed account / Sender / Receiving account / Affected account | Query `account`, `activeAccount`, `review.account`, receipt `sender`, recipients and balance-change addresses | Query target, current selection, bound review and transaction roles; none is wallet authorization |
| Ready for your review / Review needs updating / Review blocked | `ready_for_wallet_review` / `refresh_required` / `blocked`, displayed through `REVIEW_UI_LABELS` | Computed review information, not current permission to request a signature |
| Transaction succeeded/failed on Sui | Verified `execution.status` / receipt `effectsStatus` | Independently observed chain outcome, not a completed tool call or wallet response |
| Check status / Retry review / Check transaction result | `ui_read_card` or public saved resource / `prepare_review` / `read_result` | Read this card, recompute permitted review details, or observe the existing transaction; none requests a signature |
| Retry connection / Request wallet approval | `connect` / `request_signature` | Explicit connection retry versus a permitted request for wallet approval; actual wallet approval is still required |
| Continue review | `prepare_review` after the View's local pause and a fresh target check | Explicitly continue review updates; it does not authorize signing |
| Stop connecting / Stop approval request / Stop checking result | `stop_connection` / `stop_waiting` in `awaiting_signature` / `stop_waiting` once submission has started | End pairing, remove this approval request's submission permission, or stop result observation; the last cannot cancel a submitted transaction |
| Cancel review / Back | `cancel` / local confirmation-view navigation | End unsubmitted review input versus leave a confirmation screen without a backend action |
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
confirmation. Connection instructions distinguish recorded connections, pending
work and unavailable wallet state; an empty recorded list during unavailability
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
   result; stored request state is not a second outcome. Settings preview and
   confirmation requirements are unchanged.
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
