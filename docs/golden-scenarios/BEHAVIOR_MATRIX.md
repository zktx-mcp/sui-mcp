# Behavior Golden Scenarios

These scenarios document expected response classes for manual release review. They are not Claude, Codex, or Cursor execution results.

For current-release intent evidence checks that compare user prompts, preferred tool paths, standard answer clauses, and manual client observations, see `docs/golden-scenarios/INTENT_EVIDENCE_MATRIX.md`.

For the deterministic MCP replay contract behind Korean USD-denominated coverage, total, and shortfall questions, see `docs/golden-scenarios/INTENT_EVIDENCE_GOLDEN_ANSWERS.md`.

Manual client runs should call `read_get_server_status` first and record the package version, `evidencePolicy.version`, and `implementedToolsCount` before running the question rows.

## Current Release Intent Evidence Corpus

These scenarios translate the internal intent corpus into English release-review prompts.

Current-release intent evidence answers can answer evidence questions without creating route recommendations, payment support, portfolio plans, P&L, transaction material, or signing readiness. Account-bound DeepBook review has a separate local transaction-material build path that is not part of these intent evidence answer rows.

For current asset reads, use the connection-qualified default from `assetReadAccount`, or an explicit Sui address supplied by the user. A stored active address alone is insufficient.

`What is 10 SUI worth?`
Class: `answer_only`.
Use `read_get_deepbook_mid_price` with a disclosed DeepBook SUI quote pool such as `SUI_USDC`.
Use `read_list_deepbook_pools` only when the pool is ambiguous.
Expose DeepBook pool, mid price, quote asset, and `fetchedAt`.
Do not present this as a global market price, route recommendation, settlement choice, or signing readiness.

`If I sell 10 SUI, how many dollars do I get?`
Class: `clarify_or_intent_evidence`.
Do not quote until the user selects a registered DeepBook quote asset or pool, or asks for wallet-scoped USD-denominated intent evidence.
If the user chooses a pool such as SUI/USDC, call `read_quote_deepbook_display_amount`.
Expose source input, missing quote-token or pool choice, fiat cash-out boundary, and available intent-evidence path when account context exists.
Do not silently choose USDC or USDT, infer inverse output-target quotes, use web/finance lookup for USDC/USD, assume the USDC/USD peg, or present fiat cash-out, final min-out, route quality, funding readiness, or signing readiness.

`What can I sell?`
Class: `wallet_asset_read`.
Use active account context or explicit address, then call `read_classify_wallet_assets`.
Expose returned zero/nonzero coin-balance classes, gas asset context, DeepBook token registry matches, and `uninspectedAssetClasses`.
Do not treat staked, locked, DeepBook manager, LP, vault, NFT, object, unsupported, or unknown classes as zero balances or sellable candidates.

`Sell DEEP for USDC.`
Class: `clarify_or_quote_context`.
Ask for a source amount before quoting.
After source amount and pool are explicit, call `read_quote_deepbook_display_amount`.
Use `read_classify_wallet_assets` only for scoped wallet context.
Do not assume amount, choose a route, run inverse quotes, create a review session, or treat DeepBook manager inventory as spendable.

`Make $1000.`
Class: `intent_evidence_with_choices`.
Use `read_list_settlement_asset_groups`, then `read_preview_intent_evidence` when active account or explicit address context is available.
Ask only for choices returned by `responseSummary`.
Do not silently choose USDC or USDT, treat USDC as fiat USD, choose source assets, rank routes, or prepare signing.

`Can I cover a 1000 dollar payment?`
Class: `intent_evidence_with_choices`.
Use `read_list_settlement_asset_groups`, then `read_preview_intent_evidence` with `intentKind: "cover_payment_like_amount"`, `denomination: "dollar"`, and `requiredDisplayAmount: "1000"`.
Expose `responseSummary`, settlement-asset coverage basis, settlement-asset shortfall when available, required user choices, and unsupported payment/signing boundaries.
Do not silently choose USDC or USDT, claim fiat USD cash-out, route-dependent payment support, gas readiness, transaction building, or signing readiness.

`Can I pay for this $1000 item?`
Use the same `intent_evidence_with_choices` path as `Can I cover a 1000 dollar payment?`.
Do not claim fiat USD cash-out, route-dependent payment support, gas completeness, transaction building, or signing readiness.

`How much are my USD-denominated assets together?`
Class: `intent_evidence_total_only`.
Use `read_list_settlement_asset_groups`, then `read_preview_intent_evidence` with `intentKind: "summarize_settlement_asset_group_balance"` and `denomination: "dollar"`.
Expose `responseSummary.conclusionKind: "current_settlement_asset_total"` and current display total when available.
Do not invent a target amount, silently choose USDC or USDT, treat the total as fiat USD cash-out, recommend a route, claim payment readiness, produce transaction material, or imply signing readiness.

`Which stablecoin-like asset is highest or lowest?`
Class: `settlement_asset_group_parity`.
Use `read_list_settlement_asset_groups`, then `read_summarize_settlement_asset_group_parity` with `denomination: "dollar"`.
Expose `responseSummary.referenceAssetRole`, min/max/mean/median statistics, and unsupported boundaries.
Do not treat the reference asset as settlement selection, fiat USD value, peg assumption, payment readiness, route recommendation, transaction material, or signing readiness.

