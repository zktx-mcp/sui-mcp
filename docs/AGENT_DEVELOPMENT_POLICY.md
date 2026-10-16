# Agent Development Policy

This document contains binding development, review, documentation, and
source-of-truth policies for coding agents working in this repository.

Read `AGENTS.md` first. Read this document whenever the task touches a boundary
listed under `Required Detailed Policies` in `AGENTS.md`. These rules are not
optional guidance and must not be weakened to make a task easier.

## Repository Map

Target repository structure:

- `src/core/`: action-neutral intent, plan, review check, and result primitives.
- `src/core/evidence/`: natural-language intent evidence helpers and
  evidence-boundary primitives.
- `src/adapters/`: protocol-specific adapter implementations. Shared review,
  material, ownership, simulation, acceptance, and handoff contracts should stay
  protocol-agnostic unless a concrete implementation proves otherwise. DeepBook
  is the current signable swap adapter implementation; additional
  protocol support must be added through adapter contracts rather than a
  custom-only product path.
- `src/mcp/`: MCP server and tool definitions.
- `src/review-server/`: loopback HTTP routing and Host/Origin checks; no public
  browser page or Settings mutation API.
- `review-app/`: shared card display helpers/styles; no external Settings page.
- `src/mcp-ui/`: internal Account, Receipt, Chart, Connect, Disconnect, Review and Settings cards, their
  common lifecycle and view code.
- `src/runtime/shared/`: authenticated server ownership and MCP forwarding.
- `registry/`: local policy, allowlists, aliases, and generated mainnet metadata.
- `protocols/`: AI-readable protocol notes.
- `scripts/`: utility scripts for state inspection, registry generation, and
  reports.
- `docs/UTILITY_INDEX.md`: index of reusable utility scripts.
- `.WORK/`: local planning notes; ignored by Git.

Inspect the actual repository before assuming any path exists. If the
repository differs from this map, the repository is the current fact and this
section should be updated when the difference is intentional.

## Communication Rules

- Answer with verified facts and concise conclusions.
- Do not waste tokens on excuses, filler, or unsupported speculation.
- Concise means selective, not truncated. Do not abbreviate content, terms, task
  names, or status wording in documents, reports, or discussion when the
  abbreviation can change, narrow, or obscure the meaning.
- State uncertainty plainly when evidence is incomplete.
- Separate facts, assumptions, and recommendations.
- When work is missing, incomplete, removed, weakened, or previously overstated,
  state that concrete fact directly. Do not relabel it as alignment, cleanup,
  simplification, consolidation, follow-up, or a harmless tradeoff when the
  verified fact is that required behavior was not implemented or was narrowed.
- Use status labels and progress reports only when they name the actual state.
  `blocked` must identify the blocking condition, `unverified` must identify the
  missing verification, and a progress report must name completed subtasks and
  remaining requirements. Do not use `partially complete` as a success state.
  These labels and reports must not soften a defect, downplay a missed
  requirement, or support a completion claim when completion criteria are unmet.
- A scoped unit of work has no partial-success state. Progress can be reported by
  naming completed subtasks, but that progress is not task success. The unit
  succeeds only when every required behavior is implemented, every required
  cleanup is done, and every verification point passes. Otherwise report the
  unit as not complete and name the concrete blocker, missing requirement,
  failed check, or unverified requirement.
- Do not hide a defect to preserve momentum or protect prior work. If a previous
  answer, plan, review, or commit claimed completion incorrectly, correct the
  record explicitly.

## Documentation Review

When editing `AGENTS.md`, `README.md`, files under `docs/`, files under
`protocols/`, or runtime-facing instruction and limitation text such as
`src/mcp/serverInfo.ts`, do a first-reader pass before calling the work complete.

Read the changed document as if you are a new agent or human with no prior
conversation context. Verify that it communicates:

- the product purpose or user problem the document supports;
- what is implemented, planned, unsupported, or intentionally out of scope;
- the authority and boundary of every tool, workflow, protocol term, number,
  policy, or product claim it mentions;
- what the reader should do, and what they must not infer.

Separate current implementation, planned future capability, current-release not-yet-implemented behavior, and permanent no-goal statements. Do not place all four
categories under wording such as "not yet possible" or "planned boundary" when
that wording could make a permanent no-goal sound like a roadmap item, or make a
planned future capability sound permanently unsupported.

Public and runtime-facing documents must describe current product behavior,
current tool contracts, and current unsupported boundaries only. Do not include
implementation history, prior states, migration history, decision history,
planning rationale, or "why we changed this" notes in README, `docs/`,
`protocols/`, runtime instructions, MCP resources, tool descriptions, or
user-facing strings. Keep that history in ignored `.WORK` notes.

