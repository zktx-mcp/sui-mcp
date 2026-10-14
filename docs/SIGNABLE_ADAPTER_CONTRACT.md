# Signable Adapter and PTB Visualization Contract

This document defines the contract boundary for wallet-review adapters.
It is a product and implementation contract, not a current feature announcement.

The backend builds local account-bound DeepBook transaction material and
binds its Sui digest to verified review evidence. Only explicit user selection
and wallet approval allow the backend WalletConnect request. Returned bytes and
signer must match the admission before submission. No model or card receives
transaction bytes or signatures.

The source-level schema for this contract lives in
`src/core/action/signableAdapterContract.ts`.

## Current Status

The contract schema is implemented in TypeScript and Zod, and the runtime
DeepBook account-bound swap reviews emit it. When an account-bound review
completes every evidence stage (local unsigned transaction material, internal
digest commitment, object ownership, quote/policy provenance, human-readable
review facts, and review-time simulation), the review layer assembles those
private artifacts into a schema-validated `TransactionReviewData` and
records it on the public review state as `transactionReviewData` on a
`ready_for_wallet_review` status. If any required evidence is
missing or fails contract validation, no contract is emitted and the review
stays blocked with `blockedReason: "wallet_review_contract_emit_missing"`.

If that stored failure's private evidence later becomes invalid, current state
retains the failure reason and stage provenance with `evidenceValidity:
"invalidated"` and removes the material-derived public summaries. Fresh
computation still validates every required summary; invalidation does not permit
a ready contract or wallet admission. Earlier recorded snapshots remain history.

`reviewedTransactionDigest` is a hash only. Private bytes travel directly from
the backend to the wallet through WalletConnect after atomic admission; there
is no browser handoff endpoint. The adapter contract itself never signs or
executes. The platform owns request authority and verified chain outcomes.

## Final Acceptance Gate

This contract defines the data checks required before wallet admission; it does
not authorize a signature request. The current backend WalletConnect workflow
requires an explicit permitted Review card action and approval in the wallet.
The term signable adapter identifies this transaction-review contract, not a
claim that every displayed proposal is eligible for signing.

The gate binds three views of the action to one transaction commitment, so a
user cannot sign something different from what they reviewed:

- The commitment is a digest (hash) of the exact serialized transaction bytes
  that will be signed, represented as the Sui transaction digest. The commitment
  is a hash only; raw transaction bytes remain a prohibited output and must never
  appear in MCP or review responses.
- `humanReadableReview` must be derived from the transaction identified by that
  commitment.
- The review-time `simulation` must have been run against the transaction with
  that same commitment.
- Any bytes handed to the wallet must hash to that same commitment.

The acceptance criterion is strict equality: review-commitment equals
simulation-commitment equals handoff-commitment. If any is missing or differs,
the contract is invalid and signing stays blocked.

### Transaction byte lifecycle (closes the handoff loophole)

The signable bytes must have exactly one origin and one handoff path, so an
adapter cannot display a commitment while signing different bytes through a side
channel:

- Origin: the bytes are produced only inside Sui MCP's review layer (the
  signable adapter), from material Sui MCP independently built or verified.
  They are never accepted from an external MCP or AI-client proposal.
- Storage: the bytes live only in the local review-server session keyed by
  `reviewSessionId`. They never appear in an MCP tool response or in the
  review-API JSON an AI client reads; those surfaces carry the commitment hash
  only.
- Transport: the only byte path is the private backend to the wallet through
  its approved WalletConnect session. No browser signer or MCP response carries
  bytes or signatures.
- Binding: before requesting a signature, recompute the stored bytes' digest
  and require equality with both reviewed producers. Verify the returned bytes'
  digest and selected account's signature again before one backend submission.
- Admission: one request per review session/revision, consumed atomically with
  the card selection and public history. A different card cannot duplicate the
  request. Recomputing while signature/submission callbacks or initial chain
  observation remain unsettled is refused. Local timeout or stop does not prove
  remote cancellation or callback cleanup.
