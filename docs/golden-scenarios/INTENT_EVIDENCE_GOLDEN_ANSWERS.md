# Intent Evidence Golden Answers

This document records the expected answer reference for the deterministic intent-evidence replay scenarios. It is a release-review reference for AI clients, not a transcript of live Claude, Codex, Cursor, or other client runs.

The deterministic source of truth is `test/fixtures/intentEvidenceScenarios.ts`.

It owns:

- exact prompts;
- MCP tool path;
- tool input;
- expected evidence fields;
- forbidden claims.

Korean prompt text is stored there with Unicode escapes. That keeps repo-visible test prose in English while the Korean dollar-word alias remains covered by tests.

## Required Status Check

Before judging any client answer, call `read_get_server_status` and record these fields:

| Field | Required meaning |
| --- | --- |
| `packageName` | The client is connected to the expected Sui MCP package. |
| `version` | The package build under observation. |
| `evidencePolicy.version` | The evidence policy version used for the answer. |
| `network` | Must be `mainnet`. |
| `implementedToolsCount` | The server-provided implemented tool count; do not hand-count tools. |

If the status call is missing `evidencePolicy.version`, the observation is not valid release evidence.

## Deterministic Replay Scenarios

Each row uses this tool path:

1. `read_get_server_status`
2. `read_list_settlement_asset_groups`
3. `read_preview_intent_evidence`

`korean_dollar_payment_coverage`
Category: Korean USD-denominated payment coverage.
Input: `intentKind: "cover_payment_like_amount"`, Korean dollar alias, and `requiredDisplayAmount: "1000"`.
Expected status: `responseSummary.conclusionKind: "covered_by_settlement_asset_balance"`.
Answer shape: say the current settlement-asset wallet coin-balance snapshot covers the requested display amount. Ask only for `responseSummary.requiredUserChoices`.

`korean_dollar_balance_total`
Category: Korean USD-denominated balance total.
Input: `intentKind: "summarize_settlement_asset_group_balance"` with Korean dollar alias.
Expected status: `responseSummary.conclusionKind: "current_settlement_asset_total"`.
Answer shape: report the current settlement-asset total only. Do not invent a payment target or settlement token.

`korean_dollar_shortfall_with_prior_target`
Category: Korean USD-denominated shortfall with a prior target amount.
Input: `intentKind: "cover_payment_like_amount"`, Korean dollar alias, and `requiredDisplayAmount: "1000"` from prior conversation context.
Expected status: `responseSummary.conclusionKind: "shortfall_in_settlement_asset_balance"`.
Answer shape: report `responseSummary.shortfallDisplayAmount` as the settlement-asset shortfall. Ask only for `responseSummary.requiredUserChoices`.

`quote_detour_shortfall_guard`
Category: USD-denominated payment coverage after extra SUI/NS quote calls.
Input: `read_preview_intent_evidence` for a 1000 dollar target, then separate SUI/USDC and NS/USDC quote calls.
Expected status: `responseSummary.currentDisplayAmount: "278.890119"` and `responseSummary.shortfallDisplayAmount: "721.109881"`.

Allowed conclusion:
Use only the `responseSummary` result:

- current settlement-asset amount `278.890119`;
- required amount `1000`;
- settlement-asset shortfall `721.109881`.

Forbidden conclusions:

- Do not conclude that other assets were considered.
- Do not conclude that everything can be converted.
- Do not conclude that quote outputs can be combined.
- Do not conclude that the account is still short after adding quote outputs.
- Do not use `569.01226` or another quote-combined amount as the shortfall.

Required evidence fields:

- `responseSummary.answerCompleteness.requiredAnswerFields`
- `responseSummary.doNotCallQuoteToolsForThisQuestion`
- `responseSummary.separateQuoteOutputs`
- `quantitySemantics.doNotCombineWithPaymentAnswer`
- `userAnswerUse.followUp.answerFields: ["responseSummary"]`

Answer shape: use `responseSummary` for the current amount and shortfall. Treat the SUI/NS quote outputs as separate price estimates because the required evidence fields say they are not used for the payment amount or shortfall amount.