Public examples, screenshots, release material and routine work reports must
not expose complete real wallet account addresses, including test accounts.
Use shortened addresses for presentation and deliberately synthetic account
values for new or revised executable examples and fixtures. Remove linked
transaction identifiers or encoded address inputs from public examples when
they reveal the same real account. Keep illustrative data clearly labelled;
do not present synthetic data as observed mainnet evidence. Show a complete
real account address in a work report only when the user explicitly requests
it. These publication and reporting rules do not change runtime API fields,
exact account bindings, onchain evidence or transaction-target verification.

Reviewed English development records may live under
`submission/ethglobal-tokyo-2026/`, with translations and retrospective summaries
labelled as such. That directory is not product guidance, is never registered as
an MCP resource, and is excluded from npm packages. This does not permit
development history in product/runtime documents or change `.WORK`'s role as
ignored working material.

If the intended meaning depends on prior chat, hidden context, vague shorthand,
or local assumptions, rewrite it.

Remove wording that is ambiguous, overly broad, contradictory, likely to make a
reader overclaim product support, skip required verification, or optimize for
size instead of quality.

Write and review documents so a third-party reader with no Sui MCP
background can understand and use the content without guessing.

Use ordinary industry terms when they exist. Do not introduce project-specific
terms, internal shorthand, or product labels when a plain description can say
the same thing. If such a term is unavoidable because it is an existing API
field, type name, command, or documented product surface, define it in plain
language at first use and state exactly what it does and does not mean.

Do not use words whose meaning can change based on when the reader sees them,
which previous conversation they remember, or which nearby paragraph they
connect them to. Replace context-dependent wording with explicit source, time,
state, actor, tool, field, and unsupported-use statements.

Do not rely on phrases that invite the reader or an AI client to fill gaps with
imagination, such as unexplained "policy", "boundary", "gate", "support",
"coverage", "readiness", "evidence", or "review" wording. Either replace the
phrase with a concrete description or define the exact source, allowed use, and
unsupported use.

For MCP-facing documentation and runtime guidance, assume the connected AI
client may follow wording literally. Prefer concrete tool names, response
fields, and allowed conclusions over abstract warnings. If the document says an
AI must not use a value for a conclusion, also identify the field that should be
used instead.

## Documentation Ownership

Use this single responsibility schema when editing documentation:

| Document | Owns | Must not own or claim |
| --- | --- | --- |
| `README.md` | Public first-entry document for product purpose, current release boundary, setup path, and documentation map. | Detailed tool contracts, user-question workflows, internal planning history, or release-review matrices. |
| `AGENTS.md` | Root development contract and non-negotiable product boundaries for coding agents working in this repository. | User setup instructions, feature catalogs, runtime-only AI-client answer behavior, or long-form policy details. |
| `docs/AGENT_DEVELOPMENT_POLICY.md` | Detailed binding development, review, documentation, source-of-truth, and completion policies for coding agents. | User setup instructions, MCP API contracts, user-question playbooks, or runtime-only AI-client answer behavior. |
| `docs/MCP_SETUP.md` | Installation, MCP client connection, first-use flow, local settings, and troubleshooting. | Long API behavior rules, field contracts, response wording rules, or user-question playbooks. |
| `docs/MCP_TOOLS.md` | MCP API reference for tool contracts, response fields, statuses, follow-up fields, and output boundaries. | Installation procedures or user-question playbooks. |
| `docs/AGENT_BEHAVIOR.md` | Answer playbook for user-question flows, tool selection, and response wording. | Tool schemas, field contracts, response-field definitions, or install procedures. |
| `docs/WALLET_CONNECTION.md` | Approved wallet connections, active-account read context, private SDK persistence and the distinction between connection and per-transaction approval. | Login, authentication, custody, authority to approve a transaction, full review/API contracts or setup ownership. |
| `docs/TRANSACTION_ACTIVITY_LOG.md` | Local transaction activity storage, scan, and summary boundaries. | Complete wallet history, P&L, route recommendations, transaction-building input, signing data, or signing readiness. |
| `docs/UTILITY_INDEX.md` | Manual utility and source-checkout script boundaries, including the distinction between utilities, MCP tools, and packaged product commands. | Promotion of utility scripts as MCP tools, review-time simulation, packaged product commands, transaction builders, signing-readiness signals, or wallet authorization evidence. |
| `docs/LOCAL_DB_ARCHITECTURE.md`, `docs/SDK_API.md`, and other architecture or evidence notes | Specific implementation boundaries, pinned source facts, storage facts, and source-verification notes. | Future support presented as current product functionality. |
| `docs/FRONTEND_POLICY.md` | Review-app frontend implementation policy and local UI boundary rules for coding agents. | Backend API contracts, MCP tool contracts, or user setup flow ownership. |
| `docs/golden-scenarios/*.md` | Release-review scenario matrices, golden answer shapes, allowed conclusions, and forbidden conclusions. | MCP API contracts or replacement definitions for response fields. |
| `protocols/*.md` | Protocol references and promotion-gate research notes only. | Runtime registries, supported-protocol lists, live liquidity sources, route recommendations, signing-readiness signals, or support declarations. |
| `submission/ethglobal-tokyo-2026/` | Reviewed English development records for the approved external delivery. | Product rules, runtime guidance, MCP resources, or npm package contents. |
| `.WORK/` | Ignored local planning notes. | Product-facing rules unless moved into README, AGENTS, docs, protocols, tests, or code comments. |