- Results: request status and chain success/failure are separate. Unknown
  outcomes retain the known digest and may be read again, never resubmitted.
  A later explicit reviewed revision has a new attempt while prior facts remain.

DeepBook swap material is built with an explicit fee mode. When the account's
DEEP balance covers the protocol fee, the swap quotes and builds in DEEP fee
mode; otherwise it re-quotes through the protocol's input-fee dry run and
builds with an explicit zero-DEEP coin so the taker fee is paid from the
source coin at the protocol penalty. The selected fee mode is recorded as
review evidence and shown as a check. Before building, the producer verifies
the account holds the source amount plus the explicit gas budget and fails
closed with the exact required and held amounts.

This gate is enforced at the contract-schema layer. `transactionReviewDataSchema`
requires a `reviewedTransactionDigest` (the Sui transaction digest of the
transaction that will be signed, validated with the pinned SDK source of truth
`isValidTransactionDigest`; a digest only, never raw bytes) and binds
`humanReadableReview.transactionDigest` and `simulation.transactionDigest` to it
through a `superRefine` invariant (reusing the `requireEqual` cross-field helper)
that rejects any contract whose three commitments are missing, malformed, or
unequal (`src/core/action/signableAdapterContract.ts`,
`test/signableAdapterContract.test.ts`).

The private `prepareReviewedTransaction` session-store operation verifies stored
material and the reviewed digest. `WalletWorkflow` and its SQLite owner admit
the exact account/revision, verify wallet response bytes and signature, submit
once and record independently read receipt facts. Public output never gains
signing authority. Internal preparation is distinct from final user admission.

## Adapter Contract

A wallet-review adapter that returns this contract must regenerate or
independently verify action material inside Sui MCP before any wallet
handoff exists. External MCP or AI-client proposals remain untrusted structured
input and cannot become transaction-building authority.

The adapter contract requires these fields:

- `inputProvenance`: where the request came from, when it was captured, and why
  it remains untrusted until the local review layer regenerates and verifies it.
- `sourceReferences`: source metadata for pinned SDK registries, verified mainnet
  onchain metadata, wallet reads, quote evidence, simulation, validated request
  facts, or explicit user choices. A `sourceReferences` record is not itself a
  value-bearing fact. It identifies where a typed evidence claim came from.
- `evidenceClaims`: typed value-bearing claims for every safety-critical fact
  used by the payload. Each claim has a `factKind`, a `sourceEvidenceId` pointing
  to `sourceReferences[].id`, and the value fields required for that fact. The
  schema validates the claim against the safety-critical fact matrix and then
  validates that payload fields match their referenced claim values.
- `rawQuantities`: raw integer strings plus normalized Sui coin type, verified
  decimals, and unit source. `amountClaimId` must point to a
  `raw_quantity_amount` claim whose role, raw amount, and normalized coin type
  match the payload. Unit `unitClaimId` must point to a `unit_metadata` claim
  whose decimals, normalized coin type, and metadata source match the payload.
  Display amounts remain presentation-only.
- `gas`: review-time simulation evidence for gas quantities or a concrete
  unresolved reason. `gasBudgetRaw` and `gasUsedRaw` must point to
  `raw_quantity_amount` claims with `gas_budget` and `gas_used` roles, the Sui
  gas coin type, and raw MIST units. An unresolved gas status must point to a
  `gas_unresolved_status` claim. Gas object ownership must point to
  `object_ownership` claims whose ownership status is `owned_by_account`.
  `gasUsedRaw` is the nonnegative net simulation cost. If storage rebates exceed
  costs, omit this optional unsigned quantity and its claim; do not clamp it to
  zero. The verified gas budget remains available, and the review simulation
  retains the exact cost/rebate components and signed balance changes.
- `expiry`: review-time expiry status. `current` and `expired` require
  `checkedAt`, `expiresAt`, and `evidenceClaimId`; `current` requires
  `expiresAt` after `checkedAt`, and `expired` requires `expiresAt` at or before
  `checkedAt`. The referenced `expiry_status` claim must match the payload and
  must reference a `sourceReferences` record with `checkedAt` and `expiresAt`.
  `not_provided` and `not_applicable` must omit `expiresAt`, include
  `evidenceClaimId` and `reason`, and reference an `expiry_status` claim backed
  by `checkedAt` and `expiryStatus`.
