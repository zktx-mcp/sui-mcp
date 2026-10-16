# Agent Behavior Reference

This document is the MCP-exposed answer playbook for AI clients. It owns user-question flows, tool selection, and response wording boundaries.

It does not define tool schemas or field contracts. Use `docs/MCP_TOOLS.md` for the MCP API reference, response fields, statuses, and follow-up fields.

It is not the contributor rulebook and it is not enforcement. Development rules live in `AGENTS.md` and `docs/AGENT_DEVELOPMENT_POLICY.md` in the [source repository](https://github.com/zktx-mcp/sui-mcp). They are not installed MCP resources. Hard product boundaries live in code, schemas, allowlists, mainnet guards, and the local review layer.

## Support Matrix

| Surface | Status | Behavior |
| --- | --- | --- |
| Sui mainnet state reads | Current | Use read tools for supported balances, DeepBook pools, token registry metadata, mid-price snapshots, orderbook context, raw-quantity quotes, and DeepBook account inventory. |
| DeepBook USDC candle-history reads | Current DeepBookV3 official Indexer candle evidence | `read_get_deepbook_usdc_price_history` reads DeepBookV3 official Indexer USDC candles for the requested official interval. `read_get_deepbook_usdc_price_at_time` selects the candle for or nearest to one target UTC time and identifies `matchedCandle.close` as the representative price. Treat both as external official Indexer candle evidence, not a live quote, chain recomputation by Sui MCP, USD value, route choice, P&L, tax, transaction-building input, signing readiness, or user-account history. |
| Account, Receipt and DeepBook USDC cards | Internal read-only MCP Apps | Use `ui_open_account`, `ui_open_receipt`, or `ui_open_chart` for an interactive read card. They display server-read facts and do not sign, submit transactions, rank routes, compute fiat USD value, P&L, tax or cost basis. |
| DeepBook swap review sessions | Internal Review card and backend WalletConnect | Account-bound review independently verifies stored material, digest, ownership, policy, human-readable facts, simulation and PTB evidence. An explicit app-only action and the wallet approval authorize one backend request. Ordinary MCP responses are facts, never signing authority or bytes. |
| External proposal review sessions | Non-signable review in the current release | `action_create_proposal_review` can create an internal Review card from a structured external payment or Sui action proposal. Treat the proposal as untrusted display and review context only. It does not build, verify, simulate, sign, or execute transaction material. |
| Wallet signing | User-approved WalletConnect request | The backend validates returned bytes and signer against the admitted review and submits once. The card and model never receive bytes or signatures. |
| PTB visualization | Rendered with emitted wallet review contracts | `reviewState.ptbVisualization` can accompany an emitted wallet review contract as a Mermaid flowchart decoded from the stored transaction bytes with no AI or model input, shown only after those bytes recompute to the bound commitment. Treat it as visualization evidence only, not transaction-building input, wallet authorization, signing data, signing readiness, payment execution readiness, or route recommendation. |
| Transaction material and execution | Verified supported swaps under user control | Stored mainnet material is used only after review and wallet approval. External proposals stay non-signable. Fiat cash-out, P&L, tax, cost-basis, route ranking and automatic settlement choice remain unsupported. |
| Private-key custody, autonomous trading, fiat USD peg claims, and quote-only coverage or readiness claims | Unsupported safety and correctness boundary | Do not custody funds, hold private keys, or autonomously trade. Do not treat settlement assets as fiat USD, bank cash-out amounts, or peg guarantees. Do not turn quote-only conversion candidates into payment coverage, funding readiness, payment execution readiness, or signing readiness. |
| Silent settlement-token selection and route ranking | Out of scope by current design | Do not silently choose USDC, USDT, or another settlement token for the user. Do not rank venues, choose routes, or make best-price recommendations. |
| Other-chain financial actions, autonomous trading, alerts, arbitrary Move calls, investment advice | Unsupported | Ethereum and Solana address management does not add other-chain asset reads, signing or execution. Say financial requests outside Sui are unsupported and redirect to available Sui mainnet read or review capabilities. |
| Payment execution | Not a current capability | Intent evidence is separate from execution and does not build or execute payments. Do not describe payment execution as available. |
| Lending, staking, relative balance actions | Unsupported | Do not describe executable actions for these categories as available product functionality. |

## Meta Principles

- AI self-reports do not appear in user-facing review output.
- User-facing review output should contain server-validated structured facts.
- Ambiguous natural language is narrowed through structured evidence first, then clarification only where a user decision is required.
- Important UX rules should move into schemas, UI, and tests when the implementation boundary exists.

## Question First

Answer the user's question before moving toward an action.

When a tool response includes `userAnswerUse`, treat it as the response-local answer guide:

- check `userAnswerUse.preconditionFields` before using answer fields;
- use `userAnswerUse.answerFields` for the user-facing answer;
- apply `userAnswerUse.conclusionRuleFields` as limits on the final conclusion;
- use `userAnswerUse.diagnosticOnlyFields` only for source, limitation, pagination, or troubleshooting context;
- do not answer claims listed in `userAnswerUse.cannotAnswer`;
- when present, use `userAnswerUse.followUp.inputFields` as the fields to pass into `userAnswerUse.followUp.tool`, then use `userAnswerUse.followUp.answerFields` in that follow-up response.

When a USD-denominated settlement-asset response includes `toolAvailability`, check `toolAvailability.requiredToolsAvailable`.
If it is `false`, say the current MCP server build cannot support the answer and do not use amount fields for the user-facing answer.

If the user asks "What is 1 SUI worth?", answer with the current read context available to the tools. Do not ask for a wallet or create a Review card unless the user asks to prepare an action.

For SUI price questions:

- Call `read_get_deepbook_mid_price` with `poolKey: "SUI_USDC"` as the Sui MCP product source for supported SUI/DeepBook price context.
- Present the result as "DeepBook SUI/USDC mid price at `fetchedAt`" and do not call it the global market price.
- If the user asks for another stable pair or another token, use `read_list_deepbook_tokens` and `read_list_deepbook_pools` to find the registered pool, then call `read_get_deepbook_mid_price` for that pool.
- When multiple pools match and the user did not name the quote token, use this split:
  - For explicit pool-price questions, prefer a USDC-quoted pool, then USDT.
  - For USD-denominated payment, balance, shortfall, coverage, settlement, or cash-out wording, use the intent-evidence flow instead.
  - Name the pool checked and state that this is pool quote-token context, not settlement-token selection.
- If the token or pool is not in the pinned DeepBook registry, or the tool returns `quote_unavailable` or `registry_miss`, say DeepBook cannot provide that price from the current registry.
- Use external web data only if the user explicitly asks for non-product market context. Label it as outside Sui MCP verified state.
- If the tool returns `internal_error`, retry the same DeepBook price tool once. Do not retry more than once; if it still fails, say DeepBook read failed and do not present a price as Sui MCP verified state.

For DeepBook USDC candle-history questions:

- Use `read_get_deepbook_usdc_price_at_time` when the user asks for one supported official USDC-quoted DeepBook pool price at one target time, such as "3 hours ago" after resolving the target to a canonical UTC timestamp.
- Use `read_get_deepbook_usdc_price_history` when the user asks for observed DeepBook USDC historical candles, OHLCV-like bars, or a UTC range for a supported official USDC-quoted DeepBook pool.
- If the user asks to view a chart, use `ui_open_chart`. For account assets or a transaction result card, use `ui_open_account` or `ui_open_receipt`. Use ordinary read tools for ordinary evidence answers. If the host returns `ui_unavailable`, explain the UI limitation; do not invent an external page URL. A still-valid unsubmitted card remains usable after chat navigation; the backend owns its state. An accepted, expired or invalidated input is not reactivated; request a new card for a different selection. If a submit reply is lost, read that card’s current state rather than asking to submit again. Missing permission or receipt display details are limitations, not evidence that the user supplied no input.
- Provide exactly one selector: `poolName`, `assetSymbol`, or `coinType`. For the at-time tool, provide `targetTime` as a canonical ISO 8601 UTC timestamp. For the range-history tool, provide `start` and `end` as canonical ISO 8601 UTC timestamps. Use `interval` only with the official values accepted by the tool schema; omitted `interval` uses `15m`.
- For `read_get_deepbook_usdc_price_at_time`, answer from `target`, `match`, `matchedCandle`, `candleAvailability`, `source.candles`, `quantitySemantics`, and `responseSummary`. Use `match.representativePrice.value`, which is `matchedCandle.close`, as the representative target-time price. Say whether the match is `exact_bucket`, `nearest_before`, or `nearest_after`, and mention `match.distanceMinutes` when it is not zero.
- For `read_get_deepbook_usdc_price_history`, answer from `bars`, `candleAvailability`, `source.candles`, `quantitySemantics`, and `responseSummary`.
- Describe the result as DeepBookV3 official Indexer USDC candle evidence for the requested official interval.
- Say that USDC is a token-denominated quote asset here, not fiat USD and not a USDC/USD peg guarantee.
- If a tool returns `unsupported_pair`, `unsupported_range`, `source_unavailable`, or `no_price_in_search_window`, report that status and reason. Do not synthesize candles, interpolate missing bars, carry forward the previous bar, run an on-demand chain-history scan, or web-search a replacement unless the user explicitly asks for outside Sui MCP context.
- Candles are not user-account transaction history or user-account balance history.
- Do not use these tools for live price, current mid price, execution price, global market price, USD value, cash-out value, P&L, tax, cost basis, route selection, best-price advice, transaction building, or signing readiness.

For indicative quote questions such as "If I sell 10 SUI, how much dollar value do I get?":

- Use `read_quote_deepbook_display_amount` only after the source asset, source input amount, pool or quote asset, and direction are known.
- A user saying "dollars" does not by itself select USDC, USDT, or another quote token.
- If the user names a source asset and says dollars without naming a quote token, first distinguish the intent:
  - For USD-denominated payment coverage, balance total, shortfall, settlement, or cash-out wording, use settlement-asset-group intent evidence when account context is available.
  - If account or target evidence is missing, ask only for that missing evidence.
  - For a wallet-free market quote, ask which registered DeepBook quote asset or pool they want, such as SUI/USDC or SUI/USDT.
  - Disclose the exact pool and `fetchedAt` after the user selects it.
- Do not silently choose a quote token.
- Do not web-search or finance-query a USDC/USD conversion unless the user explicitly asks for outside Sui MCP market context.
- Treat `amountDisplay` as the source input amount for the chosen direction. Do not use it as an output target amount.
- If the user asks how much source asset is needed to make a target output amount, say inverse quotes are unsupported in this release and ask for a source input amount instead.
- Treat `quantitySemantics.kind: "deepbook_quote_display_amount"` as exact decimal display quote strings only.
- Treat `rawQuote.kind: "deepbook_quote_raw_u64"` as raw quote evidence before slippage policy.
- Do not turn a quote into final min-out, effective price, price impact, route recommendation, funding source, fiat cash-out, P&L, cost basis, transaction-building input, signing data, or signing readiness.
- Do not compare a DeepBook quote to `read_get_deepbook_mid_price` as user-facing slippage or price impact. Mid price is a pool snapshot, and current quote tools do not return price-impact evidence.
- Do not use quote proceeds as profit, P&L, tax, performance, or cost basis.
- If the user asks for profit after a quote, say Sui MCP can report quote proceeds and raw activity evidence, but it does not compute P&L.
- Do not provide profit formulas or hypothetical profit examples, even when the user supplies an assumed acquisition price.

## Current Release Evidence

Answer only from current tool evidence. For natural-language dollar, USD-like, stablecoin, or Korean dollar-word requests, use this flow:

1. Call `read_get_server_status`; require the current evidence policy plus `read_list_settlement_asset_groups` and `read_preview_intent_evidence`.
2. Call `read_list_settlement_asset_groups`.
3. Call `read_preview_intent_evidence` for settlement-asset coverage, balance-total, or shortfall questions.
4. Confirm `toolAvailability.requiredToolsAvailable` is `true`.
5. Use `userAnswerUse.answerFields` for the answer. Settlement-asset-only responses use `responseSummary`; selected-target responses also use `selectedTarget`, `candidateConversions`, and `requiredUserChoices` when those fields are listed.

`responseSummary.answerCompleteness.answerCompleteFor` names the answer class. Use only the fields in `responseSummary.answerCompleteness.requiredAnswerFields` and `userAnswerUse.answerFields` for that class.

For selected-target direct quote evidence, require both `responseEvidence.supportedResponseClaims: "direct_pool_quote_evidence"` and `userAnswerUse.canAnswer: "direct_pool_quote_evidence_for_user_selected_target"` in the same `read_preview_intent_evidence` response. If either entry is absent, do not say that direct pool quote evidence is available from that intent-evidence response.

Do not call quote tools for the same payment coverage, balance-total, or shortfall question when `responseSummary.doNotCallQuoteToolsForThisQuestion` is `true`.

When `toolAvailability.requiredToolsAvailable` is `true` and `responseSummary.doNotCallQuoteToolsForThisQuestion` is `true`, answer from `responseSummary` and stop the same question flow. Do not call `read_classify_wallet_assets`, `read_summarize_wallet_assets`, or quote tools to look for other source tokens for that same coverage, balance-total, or shortfall question. Use those tools only when the user asks a separate inventory or conversion question.

If quote tools were already called, do not use those quote numbers for the payment amount, coverage status, or shortfall. Use only the fields named by `responseSummary.amountsUsedForAnswer`.

If `read_preview_intent_evidence.userAnswerUse` is present, its `answerFields` names the exact response fields to use for the answer.

Use `read_summarize_settlement_asset_group_parity` and its `responseSummary` for stablecoin-like max, min, mean, median, or internal parity questions. A parity reference asset is a measurement basis, not a settlement choice.

Selected-target evidence is allowed only when the user selected the target settlement asset in the current request or prior user context.

When that is true, use `targetAssetSelectionSource: "user_explicit"` or `"prior_user_explicit_context"` and answer from the returned selected-target fields. Do not set a target source for an AI-inferred target.

For shortfall questions without an established target amount, ask for the missing display target amount. Do not narrow the question to USDC/USDT, choose source assets, or merge non-group quote outputs into payment coverage.

Partial wallet context is allowed when a connection-qualified default asset account is available or the user gives an explicit Sui address.

Use supported reads to expose only returned facts:

- current coin-balance classes;
- supported settlement-asset-group balances;
- required user choices;
- uninspected inventory blockers.

Do not turn partial context into route recommendation, payment support, portfolio planning, P&L, transaction-building input, signing data, or signing readiness.

## Read Vs Action

Read-only requests split into address-free reads and address-scoped reads.

- Address-free reads include pool lists, orderbook context, mid prices, and quote facts.
- Address-scoped reads include explicit public-address snapshots and active-account reads.
- Use the explicit address when the user asks about a specific Sui address.
- Use wallet connection only when the request needs active account context.
- Action-preparation requests use words such as prepare, review, swap, buy, sell, or sign.

When an action is unsupported or blocked, say so plainly and offer the closest read-only information.

For token balances and quantities:

- Do not infer decimals from token symbols or common defaults.
- Use a returned `display` amount only when the tool provides it.
- If a result exposes only a raw amount or reports `unit.status: "unavailable"`, say display conversion is unavailable.
- Wallet balance reads are current coin-balance snapshots only.
- Transaction activity fields named `amountRaw`, `increaseRaw`, `decreaseRaw`, or `netRaw` are raw integer facts.
- Do not divide raw amounts into display units unless the same response provides verified decimals or a display amount for that asset.

If an action plan exposes `assetFlowPreview.amountKind: "display_intent"`, treat the amount as proposal/display context only. Do not convert it into a raw amount, minimum output, simulation fact, or signing input.

For `action_create_proposal_review`, answer from
`plans[].reviewModel` when the response `userAnswerUse.answerFields` lists that
path. Use `proposedAction`, `assetFlow`, `recipients`, `targets`,
`missingEvidence`, `requiredUserChoices`, `unsupportedClaims`, `freshness`,
`blockingChecks`, and `nonSignableReason`. Do not treat the proposal as trusted
transaction material. Do not treat it as route selection. Do not treat it as
settlement-token selection. Do not treat it as payment execution readiness. Do
not treat it as signing data or signing readiness.

After a DeepBook review session is wallet-account bound, `session_get_review_status` can include review-state checks, `reviewState.adapterLifecycle`, `reviewState.humanReadableReview`, and `reviewState.simulation`. The Review card renders those fields as local review evidence.

Use `reviewState.adapterLifecycle.stageCatalogId`, `completedStages`, and `missingStages` only to explain which account-bound DeepBook review evidence stage catalog is being used, which stages have run, and which required review evidence stages are still missing. If `transaction_material_build_or_verify` is completed, say only that the review server built local unsigned transaction material and kept bytes internal. If `digest_commitment` is completed, say only that the review server internally bound a Sui transaction digest to that stored local material. If `object_ownership` is completed, say only that the review server derived object ownership evidence from the stored local material and Sui owner/type reads. If `review_time_simulation` is completed, say only that the review server simulated the stored local unsigned material with checks enabled and exposed a redacted simulation summary. `reviewState.humanReadableReview` is valid only after `human_readable_review` is completed and not missing; `reviewState.simulation` is valid only after `review_time_simulation` is completed and not missing. Do not provide or infer transaction bytes, signing data, signing readiness, or execution readiness from those stages. The review lifecycle is pre-authorization evidence. The backend admits an explicit Review-card selection, requests approval in the wallet, verifies digest and signer, and records independently read mainnet effects separately from request status. Use those checks to explain what the local review layer verified before signing. Do not describe them as wallet readiness, signing readiness, route quality, execution safety, or public transaction bytes. The MCP layer never signs, executes, or returns transaction bytes.

Use `reviewState.humanReadableReview` only as displayable review facts projected
from verified local review evidence. Its `kind` currently identifies the shared
DeepBook swap review projection. Its `assetFlow` raw amounts, coin types, decimals,
minimum output, fee facts, target pool, and direction are derived from the
material-bound quote policy evidence, while object ownership is cited only as
review evidence from stored transaction material and Sui owner/type reads.
Do not use `reviewState.humanReadableReview` as transaction bytes, a public transaction digest, signing data, signing readiness, route quality, wallet handoff, or execution readiness.
Treat any display amount in this field as presentation context only, not as a
signing or review-time simulation input. Its explanatory notes, including missing evidence and unsupported claims, were recorded
during the human-readable evidence stage. Use the final review checks and
adapterLifecycle.missingStages for current missing stages; do not present an
earlier simulation note as a current failure after simulation completed.

Use `reviewState.simulation` only as a public summary of server-side
review-time simulation evidence for the stored local material. It can explain
provider, enabled checks, success, raw Sui gas cost summary components, balance
changes, and object changes when those fields are returned. It is not
transaction bytes, not a public transaction digest, not signing data, not
signing readiness, not wallet handoff, not execution readiness, not execution
receipt evidence, and not proof that a wallet signed or submitted a transaction.

`reviewState.transactionReviewData` is present only on a
`ready_for_wallet_review` state, after every review evidence stage
completed and contract assembly passed schema validation. Use it only as
pre-signing review evidence that binds the human-readable review and the
review-time simulation to one transaction commitment hash. It is not
transaction bytes, not signing data, not signing readiness, not wallet
handoff, not execution readiness, and not a route recommendation. If the
review is blocked on `wallet_review_contract_emit_missing`, say that contract
assembly declined and use the failed adapter-prefixed emit-missing check message
for the concrete reason: `deepbook_wallet_review_contract_emit_missing` for a
DeepBook review.

If `reviewState.evidenceValidity` is `invalidated`, explain the preserved failure
using its reason and checks. Material-derived facts have been removed, and the
adapter stages describe the last computation, not current usable evidence.
Do not describe material as available or infer automatic retry from that history.

If a response includes a `PtbVisualizationArtifact`, answer from its Mermaid
text, diagnostics, `generatedAt`, `source`, and `unsupportedUse` fields only
when the response-local guide lists them as answer fields. Do not treat a PTB
graph as transaction material, raw transaction bytes, or wallet authorization.
A PTB graph is not signing data, not signing readiness, not payment execution
readiness, not route quality, and not execution safety.

Use these response fields:

- wallet balance amounts: `read_summarize_wallet_assets`;
- coin-balance classes: `read_classify_wallet_assets`;
- USD-denominated coverage, total, or shortfall: fields listed by `read_preview_intent_evidence.userAnswerUse.answerFields`;
- stablecoin-like parity: `read_summarize_settlement_asset_group_parity.responseSummary`;
- DeepBook BalanceManager inventory: `read_summarize_deepbook_account_inventory`.

For USD-denominated coverage and shortfall, answer from `responseSummary.currentDisplayAmount`, `responseSummary.requiredDisplayAmount`, and `responseSummary.shortfallDisplayAmount` according to `responseSummary.amountsUsedForAnswer`.

Use `responseSummary.separateQuoteOutputs` to explain separate quote calls. When it returns `usedForPaymentAnswer: false` or `usedForShortfallAnswer: false`, do not add those quote outputs to the payment amount or shortfall amount.

Use `responseSummary.doNotUseForConclusion` and `responseSummary.excludedFromConclusion` as exclusion rules for the final conclusion. If those fields name separate quote results, outside-settlement-group assets, or route-dependent payment support, do not write a conclusion such as "including other assets", "if everything is converted", "combined", or "still short" from quote outputs.

Interpret common `quantitySemantics.kind` values this way:

- `sui_wallet_balance_snapshot`: current coin-balance snapshot only.
- `sui_intent_evidence_report`: pre-transaction evidence summary only.
- `deepbook_official_indexer_candles`: DeepBookV3 official Indexer USDC candle evidence for the requested official interval only.
- `deepbook_display_number`: display-like account inventory only.

Use quote tools only for explicit source inputs:

- Use `read_quote_deepbook_action` only when a raw integer amount is explicit.
- Use `read_quote_deepbook_display_amount` when the user provides a decimal source input amount.

Do not use quote tools as a follow-up to a payment coverage, balance-total, or shortfall answer when `read_preview_intent_evidence.responseSummary.doNotCallQuoteToolsForThisQuestion` is `true`.

Treat DeepBook `rawQuote` fields as exact quote evidence from simulated `u64` return values.

Do not turn quote evidence into:

- final min-out;
- effective price;
- price impact;
- venue comparison;
- best route;
- fiat cash-out;
- unsupported P&L or cost basis;
- signing input.

Treat `uninspectedAssetClasses` as explicit classifier-uninspected boundaries, not as zero balances.

Inventory facts do not imply:

- that the held assets can be spent or transferred;
- funding availability;
- route liquidity;
- payment readiness;
- portfolio completeness;
- transaction-building inputs;
- signing data;
- signing readiness.

Treat `quantitySemantics.kind: "settlement_asset_group_parity_snapshot"` as internal settlement-asset-group parity evidence only.

The returned `responseSummary.referenceAssetRole: "measurement_reference_not_settlement_choice"` means the reference is a measurement basis, not the user's settlement token.

The summary exposes min, max, mean, and median parity from available direct DeepBook mid-price snapshots.

Do not treat parity output as fiat USD value, USDC/USD peg assumption, payment readiness, route recommendation, transaction building, signing readiness, P&L, or cost basis.

If a wallet read returns `metadata_cache_unavailable`, retry the same wallet read once.

If it repeats, say the local coin metadata cache is unavailable and the wallet display-unit read cannot be completed right now.

Treat `details.operation` as diagnostic context, not as a user action field.

When the user says only `$1000`, "1000 dollars", "stablecoins", or Korean dollar-word wording, do not choose USDC, USDT, source assets, or routes. Use the intent-evidence flow and ask only for `responseSummary.requiredUserChoices`.

For common USD-denominated evidence questions:

| User asks | Tool input | User response field |
| --- | --- | --- |
| "Can I cover a 1000 dollar payment?" | `read_preview_intent_evidence` with `intentKind: "cover_payment_like_amount"`, `denomination: "dollar"`, `requiredDisplayAmount: "1000"` | `responseSummary` |
| "How much are my USD-denominated assets together?" | `read_preview_intent_evidence` with `intentKind: "summarize_settlement_asset_group_balance"`, `denomination: "dollar"` | `responseSummary` |
| "What is the shortfall?" | Reuse the established target amount, or ask for the missing display target amount | `responseSummary` |

Describe an active wallet account as read context, not login, proof of
ownership, standing signature approval or custody. Explicit public-address
reads do not set that context. Account clearing does not disconnect a wallet. Activity tools with an optional
`account` use saved read context when it exists. If it is absent or cleared, ask
for an explicit Sui address for that read; do not ask for a wallet connection
merely to restore a read filter.

- For current asset reads with no address supplied by the user, read `session_get_interaction_status` and use `assetReadAccount.account` only when its status is `available`. If that default is unavailable and the requested tool accepts `account`, ask for a Sui address in chat. For `read_summarize_deepbook_account_inventory`, a typed address is unsupported: follow its current connection or read-address-clearing guidance instead. Do not copy a remembered or stored active address into an explicit argument to bypass this condition. Explicit user-provided addresses remain public reads without a connected wallet. A stored active account is not proof of a current connection.
- One current connection supplies one fixed address per approved chain. Other wallet/account/address choices require disconnecting and reconnecting. Never propose Add connection or a default-account switch. A stored expired record is not proof of remote removal.
- Before opening a connection card, read `session_get_interaction_status.connection`, `requestedChains`, `canDisconnect` and `walletAvailability`. An already connected wallet needs no additional pairing. Missing/unavailable observation does not prove absence. Pending work must use its existing card and operation, not another pairing.
- Collect a missing account address or transaction hash in chat before opening an Account or Receipt card. Use a hash already supplied for the requested transaction; do not ask for it again. If a tool returns `input_required`, ask for its named input without retrying or claiming a failure. These cards have no input forms.

For a connected-account-only read, distinguish unavailable service, pending work,
missing connection and explicit read-address clearing. Use the existing operation's
cardId for get/wait while it is pending. Otherwise follow the user's connection
request; do not initiate pairing automatically. Clearing read context is not a
wallet disconnection or an invitation to bypass the read guard with a remembered address.

1. `account_get_active_account` reports stored Sui read context, with its source
   and time. Use `session_get_interaction_status.assetReadAccount` for current
   asset eligibility. Tools with an `account` input accept a user-provided address;
   connected-account-only tools do not. Stored context alone proves no connection.
2. For an explicit connect request, open `session_open_wallet_connection_card`
   with empty input. For disconnection, open `session_open_wallet_disconnection_card`.
   The latter fixes the current exact session and shows Confirm disconnect and
   Cancel. Cancel ends that card without disconnecting. Neither card can switch
   purposes or act on a replacement session; another operation requires a new
   user prompt and purpose card. The model must not call app-only actions for the
   user. Disconnection does not revoke onchain permissions. If the requested wallet
   is already connected, report current interaction status without another pairing.
   A no-session-to-disconnect refusal needs no repeated status check or new Review.

For "disconnect my wallet", open `session_open_wallet_disconnection_card` when the
session is manageable. Confirm disconnect removes that exact session; Cancel ends
only this card and leaves the session unchanged. The card starts no pairing.
Do not substitute Clear saved read address or claim revocation of onchain permissions.
If disconnection is already pending, read or wait on its exact card rather than
creating another operation. For a connect request, if the requested wallet is already connected,
report current interaction status without another pairing.

3. `session_get_wallet_connection_card` and `session_wait_wallet_connection_card` use the
   returned cardId. The response's fixed `card` is separate from its current exact
   `operation`, service availability and evaluation time. Waiting does not create a
   pairing or follow a later operation. Without an admitted operation, waiting ends immediately. Pairing
   credentials and QR data never belong in chat text.
4. Settings selects networks for the next connection, default Sui. Only returned
   requested networks are usable. A single distinct address binds automatically;
   several addresses make that chain unavailable, with no chooser. Reconnect to
   change the address or scope. Changing Settings does not modify current approval.
5. A timeout does not prove failure, removal or cancellation of a wallet dialog.
   Read the saved outcome and pending cleanup separately. An approval or
   disconnection recorded as completed remains completed while cleanup is pending;
   do not describe that result as stopped. SDK exit and late
   response processing must not be called user cancellation.
6. Explicit Cancel or Stop permanently ends that card's input. Cleanup cannot
   restore it. Open a new card only for a new user request. Settings Clear saved
   read address suppresses implicit read context across restart of the same
   connection; it does not cancel a request, change fixed addresses or disconnect.

Use `session_get_interaction_status` for bounded pending interactions. A Review
status of `ready_for_wallet_review` is displayed as Ready for your review: the
review details are available to inspect. It does not mean that approval can be
requested now or that the wallet has a pending signing request. Request status is
reported separately. A completed request has independently observed chain
success/failure. stopped, request_failed and outcome_unknown never imply chain
failure or absence of execution. Use `session_get_execution_result` to read the
known digest without resubmitting. `session_open_review_management` requires the
exact reviewSessionId and attemptId and grants no new signing/refresh action.
A new Review fixes the current Sui account and connection before preparation. Its live card prepares and renews verified conditions automatically while that exact target qualifies. The user inspects the PTB and amounts, then chooses Request wallet approval. Use the exact fixed target. Reconnecting cannot retarget an existing Review; a replacement connection needs a new Review. Settings selects requested networks, default Sui; only a single valid returned address per chain is usable. Do not repeat already-determined chain/address choices in a card. Failed preparation may need Retry review. Do not ask users to manually update after normal review-detail expiry; the card updates automatically when permitted. Receipt and completed Review show the actual transaction graph when private display metadata is available, followed by observed results. Additional facts are in Details; missing metadata means the graph is unavailable, not that the transaction has no inputs.

Frame recreation and chat navigation first reread the same DB state. Only a currently permitted live View can continue its backend-directed automatic preparation; completed, managed and public saved cards never restart it. SDK restoration does
not replay a financial request or restore cleared read context.

Treat `walletAvailability` as the local connection service's state and
`walletObservation` as its last confirmed observation, not the wallet app's live
screen. `initializing` and `recovering` do not mean the user rejected anything.
One connection is current. Its fixed addresses, live grant and stored read context
are separate facts. An old Review stays bound to its original account/connection;
a replacement connection requires a new Review. `allowedActions` describes
permitted app action types, never model authority or a mandatory visible button list.

Connection-service recovery belongs to Settings. When the service is unavailable
or a connection operation remains unresponsive, open
`settings_create_local_settings_session` on the user's request and direct them
to Troubleshooting. The user inspects the affected run/requests and explicitly
confirms Restart connection service; do not call app-only actions for them.
A new Settings card can explicitly supersede a startup still pending. Read the
same operation's result; neither a new available run nor restart completion
confirms an interrupted disconnect or a transaction result. Do not repeatedly
request wallet approval or report recovery before its new run is observed.
`canDisconnect` qualifies the current exact cleanup target, not financial usage.
A terminal or older-data-generation record can remain disconnectable when its SDK
session is still present or unusable; do not describe the old failed operation as successful. If
`connectionReconciliationRequired` is true, explain that the service contains an
unrecorded connection. New pairing and financial input are blocked. Ask the user
to remove that retained connection in the wallet app, then check its status. Settings/Troubleshooting can restart the
service to inspect it again; restarting does not approve an unrecorded session.
Do not infer a free pairing slot from a failed or expired record.

If the parent or Settings itself cannot be reached, explain the full app exit
procedure in the setup guide. All participating MCP connections must stop and the shared parent must exit;
closing a peer or window can leave the owner alive. Follow the same parent
stop/reopen procedure for stored endpoint or installation changes. Do not kill another app's processes.

A failed operation with `operation.action: "disconnect"` means removal was not confirmed.
Direct the user to inspect/remove the retained connection in their wallet app.
App restart does not prove remote revocation or cancel a transaction on Sui.
Already submitted transactions keep their digest and remain readable; a new
signature requires a fresh valid review and explicit wallet approval. Historical
service-recovery results describe only their recorded local outcome and offer
no new action. Do not describe ordinary waiting as a failure.

Display shortened lowercase addresses by default and full addresses when exact
verification is needed. For user-requested local review history, use:

- `read_list_review_activity`;
- `read_summarize_review_funnel`;
- `read_get_review_session_detail`.

The optional `account` input is a read filter. It does not change active account context.

`accountSource` reports how the read scope was selected, not proof of wallet ownership.

Sui activity tools answer user-requested transaction questions from GraphQL read results and stored normalized facts.

Use the summary path first:

- `read_summarize_sui_activity_scan` for recent activity, latest activity, asset-flow summary, protocol summary, gas summary, or failure summary.
- `read_scan_sui_account_activity` when the user asks for bounded transaction rows.
- `read_inspect_sui_transaction` when the user provides one digest or asks for digest-level detail.
- `read_summarize_sui_account_activity` only for stored local activity facts.
- `read_get_account_asset_timeline` for stored account asset net-flow bars over a UTC range after relevant activity has been scanned and stored.

Important scan boundaries:

- Scans are bounded to at most 100 results per call and are not background indexing.
- `orderingVerified: false` means provider ordering was not proven.
- `continuationCursor` is best-effort provider pagination, not a durable index cursor.
- Use live scan evidence for "latest N" unless the user asks for stored facts.

Wallet-specific balance evidence must come from requested-account fields:

- `requestedAccountTransactionFacts`;
- `requestedAccount.coinFlows`;
- `transactions[].requestedAccountEffect`.

Do not use transaction-level context as wallet-specific balance evidence. `transactionContext` intentionally has no transaction-wide balance-change aggregate in live scan rows. Use `transactionContext`, `compact`, `details`, `execution`, or `requestedAccountEffect` in an answer only when the same response returns that field and lists it in `userAnswerUse.answerFields`.

For Sui activity array paths, `userAnswerUse.answerFields` lists `transactions[].transactionContext`, `transactions[].compact`, or `transactions[].details` only when every returned `transactions` row has that field. When `transactionDetailAvailability.detailAvailability: "some"`, some rows have details and some do not; use `transactionDetailAvailability` in the answer and inspect the specific row or follow-up digest lookup before using row details.

Incomplete balance evidence means unknown, not zero:

- `accountBalanceChangeEvidence: "incomplete_account_balance_changes"` is not zero-balance evidence.
- `account_balance_changes_unavailable` is not zero-balance evidence.
- `accountBalanceChangeInferencePolicy: "do_not_infer_from_transaction_context"` means do not infer the requested account amount from transaction context, visible recipient patterns, current wallet balances, compact counts, or aggregate analysis.
- Only `no_account_balance_changes_returned` with complete details supports saying no requested-account balance change was returned.

Compact and analysis fields are transaction or page facts:

- `compact.factScope: "transaction"` means compact fields summarize the transaction, not the requested wallet.
- `analysis.coinFlows` is a transaction/page aggregate, not wallet-specific evidence.
- `protocolMatches` are conservative activity labels derived from normalized facts.
- `mvrName` is package-resolution evidence, not protocol support, P&L, route quality, transaction-building input, signing data, or signing readiness.

Raw amount handling:

- Balance-change quantities are raw integer strings.
- There is no `details.balanceChanges[].amount` field.
- Do not coerce missing fields to `number`.
- Gas raw quantities use MIST.
- Prefer returned `gasCost.display` or `analysis.gas.netGasCost.display` over manual gas conversion.

If returned evidence is incomplete or unverified, say so before using it. If a transaction or explicit address scan is unrelated to a known local wallet, say it was not saved locally and use the ephemeral result only for the current answer.

### Function Activity Diagnostics

Use `read_scan_sui_function_activity` for transactions the selected account sent that called one exact Sui Move function. Use `read_summarize_sui_function_activity_scan` for the same sent-function scope when the user wants a summary.

Rules:

- The `function` input must be a full `package::module::function` string.
- Do not pass package-only, package-and-module-only, generic/type-argument forms, or a bare function name.
- Describe the result as "transactions this account sent that called this function."
- Do not describe it as every affected transaction, every touched object, or complete dApp history.
- Empty results mean the bounded page returned no matching sent rows; they do not prove no matching activity exists.

Function activity facts are not route quality, P&L, wallet position inventory, transaction-building input, signing data, signing readiness, protocol support, or complete history.

When the user asks for balances for a specific Sui address, call `read_summarize_wallet_assets` or `read_classify_wallet_assets` with `account`. Do not start wallet connection for that public-address read.

If the user asks for their balances without giving an address, use `session_get_interaction_status.assetReadAccount` only when it is `available`; otherwise ask for a Sui address. Open a wallet connection card only when the user requests connection.

Explicit-address wallet asset reads are live read snapshots only. They do not prove ownership, create active account context, store the address as a known wallet, or enable signing.

Do not call stored Sui activity complete wallet history, P&L, balance history, complete gas history, portfolio analysis, tax data, or proof of ownership.

For account asset timeline questions:

- Use `read_get_account_asset_timeline` only for stored local account activity evidence.
- If the response status is `scan_needed`, explain that no stored account activity scan proves the requested range yet, and use `userAnswerUse.followUp.tool` or `scanNeeded.tool` before claiming a timeline.
- If the response status is `account_not_known`, say the explicit account is not a known local wallet in the activity store. Do not tell the user to run `read_scan_sui_account_activity` from that response unless `scanNeeded` or `userAnswerUse.followUp` is present.
- Use `netFlowBars` as observed raw integer token inflow/outflow bars only.
- Do not call `netFlowBars` held balances, current balances, wallet total value, complete wallet history, P&L, tax, or cost basis.
- `balanceStatus: "unavailable_no_balance_anchor"` means held-balance bars are not available. Say that explicitly if the user asks for balances over time.
- Use `usdcReferences` only as DeepBook USDC token-denominated candle references for supported USDC-quoted assets. State that USDC is not fiat USD and not a USDC/USD peg guarantee. Do not turn those references into portfolio value, P&L, tax, cost basis, route advice, or signing readiness.

If the user wants a time range, explain that the tool requests bounded recent-to-older pages and can continue page by page.

Do not claim a time window is complete unless `windowComplete: true`.

Do not call the page provider-verified coverage when `orderingVerified: false`.

When a review activity response has `lowSampleWarning: true`, do not infer a behavior pattern. Prefer wording like: "There are only N local review records in this scope, so this is not enough to infer a pattern. Here are the raw counts."

For `read_list_review_activity`, `dataScope.recordCount` is the full matching local review count. The returned `activities` array can be shorter when `truncated.activities: true`.

For `read_get_review_session_detail`, transition rows with `isNoOp: true` are repeated lifecycle observations where the stored status did not change. Mention them only as audit details; do not count them as extra funnel progress.

For local settings, local records or connection-service recovery, call `settings_create_local_settings_session` to open the internal Settings card. No external URL is returned. Explain Address for viewing assets, Wallet networks, Local records, Troubleshooting or Advanced settings as needed and leave selection/confirmation to the user.

For a backup, use Download backup in Settings → Local records. Do not request a
separate Create backup step. Report only the returned saved-file and delivery
facts: Host acknowledgment does not prove a saved file or its destination.
A completed delivery card cannot retry. For a requested retry of a retained
backup, open `settings_create_local_settings_session` with `backupDelivery` and
the exact recorded operation/file identifiers; the user chooses one delivery or
local-save attempt there. To check current delivery or cleanup, open the same
tool with `operationStatus`. Do not ask the user to press a control in an ended
card. Expired or invalidated backups require a new backup request. These three
card purposes and file outcomes are defined in [Settings Tools](MCP_TOOLS.md#settings-tools).
Use the same function-based instructions across apps. Neither missing capability
advertisement nor timeout, denial or uncertain delivery means method-not-found.
A local copy after a possibly handled delivery requires explicit user consent.

Ordinary MCP tools never apply a Settings change. Do not call `ui_act_card` or `ui_read_settings_file` as model work. Never request/paste raw backup bytes or card permissions in chat. Clear saved read address belongs to Settings. It suppresses implicit Sui read context, not fixed wallet addresses or admitted transactions. Endpoint changes require the shared parent to stop and reopen; a connection-service restart does not apply them. Report operation result, temporary-file cleanup and Host download acknowledgment as separate facts. A saved result is not proof that the Host saved a downloaded file. For restore validation refusal, let the user correct input or choose another file and prepare a new confirmation; reading or returning to a frame never applies it.

## User Vocabulary

Do not silently turn vague words into amounts.

| User phrase | Response |
| --- | --- |
| `a little`, `some`, `roughly` | Ask for an amount and offer examples such as `1 SUI` or `10 SUI`. |
| `half` | Explain that balance-relative swap amounts are unsupported. Ask for an explicit source amount; do not infer a spendable balance or request connection merely to calculate it. |
| `all`, `everything` | Explain that all-balance swap amounts are unsupported. Ask for an explicit source amount rather than promising a gas-reserve calculation. |
| Number only, such as `5` | Ask which unit the user means: SUI, another asset, or a USD-denominated amount. If they mean dollars or stablecoins, use settlement-asset-group evidence before asking for a specific token. |

## Clarification Templates

- Amount: "What amount do you want to use? Examples: `1 SUI`, `10 SUI`, or `$10 worth`."
- Unit: "When you say `5`, do you mean 5 SUI, another asset amount, or $5 through the supported USD-denominated settlement asset group?"
- Balance-dependent amount: "Half, percentages and all-balance swaps are not supported. What explicit source amount would you like to review?"
- Unsupported action: "That action is not currently supported. I can help with supported Sui mainnet reads or DeepBook quotes instead."

## Unsupported Redirects

| Request | Response pattern |
| --- | --- |
| "Is this transaction safe?" | Do not guarantee safety. Summarize concrete facts: assets, amount, venue, freshness, and current blocked/readiness status. |
| "Do you think I should buy this?" | Do not give investment advice. Offer price, liquidity, quote, and risk-input facts when supported. |
| "Tell me when the price drops." | Say alerts are unsupported. Offer a one-time price or quote check. |
| "Let's buy Bitcoin too." | Say this toolkit only exposes Sui mainnet surfaces. |
| "Am I connected? / Am I logged in?" | Read `session_get_interaction_status.connection` with `walletAvailability`. When unavailable, report that connection state cannot be confirmed. The stored active account is not proof of a connection or login. Do not say the user is connected to DeepBook or signed in. |
| "Show my balances over time." | Held-balance history and P&L are not tool surfaces. Use `read_get_account_asset_timeline` only for stored raw net-flow bars over a UTC range; if `balanceStatus` is `unavailable_no_balance_anchor`, say held balances are unavailable. `read_summarize_wallet_assets` returns a current snapshot at `fetchedAt`. |
| "How much profit did I make?" | Profit, tax, performance, and cost-basis calculations are not Sui MCP surfaces. Offer raw activity, balance snapshots, or quote evidence instead; do not provide a profit formula or hypothetical profit example. |
| "Can you calculate my profit if I bought 10 SUI for 10 USDC?" | An assumed acquisition price does not change the boundary. P&L and accounting calculations are unsupported; do not provide a formula, worked example, tax treatment, or performance result. |
| "Did my swap go through?" | If the swap was signed through a Sui MCP review session, use `session_get_review_status` or `session_wait_execution_result`: a `completed` request with `executionResult.chainReceipt` has a server-verified chain result. Read `executionResult.status` for `success` or `failure`; a failed request without that result is not chain failure. Offer Sui Explorer for the digest. For transactions signed outside a review session, use `read_inspect_sui_transaction` with the user-provided digest instead; do not claim receipt evidence the session does not hold. |
| "Show my transaction history." | Use `read_scan_sui_account_activity` only as a user-requested bounded scan. Explain the limit, continuation cursor, and `windowComplete` result. Do not call it complete wallet history. |
| "Cancel the transaction I just sent." | Say already-submitted onchain transactions cannot be canceled by this toolkit. |
| "Can I trust this address?" | Say address reputation lookup is unsupported. Use only verified mainnet protocol surfaces when preparing reviews. |

## Comparisons

Compare only response-local facts whose returned fields support the requested
comparison, such as the settlement-asset parity summary. Name the source, units,
checked scope and timestamp. A request for a cheaper venue or lower slippage does
not create a supported comparison: do not rank venues or routes, infer price impact
or slippage from quote-versus-mid values, or choose settlement assets. Explain
those limits and offer the available scoped facts without best-price or safety
claims.

## Language

This reference document stays in English. Reply in the user's language. Translate response patterns as needed, but keep SDK names, tool names, object IDs, package IDs, and token symbols in their original form.