Do not remove all repetition. These repeated boundaries are allowed when they
protect readers on separate surfaces:

- the top-level boundary against autonomous execution, private-key signing or
  custody, venue ranking, route choice, silent settlement-token selection, fiat
  cash-out, P&L and signing-readiness claims; user-approved wallet signing and
  independently verified backend submission are distinct supported operations;
- the core answer path that `read_preview_intent_evidence.responseSummary` and
  response-local `userAnswerUse.answerFields` identify fields for
  USD-denominated coverage, balance-total, and shortfall answers;
- the safety rule that separate DeepBook quote outputs are price estimates and
  must not be combined into payment coverage or shortfall conclusions.

Do remove or rewrite duplication when it creates conflicting authority:

- The API reference and answer playbook must not define the same tool contract
  in different words. Tool contracts belong in the API reference; question flows
  belong in the answer playbook.
- API field meanings must not be reinterpreted in prose. If a document says a
  field cannot support a conclusion, it must name the response field that should
  be used instead when one exists.
- Protocol Markdown must not read as a runtime registry, supported-protocol
  list, live liquidity source, route recommendation source, or signing-readiness
  signal.
- Setup documentation must not copy long API behavior rules. It should link to
  the API reference and answer playbook after the first-use setup flow.

## Instruction Surface Ownership

Keep development-time rules separate from MCP-injected agent guidance.

Development rule surfaces are for contributors and coding agents changing the
repository.

They include `AGENTS.md`, `docs/AGENT_DEVELOPMENT_POLICY.md`, implementation
notes under `docs/`, release-review matrices, protocol research notes, tests,
and ignored `.WORK/` planning notes.

They may define product invariants, implementation discipline, review criteria,
and release gates. Clients do not reliably read them at runtime.

MCP-injected or runtime-facing agent surfaces are what connected AI clients can
actually discover through the server.

They include:

- `SERVER_INSTRUCTIONS` in `src/mcp/serverInfo.ts`;
- MCP prompts in `src/mcp/prompts.ts`;
- tool schemas and descriptions;
- MCP resources registered from `src/mcp/resources.ts`.

Runtime-facing resources currently include:

- `README.md`;
- `docs/MCP_SETUP.md`;
- `docs/MCP_TOOLS.md`;
- `docs/WALLET_CONNECTION.md`;
- `docs/AGENT_BEHAVIOR.md`;
- `protocols/deepbook-v3.md`;
- `protocols/deepbook-margin.md`.

When a behavior must influence AI client answers, put the actionable guidance in
a runtime-facing surface and guard it with tests.

`AGENTS.md` and this detailed policy may require that such a runtime-facing rule
exists. They must not be the only places where an AI client is expected to learn
user-answer behavior.

Keep tool descriptions concise, literal, and instruction-free. Use server
instructions, resources, prompts, schemas, output fields, and tests for behavior
guidance.

## Evidence Standard

Do not work from imagination or unchecked assumptions.

Before applying an external suggestion or plan:

- investigate the claim;
- check the current codebase, official docs, source code, or direct command
  output;
- separate verified facts from assumptions;
- explain the evidence behind the recommendation;
- do not apply the suggestion blindly.

For Sui, DeepBook, MCP, wallet behavior, transaction building, SDK behavior, and
dependency behavior, prefer official documentation, source code, and local
inspection over memory.

When official docs and the pinned installed SDK disagree, implementation must
follow the pinned SDK/source actually used by this repository. Document the
discrepancy.

## Planning And Scope

For non-trivial or boundary-changing work, compare alternatives before choosing
a direction.

Before implementation, identify:

- what prerequisite work should already exist;
- what must be inspected first;
- what alternative development directions are available;
- why the chosen direction is better for the current goal;
- what risks or scope traps should be avoided.

Plans must be grounded in confirmed objective facts. Distinguish current
implemented work from unimplemented expansion, and do not make unimplemented
possibilities look like supported functionality.

Before answering a status, planning, review-readiness, commit-readiness, or
next-task question, verify the same-turn disk facts that the answer depends on.
At minimum, inspect tracked status, unstaged/staged diff summary, changed file
names, untracked files, and the active roadmap or work note that owns the
canonical task name. Do not reuse a clean/dirty/tree-status statement from a
prior turn. If disk facts changed after a plan was written, treat the plan as
stale until reconciled.

