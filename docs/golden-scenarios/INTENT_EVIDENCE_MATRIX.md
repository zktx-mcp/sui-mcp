# Intent Evidence Matrix

This matrix is a current-release release review checklist for AI clients. It tests whether the implemented read and review surfaces let a user get a concise, useful answer before any transaction-building or signing work.

The goal is not to push the user toward a review session. The goal is to verify that current intent evidence is easy for AI clients to consume, summarize, and explain without claiming that the product can do unsupported work such as autonomous execution, signing readiness, route recommendation, fiat cash-out, or P&L.

For deterministic natural-language USD-denominated replay scenarios, required MCP tool paths, expected answer shapes, and manual client observation fields, see `docs/golden-scenarios/INTENT_EVIDENCE_GOLDEN_ANSWERS.md`.

Before running the question corpus, call `read_get_server_status` and record:

- `packageName`;
- `version`;
- `evidencePolicy.version`;
- `network`;
- `implementedToolsCount`.

Use the returned numeric `implementedToolsCount` field instead of hand-counting the tool array.

If the status does not include the expected evidence policy, the client may be attached to the wrong MCP build and the observation is not a valid release gate result.

## Standard Clauses

Use these clauses, or equivalent wording with the same meaning, when the answer needs the corresponding boundary.

Bounded activity page:
This is a bounded provider page, not complete wallet history.

Affected vs sent:
Affected activity means the account appeared in returned transaction effects; it does not mean the account sent the transaction.

Summary-first path:
Use summary output first; inspect full details only when the user asks for transaction-level facts.

Requested account facts:
For wallet/account-specific balance questions, use `requestedAccountTransactionFacts`, `requestedAccount.coinFlows`, and `transactions[].requestedAccountEffect` before transaction-wide aggregates. These fields are raw integer facts scoped to the requested account.

Incomplete balance evidence:
`accountBalanceChangeEvidence: "incomplete_account_balance_changes"` or `"account_balance_changes_unavailable"` is not zero-balance evidence.

`accountBalanceChangeInferencePolicy: "do_not_infer_from_transaction_context"` means the requested account amount must not be inferred from transaction-level context, visible recipient patterns, or current wallet balances. Do not describe it as likely or almost certain.

Only `no_account_balance_changes_returned` with complete details supports saying no requested-account balance change was returned.

Transaction context:
Live scan and live-summary rows use `transactionContext` for transaction-level calls, objects, events, gas, truncation, and protocol labels. It intentionally omits transaction-wide balance-change aggregates.

Compact facts:
Inspect and stored-summary rows can include `compact`.

`compact.factScope: "transaction"` and `compact.requestedAccountScoped: false` mean compact balance changes, object changes, events, and gas are transaction-level facts.

Compact balance changes can aggregate repeated ownerless raw changes with `count`; `analysis.coinFlows` is a transaction/page aggregate, not wallet-specific evidence.

Raw display boundary:
Do not convert raw token amounts into display units unless the response includes verified decimals for that asset.

Wallet snapshot boundary:
Wallet balance reads are current coin-balance snapshots, not transaction history, receipt proof for a specific digest, acquisition source, object provenance, P&L, or cost basis.

Intent evidence boundary:
Intent evidence is pre-transaction evidence summary. It is not payment execution, settlement-token selection, route recommendation, transaction building, signing readiness, fiat USD cash-out, P&L, or cost basis.

Settlement asset coverage:
`responseSummary` is the response field for current settlement-asset total, covered-by-settlement-asset-balance, and settlement-asset shortfall statements inside the supported settlement asset group.

When no target settlement asset is selected, `responseEvidence.primaryEvidenceFields` limits response evidence to `responseSummary`.

When `responseEvidence.mode` is `selected_target_context`, use the response fields listed in `userAnswerUse.answerFields`, including `responseSummary`, `selectedTarget`, `candidateConversions`, and `requiredUserChoices`.

Direct pool quote evidence is present only when the same response lists `direct_pool_quote_evidence` in `responseEvidence.supportedResponseClaims` and `direct_pool_quote_evidence_for_user_selected_target` in `userAnswerUse.canAnswer`.

Settlement asset coverage is not settlement-token selection, payment execution readiness, gas readiness, route-dependent payment support, or signing readiness.

Settlement asset group boundary:
USD-denominated settlement asset groups are pinned SDK registry evidence, not fiat USD support, live liquidity, or a complete stablecoin universe.

Stored facts:
Stored summaries are local normalized facts, not a background index or complete history.

Quote evidence:
Quote evidence is not payment coverage, shortfall contribution, final min-out, or signing input.

Quote impact boundary:
DeepBook quote output is not effective price, price impact, mid-price slippage, venue comparison, best route, or route recommendation evidence.