`explicit_usdc_shortfall`
Category: user-explicit selected target shortfall.
Input: `intentKind: "cover_payment_like_amount"`, `denomination: "dollar"`, established `requiredDisplayAmount`, `targetAssetSymbol: "USDC"`, and `targetAssetSelectionSource: "user_explicit"` or `"prior_user_explicit_context"`.
Expected status: `responseEvidence.mode: "selected_target_context"` and `selectedTarget.selectionSource` matches the input source.
Answer shape: distinguish `selectedTarget.shortfallDisplayAmount` from the settlement-asset aggregate shortfall. Ask only for returned `requiredUserChoices`.

## Required Evidence Fields

For these settlement-asset answers without a selected target settlement asset, `responseEvidence.mode` must be `settlement_asset_only`.

`responseEvidence.primaryEvidenceFields` must be exactly:

- `responseSummary`

The user-facing response should use `responseSummary` only. Other packet fields may be source or diagnostic evidence, but they must not become a settlement-token choice, a route, or signing readiness.

When the response includes `userAnswerUse`, `userAnswerUse.answerFields` is the response-local copy of this answer path.

Selected-target answers are allowed only when the user explicitly selected the target settlement asset.

For selected-target answers, use the fields listed in `userAnswerUse.answerFields`, including `responseSummary`, `selectedTarget`, `candidateConversions`, and `requiredUserChoices`.

Direct pool quote evidence is part of a selected-target answer only when the same response lists `direct_pool_quote_evidence` in `responseEvidence.supportedResponseClaims` and `direct_pool_quote_evidence_for_user_selected_target` in `userAnswerUse.canAnswer`.

`targetAssetSymbol` without `targetAssetSelectionSource` must fail or remain unselected.

Clients must not use `targetAssetSelectionSource` for an AI-inferred target.

Separate quote tool results from SUI, WAL, RWA, or other non-group assets must not be counted as payment coverage or shortfall evidence.

## Standard Clauses

Use equivalent wording with the same meaning:

| Evidence result | Standard clause |
| --- | --- |
| `responseSummary.conclusionKind: "covered_by_settlement_asset_balance"` | Based on the current settlement-asset wallet coin-balance snapshot, the requested display amount is covered. |
| `responseSummary.conclusionKind: "shortfall_in_settlement_asset_balance"` | Based on the current settlement-asset wallet coin-balance snapshot, the settlement-asset shortfall is `<shortfallDisplayAmount>`. |
| `responseSummary.conclusionKind: "current_settlement_asset_total"` | The current settlement-asset wallet coin-balance total is `<currentDisplayAmount>` display units. |
| Any settlement-asset answer | This is pre-transaction intent evidence only, not payment execution readiness, gas readiness, transaction building, or signing readiness. |
| Returned `responseSummary.requiredUserChoices` | Ask only for the missing decisions returned by the evidence report. |

## Forbidden Claims

Client answers for these rows must not claim or imply:

- USDC, USDT, or any other settlement-token selection unless the user selected that target asset.
- USDC equals fiat USD or a fiat USD cash-out estimate.
- Best route, route quality, route-dependent payment support, or venue comparison.
- Gas readiness, payment execution readiness, transaction building, signing data, or signing readiness.
- P&L, profit, tax, performance, or cost-basis calculations.
- Source-asset selection for filling a shortfall.

## Manual Client Observation

Manual Claude/Codex observations should reuse the deterministic replay scenarios and record whether the client followed the expected answer reference. A release observation row should include:

| Field | Required content |
| --- | --- |
| Client | Client name and version when available. |
| Date | Observation date. |
| Status fields | `packageName`, `version`, `evidencePolicy.version`, `network`, and `implementedToolsCount`. |
| Prompt | The exact prompt category or fixture scenario id. |
| Tool path used | Tools called by the client, in order. |
| Response evidence | Whether the answer used only `responseEvidence.primaryEvidenceFields` for the conclusion. |
| Forbidden claim check | Any settlement-token, fiat USD, route, P&L, transaction-building, or signing-readiness leakage. |
| Follow-up | Whether the fix belongs in evidence report fields, MCP/API docs, agent behavior docs, or the client prompt. |

Do not treat a manual observation as stronger than the deterministic MCP replay test. Manual observations show client behavior for a specific client build; the replay test guards the product evidence policy.

Treat a specific client's unaided behavior as unobserved unless a dated
observation for that client build and these scenarios supports the claim.
The deterministic MCP replay test can satisfy the product evidence policy;
manual evidence is needed only for a claim about that client's behavior.