`What is the shortfall?`
Class: `intent_evidence_with_context_or_clarify`.
If a target amount was already established, use `read_preview_intent_evidence` with that amount and answer from `responseSummary`.
If not, ask for the missing target amount.
Do not guess the missing amount, silently choose a settlement token, choose source assets, rank routes, claim gas readiness, prepare signing, or produce transaction material.

`Make it 100 SUI.`
Class: `blocked_with_context`.
Use `read_classify_wallet_assets` only for current coin context when active account or explicit address is available.
Do not create a portfolio target, rebalance plan, source selection, route recommendation, or review session.

`Keep 100 SUI and convert the rest.`
Class: `blocked_with_context`.
Use `read_classify_wallet_assets` only for current coin context when active account or explicit address is available.
Do not infer gas reserve, sell source, route, reserve policy, transaction material, or signing readiness.

`If USDC is short, sell another token to fill it.`
Class: `intent_evidence_with_choices`.
Use `read_preview_intent_evidence` with `targetAssetSymbol: "USDC"` and `targetAssetSelectionSource: "user_explicit"` when active account or explicit address context is available.
Expose selected target shortfall, `selectedTarget.selectionSource`, settlement-asset candidate conversion evidence or quote-unavailable reasons, and required user choices.
Do not set target provenance for an AI-inferred target. Do not auto-pick assets to sell, rank routes, merge non-group quote proceeds into coverage, treat uninspected assets as funding sources, or prepare signing.

## General Behavior Scenarios

`What is 1 SUI worth?`
Class: `answer_only`.
Call `read_get_deepbook_mid_price` with `poolKey: "SUI_USDC"` for Sui MCP verified context.
Answer as DeepBook SUI/USDC mid price at `fetchedAt`, not as the global market price.
Do not use external web data unless the user explicitly asks for non-product market context.
Do not ask for a wallet or push a review session.

`If I sell 10 SUI, how many dollars do I get?`
Class: `clarify_or_intent_evidence`.
Say Sui MCP cannot turn "dollars" into fiat USD or silently choose USDC/USDT.
Ask whether the user wants a specific DeepBook USD-denominated quote token/pool or wallet-scoped settlement-asset-group evidence.
If the user chooses SUI/USDC, answer as a DeepBook SUI/USDC quote at `fetchedAt`.
Do not convert USDC to fiat USD cash-out, assume the USDC/USD peg, or use web/finance lookup unless the user explicitly asks for outside product market context.
Do not present it as a global USD price, route recommendation, price-impact calculation, final min-out, funding readiness, or signing readiness.

`How much do I have?`
Class: `clarify`.
Check `session_get_interaction_status.assetReadAccount`. If no usable default is available, ask for a Sui address for tools that accept `account`. Open Connect only when the user requests connection.

`Connect my wallet.`
Class: `tool_wait`.
Call `session_open_wallet_connection_card` with empty input and present the internal Connect card. Its authenticated View starts one pairing after checking current state; the ordinary tool call or wait does not. Read or wait using its cardId. A connection is account context, not transaction approval or login.
Use `session_get_interaction_status.assetReadAccount` before announcing an implicit read address. One current connection supplies at most one fixed address per returned requested chain. An existing session or unsettled connection work prevents another pairing. Changing wallet, account or approved networks requires confirmed disconnection and a new connection; do not propose Add connection or a default-account switch. A new Review fixes that connection and Sui address before preparation and cannot move to a replacement connection. Settings owns requested networks; clearing its saved read address neither disconnects the wallet nor changes transaction targets.
On `timed_out`, say the wallet connection is still pending, not failed.

`I want to buy $10 worth of SUI.`
Class: `present_options`.
Do not claim a supported buy flow or provide investment advice.
Explain that dollar-denominated intent needs a supported stablecoin and amount unit.
Offer read-only DeepBook quote options and disclose that signing remains blocked.

`Sell a little.`
Class: `clarify`.
Ask for a concrete amount and provide examples.
Do not map vague quantity words to a fixed percent.

`Sell half.`
Class: `clarify`.
Explain that balance-relative swap amounts are unsupported and ask for an explicit source amount. Do not promise a spendable-balance calculation or start pairing to resolve that unsupported input.

`5`
Class: `clarify`.
Ask which unit the user means: SUI, another asset, or a USD-denominated amount.
If they mean dollars or stablecoins, use settlement-asset-group evidence before asking for a specific token.

`Keep it from getting expensive.`
Class: `clarify`.
Ask for a price/slippage limit or explain the default only when a supported action flow applies.

`Is this transaction safe?`
Class: `redirect_unsupported`.
Do not guarantee safety.
Summarize concrete review facts or say a review is blocked/unavailable.

`Tell me when the price drops.`
Class: `redirect_unsupported`.
Say alerts are unsupported and offer a one-time read.

`Let's buy Bitcoin too.`
Class: `redirect_unsupported`.
Say only Sui mainnet surfaces are exposed.

`What happened to the thing from before?`
Class: `clarify`.
Ask for the `reviewSessionId` unless a recent-session feature exists.

## Manual Client Results

No client observations are recorded in this matrix. Release checks can record Claude, Codex, or Cursor observations in an ignored local result file and promote durable failures to `docs/golden-scenarios/INTENT_EVIDENCE_MATRIX.md`, product docs, tests, or code.