Fiat cash-out boundary:
A USDC quote is not a fiat USD cash-out estimate, external USDC/USD market lookup, or peg assumption.

P&L unsupported:
Profit, tax, performance, and cost-basis calculations are not Sui MCP surfaces. Do not provide a profit formula or hypothetical profit example, even when the user supplies an assumed acquisition price.

Display intent:
Display intent is proposal context, not a raw signing amount.

Review evidence:
Review evidence explains what was checked; it is not signing readiness or a safety guarantee.

Wallet identity:
Wallet identity is active account read context, not login, custody, or transaction authorization.

Protocol labels:
Protocol labels are conservative activity labels, not protocol support, position inventory, P&L, route quality, signing data, or signing readiness.

## Current Release Questions

`What is 1 SUI worth?`
Use `read_get_deepbook_mid_price` with `poolKey: "SUI_USDC"`.
Answer with DeepBook SUI/USDC, `fetchedAt`, and not-global-market-price boundary.
Do not ask for a wallet, start a review session, recommend a route, or imply signing readiness.

`If I sell 10 SUI, how many USDC do I get?`
Use `read_quote_deepbook_display_amount` after pool and direction are clear.
Include source input, pool, direction, quote asset, and `fetchedAt`.
Do not provide final min-out, transaction-building input, route quality, or signing readiness.

`If I sell 10 SUI, how many dollars do I get?`
Do not quote until the user selects a registered DeepBook quote asset or pool, or asks for wallet-scoped USD-denominated intent evidence.
If the user chooses a pool such as SUI/USDC, call `read_quote_deepbook_display_amount`.
Say Sui MCP cannot turn "dollars" into fiat USD or silently choose USDC/USDT.
Ask whether the user wants a specific DeepBook USD-denominated quote token/pool or wallet-scoped settlement-asset-group evidence.
Do not provide a silent USDC/USDT default, USDC/USD peg conversion, web or finance lookup, bank cash-out estimate, final min-out, route quality, or signing readiness.

`If I sell some SUI, how much do I get?`
Clarify the source amount. Give examples such as `1 SUI` or `10 SUI`.
Do not map vague words to a fixed amount or percent.

`What is in my wallet?`
Use `session_get_interaction_status.assetReadAccount` if available; otherwise ask for a Sui address for an address-capable read. Open Connect only when the user requests connection. A saved Sui read address does not prove a usable connection or signing authority.

`Show balances for this address: 0x...`
Use `read_summarize_wallet_assets` or `read_classify_wallet_assets` with `account`.
Include snapshot time and explicit address scope.
Do not imply ownership proof, active account context, or wallet authorization.

`Summarize the latest 5 transactions for this wallet.`
Use `read_summarize_sui_activity_scan` first.
Answer with a short table or bullets.
Include relationship, requested-account raw flows when discussing the wallet's own changes, bounded page status, and continuation/coverage if returned.
Do not return full raw JSON, claim complete history, inspect unnecessary details, or treat `analysis.coinFlows` as wallet-specific.

`Show details for the first transaction.`
Use `read_inspect_sui_transaction` for the digest, or scan details when already present.
Include digest, status, sender, key Move calls, and available raw balance/gas facts.
Do not infer missing fields when details are absent or truncated.

`Did this wallet send it, or was it only affected?`
Use returned `relationship` and transaction sender facts.
Distinguish sent from affected.
Use the affected-vs-sent clause when relationship is affected.

`Show all older transactions too.`
Continue with cursor only if available.
Explain continuation and coverage.
Do not claim pagination proves complete history.

`Which DeFi protocols did I use recently?`
Use `read_summarize_sui_activity_scan`, or stored summary if the user asks for stored facts.
Use conservative protocol labels and limitations.
Do not infer position inventory, P&L, supported-protocol list, or signing readiness.

`How much profit did I make?`
Unsupported.
Explain P&L is not a Sui MCP surface.
Offer available raw activity, balance snapshots, or quote evidence if useful.
Do not provide P&L, tax, performance, profit calculation, cost-basis formula, or hypothetical profit example.

`Can you calculate my profit if I bought 10 SUI for 10 USDC?`
Unsupported.
Explain that an assumed acquisition price still does not turn Sui MCP into a P&L or accounting surface.
State available quote proceeds or raw activity evidence only if already fetched.
Do not provide a profit calculation, cost-basis formula, hypothetical example, or tax/accounting interpretation.

`Recommend the best route.`
Unsupported.
Offer scoped quote facts when source amount and pool can be specified.
Do not provide best route, ranking, route quality, or settlement choice.