For each specification-baseline requirement, identify the implementation surface
and verification point before claiming the plan is executable. During
implementation and final review, classify each baseline requirement as
implemented, missing, weakened, or unverified.

Do not silently drop, merge, rename, or weaken a baseline requirement because it
is inconvenient, cross-module, time-consuming, or already partly covered by docs
or tests.

Do not introduce generalized abstractions for aesthetics, symmetry, or future
possibilities before a concrete implementation proves that the verified boundary
needs them.

Do not use boundary control as an excuse to avoid necessary investigation. Do
not use broad investigation as an excuse to expand product authority, add
unrelated features, or delay a safe fix.

When a request points to a specific file, line, review comment, or symptom, do
not start by editing that spot. First inspect adjacent callers, callees,
schemas, docs, tests, user flows, failure modes, and shared invariants. If
inspection shows the pointed-at spot is the only affected boundary, state that
finding and keep the edit narrow.

## Development Discipline

For every task:

1. Inspect the current repository state first.
2. Identify affected files, modules, interfaces, user flows, and docs.
3. Check whether a source-of-truth implementation already exists before adding a
   function, type, script, adapter, or registry entry.
4. Reuse existing source-of-truth code when it exists. Do not create a parallel
   helper with similar responsibility unless the existing source is demonstrably
   wrong or too limited for the verified boundary.
5. Add new code only when no suitable source exists or the existing source is
   demonstrably insufficient.
6. Do not duplicate existing logic, registries, or protocol metadata without a
   clear reason.
7. Make the quality-first complete change that satisfies the goal after the
   affected boundary is understood.
8. After the change, re-check every affected area.
9. Run relevant checks, tests, builds, or manual verification when available.
10. Fix errors or regressions caused by the change before calling the work
    complete.

Function and program structure:

- Prefer simple, direct structure with locally understandable control flow and
  only the moving parts justified by the verified boundary.
- Use existing source-of-truth modules and established infrastructure when they
  already own the boundary.
- Add a helper or abstraction only when it names a real shared concept,
  preserves an invariant, or removes meaningful repetition.
- Avoid premature class hierarchies, generic frameworks, new registries, plugin
  layers, event buses, background schedulers, callback/subscription systems, or
  other coordination machinery unless the current verified requirement needs
  them, including failure paths, lifecycle cleanup, and observability.
- Simple never means hardcoded, temporary, case-specific, or test-only code.

## Review Discipline

The goal of review is defect discovery, not praise or consensus. Do not defend
an implementation; verify whether code, docs, tests, and product boundaries
actually agree.

- Report findings only, in priority order.
- Each finding cites a file and line as evidence.
- Mark speculation as speculation when the claim is not directly confirmed by
  code, tests, or pinned SDK source.
- Do not defer with "can be done later." If a defect can be fixed safely now
  within the current affected boundary, classify it as fix-now.
- Do not rely on existing tests passing as proof of correctness.
- When a defect is found, expand the search to callers, callees, and adjacent
  boundaries. Trace upstream until the shared rule, type, or invariant the
  defect violates is identified.

### Reduction Detection

When a change is framed as refactor, cleanup, alignment, simplification, or
documentation synchronization, check whether supported behavior, tool authority,
or a user-facing claim became smaller.

Inspect git history when tool names, response fields, status values, runtime
guidance, public docs, tests, golden scenarios, or supported-claim lists are
removed, renamed, or narrowed.

If history shows prior behavior, classify the current work as restoration,
replacement, or intentional removal before reviewing it as new functionality. Do
not accept "new feature" framing until the prior behavior has been accounted
for. If a removal is intentional, cite the user decision, issue, commit, or
source evidence that changed the requirement.

A passing test is not proof that the tested behavior is intended. For tests that
prevent unsafe or unsupported behavior, read the test body and state what it
prevents from returning before treating it as stale or necessary.

Documentation and tests can narrow together, so agreement between them is not
enough. Compare code, tests, docs, runtime outputs, and history across the same
boundary.

For `userAnswerUse` and golden-document tests, verify semantic polarity instead
of string presence alone. A test that reads a document fixture must distinguish
allowed-answer text from forbidden, diagnostic, or exclusion text, and it must
fail when required section markers are missing.

When findings reveal structural problems, describe how the feature would be
designed from scratch with no legacy constraints. Start from type dependencies
and explicit separation of boundaries and responsibilities.

## Implementation Integrity

- Do not hardcode values to bypass real validation, live integration, registry
  policy, or mainnet checks.
- Do not add temporary branches solely to satisfy one failing case.
- Do not manipulate tests, fixtures, generated files, snapshots, package
  metadata, or source files just to make checks pass.
- Test doubles, fixtures, placeholders, and config constants are allowed only
  when their scope is explicit and they are not presented as product
  functionality.
- Do not fake liquidity, quotes, transactions, wallet state, package IDs, or
  mainnet support.
- If technical debt remains, name it explicitly and explain why it is not being
  removed now.
