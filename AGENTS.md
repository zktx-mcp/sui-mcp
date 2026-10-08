# AGENTS.md

This file is the root operating contract for coding agents working in this
repository. Read it from disk before every task.

Detailed policy files are binding when the task touches their boundary. Moving a
rule out of this root file does not make it optional or lower priority. The
primary detailed policy is `docs/AGENT_DEVELOPMENT_POLICY.md`.

## Product Purpose

Sui MCP is a local-first toolkit that turns natural-language Sui DeFi
intent and structured Sui payment/action proposals into verified, AI-readable
evidence. Users inspect independently built or verified transaction material
and approve each transaction in their own wallet. The current backend builds
account-bound DeepBook swap material, verifies its digest, ownership,
quote/policy provenance, human-readable facts, simulation and PTB visualization,
and exposes internal Connect and Review cards alongside Account, Receipt,
Chart and Settings cards. Settings owns scoped local data/configuration actions
and explicit connection-service recovery; ordinary MCP calls do not apply them.

WalletConnect is the only connection and signing transport. An explicit,
permission-checked card action is admitted atomically in SQLite before the
backend requests a wallet signature. The backend verifies the returned bytes'
digest and signer against that admitted review, checks Sui mainnet, and submits
once. It records only independently read chain effects as execution success or
failure. Lost responses are resolved by reading the same digest, never by
resending a financial request. Request state and observed chain outcome are
separate facts. No card or model receives transaction bytes or signatures.

Implemented surfaces and deliberately sequenced work remain distinct:

- Current surfaces: read-only evidence and external proposal review, internal
  Connect/Review cards for the supported swap adapter, backend WalletConnect
  signing and receipt observation, and internal Settings/file/data controls. Ordinary MCP tools
  create cards or read evidence; they do not authorize signing or execution.
- Sequenced next: final package and actual Host handoff checks, further analysis
  views and protocol adapters. External proposal execution requires a separate implementation
  decision and independent material verification; proposals remain non-signable.

The evidence layer answers what verified Sui facts support about a user's
assets and request, and which choices or claims remain unsupported. A reviewed
transaction is not a safety guarantee. Implementation or a unit's verification
must not be reported as completion of the entire product goal.

Sui MCP uses protocol-agnostic adapter contracts. Extensibility across Sui
DeFi protocols remains a core product boundary. DeepBook is the current concrete
protocol surface: it provides scoped conversion, price, orderbook,
account-inventory, and swap-review evidence. Concrete tools, SDK calls, registry
fields, and implemented adapter details may name DeepBook. Product-level plans
and new evidence producer work must still use shared adapter contracts;
a single installed adapter must not turn shared code into a custom-only path.
Wallet and Sui balance reads describe held assets. DeepBook facts must not become
route choice, liquidity readiness, price-impact claims, funding readiness,
payment readiness, best-price advice, or signing readiness unless response-local
fields explicitly support those conclusions.

Do not introduce names of other DeFi protocols into public docs, runtime
guidance, MCP resources, roadmap labels, or product copy during development
unless there is an approved concrete implementation or support decision for that
protocol. Use generic terms such as "protocol adapter", "first swap adapter",
"supported action adapter", or "account-bound swap review" until a protocol is
actually implemented or explicitly approved. DeepBook is a current exception
because it is implemented, but it must not become a custom-only design shortcut.

Existing transaction-activity classifier research notes may name protocols only
inside that implemented `compact.protocolMatches` evidence boundary. Those names
must not be copied into runtime guidance, MCP resources, roadmap labels, product
copy, adapter plans, route support, wallet inventory support, transaction
building, signing readiness, or execution claims without a separate approved
implementation or support decision.

## Non-Negotiable Boundaries

These boundaries are not implementation details and must not be weakened to make
a task easier.

- The product must not provide private-key custody, autonomous execution, or
  unchecked AI-controlled authorization.
- Ordinary model-facing MCP and review-session responses never request wallet
  signatures or authorize execution. Only a scoped app-only action initiated by
  the user, followed by the wallet's approval of that exact transaction, may
  authorize the backend request. Host UI/model separation is a trust boundary,
  not cryptographic proof of a physical click. Transaction bytes and signatures
  stay between the private backend and wallet; they never appear in model
  responses, card display state, public backup or logs. The backend independently
  builds/verifies material and binds digest, selected account and review revision
  before admission, verifies returned bytes and signature, and submits once.
  Ownership, quote/policy, human-readable review, PTB and simulation remain
  pre-signing evidence, not authorization or guaranteed execution.