- `slippageOrMinOut`: quote-linked max slippage and minimum-output policy when
  quote evidence is used. `quoteEvidenceClaimId` must point to a `quote_min_out`
  claim whose `quoteEvidenceId` and `minOutRaw` match the payload.
  `policySource: "user_explicit"` requires a separate `policyEvidenceClaimId`
  pointing to a `slippage_policy` claim backed by `user_explicit_choice` fields
  including `maxSlippageBps` and `userSelection`.
  `policySource: "adapter_policy_from_quote_evidence"` requires
  `policyEvidenceClaimId` pointing to a `slippage_policy` claim backed by quote
  evidence fields including `maxSlippageBps` and `minOutRaw`. If `minOutRaw` or
  `maxSlippageBps` appears in the payload, it must have the matching typed claim;
  stale or missing status does not make an unclaimed scalar safe to use.
  `minOutRaw` must also match a `rawQuantities[]` entry with role
  `minimum_output` so the raw integer has normalized coin type and verified
  decimals.
- `objectOwnership`: account-bound object ownership or shared-object facts. Each
  object must point to an `object_ownership` claim whose object id, owner account,
  and ownership status match the payload.
- `simulation`: the public Sui gRPC `transactionExecutionService.simulateTransaction`
  with validation checks enabled, identical returned transaction BCS and matching
  effects digest. The required normalized evidence fields are `effects`,
  `balanceChanges`, `objectTypes`, and `transaction`. The simulation payload must point to a `simulation_result`
  claim whose provider, status, required fields, missing fields, and failure
  reason match the payload.
- `humanReadableReview`: the fields a human must see before wallet
  authorization, matching the review-model concepts already exposed for
  non-signable proposal review.
- `outputBoundary`: the MCP and review UI exposure limit. Human-readable review,
  PTB visualization artifacts, diagnostics, and status checks are allowed.
  The required prohibited set is executable transaction material, serialized
  transaction material, wallet signature requests, private-key material, wallet
  authorization, signing data, signing readiness, and payment execution
  readiness. Each contract must include the whole prohibited set.

## Safety-Critical Fact Matrix

`SAFETY_CRITICAL_FACT_MATRIX` in `src/core/action/signableAdapterContract.ts`
is the contract's validation source of truth.

It defines the required source kind and source fields for these fact kinds:

- `raw_quantity_amount`, keyed by role: input, expected output, minimum output,
  gas budget, gas used, fee, and balance delta;
- `unit_metadata`, keyed by metadata source;
- `gas_unresolved_status`;
- `expiry_status`, keyed by status;
- `quote_min_out`;
- `slippage_policy`, keyed by policy source;
- `object_ownership`;
- `simulation_result`.

Payload fields do not cite `sourceReferences` records directly as proof. They cite
typed evidence claims, and those claims cite `sourceReferences` records. The schema
rejects payload values that do not match their typed claims.

## Consumer Invariant Matrix

`CONSUMER_INVARIANT_MATRIX` in
`src/core/action/signableAdapterContract.ts` defines extra requirements for
payload fields that consume typed claims. It is separate from
`SAFETY_CRITICAL_FACT_MATRIX`.

`SAFETY_CRITICAL_FACT_MATRIX` answers whether a typed claim has the required
source kind and source fields. `CONSUMER_INVARIANT_MATRIX` answers whether that
claim is valid for a specific payload use.

Current consumer invariants are:

- `gas.gasBudgetClaimId` must reference a `raw_quantity_amount` claim with role
  `gas_budget`, matching raw amount, and Sui gas coin type. The raw unit is MIST.
- `gas.gasUsedClaimId` must reference a `raw_quantity_amount` claim with role
  `gas_used`, matching raw amount, and Sui gas coin type. The raw unit is MIST.
- `gas.gasObjects[].ownershipClaimId` must reference an `object_ownership` claim
  with matching object id, matching owner account, and
  `ownership: "owned_by_account"`.