- Prefer removing avoidable debt in the same change when it is safe and within
  the affected boundary.

## Numeric, Financial, And Protocol Honesty

Numeric and unit safety:

- Treat raw token amounts, display amounts, decimals, slippage, bps, quote
  quantities, min-out values, gas, and balance deltas as safety-critical data.
- Do not infer token decimals from token symbols, memory, UI convention, or
  common ecosystem defaults. Use a verified source of truth such as pinned SDK
  metadata or verified mainnet onchain metadata.
- Keep raw amounts as integer strings or `BigInt` values. Do not use floating
  point `number` arithmetic for token balances or signable quantities.
- Keep display amounts presentation-only and label them as display data. Do not
  feed display strings back into signing, quoting, or review-time simulation
  without an explicit raw conversion step.
- Formatting may strip trailing fractional zeros for readability, but it must
  not use exponent notation or silently round away raw precision.

Financial and protocol honesty:

- Treat every balance, quote, fee, rebate, stake, locked amount, price, route
  quantity, and derived value as financial information. It must have a clear
  source, unit, precision boundary, and product meaning.
- Derived numbers must be honest about how they were produced. Do not hide
  rounding, precision loss, simulation assumptions, registry lookups,
  display-only conversion, cache age, or unavailable raw amounts.
- Separate raw integers, display amounts, simulated values, indicative quotes,
  cached registry metadata, and live onchain state in types, docs, and
  user-facing explanations.
- Use protocol terms as the protocol defines them. For DeepBook and future DeFi
  integrations, prefer the pinned SDK source, official protocol documentation,
  verified smart contract source, or mainnet onchain evidence over invented
  wording.
- Do not rename, reinterpret, or simplify protocol concepts in a way that
  changes their meaning.
- If a protocol, SDK, or contract source does not define a term, quantity,
  status, or behavior clearly enough, mark it as unsupported, unavailable, or
  requiring verification. Do not fill the gap with imagination or confident
  prose.

## Stateful/API Change Protocol

For session, review, signing, MCP tool, HTTP endpoint, wallet, adapter, or other
stateful/API changes, do not start from the patch. Use this order:

1. Define the boundary being changed.
2. Write or inspect the relevant state and input combination table.
3. Decide the canonical source of truth.
4. Check response consistency across HTTP, MCP, store, browser, wallet, adapter,
   and docs as applicable.
5. Add or update tests for failure combinations.
6. Make the change.
7. Search for the same pattern with `rg` and inspect adjacent paths.
8. Run the relevant full verification before calling the work complete.

For non-trivial changes, record the matrix in `.WORK/` notes, the task report,
or tests. Do not rely on unstated intent.

Avoid case-driven exception stacking. When a bug appears as a specific case,
first ask which general boundary rule it violates. Fix the shared rule, mapper,
type, or invariant when possible instead of adding a case-specific branch for
that one case.

Required invariants:

- Store methods own state transitions. HTTP and MCP layers should map store
  results and errors, not reimplement transition rules.
- Public status fields must be derived through shared mapping code. Do not
  hand-map equivalent status concepts separately in HTTP and MCP.
- Idempotency checks must compare all identity fields needed for correctness,
  such as `reviewSessionId`, `planId`, status, and `txDigest`.
- A successful state-changing response must reflect the state actually stored
  after the operation.
- Do not leak session or domain details before token validation. After token
  validation succeeds, lifecycle and domain errors should be specific unless a
  different security decision is documented in code or tests.

Failure combinations are boundary-specific. For session/review work, include
wrong token, missing session, wrong `planId`, expired session, finalized session,
duplicate request, conflicting duplicate request, and mismatched action data. For
other boundaries, define the equivalent negative combinations before editing.

## Product Rules

- Treat AI reasoning and transaction authorization as separate concerns.
- Treat natural-language intent evidence and transaction construction as
  separate concerns.
- Do not pass executable transaction bytes from the MCP layer as trusted signing
  material.
- The review layer must regenerate and verify signable actions before wallet
  signing.
- The review layer exists to explain execution before authorization, not to
  guarantee safety.
- Review checks must use deterministic checks, not opaque AI risk scores.
- Use `Ready for your review`, `Review needs updating`, and `Review blocked` for review
  display states. These labels describe review information, not permission to
  request wallet approval or a guarantee of execution. Keep public state enums
  unchanged when editing display labels. Avoid language that implies absolute safety.
- Keep unsupported actions clearly unsupported. Do not add unimplemented intent
  types in code.
- Prefer read-only utilities before write actions when adding protocol coverage.
- Intent evidence reports are useful product outputs by themselves. Do not treat
  transaction creation or signing as required for a feature to have value.
- Do not ask users to speak in contract, function, coin type, or raw amount
  terms when a supported natural-language settlement asset group can be resolved
  from pinned SDK registry evidence.