- Current read-only external proposal review records structured proposal facts
  only as non-signable review context. It is not transaction building, payment
  execution, wallet signing, signing readiness, or trusted transaction material.
- Future external proposal execution or signing support must resolve mainnet
  facts independently and either build or verify review-time transaction
  material inside Sui MCP before wallet signing is offered.
- External MCP or AI-client proposals must be treated as untrusted structured
  inputs, not executable authority.
- The product must not treat USDC, USDT, or any USD-denominated settlement asset
  as fiat USD, a bank cash-out amount, or a USDC/USD peg guarantee.
- The product must not provide fiat cash-out, P&L, tax, or cost-basis support in
  the current release or immediate review roadmap unless a separate product
  decision changes that scope.
- Sui MCP must not silently choose USDC, USDT, or another settlement token
  for a user.
- Sui MCP must not rank venues, choose routes, or make best-price
  recommendations for users.
- Quote-only conversion candidates must not become payment coverage, shortfall
  evidence, funding readiness, route support, final min-out, price impact,
  slippage evidence, payment execution readiness, or signing readiness unless a
  reviewed implementation returns response-local fields that explicitly support
  those conclusions.
- Do not frame the product around competitions, event tracks, prizes, or judging.

## Agent Operating Contract

- Open and read `AGENTS.md` from disk before starting. Do not rely on memory,
  previous turns, or summaries as a substitute.
- Inspect the current repository state before editing.
- For every task, finish collecting the task-relevant evidence before beginning
  evaluation. Define the collection scope from the user's objective and affected
  boundaries, including existing implementations, examples, tests, and recorded
  observations. During collection, record facts, sources, and missing evidence;
  do not form or report findings, rank alternatives, or assign priorities.
- State when collection is complete before evaluating the collected material.
  If evaluation reveals a material evidence gap, pause that evaluation, return
  to collection, and resume only after the gap has been investigated. Do not
  carry an earlier assessment forward as an established fact.
- Reuse applicable implementation and verification evidence before proposing
  new checks. Each additional check must name the changed boundary or missing
  fact it resolves and the implementation or release decision that consumes it.
  Unverified behavior alone does not make a separate pre-refactoring gate
  necessary; distinguish prior evidence, integration checks, and release checks.
- Do not create one-item/one-test development stages merely to satisfy a
  procedure. Group related changes by the user flow they complete. Do not
  repeat an established review or check unless the relevant code or process
  changes, or new evidence invalidates its result. Apply this to this project's
  existing implementation as well as reference projects.
- Before reporting repository status, pending work, a task list, a plan,
  whether the tree is clean, or the current/next task name, re-check disk state
  in that same turn. At minimum inspect `git status --short --branch`,
  `git diff --stat`, `git diff --name-only`, untracked files, and the canonical
  task name in the active `.WORK/` roadmap when the answer depends on it.
- Do not answer status or planning questions from memory when disk state may
  have changed. If the disk facts differ from a prior plan or prior answer,
  update the answer to the disk facts and say which prior statement is stale.
- State assumptions when ambiguity affects architecture, security, public API,
  data model, financial/protocol meaning, or a product boundary.
- Prefer the smallest change that fully solves the requested task while
  preserving the verified boundary.
- Do not make drive-by refactors or unrelated formatting changes.
- Every changed line must trace to the user request, the agreed specification
  baseline, or an affected shared invariant.
- Do not change `AGENTS.md`, product-boundary docs, runtime guidance, tests, or
  fixtures to make a task easier unless the user explicitly approved that
  product-rule change.
- For non-trivial or boundary-changing work, define success criteria,
  implementation surfaces, and verification points before editing.
- Treat the first accepted task name as the canonical task name. Use that same
  name in plans, work tables, progress updates, reviews, commit messages, and
  completion reports.
- Task-name drift is scope drift. Confusing the canonical task name with the
  first implementation target can collapse the implementation purpose,
  dependency order, and completion criteria.
- Do not fold the first implementation target into the canonical task name.
  Record it separately, such as "task: Object Ownership Evidence Producer" and
  "first implementation: DeepBook account-bound swap adapter".
- Do not rename, shorten, replace, or reframe a task to make incomplete work
  look complete, smaller, aligned, or out of scope.
- If discovery changes the work, keep the canonical task name and record the
  changed status, missing requirement, blocked condition, or explicitly named
  subtask separately. Work notes and task tables must preserve the canonical
  task name instead of overwriting it.