The current contract does not prove that a gas object is a `Coin<SUI>` object
type because the object-ownership claim does not carry object type evidence.
An adapter must not use object ownership alone as gas coin type evidence.

## PTB Visualization Artifact

The PTB visualization contract is for explaining a locally generated
transaction shape before wallet authorization. It is not wallet handoff.

The artifact may contain:

- `generatedAt`;
- `source`, including adapter id, plan id when available, source kind, renderer
  name, package name, and version;
- Mermaid `flowchart` text;
- diagnostics from the adapter, renderer, schema, or simulation;
- `unsupportedUse`, including transaction-building input, wallet authorization,
  signing data, signing readiness, payment execution readiness, and route
  recommendation;
- `executableMaterial.included: false`.

The artifact must not contain executable transaction material. Mermaid text and
diagnostic messages are screened for executable-material terms and long encoded
payloads.

## PTB Renderer Status

The pinned renderer dependency is `@zktx.io/ptb-model@0.5.0`. The review layer
converts the stored local transaction material into a Mermaid `flowchart`
artifact with `rawTransactionToIR` and `transactionIRToMermaid`, only after the
stored bytes are recomputed to match the bound transaction material commitment;
a mismatch declines the artifact. The graph is decoded from the stored transaction bytes with no AI or model input in the rendering path, so it reflects the decoded transaction the wallet will receive, not an AI description of it. The artifact passes
`ptbVisualizationArtifactSchema` screening before exposure and accompanies the
emitted wallet review contract as `reviewState.ptbVisualization`. PTB
visualization stays visualization-only evidence: it is not a runtime
transaction builder, not wallet handoff, and not a signing-readiness surface.

The producer emits the Mermaid flowchart as two parallel streams. `mermaid.text`
keeps raw package addresses for audit and copy. `mermaid.namedText` is a second
relabeled stream produced by `applyContractNamesToMermaid`
(`src/core/action/ptbVisualizationProducer.ts`,
`src/core/action/contractNameRegistry.ts`): it labels registered packages
(`@deepbook/core`; the Sui framework `std`/`sui`/`sui_system`) and well-known
objects (`SuiSystemState`, `Clock`, `Random`, `DenyList`, `CoinRegistry`,
`AccumulatorRoot`) while keeping the raw addresses available. These names are a
display label, not a safety, ownership, or trust signal, and the renderer does not perform a fresh Move Registry lookup or verify
current package identity from a display label.

## Adapter Registration And Stage Vocabulary

Review adapters register through `ReviewAdapterDescriptor` entries in
`src/adapters/reviewAdapters.ts` (`buildSupportedReviewAdapterDescriptors`).
A descriptor supplies the adapter id, protocol, action kind, stage catalog id,
and the evidence computer; action-plan factories live in the adapter module
and are wired by the MCP layer. The platform keeps the
safety gates non-delegable: the typed evidence claim matrices, the commitment
equality gate, the adapter lifecycle validator registry
(`src/adapters/adapterLifecycleValidators.ts`), and the digest-gated byte
handoff all run outside adapter code. `src/core` contains no adapter imports;
a source-policy test enforces that boundary.

Stage vocabulary is a cross-adapter contract. Every stage catalog that reports
public review evidence must use these stage ids for these concepts, because the
core review-state schema binds public fields to them:

- `transaction_material_build_or_verify`: local unsigned material exists.
- `digest_commitment`: the Sui transaction digest is bound to the material.
- `object_ownership`: object ownership evidence is verified.
- `human_readable_review`: required before `reviewState.humanReadableReview`.
- `review_time_simulation`: required before `reviewState.simulation`.

Adapter acceptance gate: a new protocol enters as read-only tools or
non-signable proposal review first. A signable adapter is accepted only when it
produces every required evidence stage from independently built or verified
material, passes `transactionReviewDataSchema` without placeholder
values, and fails closed when any evidence is missing. Protocol names stay out
of public docs, runtime guidance, and MCP resources until a concrete
implementation or support decision exists.