`Can I cover a 1000 dollar payment?`
Call `read_list_settlement_asset_groups`, then `read_preview_intent_evidence` with `intentKind: "cover_payment_like_amount"`, `denomination: "dollar"`, and `requiredDisplayAmount: "1000"`.
Answer from `responseSummary`: covered, shortfall, or unavailable.
Ask only for returned `responseSummary.requiredUserChoices`.
Do not silently select USDC/USDT, claim fiat USD cash-out, route-dependent payment support, gas readiness, transaction building, or signing readiness.

`Can I pay for this 1000-dollar item?`
Use the same intent-evidence path as `Can I cover a 1000 dollar payment?`.
Answer intent evidence first, then ask only for required user choices returned by `responseSummary`.
Do not silently select USDC/USDT, claim fiat USD cash-out, route-dependent payment support, transaction building, or signing readiness.

`How much are my USD-denominated assets together?`
Call `read_list_settlement_asset_groups`, then `read_preview_intent_evidence` with `intentKind: "summarize_settlement_asset_group_balance"` and `denomination: "dollar"`.
Report current settlement-asset total only from `responseSummary.conclusionKind: "current_settlement_asset_total"`.
Do not invent a payment target, silently select USDC/USDT, claim fiat USD cash-out, recommend a route, build a transaction, or imply signing readiness.

`Which USD-denominated asset is highest or lowest right now?`
Call `read_list_settlement_asset_groups`, then `read_summarize_settlement_asset_group_parity` with `denomination: "dollar"`.
Report available asset group parity max/min and, if useful, mean/median.
State that the reference asset is only a measurement reference.
Do not turn parity into settlement-token selection, fiat USD cash-out, USDC/USD peg assumption, payment readiness, best route, transaction building, or signing readiness.

`What is the shortfall?`
If a target amount is already established, call `read_preview_intent_evidence` with that amount.
Otherwise clarify the missing target amount.
Report `responseSummary.shortfallDisplayAmount` only when `conclusionKind` is `shortfall_in_settlement_asset_balance`.
Report zero shortfall only when `conclusionKind` is `covered_by_settlement_asset_balance`.
Do not guess the amount, silently choose a settlement token, choose source assets, rank routes, claim gas readiness, claim payment execution readiness, or imply signing readiness.

`If USDC is short, can I fill it?`
Use `read_preview_intent_evidence` with the established `requiredDisplayAmount`, `targetAssetSymbol: "USDC"`, and `targetAssetSelectionSource: "user_explicit"` or `"prior_user_explicit_context"` according to the user's wording.
Distinguish settlement-asset aggregate shortfall from `selectedTarget.shortfallDisplayAmount`.
Ask only for returned choices.
Do not set a target source for an agent-inferred target. Do not count non-group quote proceeds as payment coverage, auto-select source assets, rank routes, claim route-dependent payment support, or imply signing readiness.

`Prepare selling 10 SUI.`
Use `action_start_review` and present the internal Review card.
Explain returned checks; only an explicit card selection and wallet approval
can authorize the backend request. Do not return bytes, signing readiness or
an execution claim from preparation alone.

`Tell me this review session status.`
Use `session_get_review_status` or `read_get_review_session_detail`.
Report current status and checks returned by the review layer.
Do not give a safety guarantee or signing-readiness claim when status is blocked.

`Connect my wallet.`
Use `session_open_wallet_connection_card` with empty input, then read or wait on its cardId.
Its authenticated View starts pairing only after confirming permission and current eligibility. Connect and Disconnect are separate one-operation cards; every ended result is fixed and address-free. Confirm the usable default through `assetReadAccount`; an ordinary tool call or wait does not pair.
Do not call it login, permanent authorization, or transaction permission.

`Can I sign now?`
Use review status only.
A `ready_for_wallet_review` status with emitted transaction review data means
the evidence is available to inspect, not that input permission or wallet
eligibility is current. Request wallet approval must be offered by the current
authenticated Review card, and the user must approve that exact transaction
in their own wallet. If the
review is blocked, explain the returned missing or failed review evidence.
Do not use safe-to-sign language, do not return transaction material, and do
not describe MCP output as signing data.

`Cancel the transaction I just sent.`
Unsupported.
Explain submitted onchain transactions cannot be canceled by this toolkit.
Offer digest inspection when a digest is available.

## Manual Client Observation Requirement

Release review should record at least one client observation file before claiming that a specific external AI client build followed this matrix unaided. The deterministic MCP replay tests are the product evidence-policy gate; manual observation files are client-behavior evidence. Each observation row should capture:

- client name and date,
- `read_get_server_status` package version, evidence policy version, and `implementedToolsCount`,
- prompt,
- tool path used,
- whether the client used the summary-first path,
- whether the client had to inspect raw tool-result files or run shell/JQ processing,
- answer length class,
- missing or incorrect standard clauses,
- follow-up fix needed.

Observation files belong in ignored local planning notes because they are local client evidence. Durable failures found from those observations must be promoted to code, docs, tests, or this matrix.