- If a requirement is missing, weakened, removed, or unverified, say that
  directly. Do not relabel it as cleanup, simplification, alignment, or a
  harmless tradeoff.
- Status or progress wording such as `blocked`, `unverified`, `follow-up`, or
  `limitation` must not soften, downplay, or justify a missed requirement,
  failed check, or completion claim when completion criteria are unmet. Do not
  use `partially complete` as a completion status; if progress matters, name
  completed subtasks and remaining requirements.
- Completion judgment for a scoped task is binary. If any required behavior is
  unimplemented, required cleanup remains undone, or verification is missing or
  failing, the task is not complete.
- Run relevant checks and report what passed or failed.
- Check `git status --short` before the final response and classify unexpected
  files.

## Scope And Planning

Treat work as non-trivial when it touches multiple files, changes a public API or
MCP tool response, changes tests or documentation that define behavior, follows
an accepted plan or review, revisits incomplete work, or responds to a previous
incorrect completion claim.

For non-trivial work:

1. State the product purpose and current task goal.
2. Identify the boundary that must not be crossed.
3. Inspect affected callers, callees, schemas, docs, tests, user flows, and
   failure paths before editing.
4. Establish a specification baseline from the user request, accepted plan,
   confirmed review findings, promised behavior, and required cleanup found
   during investigation.
5. Compare reasonable implementation directions when architecture, data model,
   security, public API, or product authority is affected.
6. Map each baseline requirement to an implementation surface and verification
   point.
7. Implement the complete quality-first change for the verified boundary.
8. Re-check the affected boundary from product purpose, code paths, tests, docs,
   and user flows.

Do not interpret a user request as the lowest-effort literal edit that satisfies
the words in isolation. Interpret it by the product outcome, affected boundary,
and adjacent invariants that must hold for the work to be complete.

### Objectives And Means

- In every task, the accepted user outcome is the objective. Tools,
  architectures, abstractions, tests, documentation, and procedures are means
  to that outcome and must never become independent objectives.
- Improve a means only when collected evidence connects the improvement to a
  concrete product behavior or quality requirement within the accepted task.
  If that contribution cannot be explained, do not proceed. Greater internal
  completeness, elegance, generality, test counts, or process sophistication
  alone are not product quality improvements.
- Once a means satisfies the product requirements it serves, stop improving
  that means and continue toward the user outcome. Add no independent review
  gate, report, or framework merely to perfect the means.
- This rule does not permit reducing the accepted objective, weakening product
  boundaries, or leaving required correctness, safety, or functionality
  incomplete to fit a chosen means.

## Implementation Rules

- Inspect `package.json` before running project commands. Do not invent scripts.
- When changing the published package or MCP server release version, keep all
  release metadata synchronized in the same change: `package.json`,
  root/package entries in `package-lock.json`, and `server.json` top-level and
  package versions. Before completion, search committed repository surfaces
  excluding `node_modules/`, `dist/`, `.git/`, and `.WORK/` for the old release
  version and classify any remaining matches.
- When changing an SDK or wallet-related dependency version, update pinned
  version documentation such as `docs/SDK_API.md` when that dependency is listed
  there.
- Reuse existing source-of-truth modules, pinned SDK/source APIs, verified
  mainnet data, local registries, and established infrastructure when they own
  the boundary.
- Add new code only when no suitable source exists or the existing source is
  demonstrably insufficient.
- Do not duplicate logic, registries, parsers, protocol metadata, SDK behavior,
  or policy checks without a clear reason.
- Add helpers only when they name a real shared concept, preserve an invariant,
  or remove meaningful repetition.
- Avoid generic frameworks, new registries, plugin layers, event buses,
  background schedulers, or broad configurability unless the verified
  requirement needs them.
- Simple never means hardcoded, temporary, case-specific, or test-only code. A
  simple implementation still validates inputs and outputs, handles errors,
  preserves shared invariants, and covers affected paths with tests.
- Do not hardcode values to bypass real validation, live integration, registry
  policy, or mainnet checks.
- Do not manipulate tests, fixtures, generated files, snapshots, package
  metadata, or source files just to make checks pass.
- Test doubles, fixtures, placeholders, and config constants are allowed only
  when their scope is explicit and they are not presented as product
  functionality.
- Do not fake liquidity, quotes, transactions, wallet state, package IDs, or
  mainnet support.

## Review Rules

The goal of review is defect discovery, not praise or consensus.