- Do not silently choose USDC, USDT, or another settlement token for a
  USD-denominated user intent. Expose the supported settlement asset group
  evidence and required user choices.
- USD-denominated evidence checks require a runtime-facing preflight contract.
  AI-client guidance exposed through MCP instructions, resources, prompts, and
  tests must require `read_get_server_status` before USD-denominated coverage,
  balance-total, or shortfall answers.
- Ordinary MCP tools are evidence and card gateways. They may create review
  sessions and return internal cards, but model calls must not authorize
  signing or execution. Scoped app-only actions admit an exact user selection;
  the backend performs wallet I/O and verifies each resulting signature.
- Settings uses an internal card. Ordinary MCP may create that card or read
  settings. Only scoped app-only input with current card/operation/revision and
  explicit confirmation may apply a local change or restart the connection
  service. Shared HTTP Host/Origin checks and private transport authentication
  remain separate boundaries; no Settings URL or HTTP mutation fallback exists.

## Network Policy

Product specs, public docs, UX copy, product-facing AI/tool responses,
registries, and signable actions are mainnet-only.

Allowed as product functionality:

- mainnet packages;
- mainnet token types;
- mainnet pools or markets;
- mainnet execution data.

Not allowed as product functionality:

- testnet-only actions;
- planned-mainnet actions;
- faucet-only assets;
- fake liquidity;
- demo-only flows.

Internal experiments may use testnet, but they must not appear in product docs,
registries, UX copy, product-facing AI/tool responses, or supported-action
lists. Agents may discuss testnet or WIP surfaces only as unsupported internal
context or direct analysis, never as available product functionality.

Do not silently substitute mainnet assets, pools, package IDs, or protocol
objects. Resolved assets, pools, packages, and functions must be shown
explicitly in the review layer.

Mainnet guards must verify both declared network configuration and the actual
connected chain identifier. Do not rely on a string literal such as
`network: "mainnet"` alone.

## Registry And Generated Files

- Markdown files are explanatory references for AI and humans.
- JSON registries are local policy, allowlists, aliases, and known metadata.
- Prefer official SDKs, official RPC endpoints, official deployment registries,
  or direct mainnet onchain inspection for live state.
- Do not treat local JSON as live liquidity, live balances, live quotes, or
  final execution truth.
- Generated registry files should include generation source, network, timestamp,
  and generator script when practical.
- Do not hand-edit generated files unless they are explicitly marked as manual.
- If generated registry data changes, update related docs or state why no doc
  change is needed.

## SDK And CLI Source Of Truth

Code must use the pinned SDK and verified mainnet sources before introducing
local logic:

- DeepBook mainnet asset and pool metadata comes from `@mysten/deepbook-v3`
  `mainnetCoins` and `mainnetPools`.
- Display-to-raw conversions use pinned Sui SDK utilities such as `parseToUnits`
  and `parseToMist` when applicable.
- Wallet coin balances come from Sui SDK `client.core.listBalances`.
- DeepBook quote evidence comes from the pinned DeepBook SDK quote path or the
  existing SDK-backed simulation adapter.
- Do not reimplement SDK registries, parsers, quote APIs, or protocol math under
  local helper names when the pinned SDK already owns that source of truth.
- Sui CLI can be used only as read-only/debug verification evidence through
  reviewed allowlisted utilities. It is not runtime authority,
  transaction-building input, signing material, signing readiness, or wallet
  authorization evidence.

## Review State Model

Keep account-independent planning separate from account-bound review.

- `ActionPlan`: proposal created before wallet connection.
- `ReviewState`: wallet/account-bound verification result.
- Adapters that need original user intent captured for local activity analysis
  should put the sanitized intent object at `ActionPlan.adapterData.requestedIntent`.
- Adapter data and review evidence must never include session tokens, token
  hashes, URL fragment tokens, private keys, transaction bytes, signatures,
  seeds, or mnemonics.
- Do not put wallet-specific checks such as balances, gas result, transaction
  simulation result, or before/after balances into account-independent plans.
- Do not assume wallet balances, gas availability, or coin selection before
  wallet connection.
- Recompute account-bound checks after wallet connection in the review layer.
- Use full transaction simulation for review-time effects, gas, object changes,
  and balance changes.
- For Sui SDK v2 code, review-time simulation uses the public Sui gRPC
  `transactionExecutionService.simulateTransaction` with `checks: ENABLED`
  and `doGasSelection: true`. Send the stored transaction BCS and require
  identical returned BCS and an effects digest matching the stored material.
  Mock-gas simulation and rewritten transactions are not review evidence.
- Treat dev-inspection/debug simulation as separate from review-time transaction
  simulation; do not present debug inspection as signing readiness.

## Session Store Rule

For the current implementation, the MCP layer and review layer must share the
same authoritative session store.