## Verification

Tests must keep this contract in place before any adapter can use it:

- schema tests for required provenance, source-of-truth, raw quantity, gas,
  expiry, slippage or minimum output, object ownership, simulation, and
  human-readable review fields;
- tests that reject duplicate `sourceReferences[].id` and `evidenceClaims[].id`
  values;
- tests that reject every payload claim reference that does not resolve to a
  typed `evidenceClaims[].id`;
- tests that reject every `evidenceClaims[].sourceEvidenceId` that does not
  resolve to a `sourceReferences[].id`;
- tests that reject safety-critical claims whose source references resolve to the
  wrong source kind or to records missing the required fields for that claim;
- tests that reject payload values whose raw amounts, decimals, gas quantities,
  expiry values, minimum output, slippage policy, object ownership, or simulation
  status do not match their typed evidence claims;
- tests that reject metadata-only records as raw amount evidence and reject
  user-explicit slippage policy claims without explicit user-choice evidence;
- tests that reject raw signable quantity assets without normalized Sui coin
  types;
- tests that reject min-out or slippage scalar fields when they do not have typed
  evidence claims;
- tests that reject `minOutRaw` when it does not match a `rawQuantities[]` entry
  with role `minimum_output`;
- tests that require `gasBudgetRaw` and `gasUsedRaw` to use
  `raw_quantity_amount` claims with gas roles, the Sui gas coin type, and raw
  MIST units, or require unresolved gas status to use a `gas_unresolved_status`
  claim;
- tests that reject gas object references backed by object-ownership claims whose
  ownership status is not `owned_by_account`;
- tests that require every mandatory prohibited output boundary and every
  mandatory PTB unsupported-use boundary;
- tests that reject `current` or `expired` expiry status without timestamp
  evidence, source evidence, matching source fields, and the required
  `checkedAt`/`expiresAt` time relationship;
- tests that reject `not_provided` or `not_applicable` expiry status when it
  includes an `expiresAt` timestamp or omits the reason and source evidence for
  why timestamp evidence is unavailable;
- tests that require failed or unavailable simulation evidence to include a
  concrete `failureReason`;
- tests that reject display amounts, exponent notation, or floating-point values
  as raw quantities;
- tests that reject PTB visualization artifacts containing executable-material
  terms or long encoded payloads;
- MCP/review output tests using the shared forbidden-field-name policy;
- documentation tests that keep PTB visualization described as visualization
  only, not transaction material, signing readiness, or payment execution
  readiness.

## Transaction funding and ownership

The supported swap adapters retain the SDK's coin-object and address-balance
selection. The private ownership evidence verifies the stored transaction's
sender, gas payer, real object references, address withdrawals, and gas funding
against the reviewed account and verified mainnet source. The same description
must match the checks-enabled simulation and the material rechecked for admission.

An empty gas payment array means address-balance gas; it is not missing gas
evidence. It requires a mainnet-bound ValidDuring epoch window and address SUI
covering both explicit SUI withdrawals and the gas budget. A gas reservation
reference is an address-balance reservation, not a Coin<SUI> object. Its account,
asset, chain, amount and epoch are verified; any real gas coins alongside it
retain their ownership/type checks. Explicit address withdrawals and reservations
are summed per coin type without counting the gas budget twice. Observed balances
are review-time facts, not locked funds or execution guarantees.

Only real gas coins produce `gas.gasObjects` and object-ownership claims. The
public optional field remains absent when no such objects are used. Private
funding evidence is required in either case; omitting all funding checks does not
produce a valid review. The existing human review evidence explains the funding
form without publishing private artifacts or creating signing authority.

Different gas owners, sponsor withdrawals, unsupported reservation formats, and
unverified funding remain blocked. Supported adapters still require the same quote,
amount, ownership, human review, simulation, wallet approval, and digest checks.

The current review producer uses `client.transactionExecutionService.simulateTransaction`.
A stored public record identifies the provider that produced its evidence; reading
that record does not select a simulation fallback or create new funding proof.
Returned BCS is compared privately and is never added to evidence, cards, backups or logs.