- Lead with findings, ordered by severity.
- Cite file and line evidence for each finding.
- Mark speculation as speculation when not directly confirmed by code, tests, or
  pinned SDK source.
- Do not rely on passing tests as proof of correctness. Walk input, state, error,
  and boundary paths.
- When a change is framed as refactor, cleanup, alignment, simplification, or
  documentation synchronization, check whether supported behavior, tool
  authority, runtime guidance, tests, docs, status values, or user-facing claims
  became smaller.
- If history shows prior behavior, classify the current work as restoration,
  replacement, or intentional removal before reviewing it as new functionality.
- For tests that prevent unsafe or unsupported behavior, read the test body and
  state what it prevents before treating it as stale.
- For `userAnswerUse` and golden-document tests, verify semantic polarity, not
  string presence alone.

## Documentation And Runtime Guidance

- Repository-visible code comments, public docs, tests, protocols, tool
  descriptions, user-facing strings, and release-facing copy must be English.
- Internal ignored planning notes are not public product copy. Anything moved
  into exposed surfaces must be rewritten in English.
- `AGENTS.md` owns development rules. It must not be the only place where a
  connected AI client is expected to learn user-answer behavior.
- Runtime-facing behavior must live in MCP-injected or discoverable surfaces:
  `SERVER_INSTRUCTIONS`, prompts, tool schemas/descriptions, MCP resources,
  response fields, and tests.
- Tool descriptions must remain concise, literal, and instruction-free.
- When editing `README.md`, `docs/`, `protocols/`, or runtime-facing instruction
  text, do a first-reader pass. A reader with no prior context must understand
  what is implemented, planned, unsupported, and out of scope.
- Use ordinary industry terms when available. Define unavoidable project terms at
  first use and state exactly what they do and do not mean.
- Do not remove all repetition. Repeated safety boundaries are allowed when they
  protect separate reader surfaces.

## Numeric, Financial, And Protocol Rules

- Treat raw token amounts, display amounts, decimals, slippage, bps, quote
  quantities, min-out values, gas, and balance deltas as safety-critical data.
- Do not infer token decimals from token symbols, memory, UI convention, or
  common ecosystem defaults. Use pinned SDK metadata or verified mainnet onchain
  metadata.
- Keep raw amounts as integer strings or `BigInt` values. Do not use floating
  point `number` arithmetic for token balances or signable quantities.
- Keep display amounts presentation-only. Do not feed display strings back into
  signing, quoting, or review-time simulation without an explicit raw conversion
  step.
- Product specs, public docs, UX copy, product-facing AI/tool responses,
  registries, and signable actions are mainnet-only.
- Internal experiments may use testnet, but they must not appear as product
  functionality.
- Mainnet guards must verify both declared network configuration and the actual
  connected chain identifier. Do not rely on a string literal such as
  `network: "mainnet"` alone.

## Required Detailed Policies

Read `docs/AGENT_DEVELOPMENT_POLICY.md` before work that touches any of these
boundaries:

- documentation ownership or runtime-facing guidance;
- stateful/API behavior, session state, review state, signing, wallet, MCP
  tools, HTTP endpoints, or adapters;
- numeric, financial, Sui, DeepBook, SDK, CLI, registry, generated file, or
  mainnet source-of-truth behavior;
- review-server frontend or local browser review surfaces;
- utility scripts, smoke tests, release checks, or source-checkout scripts;
- dependency upgrades or lockfile changes;
- any non-trivial implementation or review.

## Commands

Current commands, as of the current `package.json`:

- Install: `npm install`
- Type check: `npm run typecheck`
- Build: `npm run build`
- Test: `npm test`
- Release check: `npm run release:check`
- Generate DeepBook registry: `npm run generate:deepbook-registry`
- Mainnet read smoke: `npm run smoke:mainnet` (manual only; requires mainnet env values)

If `package.json` differs from this section, `package.json` wins. Say so and
update this section when the difference is intentional.

## Completion Criteria

Work is complete only when:

- the requested behavior is implemented;
- affected code, docs, interfaces, user flows, and product claims have been
  reviewed after the change;
- the affected boundary still looks robust from product purpose, code paths,
  tests, docs, and user flows;
- relevant checks, tests, builds, or manual verification have been run when
  available;
- introduced errors have been fixed;
- remaining limitations are explicitly documented;
- non-trivial work is compared against the specification baseline, with every
  baseline requirement classified as implemented and verified, missing,
  weakened, or unverified;
- final `git status --short` has been checked and unexpected files are
  classified or cleaned up.