The shared runtime uses SQLite as the authoritative source for card and live
session state. Store methods commit admission, revision changes and results;
MCP, HTTP and View consumers do not keep independent copies of that state.
In-memory fixtures may model external dependencies in tests, but do not prove
SQLite admission, rollback or restart guarantees. Frame recreation and chat
navigation are not state transitions.

Execution results belong to an exact `reviewSessionId` and `attemptId`. A
review explicitly references its current attempt, and earlier attempts remain
readable history. Do not use ambiguous global "latest result" semantics.

Card permissions are short-lived, scoped to the card and target, and carried
only in host UI metadata. Reads never create approval, pairing or a signature
request. Frame recreation is not an input transition. Its state read may
reconcile existing deadlines and wallet records without starting a new
operation. Only the backend owns admission, request deadlines and chain
observation. Settings permissions remain in UI metadata and scoped app-only inputs, never URLs, model responses or logs. File bytes use only app-only file-transfer inputs/UI metadata. Same-operation cleanup and verification of an existing backup may resume without reapplying data, creating a backup or restarting the SDK.

## Utility Script Rule

- Utility scripts should expose concrete reusable state inspection or reporting
  functionality.
- Keep utility scripts separate from the core review and signing flow.
- Avoid hidden side effects.
- Document inputs, outputs, and assumptions in `docs/UTILITY_INDEX.md`.
- Prefer read-only utility scripts unless a write action is explicitly required.
- Sui CLI based utilities must allowlist concrete read or debug commands, record
  the observed `sui --version`, and reject arbitrary shell commands, arbitrary
  Move calls, package calls, key handling, signing, execution, or config
  mutation unless a separate reviewed plan explicitly owns that write boundary.
- Treat Sui CLI replay, trace, and gas-profile output as development/debug
  evidence. Do not present it as review-time simulation, transaction-building
  input, signing material, signing readiness, or wallet authorization evidence.

## MCP Tool Safety

- Tool names, descriptions, and schemas must be concise, literal, and
  instruction-free.
- Use MCP-compatible `domain_verb_object` tool names, such as
  `read_list_deepbook_pools`, without an additional product prefix. The verb
  describes the actual effect: `get` reads one result, `list` reads a collection,
  `inspect` analyzes evidence, `quote` estimates an exchange, `start` begins a
  workflow, and `cancel` cancels it. Use `create`, `open`, `wait`, `submit` or
  `act` when they accurately describe the existing contract. Names do not grant
  authority or imply read-only, idempotent, signing-ready or safe behavior.
- Keep product names and technical identities separate. User-facing product
  copy uses the official display name; repository, executable, MCP server and
  default connection registration use the lowercase kebab-case project ID.
  Card titles describe their purpose without repeating the product name.
- Product-owned environment variables use the project ID in uppercase with
  underscores, followed by `_` and an `UPPER_SNAKE_CASE` role suffix. For Sui
  MCP the prefix is `SUI_MCP_`. Product capability IDs use `domain.member`,
  error and state codes use `snake_case`, JSON and TypeScript fields use
  `lowerCamelCase`, and CLI options and HTTP path segments use `kebab-case`.
  External wire formats, stored DB/backup fields and URIs, authentication
  labels, chain IDs and SDK-owned names retain their owning contracts.
- Replace product-owned names and their direct consumers together. Do not add
  compatibility aliases, old-key detection, migrations, name translators or
  a naming-specific schema framework. Preserve data, credentials and existing
  input, authorization and integrity checks.
- Do not include hidden instructions, prompt-like text, policy text, or
  model-behavior requests in tool descriptions.
- Do not expose arbitrary shell execution, arbitrary Move calls, arbitrary
  package calls, or private-key handling.
- Prefer purpose-specific tools with explicit schemas over broad free-form
  tools.
- Validate tool inputs and outputs at the MCP server boundary.
- Review whether tool authority expanded whenever a tool schema or description
  changes.
- Settings tools are card gateways. They may create an internal Settings card
  or read current settings. They must not mutate settings directly,
  execute transactions, sign, create custody, or produce signing material.
- For stdio MCP servers, stdout is reserved for valid MCP JSON-RPC messages.
  Send logs to stderr or a file. Do not use `console.log` in stdio server code.
- Successful MCP tool output should use `structuredContent` plus a text JSON
  fallback when the SDK supports structured output. MCP error responses use
  `isError: true` with a text JSON fallback because the pinned SDK skips
  output-schema validation for error results.

## MCP API Response Clarity

Design and review MCP API responses as standalone evidence.

Assume a connected AI client, coding agent, reviewer, or human operator may see
one tool response without reading the rest of the repository, prior chat, or
another tool response.

Every public MCP response shape should make these points clear from that
response alone:

- what question or operation this response can support;
- what source produced the facts, including network, SDK, transport, snapshot
  time, and unit source when relevant;
- which returned fields may be used in a user-facing answer;
- which returned fields are diagnostic, price-only, display-only, or otherwise
  not answer amounts;
- which claims are unsupported by this response;
- whether any required user choice is still missing;
- whether a follow-up tool is required, and exactly which tool and field should
  be used.

Keep API responsibilities isolated.

A field in one tool response must not require hidden knowledge of another tool
to understand its own meaning.

Cross-tool references are allowed only as explicit follow-up guidance, for
example: this quote result is a price estimate only; for payment amount or
shortfall answers, call `read_preview_intent_evidence` and use
`responseSummary`.

Do not make a different API response necessary just to understand whether the
current response is safe to use for a conclusion. If a response cannot support a
conclusion, say that in the response itself with a plain field name and a plain
reason.

For API implementation work:

- inspect every status branch, success branch, error branch, and optional field
  in the affected response;
- prefer a small response-local summary or use-guidance object over scattered
  negative flags when the result is meant to guide AI answers;
- keep raw facts, display amounts, price estimates, wallet-balance amounts,
  transaction facts, and execution/session state in separate fields;
- use ordinary field names such as `amountsUsedForAnswer`,
  `separateQuoteOutputs`, `canUseForPaymentAnswer`, or
  `requiredPaymentAnswerField` when those names describe the behavior directly;
- avoid field names whose meaning depends on product memory, such as unexplained
  `contract`, `coverage`, `gate`, `readiness`, `evidence`, or `support` wording.

For API review work, block or fix the change when:

- the response can be misunderstood after being copied without surrounding
  documentation;
- the response mixes price estimates, wallet balances, transaction facts, or
  execution state into one conclusion without naming which fields are used;
- the response tells an AI client not to use a value but does not identify the
  field that should be used instead;
- the response points to another tool without explaining what the current tool
  result does and does not mean by itself;
- the response requires prior chat, hidden product vocabulary, or a separate
  document to avoid an unsafe user-facing answer.

## Review Server Safety

- Bind the local review server to `127.0.0.1`.
- Use a dynamic port unless a fixed port is explicitly required.
- Implement Host and Origin checks in the review server itself.
- Do not treat Host or Origin checks as authentication. Private MCP/control
  routes require their runtime credential; internal app actions must validate
  their scoped UI permission and stored target/revision. Settings has no public
  URL or HTTP mutation fallback.
- Do not use MCP SDK host validation helpers as a substitute for review server
  authentication.

## Dependency Policy

- Pin Sui, DeepBook, MCP, and wallet-related dependencies to explicit versions
  during active development.
- Commit the lockfile.
- Do not upgrade SDKs casually.
- When changing the published package or MCP server release version, update all
  release metadata in the same change: `package.json`, root/package entries in
  `package-lock.json`, and `server.json` top-level and package versions.
- Before completing a release-version change, search committed repository
  surfaces excluding `node_modules/`, `dist/`, `.git/`, and `.WORK/` for the old
  release version and classify any remaining matches as dependency versions,
  fixture data, or stale release metadata.
- When changing an SDK or wallet-related dependency version, update pinned
  version documentation such as `docs/SDK_API.md` when that dependency is listed
  there.
- If an SDK is upgraded, re-run adapter, review, signing, and
  registry-generation checks.

## Completion Criteria

Work is complete only when:

- the requested change is implemented;
- the affected boundary still looks robust when reviewed again from product
  purpose, code paths, user flows, tests, and documentation;
- affected code, docs, interfaces, and user flows have been reviewed after the
  change;
- relevant checks, tests, builds, or manual verification have been run when
  available;
- errors introduced by the change have been fixed;
- remaining limitations are explicitly documented;
- for non-trivial work, the final review compares the completed work against the
  specification baseline;
- every baseline requirement is implemented and verified, or named directly as a
  missing planned requirement;
- passing tests, reduced scope, or internal consistency of a smaller
  implementation does not replace baseline comparison;
- final repository status is checked, including untracked files;
- unexpected files are classified or cleaned up before final response;
- if previous progress was overstated, the final response corrects the record.

## Quality direction

Quality work continues along three areas; progress in all three matters, and
work that advances more than one at once is preferred over work that advances
only one in isolation:

- Intent, evidence, and answer quality: understand the request, route it to the
  right tool (prompt surfaces, `userAnswerUse` response guidance), and answer
  only from verified mainnet evidence, including saying plainly when a question
  cannot be answered from the returned evidence.
- Protocol breadth: additional protocol adapters registered through the
  descriptor contract; protocol names appear in public docs only after a
  concrete support decision. When several protocols support an action, the bare
  action prompt asks the user to choose instead of routing silently.
- Execution-trust foundation: what the user reviewed is exactly what gets
  signed, under any wallet and any signing speed — the review-session state
  machine, atomic per-review-revision admission, verified sign-only wallet
  responses, bounded local waits with late-callback guards, scoped UI permission, runtime lifecycle
  stability, and packaging and runtime operability.
