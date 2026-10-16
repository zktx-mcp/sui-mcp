import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { unnegatedClaims, unsupportedJsonRpcClaims } from "./helpers/documentClaims.js";

import {
  DEEPBOOK_OFFICIAL_INDEXER_CANDLE_USE,
  DEEPBOOK_OFFICIAL_INDEXER_SOURCE_BASE,
  DEEPBOOK_OFFICIAL_INDEXER_USDC_REFERENCE,
  DEEPBOOK_READ_RESPONSE_UNSUPPORTED,
  DEEPBOOK_SDK_SIMULATION_SOURCE_BASE,
  DEEPBOOK_SOURCE_OWNER_RUNTIME_WORDING
} from "../src/core/read/deepbookSourceOwners.js";

const sourceFiles = [
  "src/runtime/start.ts",
  "src/runtime/logger.ts",
  "src/mcp/server.ts",
  "src/review-server/server.ts"
];

const toolFiles = [
  "src/mcp/tools/account/index.ts",
  "src/mcp/tools/read/deepbookReadTools.ts",
  "src/mcp/tools/read/reviewActivityTools.ts",
  "src/mcp/tools/read/serverStatusTools.ts",
  "src/mcp/tools/read/transactionActivityTools.ts",
  "src/mcp/tools/read/walletReadTools.ts",
  "src/mcp/tools/action/prepareSuiActionReview.ts",
  "src/mcp/tools/session/executionResultTools.ts",
  "src/mcp/tools/session/statusTools.ts",
  "src/mcp/tools/session/walletConnectionTools.ts",
  "src/mcp/tools/settings/index.ts"
];

const behaviorDocs = [
  "docs/AGENT_BEHAVIOR.md",
  "docs/FRONTEND_POLICY.md",
  "docs/golden-scenarios/INTENT_EVIDENCE_MATRIX.md",
  "docs/golden-scenarios/BEHAVIOR_MATRIX.md",
  "docs/WALLET_CONNECTION.md"
];

const protocolResearchDocs = [
  "protocols/sui-defi-activity-classifier-spec.md",
  "protocols/sui-defi-mainnet-survey.md"
];

const plannedRoutePaymentPortfolioToolPattern =
  /read_(preview_portfolio_target|compare_funding_routes|explain_payment_readiness)/;

const unsupportedProtocolAuthorityClaims = [
  /wallet position inventory\s+(is|are)\s+supported/i,
  /(provides?|supports?|enables?)\s+.{0,80}wallet position inventory/i,
  /route recommendation\s+(is|are)\s+supported/i,
  /(provides?|supports?|enables?)\s+.{0,80}route recommendation/i,
  /route quality\s+(is|are)\s+supported/i,
  /P&L\s+(is|are)\s+supported/i,
  /complete wallet history\s+(is|are)\s+supported/i,
  /transaction-building inputs?\s+(is|are)\s+supported/i,
  /signing data\s+(is|are)\s+supported/i,
  /signing readiness\s+(is|are)\s+supported/i,
  /(staked|locked|vesting) (SUI|assets?|positions?).{0,160}(can be used as|is a|are a).{0,160}(funding sources?|route liquidity|payment readiness|portfolio completeness|transaction-building inputs?|signing data|signing readiness)/i,
  /(NFTs?|objects?|LP positions?|vault positions?).{0,160}(can be used as|is a|are a).{0,160}(funding sources?|route liquidity|payment readiness|portfolio completeness|transaction-building inputs?|signing data|signing readiness)/i
];

function sourceFilePathsUnder(relativeDirectory: string): string[] {
  const absoluteDirectory = join(process.cwd(), relativeDirectory);
  return readdirSync(absoluteDirectory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      return sourceFilePathsUnder(relativePath);
    }
    return relativePath.endsWith(".ts") ? [relativePath] : [];
  });
}

function runtimeWordingReference(key: keyof typeof DEEPBOOK_SOURCE_OWNER_RUNTIME_WORDING): string {
  return `DEEPBOOK_SOURCE_OWNER_RUNTIME_WORDING.${key}`;
}

function constructorBlocksFor(source: string, marker: string, label: string): string[] {
  const blocks: string[] = [];
  let searchFrom = 0;
  while (true) {
    const start = source.indexOf(marker, searchFrom);
    if (start === -1) {
      return blocks;
    }
    const braceStart = source.indexOf("{", start);
    let depth = 0;
    let end = braceStart;
    for (; end < source.length; end += 1) {
      const character = source[end];
      if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          blocks.push(source.slice(start, end + 1));
          searchFrom = end + 1;
          break;
        }
      }
    }
    if (end >= source.length) {
      throw new Error(`Unterminated ${label} constructor block`);
    }
  }
}

function inMemorySessionStoreConstructorBlocks(source: string): string[] {
  return constructorBlocksFor(source, "new InMemorySessionStore({", "InMemorySessionStore");
}

function sqliteActivityStoreConstructorBlocks(source: string): string[] {
  return constructorBlocksFor(source, "new SqliteActivityStore({", "SqliteActivityStore");
}

describe("source policy", () => {
  it("does not use console logging in runtime or server code", () => {
    for (const file of sourceFiles) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source).not.toMatch(/console\./);
    }
  });

  it("does not use the Sui JSON-RPC client path in source or tests", () => {
    const disallowed = [
      ["Sui", "Json", "Rpc", "Client"].join(""),
      `@mysten/sui/${["json", "Rpc"].join("")}`
    ];
    for (const file of sourceFiles.concat(["test/sdkApi.test.ts"])) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      for (const token of disallowed) {
        expect(source).not.toContain(token);
      }
    }
  });

  it("keeps MCP tool descriptions concise, literal, and instruction-free", () => {
    const forbiddenInstructionTerms = /\b(always|never|must|should|critical|important)\b/i;

    for (const file of toolFiles) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      const descriptions = [...source.matchAll(/description:\s*"([^"]+)"/g)].flatMap((match) =>
        match[1] ? [match[1]] : []
      );
      expect(descriptions.length).toBeGreaterThan(0);
      for (const description of descriptions) {
        expect(description.length).toBeLessThanOrEqual(180);
        expect(description).not.toMatch(forbiddenInstructionTerms);
      }
    }
  });

  it("keeps card actions from supplying an execution result or signing material", () => {
    const actions = readFileSync(join(process.cwd(), "src/core/session/workflowView.ts"), "utf8");
    const end = actions.indexOf("export const workflowViewSchema");
    expect(actions.slice(0, end)).not.toMatch(/transactionBytes|signature:|executionResult:/);
    const backend = readFileSync(join(process.cwd(), "src/core/session/walletWorkflow.ts"), "utf8");
    expect(backend).toContain("verifyTransactionSignature");
    expect(backend).toContain('result.status === "verified_success" || result.status === "verified_failure"');
  });

  it("keeps the internal receipt card display-only and server-fact owned", () => {
    const pageSource = readFileSync(join(process.cwd(), "src/mcp-ui/view/receipt.ts"), "utf8");

    // Reads public on-chain facts through the server endpoint only.
    const service = readFileSync(join(process.cwd(), "src/mcp-ui/readCards.ts"), "utf8");
    expect(service).toContain("options.publicChainReceiptReader");
    expect(service).toContain("receiptInputSchema.parse(input)");
    // Fail closed against shape drift: types the response with the shared
    // server SOT type and validates it before rendering.
    const displaySource = readFileSync(join(process.cwd(), "src/mcp-ui/view/receiptData.ts"), "utf8");
    expect(pageSource).toContain("receiptForCard(snapshot, display)");
    expect(displaySource).toContain("parseReceipt(receiptResult?.receipt)");
    expect(displaySource).toContain("display.transactionDigest !== receipt.txDigest");
    expect(displaySource).toContain("display.cardId !== snapshot.cardId");
    expect(displaySource).toContain("display.revision !== snapshot.revision");
    for (const source of [pageSource, displaySource]) {
    // No wallet, no Sui client, no signing or execution from this page.
    expect(source).not.toMatch(/@mysten\/sui|dappKit|createLocalDAppKit|suiMainnetClient|executeTransactionBlock/i);
    expect(source).not.toMatch(/all matched|safe to sign|ready to sign/i);
    // Public page: never carries a session token or review/session evidence.
    expect(source).not.toMatch(/x-sui-mcp-token|readPageToken|tokenHeaders/);
    expect(source).not.toMatch(/reviewedRequest|labeledSessionFacts|transactionReviewData|reviewState/);
    }
  });

  it("keeps wallet and transaction I/O out of every card and remaining page", () => {
    for (const directory of ["src/mcp-ui/view", "review-app/src"]) {
      for (const file of readdirSync(join(process.cwd(), directory)).filter((file) => file.endsWith(".ts"))) {
        const source = readFileSync(join(process.cwd(), directory, file), "utf8");
        expect(source, file).not.toMatch(/@walletconnect\/sign-client|dappKit|signTransaction\(|executeTransaction\(|transactionBytesBase64|\/handoff/);
      }
    }
    const backend = readFileSync(join(process.cwd(), "src/runtime/walletConnectTransport.ts"), "utf8");
    expect(backend).toContain("SUI_SIGN_TRANSACTION_METHOD");
    expect(backend).not.toMatch(/sui_signAndExecuteTransaction/);
  });

  it("documents chain receipts as server-read execution evidence without expanding authority", () => {
    const publicAndRuntimeSurface = [
      "AGENTS.md",
      "README.md",
      "docs/AGENT_BEHAVIOR.md",
      "docs/FRONTEND_POLICY.md",
      "docs/LOCAL_DB_ARCHITECTURE.md",
      "docs/MCP_SETUP.md",
      "docs/MCP_TOOLS.md",
      "src/mcp/serverInfo.ts",
      "src/mcp/prompts.ts"
    ].map((file) => readFileSync(join(process.cwd(), file), "utf8")).join("\n");
    // Collapse whitespace so line-wrapped forbidden phrases cannot slip past the
    // negative guards below.
    const publicAndRuntimeSurfaceNormalized = publicAndRuntimeSurface.replace(/\s+/g, " ");

    expect(publicAndRuntimeSurface).toMatch(/checks Sui mainnet[\s\S]{0,140}independently read chain effects/i);
    expect(publicAndRuntimeSurface).toMatch(/independently (read|observed|verified)[\s\S]{0,80}chain/i);
    expect(publicAndRuntimeSurface).toMatch(/never receive executable transaction bytes or signatures/i);
    expect(publicAndRuntimeSurface).toMatch(/not (?:establish )?execution guarantees[\s\S]{0,180}route quality[\s\S]{0,180}P&L/i);
    expect(publicAndRuntimeSurfaceNormalized).not.toMatch(/server-side receipt verification against chain state/i);
    expect(publicAndRuntimeSurfaceNormalized).not.toMatch(/receipt verification against chain state is not implemented/i);
    expect(publicAndRuntimeSurfaceNormalized).not.toMatch(/execution receipts happen on the local review page/i);
    expect(publicAndRuntimeSurfaceNormalized).not.toMatch(/page records the execution receipt/i);
    expect(publicAndRuntimeSurfaceNormalized).not.toMatch(/Execution result transitions are owned by the local review-server browser flow/i);
  });

  it("documents the internal receipt card without reviving the removed analysis page", () => {
    const rawSurface = [
      "AGENTS.md",
      "README.md",
      "docs/AGENT_BEHAVIOR.md",
      "docs/FRONTEND_POLICY.md",
      "docs/MCP_TOOLS.md",
      "src/mcp/serverInfo.ts"
    ].map((file) => readFileSync(join(process.cwd(), file), "utf8")).join("\n");
    // Collapse all whitespace (including newlines) so a line-wrapped phrase such
    // as "review execution\nanalysis page" cannot slip past these guards.
    const publicAndRuntimeSurface = rawSurface.replace(/\s+/g, " ");

    // The review page shows the chain receipt inline; the internal Receipt card
    // reads on-chain receipt facts by transaction digest.
    expect(publicAndRuntimeSurface).toMatch(/internal Receipt card/);
    expect(publicAndRuntimeSurface).toMatch(/receipt facts (for|by)[\s\S]{0,80}digest/i);
    expect(publicAndRuntimeSurface).toMatch(/Account card/i);
    // The per-session review-execution-analysis page and its route were removed.
    expect(publicAndRuntimeSurface).not.toMatch(/review execution analysis page/i);
    expect(publicAndRuntimeSurface).not.toMatch(/\/review\/[^\s)]*\/analysis/);
    expect(publicAndRuntimeSurface).not.toMatch(/all matched/i);
    expect(publicAndRuntimeSurface).not.toMatch(/safe to sign/i);
    expect(publicAndRuntimeSurface).not.toMatch(/ready to sign/i);
  });

  it("keeps the initial MCP tool registration wrapper migration narrow", () => {
    const wrapperSource = readFileSync(join(process.cwd(), "src/mcp/registerTool.ts"), "utf8");
    expect(wrapperSource).toMatch(/server\.registerTool/);
    expect(wrapperSource).toMatch(/ToolCallback<InputArgs>/);
    expect(wrapperSource).not.toMatch(/okToolResult|errorToolResult|toolErrors|successOutputSchema|userAnswerUse/);
    expect(wrapperSource).not.toMatch(/\btry\b|\bcatch\b/);

    const migratedTools = [
      ["src/mcp/tools/settings/index.ts", "TOOL_NAMES.settingsGetLocalSettings"],
      ["src/mcp/tools/action/prepareSuiActionReview.ts", "TOOL_NAMES.actionCreateProposalReview"]
    ] as const;

    for (const [file, toolName] of migratedTools) {
      const escapedToolName = toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const source = readFileSync(join(process.cwd(), file), "utf8");

      expect(source).toMatch(new RegExp(`registerSuiMcpTool\\(\\s*server,\\s*${escapedToolName},`));
      expect(source).not.toMatch(new RegExp(`server\\.registerTool\\(\\s*${escapedToolName},`));
    }

    const remainingDirectRegistrations = toolFiles
      .map((file) => readFileSync(join(process.cwd(), file), "utf8"))
      .flatMap((source) => source.match(/server\.registerTool\(/g) ?? []);
    expect(remainingDirectRegistrations.length).toBeGreaterThan(0);
  });

  it("keeps agent behavior docs inside current product boundaries", () => {
    const source = behaviorDocs
      .map((file) => readFileSync(join(process.cwd(), file), "utf8"))
      .join("\n");

    expect(source).toMatch(/answer playbook/i);
    expect(source).toMatch(/internal Review card/i);
    expect(source).toMatch(/Ordinary MCP responses are facts, never signing authority or bytes/is);
    expect(source).toMatch(/Unsupported/i);
    expect(source).not.toMatch(/[\uAC00-\uD7A3]/u);
    expect(source).not.toMatch(/safe to sign/i);
    expect(source).not.toMatch(/autonomous trading is supported/i);
    expect(source).not.toMatch(/provides? custody/i);
    expect(source).not.toMatch(/signable DeepBook swap is implemented/i);
    expect(source).not.toMatch(/payment is supported/i);
  });

  it("documents current release intent evidence without expanding action authority", () => {
    const source = [
      "docs/AGENT_BEHAVIOR.md",
      "docs/golden-scenarios/INTENT_EVIDENCE_MATRIX.md",
      "docs/golden-scenarios/BEHAVIOR_MATRIX.md"
    ].map((file) => readFileSync(join(process.cwd(), file), "utf8")).join("\n");

    for (const prompt of [
      "What is 10 SUI worth?",
      "If I sell 10 SUI, how many dollars do I get?",
      "What can I sell?",
      "Sell DEEP for USDC.",
      "Make $1000.",
      "Can I cover a 1000 dollar payment?",
      "Can I pay for this $1000 item?",
      "How much are my USD-denominated assets together?",
      "Which stablecoin-like asset is highest or lowest?",
      "What is the shortfall?",
      "Make it 100 SUI.",
      "Keep 100 SUI and convert the rest.",
      "If USDC is short, sell another token to fill it."
    ]) {
      expect(source).toContain(prompt);
    }
    expect(source).toMatch(/read_get_deepbook_mid_price/);
    expect(source).toMatch(/read_get_server_status/);
    expect(source).toMatch(/evidencePolicy\.version/);
    expect(source).toMatch(/implementedToolsCount/);
    expect(source).toMatch(/wrong MCP build/i);
    expect(source).toMatch(/Answer only from current tool evidence[\s\S]{0,220}read_get_server_status/);
    expect(source).toMatch(/read_quote_deepbook_display_amount/);
    expect(source).toMatch(/read_classify_wallet_assets/);
    expect(source).toMatch(/read_list_settlement_asset_groups/);
    expect(source).toMatch(/read_summarize_settlement_asset_group_parity/);
    expect(source).toMatch(/read_preview_intent_evidence/);
    expect(source).toMatch(/responseSummary/);
    expect(source).toMatch(/responseEvidence/);
    expect(source).toMatch(/primaryEvidenceFields/);
    expect(source).toMatch(/summarize_settlement_asset_group_balance/);
    expect(source).toMatch(/read_summarize_sui_activity_scan/);
    expect(source).toMatch(/uninspectedAssetClasses/);
    expect(source).toMatch(/Partial wallet context is allowed when a connection-qualified default asset account is available or the user gives an explicit Sui address/);
    expect(source).toMatch(/Use summary output first; inspect full details only when the user asks for transaction-level facts/);
    expect(source).toMatch(/This is a bounded provider page, not complete wallet history/);
    expect(source).toMatch(/Affected activity means the account appeared in returned transaction effects; it does not mean the account sent the transaction/);
    expect(source).toMatch(/Compact balance changes can aggregate repeated ownerless raw changes with `count`/);
    expect(source).toMatch(/DeepBook quote output is not[\s\S]{0,80}price impact/i);
    expect(source).toMatch(/A USDC quote is not a fiat USD cash-out estimate/i);
    expect(source).toMatch(/Do not silently choose USDC or USDT/i);
    expect(source).toMatch(/targetAssetSelectionSource/);
    expect(source).toMatch(/user_explicit/);
    expect(source).toMatch(/prior_user_explicit_context/);
    expect(source).toMatch(/Do not set (?:that source|a target source) for an AI-inferred target/i);
    expect(source).toMatch(/non-group (?:quote outputs|assets)[\s\S]{0,120}(?:payment coverage|coverage)/i);
    expect(source).toMatch(/measurement reference/i);
    expect(source).toMatch(/(?:max\/min|min, max).*mean|mean.*median/i);
    expect(source).not.toMatch(/USDC first/i);
    expect(source).not.toMatch(/USDC quote-token default/i);
    expect(source).toMatch(/Do not invent a target amount/i);
    expect(source).toMatch(/ask for the missing display target amount/i);
    expect(source).toMatch(/Do not narrow the question to USDC\/USDT/i);
    expect(source).toMatch(/Do not auto-pick assets to sell/i);
    expect(source).not.toMatch(/route recommendation is supported/i);
    expect(source).not.toMatch(/payment readiness is supported/i);
    expect(source).not.toMatch(/portfolio planning is supported/i);
  });

  it("keeps runtime MCP instructions aligned with USD-denominated intent evidence guidance", () => {
    const source = readFileSync(join(process.cwd(), "src/mcp/serverInfo.ts"), "utf8");

    expect(source).toMatch(/USD coverage\/total\/shortfall: read_get_server_status, then read_list_settlement_asset_groups, then read_preview_intent_evidence/);
    expect(source).toMatch(/read_get_server_status/);
    expect(source).toMatch(/read_list_settlement_asset_groups/);
    expect(source).toMatch(/read_preview_intent_evidence/);
    expect(source).toMatch(/read_summarize_settlement_asset_group_parity/);
    expect(source).toMatch(/toolAvailability/);
    expect(source).toMatch(/requiredToolsAvailable/);
    expect(source).toMatch(/Missing toolAvailability means this build cannot answer/);
    expect(source).toMatch(/responseSummary\.doNotCallQuoteToolsForThisQuestion/);
    expect(source).toMatch(/Inventory\/quotes require a separate user request/);
    expect(source).toMatch(/evidencePolicyVersion/);
    expect(source).toMatch(/implementedToolsCount/);
    // SERVER_INSTRUCTIONS points clients at userAnswerUse.answerFields as the
    // per-response answer guide; field-path-per-tool wording lives in
    // docs/AGENT_BEHAVIOR.md and is verified by freshClientAnswerRegression.
    expect(source).toMatch(/userAnswerUse\.answerFields/);
    expect(source).not.toMatch(/no-target settlement-asset/i);
    expect(source).not.toMatch(/before testing question answers/i);
  });

  it("keeps the README documentation map aligned with public and maintainer doc ownership", () => {
    const source = readFileSync(join(process.cwd(), "README.md"), "utf8");

    expect(source).toMatch(/Runtime-facing MCP resources currently include/);
    expect(source).toMatch(/AI client answer behavior must be mirrored in runtime-facing instructions, resources, prompts, schemas, or returned evidence fields/);
    expect(source).toMatch(/docs\/MCP_SETUP\.md/);
    expect(source).toMatch(/docs\/MCP_TOOLS\.md/);
    expect(source).toMatch(/docs\/AGENT_BEHAVIOR\.md/);
    expect(source).toMatch(/docs\/UTILITY_INDEX\.md/);
    expect(source).toMatch(/docs\/LOCAL_DB_ARCHITECTURE\.md/);
    expect(source).toMatch(/docs\/SDK_API\.md/);
    expect(source).toMatch(/docs\/FRONTEND_POLICY\.md/);
    expect(source).toMatch(/docs\/AGENT_DEVELOPMENT_POLICY\.md/);
    expect(source).toMatch(/docs\/golden-scenarios\/INTENT_EVIDENCE_MATRIX\.md/);
    expect(source).toMatch(/docs\/golden-scenarios\/BEHAVIOR_MATRIX\.md/);
    expect(source).toMatch(/manual maintainer and developer utilities/i);
    expect(source).toMatch(/not MCP tools unless they explicitly name an MCP tool/i);
    expect(source).toMatch(/not packaged product commands/i);
    expect(source).toMatch(/AGENTS\.md.*development contract/s);
  });

  it("separates contributor-only rules from MCP runtime-facing agent guidance", () => {
    const agents = readFileSync(join(process.cwd(), "AGENTS.md"), "utf8");
    const developmentPolicy = readFileSync(join(process.cwd(), "docs/AGENT_DEVELOPMENT_POLICY.md"), "utf8");
    const agentBehavior = readFileSync(join(process.cwd(), "docs/AGENT_BEHAVIOR.md"), "utf8");
    const mcpTools = readFileSync(join(process.cwd(), "docs/MCP_TOOLS.md"), "utf8");

    expect(agents).toMatch(/Detailed policy files are binding/);
    expect(agents).toMatch(/docs\/AGENT_DEVELOPMENT_POLICY\.md/);
    expect(developmentPolicy).toMatch(/Instruction Surface Ownership/);
    expect(developmentPolicy).toMatch(/Development rule surfaces are for contributors and coding agents/);
    expect(developmentPolicy).toMatch(/MCP-injected or runtime-facing agent surfaces/);
    expect(developmentPolicy).toMatch(/clients do not reliably read them at runtime/i);
    expect(developmentPolicy).toMatch(/When a behavior must influence AI client answers, put the actionable guidance in\s+a runtime-facing surface/);
    expect(agents).not.toMatch(/Before answering a USD-denominated coverage, balance-total, or shortfall question, call `read_get_server_status` first/);

    expect(agentBehavior).toMatch(/MCP-exposed answer playbook for AI clients/);
    expect(agentBehavior).toMatch(/does not define tool schemas or field contracts/i);
    expect(agentBehavior).toMatch(/Development rules live in `AGENTS\.md` and `docs\/AGENT_DEVELOPMENT_POLICY\.md`/);
    expect(agentBehavior).toMatch(/another asset amount/);
    expect(agentBehavior).not.toMatch(/5 USDC|5 USDT/);

    expect(mcpTools).toMatch(/MCP resources are runtime-facing references/);
    expect(mcpTools).toMatch(/contributor-only documents such as `AGENTS\.md`, `docs\/AGENT_DEVELOPMENT_POLICY\.md`/);
    expect(mcpTools).toMatch(/Tool descriptions remain concise, literal, and instruction-free/);
  });

  it("keeps first-reader documentation guidance and USD answer fields plain", () => {
    const agents = readFileSync(join(process.cwd(), "AGENTS.md"), "utf8");
    const developmentPolicy = readFileSync(join(process.cwd(), "docs/AGENT_DEVELOPMENT_POLICY.md"), "utf8");
    const runtimeFacingSource = [
      "README.md",
      "docs/AGENT_BEHAVIOR.md",
      "docs/MCP_TOOLS.md",
      "docs/golden-scenarios/INTENT_EVIDENCE_GOLDEN_ANSWERS.md",
      "src/mcp/serverInfo.ts"
    ]
      .map((file) => readFileSync(join(process.cwd(), file), "utf8"))
      .join("\n");

    expect(agents).toMatch(/Required Detailed Policies/);
    expect(developmentPolicy).toMatch(/third-party reader with no Sui MCP\s+background/);
    expect(developmentPolicy).toMatch(/Do not introduce project-specific\s+terms, internal shorthand, or product labels/);
    expect(developmentPolicy).toMatch(/define it in plain\s+language at first use/);
    expect(developmentPolicy).toMatch(/MCP API Response Clarity/);
    expect(developmentPolicy).toMatch(/Design and review MCP API responses as standalone evidence/);
    expect(developmentPolicy).toMatch(/what question or operation this response can support/);
    expect(developmentPolicy).toMatch(/which returned fields may be used in a user-facing answer/);
    expect(developmentPolicy).toMatch(/Keep API responsibilities isolated/);
    expect(developmentPolicy).toMatch(/Cross-tool references are allowed only as explicit follow-up guidance/);
    expect(developmentPolicy).toMatch(/the response can be misunderstood after being copied without surrounding\s+documentation/);
    expect(runtimeFacingSource).toMatch(/responseSummary\.amountsUsedForAnswer/);
    expect(runtimeFacingSource).toMatch(/responseSummary\.separateQuoteOutputs/);
    expect(runtimeFacingSource).toMatch(/responseSummary\.answerCompleteness/);
    expect(runtimeFacingSource).toMatch(/responseSummary\.doNotCallQuoteToolsForThisQuestion/);
    expect(runtimeFacingSource).toMatch(/Do not call `read_classify_wallet_assets`, `read_summarize_wallet_assets`, or quote tools/);
    expect(runtimeFacingSource).toMatch(/responseSummary\.doNotUseForConclusion/);
    expect(runtimeFacingSource).toMatch(/userAnswerUse/);
    expect(runtimeFacingSource).toMatch(/userAnswerUse\.answerFields/);
    expect(runtimeFacingSource).toMatch(/userAnswerUse\.preconditionFields/);
    expect(runtimeFacingSource).toMatch(/userAnswerUse\.conclusionRuleFields/);
    expect(runtimeFacingSource).toMatch(/userAnswerUse\.followUp/);
    expect(runtimeFacingSource).toMatch(/responseEvidence\.supportedResponseClaims/);
    expect(runtimeFacingSource).toMatch(/direct_pool_quote_evidence/);
    expect(runtimeFacingSource).toMatch(/direct_pool_quote_evidence_for_user_selected_target/);
    expect(runtimeFacingSource).toMatch(/canUseForPaymentAnswer/);
    expect(runtimeFacingSource).toMatch(/doNotCombineWithPaymentAnswer/);
    expect(runtimeFacingSource).toMatch(/requiredPaymentAnswerTool/);
    expect(runtimeFacingSource).toMatch(/requiredPaymentAnswerField/);
    const removedTerms = [
      new RegExp(["non", "contribution contract"].join("-"), "i"),
      new RegExp(["over", "reach"].join(""), "i"),
      new RegExp(["answer", "ready"].join("-"), "i"),
      new RegExp(["counted", "In", "Conclusion"].join("")),
      new RegExp(["quote", "Output", "Coverage"].join("")),
      new RegExp(["coverage", "Use", "Blocked", "Reason"].join("")),
      new RegExp(["cannot", "Contribute", "To", "Payment", "Coverage"].join("")),
      new RegExp(["cannot", "Contribute", "To", "Shortfall"].join(""))
    ];
    for (const removedTerm of removedTerms) {
      expect(runtimeFacingSource).not.toMatch(removedTerm);
    }
  });

  it("does not document the removed DeepBook read simulation sender env", () => {
    const removedEnv = ["SUI", "READONLY", "SIMULATION", "SENDER"].join("_");
    const files = [
      "README.md",
      "docs/MCP_SETUP.md",
      "docs/MCP_TOOLS.md",
      "docs/SDK_API.md",
      "docs/UTILITY_INDEX.md",
      "protocols/deepbook-v3.md",
      "src/runtime/config.ts",
      "src/runtime/start.ts"
    ];
    for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source).not.toContain(removedEnv);
    }
  });

  it("documents internal cards as the connection surface without a browser signer", () => {
    const docs = ["docs/MCP_SETUP.md", "docs/WALLET_CONNECTION.md", "docs/FRONTEND_POLICY.md"]
      .map((file) => readFileSync(join(process.cwd(), file), "utf8")).join("\n");
    expect(docs).toMatch(/internal Connect card/);
    expect(docs).toMatch(/WalletConnect/);
    expect(docs).toMatch(/No browser signer|no external wallet\/review page or browser/);
    expect(docs).not.toMatch(/Open the .*walletUrl.*system browser/);
  });

  it("keeps DeepBook product source and external web context separated", () => {
    // DeepBook external-web routing rules live in docs/AGENT_BEHAVIOR.md and
    // docs/golden-scenarios/BEHAVIOR_MATRIX.md.
    const priceRoutingDocs = {
      "docs/AGENT_BEHAVIOR.md": /Sui MCP product source[^.\n]{0,200}supported SUI\/DeepBook price context/i,
      "docs/golden-scenarios/BEHAVIOR_MATRIX.md": /Sui MCP verified context[\s\S]{0,200}Do not use external web data unless the user explicitly asks for non-product market context/i
    };

    for (const [file, requiredPattern] of Object.entries(priceRoutingDocs)) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source).toMatch(requiredPattern);
    }

    const priceToolCatalogDocs = {
      "README.md": /read_get_deepbook_mid_price/,
      "docs/AGENT_BEHAVIOR.md": /read_get_deepbook_mid_price/,
      "docs/MCP_TOOLS.md": /read_get_deepbook_mid_price/,
      "docs/golden-scenarios/BEHAVIOR_MATRIX.md": /read_get_deepbook_mid_price/
    };

    for (const [file, requiredPattern] of Object.entries(priceToolCatalogDocs)) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source).toMatch(requiredPattern);
    }

    const pricePolicySurfaces = [
      "README.md",
      "src/mcp/serverInfo.ts",
      "docs/AGENT_BEHAVIOR.md",
      "docs/MCP_TOOLS.md",
      "docs/golden-scenarios/BEHAVIOR_MATRIX.md"
    ];
    const forbiddenProductWebPatterns = [
      /web (search|sources?) first/i,
      /search (the )?web before (using )?DeepBook/i,
      /external web sources before DeepBook/i,
      new RegExp(["use", "web", "fallback", "for", "the", "price", "answer"].join(" "), "i"),
      new RegExp(["web", "fallback"].join(" ") + ".{0,120}Sui MCP", "i"),
      /external web.{0,120}verified (Sui|DeepBook|product) state/i,
      /external web.{0,120}\bas Sui MCP verified state/i
    ];

    for (const file of pricePolicySurfaces) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      for (const forbiddenPattern of forbiddenProductWebPatterns) {
        expect(source).not.toMatch(forbiddenPattern);
      }
    }
  });

  it("keeps connection observation distinct from an unsubmitted card and transaction approval", () => {
    const docs = readFileSync(join(process.cwd(), "docs/AGENT_BEHAVIOR.md"), "utf8");
    expect(docs).toMatch(/Without an admitted operation, waiting ends immediately/);
    expect(docs).toMatch(/Waiting does not create a[\s\S]{0,20}pairing/);
    expect(docs).toMatch(/model must not call app-only actions/);
    expect(docs).toMatch(/session_get_wallet_connection_card/);
    expect(docs).toMatch(/session_wait_wallet_connection_card/);
  });

  it("keeps numeric unit policy explicit and forbids decimals inference guidance", () => {
    const agents = readFileSync(join(process.cwd(), "AGENTS.md"), "utf8");
    const developmentPolicy = readFileSync(join(process.cwd(), "docs/AGENT_DEVELOPMENT_POLICY.md"), "utf8");
    expect(agents).toMatch(/Numeric, Financial, And Protocol Rules/);
    expect(developmentPolicy).toMatch(/Numeric and unit safety/);
    expect(developmentPolicy).toMatch(/Do not infer token decimals from token symbols/);
    expect(developmentPolicy).toMatch(/Do not use floating\s+point `number` arithmetic for token balances or signable quantities/);

    const docs = [
      "docs/AGENT_BEHAVIOR.md",
      "docs/MCP_TOOLS.md",
      "docs/UTILITY_INDEX.md"
    ].map((file) => readFileSync(join(process.cwd(), file), "utf8")).join("\n");
    expect(docs).toMatch(/Do not infer token decimals from (the )?token symbol|Do not infer token decimals from symbols/i);
    expect(docs).toMatch(/display.+presentation-only/is);
    expect(docs).toMatch(/assetFlowPreview\.amount.{0,120}not raw signable quantities/i);
    expect(docs).toMatch(/deepbook_display_number/);
    expect(docs).toMatch(/not raw balance|not raw amounts/i);
    expect(docs).not.toMatch(/assetFlowPreview\.amount.{0,120}(is|as|are) raw(?! signable quantities)/i);
    expect(docs).not.toMatch(/assume (SUI|USDC|USDT).{0,40}decimals/i);
    expect(docs).not.toMatch(/infer decimals from (SUI|USDC|USDT)/i);
  });

  it("keeps DeepBook account inventory separate from funding, routing, and signing", () => {
    const docs = [
      "README.md",
      "docs/AGENT_BEHAVIOR.md",
      "docs/MCP_TOOLS.md",
      "docs/UTILITY_INDEX.md"
    ].map((file) => readFileSync(join(process.cwd(), file), "utf8")).join("\n");
    const source = [
      "src/core/read/readService.ts",
      "src/core/read/readServiceTypes.ts",
      "src/mcp/serverInfo.ts",
      "src/mcp/toolNames.ts",
      "src/mcp/tools/read/deepbookReadTools.ts",
      "src/mcp/tools/read/index.ts"
    ].map((file) => readFileSync(join(process.cwd(), file), "utf8")).join("\n");

    expect(docs).toMatch(/read_summarize_deepbook_account_inventory/);
    expect(docs).toMatch(/deepbook_display_number/);
    expect(docs).toMatch(/withdrawal readiness/i);
    expect(docs).toMatch(/transaction-building/i);
    expect(source).toMatch(/read_summarize_deepbook_account_inventory/);
    expect(source).toMatch(/deepbook_display_number/);
    expect(source).toMatch(/withdrawal_readiness/);
    expect(source).toMatch(/transaction_building/);
    expect(docs).not.toMatch(
      /DeepBook account inventory (is|as|are|can be used as).{0,120}(signing data|signing readiness|funding sources?|route liquidity|withdrawal readiness|transaction-building inputs?)/i
    );
  });

  it("keeps DeepBook display quotes separate from routes, funding, min-out, and signing", () => {
    const docs = [
      "README.md",
      "docs/AGENT_BEHAVIOR.md",
      "docs/MCP_SETUP.md",
      "docs/MCP_TOOLS.md",
      "docs/SDK_API.md",
      "docs/UTILITY_INDEX.md",
      "docs/golden-scenarios/BEHAVIOR_MATRIX.md"
    ].map((file) => readFileSync(join(process.cwd(), file), "utf8")).join("\n");
    const source = [
      "src/core/read/deepbookSourceOwners.ts",
      "src/core/read/readService.ts",
      "src/core/read/readServiceTypes.ts",
      "src/core/read/deepbookReadHelpers.ts",
      "src/core/read/deepbookRawQuoteClient.ts",
      "src/mcp/serverInfo.ts",
      "src/mcp/toolNames.ts",
      "src/mcp/tools/read/deepbookReadTools.ts",
      "src/mcp/tools/read/index.ts"
    ].map((file) => readFileSync(join(process.cwd(), file), "utf8")).join("\n");

    expect(docs).toMatch(/read_quote_deepbook_display_amount/);
    expect(docs).toMatch(/deepbook_quote_display_amount/);
    expect(docs).toMatch(/exact decimal display (quote )?strings/i);
    expect(docs).toMatch(/rawQuote\.kind:\s+"deepbook_quote_raw_u64"/);
    expect(docs).toMatch(/rawQuote\.sourceMoveFunction[\s\S]{0,160}pool::get_quote_quantity_out/);
    expect(docs).toMatch(/rawQuote\.sourceMoveFunction[\s\S]{0,160}pool::get_base_quantity_out/);
    expect(docs).toMatch(/rawQuote\.returnValueSourceMoveFunction:\s+"pool::get_quantity_out"/);
    expect(docs).toMatch(/base_quantity_out[\s\S]{0,80}quote_quantity_out[\s\S]{0,80}deep_quantity_required/);
    expect(docs).toMatch(/u64/);
    expect(docs).toMatch(/display-amount quote reads[\s\S]{0,160}do not require wallet connection/i);
    expect(docs).toMatch(/raw-quantity DeepBook quote[\s\S]{0,120}does not call (the )?display-amount quote/i);
    expect(docs).toMatch(/not a global (USD|market) price|not as a global USD price/i);
    expect(docs).toMatch(/not (a )?settlement asset choice/i);
    expect(docs).toMatch(/not[\s\S]{0,80}price-impact/i);
    expect(docs).toMatch(/not[\s\S]{0,80}venue comparison/i);
    expect(docs).toMatch(/fiat USD cash-out estimate/i);
    expect(docs).not.toMatch(/until live quote, object resolution/i);
    expect(source).toMatch(/read_quote_deepbook_display_amount/);
    expect(source).toMatch(/deepbook_quote_display_amount/);
    expect(source).toMatch(/deepbook_quote_raw_u64/);
    expect(source).toMatch(/pool::get_quote_quantity_out/);
    expect(source).toMatch(/pool::get_base_quantity_out/);
    expect(source).toMatch(/returnValueSourceMoveFunction/);
    expect(source).toMatch(/final_min_out/);
    expect(source).toMatch(/price_impact/);
    expect(source).toMatch(/mid_price_slippage/);
    expect(source).toMatch(/venue_comparison/);
    expect(source).toMatch(/best_route/);
    expect(source).toMatch(/deepbookDisplayQuoteSchema/);
    expect(source).toMatch(/MAX_DEEPBOOK_QUOTE_RAW_AMOUNT/);
    expect(source).toMatch(/min_out/);
    expect(source).toMatch(/liquidity_verdict/);
    expect(docs).not.toMatch(
      /DeepBook display-amount quotes? (is|as|are|can be used as).{0,160}(signing data|signing readiness|funding sources?|route liquidity|min-out|transaction-building inputs?)/i
    );
  });

  it("keeps DeepBook USDC price history bounded to external candle evidence", () => {
    const toolSource = readFileSync(join(process.cwd(), "src/mcp/tools/read/deepbookReadTools.ts"), "utf8");
    const docs = [
      "docs/AGENT_BEHAVIOR.md",
      "docs/MCP_TOOLS.md",
      "docs/UTILITY_INDEX.md",
      "src/mcp/serverInfo.ts"
    ].map((file) => readFileSync(join(process.cwd(), file), "utf8")).join("\n");
    const source = [
      "src/core/read/deepbookSourceOwners.ts",
      "src/core/read/readService.ts",
      "src/core/read/readServiceTypes.ts",
      "src/core/read/deepbookReadHelpers.ts",
      "src/mcp/serverInfo.ts",
      "src/mcp/toolNames.ts",
      "src/mcp/tools/read/deepbookReadTools.ts"
    ].map((file) => readFileSync(join(process.cwd(), file), "utf8")).join("\n");

    const description =
      toolSource.match(
        /TOOL_NAMES\.readGetDeepbookUsdcPriceHistory[\s\S]{0,700}description:\s*"([^"]+)"/
      )?.[1] ?? "";
    const atTimeDescription =
      toolSource.match(
        /TOOL_NAMES\.readGetDeepbookUsdcPriceAtTime[\s\S]{0,700}description:\s*"([^"]+)"/
      )?.[1] ?? "";

    expect(description).toContain("DeepBookV3 official Indexer USDC candle evidence");
    expect(description).not.toMatch(/live quote|execution price|route|best price|USD value|P&L|tax|signing readiness/i);
    expect(atTimeDescription).toContain("DeepBookV3 official Indexer USDC candle evidence");
    expect(atTimeDescription).toContain("representative price");
    expect(atTimeDescription).not.toMatch(/live quote|execution price|route|best price|USD value|P&L|tax|signing readiness/i);
    expect(docs).toMatch(/read_get_deepbook_usdc_price_history/);
    expect(docs).toMatch(/read_get_deepbook_usdc_price_at_time/);
    expect(docs).toMatch(/matchedCandle\.close/);
    expect(docs).toMatch(/no_price_in_search_window/);
    expect(docs).toMatch(/DeepBookV3 official Indexer USDC candle evidence|official Indexer candle data|official Indexer candle references/i);
    expect(docs).toContain(`quantitySemantics.allowedUse: "${DEEPBOOK_OFFICIAL_INDEXER_CANDLE_USE.allowedUse}"`);
    expect(docs).toContain(`source.kind: "${DEEPBOOK_OFFICIAL_INDEXER_SOURCE_BASE.kind}"`);
    expect(docs).toContain(
      `source.chainRecomputedBySuiMcp: ${String(DEEPBOOK_OFFICIAL_INDEXER_SOURCE_BASE.chainRecomputedBySuiMcp)}`
    );
    expect(docs).toMatch(/does not independently recompute/i);
    expect(docs).toContain(DEEPBOOK_SOURCE_OWNER_RUNTIME_WORDING.usdcNotFiatUsdAndNotPeg);
    expect(docs).toMatch(/not[\s\S]{0,160}(live quote|historical mid price|global market price)/i);
    expect(docs).toMatch(/not[\s\S]{0,160}(P&L|cost basis|signing readiness)/i);
    expect(docs).toMatch(/not[\s\S]{0,160}(user-account transaction history|user-account balance history)/i);
    expect(docs).toMatch(/unsupported_pair/);
    expect(docs).toMatch(/unsupported_range/);
    expect(docs).toMatch(/source_unavailable/);
    expect(source).toMatch(/read_get_deepbook_usdc_price_history/);
    expect(source).toMatch(/read_get_deepbook_usdc_price_at_time/);
    expect(source).toMatch(/matchedCandle\.close/);
    expect(source).toMatch(/no_price_in_search_window/);
    expect(source).toContain(DEEPBOOK_OFFICIAL_INDEXER_SOURCE_BASE.kind);
    expect(source).toContain(DEEPBOOK_OFFICIAL_INDEXER_CANDLE_USE.allowedUse);
    expect(source).toContain(`usdcIsFiatUsd: ${String(DEEPBOOK_OFFICIAL_INDEXER_USDC_REFERENCE.usdcIsFiatUsd)}`);
    expect(source).toContain(
      `usdPegGuaranteeAvailable: ${String(DEEPBOOK_OFFICIAL_INDEXER_USDC_REFERENCE.usdPegGuaranteeAvailable)}`
    );
    expect(source).toContain(
      `chainRecomputedBySuiMcp: ${String(DEEPBOOK_OFFICIAL_INDEXER_SOURCE_BASE.chainRecomputedBySuiMcp)}`
    );
    expect(source).toMatch(/liveQuoteAvailable:\s*false/);
    expect(source).toMatch(/historicalMidPriceAvailable:\s*false/);
    expect(source).toMatch(/routeRecommendationAvailable:\s*false/);
    expect(source).toMatch(/transactionBuildingAvailable:\s*false/);
    expect(source).toMatch(/signingReadinessAvailable:\s*false/);
    expect(source).toMatch(/profitAndLossAvailable:\s*false/);
    expect(source).toMatch(/costBasisAvailable:\s*false/);
    expect(source).toMatch(/independent_chain_recomputation/);
  });

  it("keeps public and runtime DeepBook source-owner guidance aligned with the contract", () => {
    const publicAndRuntimeGuidanceFiles = [
      "docs/MCP_TOOLS.md",
      "docs/AGENT_BEHAVIOR.md",
      "docs/SDK_API.md",
      "protocols/deepbook-v3.md",
      "src/mcp/serverInfo.ts",
      "src/mcp/resources.ts",
      "src/mcp/prompts.ts",
      "src/adapters/adapterPromptSurfaces.ts"
    ] as const;
    const guidanceByFile = Object.fromEntries(
      publicAndRuntimeGuidanceFiles.map((file) => [file, readFileSync(join(process.cwd(), file), "utf8")])
    ) as Record<(typeof publicAndRuntimeGuidanceFiles)[number], string>;
    const usdcNotFiatAndNotPeg = DEEPBOOK_SOURCE_OWNER_RUNTIME_WORDING.usdcNotFiatUsdAndNotPeg;

    expect(guidanceByFile["docs/MCP_TOOLS.md"]).toContain(DEEPBOOK_OFFICIAL_INDEXER_SOURCE_BASE.kind);
    expect(guidanceByFile["docs/MCP_TOOLS.md"]).toContain(DEEPBOOK_OFFICIAL_INDEXER_CANDLE_USE.allowedUse);
    expect(guidanceByFile["docs/MCP_TOOLS.md"]).toContain(DEEPBOOK_SDK_SIMULATION_SOURCE_BASE.simulation);
    expect(guidanceByFile["docs/MCP_TOOLS.md"]).toContain(DEEPBOOK_OFFICIAL_INDEXER_USDC_REFERENCE.priceConvention);
    expect(guidanceByFile["docs/MCP_TOOLS.md"]).toContain(usdcNotFiatAndNotPeg);
    expect(guidanceByFile["docs/MCP_TOOLS.md"]).toMatch(/official Indexer[\s\S]{0,80}candle evidence/i);
    expect(guidanceByFile["docs/MCP_TOOLS.md"]).toMatch(
      /orderbook[\s\S]{0,160}pinned DeepBook SDK|pinned SDK[\s\S]{0,160}orderbook/i
    );
    expect(guidanceByFile["docs/MCP_TOOLS.md"]).toMatch(
      /mid[- ]price[\s\S]{0,160}pinned SDK|pinned SDK[\s\S]{0,160}mid[- ]price/i
    );

    expect(guidanceByFile["docs/AGENT_BEHAVIOR.md"]).toMatch(/official Indexer candle evidence/i);
    expect(guidanceByFile["docs/AGENT_BEHAVIOR.md"]).toContain(usdcNotFiatAndNotPeg);
    expect(guidanceByFile["docs/AGENT_BEHAVIOR.md"]).toMatch(/matchedCandle\.close/);
    expect(guidanceByFile["docs/AGENT_BEHAVIOR.md"]).toMatch(/not[\s\S]{0,160}(route choice|P&L|tax|signing readiness)/i);

    expect(guidanceByFile["docs/SDK_API.md"]).toContain(DEEPBOOK_SDK_SIMULATION_SOURCE_BASE.simulation);
    expect(guidanceByFile["protocols/deepbook-v3.md"]).toContain(DEEPBOOK_SDK_SIMULATION_SOURCE_BASE.simulation);

    expect(guidanceByFile["src/mcp/serverInfo.ts"]).toContain(
      runtimeWordingReference("officialIndexerCandleData")
    );
    expect(guidanceByFile["src/mcp/serverInfo.ts"]).toContain(
      runtimeWordingReference("officialIndexerCandleReferences")
    );
    expect(guidanceByFile["src/mcp/serverInfo.ts"]).toContain(
      runtimeWordingReference("officialIndexerUsdcDenominatedCandles")
    );
    expect(guidanceByFile["src/mcp/serverInfo.ts"]).toContain(runtimeWordingReference("pinnedSdkSnapshots"));
    expect(guidanceByFile["src/mcp/serverInfo.ts"]).toContain(runtimeWordingReference("usdcNotFiatUsdAndNotPeg"));

    for (const file of [
      "src/mcp/resources.ts",
      "src/mcp/prompts.ts",
      "src/adapters/adapterPromptSurfaces.ts"
    ] as const) {
      expect(guidanceByFile[file]).not.toContain(DEEPBOOK_OFFICIAL_INDEXER_SOURCE_BASE.kind);
      expect(guidanceByFile[file]).not.toContain(DEEPBOOK_OFFICIAL_INDEXER_CANDLE_USE.allowedUse);
      expect(guidanceByFile[file]).not.toContain(DEEPBOOK_SDK_SIMULATION_SOURCE_BASE.simulation);
    }

    for (const [file, guidance] of Object.entries(guidanceByFile)) {
      expect(guidance, file).not.toMatch(
        /official Indexer[\s\S]{0,120}(owns|provides|supports|returns|is used for)\s+(orderbook context|mid-price snapshots?|raw-quantity quotes?|display-amount quotes?|account inventory)/i
      );
      expect(guidance, file).not.toMatch(
        /DeepBook source owner contract[\s\S]{0,160}(FlowX|flowx_aggregator_route|flowx_pinned_registry)/i
      );
      expect(guidance, file).not.toMatch(
        /DeepBookV3 official Indexer[\s\S]{0,120}(supports|provides|enables|returns)\s+(route recommendation|best-price advice|signing readiness|transaction bytes|P&L|tax|cost basis)/i
      );
    }
  });

  it("keeps DeepBook source-owner unsupported-use rules explicit in the contract", () => {
    expect(DEEPBOOK_READ_RESPONSE_UNSUPPORTED.officialUsdcCandles).toEqual(
      expect.arrayContaining([
        "fiat_usd_cash_out",
        "usd_peg_assumption",
        "route_recommendation",
        "best_route",
        "transaction_building",
        "signing_data_or_readiness",
        "profit_or_pnl",
        "cost_basis"
      ])
    );
    expect(DEEPBOOK_READ_RESPONSE_UNSUPPORTED.quote).toEqual(
      expect.arrayContaining([
        "payment_coverage",
        "payment_shortfall",
        "funding_source",
        "route_dependent_payment_support",
        "final_min_out",
        "price_impact",
        "route_recommendation",
        "transaction_building",
        "signing_data_or_readiness"
      ])
    );
    expect(DEEPBOOK_READ_RESPONSE_UNSUPPORTED.protocolMatches).toEqual(
      expect.arrayContaining([
        "market_data",
        "route_support",
        "inventory_evidence",
        "signing_readiness",
        "official_indexer_replacement_evidence"
      ])
    );
  });

  it("keeps the internal chart display tied to official candles without trading authority", () => {
    const docs = ["docs/AGENT_BEHAVIOR.md", "docs/MCP_TOOLS.md", "src/mcp/serverInfo.ts"]
      .map((file) => readFileSync(join(process.cwd(), file), "utf8")).join("\n");
    const renderer = readFileSync(join(process.cwd(), "src/mcp-ui/view/chart.ts"), "utf8");
    const service = readFileSync(join(process.cwd(), "src/core/read/deepbookUsdcChartService.ts"), "utf8");
    expect(docs).toContain("ui_open_chart");
    expect(docs).toMatch(/internal read-only card/i);
    expect(docs).toContain(DEEPBOOK_SOURCE_OWNER_RUNTIME_WORDING.usdcNotFiatUsdAndNotPeg);
    expect(docs).toMatch(/not[\s\S]{0,160}(live feed|live quote|auto-refresh)/i);
    expect(docs).toMatch(/not[\s\S]{0,160}(route recommendation|route advice|trading interface)/i);
    expect(docs).toMatch(/not[\s\S]{0,160}(fiat USD|P&L|tax|cost basis)/i);
    expect(docs).not.toMatch(/shortcut labels? (are|become) (API values?|source contracts?)/i);
    expect(renderer).not.toMatch(/fetch\(|setInterval|autoRefresh|localStorage|sessionStorage|indexedDB|SuiGrpcClient|dappKit/);
    expect(service).toContain("source.fetchCandles");
    expect(service).toContain("deepbookUsdcPriceHistoryQuantitySemantics");
  });

  it("keeps account asset timeline bounded to stored net-flow evidence", () => {
    const toolSource = readFileSync(join(process.cwd(), "src/mcp/tools/read/transactionActivityTools.ts"), "utf8");
    const docs = [
      "docs/AGENT_BEHAVIOR.md",
      "docs/MCP_TOOLS.md",
      "docs/TRANSACTION_ACTIVITY_LOG.md",
      "docs/UTILITY_INDEX.md",
      "src/mcp/serverInfo.ts"
    ].map((file) => readFileSync(join(process.cwd(), file), "utf8")).join("\n");
    const source = [
      "src/core/activity/accountAssetTimeline.ts",
      "src/core/activity/accountAssetTimelineUsdcReferences.ts",
      "src/core/read/deepbookSourceOwners.ts",
      "src/mcp/serverInfo.ts",
      "src/mcp/toolNames.ts",
      "src/mcp/tools/read/transactionActivityOutput.ts",
      "src/mcp/tools/read/transactionActivityTools.ts"
    ].map((file) => readFileSync(join(process.cwd(), file), "utf8")).join("\n");

    const description =
      toolSource.match(
        /TOOL_NAMES\.readGetAccountAssetTimeline[\s\S]{0,500}description:\s*"([^"]+)"/
      )?.[1] ?? "";

    expect(description).toContain("stored local account asset net-flow timeline evidence");
    expect(description).toContain("held balances");
    expect(description).not.toMatch(/USD value|tax|signing readiness/i);
    expect(docs).toMatch(/read_get_account_asset_timeline/);
    expect(docs).toMatch(/stored local account asset net-flow bars|stored account asset net-flow bars/i);
    expect(docs).toMatch(/half-open[\s\S]{0,120}start[\s\S]{0,120}included[\s\S]{0,120}end[\s\S]{0,120}excluded/i);
    expect(docs).toMatch(/account_not_known[\s\S]{0,260}(does not return `?scanNeeded`?|Do not tell the user to run `?read_scan_sui_account_activity`?)/i);
    expect(docs).toMatch(/scan_needed[\s\S]{0,220}read_scan_sui_account_activity/i);
    expect(docs).toMatch(/balanceStatus:\s*"unavailable_no_balance_anchor"|unavailable_no_balance_anchor/i);
    expect(docs).toMatch(/netFlowBars[\s\S]{0,220}(observed|raw)[\s\S]{0,220}(not held balances|held balances are unavailable)/i);
    expect(docs).toContain(DEEPBOOK_SOURCE_OWNER_RUNTIME_WORDING.usdcNotFiatUsdAndNotPeg);
    expect(docs).toMatch(/not[\s\S]{0,220}(complete wallet history|P&L|cost basis|signing readiness)/i);
    expect(source).toMatch(/read_get_account_asset_timeline/);
    expect(source).toMatch(/ACCOUNT_ASSET_TIMELINE_QUANTITY_SEMANTICS/);
    expect(source).toMatch(/balanceBarsAvailable:\s*false/);
    expect(source).toMatch(/held_balance_without_balance_anchor/);
    expect(source).toMatch(/complete_wallet_history/);
    expect(source).toMatch(/profit_or_pnl/);
    expect(source).toMatch(/cost_basis/);
    expect(source).toMatch(/signing_data_or_readiness/);
    expect(source).toMatch(/read_scan_sui_account_activity/);
    expect(source).toMatch(/account_not_known/);
    expect(source).toMatch(/deepbook_usdc_token_denominated_reference_candles_for_supported_assets/);
    expect(source).toMatch(/usdcIsFiatUsd:\s*false/);
    expect(source).toMatch(/usdPegGuaranteeAvailable:\s*false/);
    expect(source).toMatch(/chainRecomputedBySuiMcp:\s*false/);
  });

  it("keeps review-time simulation requirements separate from transaction bytes and quote reads", () => {
    const sdkApi = readFileSync(join(process.cwd(), "docs/SDK_API.md"), "utf8");
    const simulationSource = readFileSync(
      join(process.cwd(), "src/core/action/reviewTimeSimulationEvidence.ts"),
      "utf8"
    );
    const deepbookReviewSource = readFileSync(
      join(process.cwd(), "src/adapters/deepbook/deepbookReviewEvidence.ts"),
      "utf8"
    );
    const runtimeSource = readFileSync(join(process.cwd(), "src/runtime/application.ts"), "utf8");
    const responseGuidanceSource = readFileSync(
      join(process.cwd(), "src/mcp/responseGuidance.ts"),
      "utf8"
    );
    const statusToolsSource = readFileSync(
      join(process.cwd(), "src/mcp/tools/session/statusTools.ts"),
      "utf8"
    );
    const docs = [
      "docs/AGENT_BEHAVIOR.md",
      "docs/MCP_TOOLS.md"
    ].map((file) => readFileSync(join(process.cwd(), file), "utf8")).join("\n");

    expect(sdkApi).toMatch(/review-time transaction simulation/i);
    expect(sdkApi).toMatch(/client\.core\.simulateTransaction/);
    expect(sdkApi).toMatch(/validation checks enabled/i);
    expect(sdkApi).toMatch(/effects[\s\S]{0,120}balanceChanges[\s\S]{0,120}objectTypes[\s\S]{0,120}transaction/);
    expect(sdkApi).toMatch(/Missing required fields must fail closed/i);
    expect(sdkApi).toMatch(/Returned BCS is only a private equality check/);
    expect(sdkApi).toMatch(/returned BCS to equal the submitted bytes/);
    expect(sdkApi).toMatch(/raw transaction bytes are not an MCP or review-app output/i);
    expect(sdkApi).toMatch(/`commandResults` remains scoped to read-only DeepBook raw quote extraction/i);
    expect(sdkApi).toMatch(/not swap review simulation evidence/i);
    expect(sdkApi).toMatch(/Failed simulations are blocked pre-signing review facts/i);
    expect(sdkApi).toMatch(/not wallet rejection[\s\S]{0,120}transaction submission failure[\s\S]{0,120}automatic transient retry evidence/i);
    expect(sdkApi).not.toMatch(/review-time transaction simulation[\s\S]{0,240}signing readiness/i);
    expect(simulationSource).toMatch(/createReviewTimeSimulationProducer/);
    expect(simulationSource).toMatch(/simulateTransaction/);
    expect(simulationSource).toMatch(/checksEnabled:\s*true/);
    expect(simulationSource).toMatch(/checks:\s*GrpcTypes\.SimulateTransactionRequest_TransactionChecks\.ENABLED/);
    expect(simulationSource).toMatch(/doGasSelection:\s*true/);
    expect(simulationSource).toContain('"transaction.transaction.bcs"');
    expect(simulationSource).toContain('"transaction.effects"');
    expect(simulationSource).toContain('"transaction.balance_changes"');
    expect(simulationSource).toContain('"transaction.objects.objects.object_type"');
    expect(simulationSource).toMatch(/Buffer\.from\(input\.submittedBytes\)\.equals\(returnedBytes\)/);
    expect(simulationSource).toMatch(/tx\.effects\.transactionDigest !== input\.recomputedTransactionDigest/);
    const publicProjection = simulationSource.slice(simulationSource.indexOf("export function publicTransactionSimulationSummaryFromEvidence"), simulationSource.indexOf("export function createReviewTimeSimulationProducer"));
    expect(publicProjection).not.toMatch(/returnedBytes|submittedBytes|\.bcs/);
    expect(simulationSource).not.toMatch(/signAndExecute|executeTransaction|requestSignature|ready_for_wallet_review/);
    expect(simulationSource).toMatch(/function classifySimulationException/);
    expect(simulationSource).toMatch(/function isTransientSimulationException/);
    expect(simulationSource).toMatch(/review_time_simulation_transient_failure/);
    expect(simulationSource).toMatch(/status:\s*"blocked"[\s\S]{0,520}review_time_simulation_exception_blocked/);
    expect(deepbookReviewSource).toMatch(/reviewTimeSimulationProducer/);
    expect(deepbookReviewSource).toMatch(/stage:\s*"review_time_simulation"/);
    expect(deepbookReviewSource).toMatch(/publicTransactionSimulationSummaryFromEvidence/);
    expect(deepbookReviewSource).toMatch(/deepbook_wallet_review_contract_emit_missing/);
    expect(deepbookReviewSource).toMatch(/function quoteSourceFailureOutcome/);
    expect(deepbookReviewSource).toMatch(/error\.kind === "quote_unavailable"[\s\S]{0,140}status:\s*"refresh_required"/);
    expect(deepbookReviewSource).toMatch(/status:\s*"blocked",\s*blockedReason:\s*"object_resolution_failed",\s*checks/);
    expect(runtimeSource).toMatch(/createRuntimeReviewDependencies/);
    expect(readFileSync(join(process.cwd(), "src/runtime/reviewDependencies.ts"), "utf8")).toMatch(/createReviewTimeSimulationProducer/);
    expect(responseGuidanceSource).toMatch(/reviewState\.simulation/);
    expect(responseGuidanceSource).toMatch(/current_review_time_simulation_summary_projected_from_private_review_evidence/);
    expect(statusToolsSource).toMatch(/!!session\.reviewState\?\.simulation/);
    expect(docs).toMatch(/reviewState\.simulation/);
    expect(docs).toMatch(/public summary (?:projected from private|of server-side)[\s\S]{0,100}review-time simulation evidence/i);
    expect(docs).toMatch(/not wallet handoff[\s\S]{0,120}signing data[\s\S]{0,120}signing readiness/i);
    expect(simulationSource).not.toMatch(/failedSimulationStatus/);
    expect(simulationSource).toMatch(/simulation_transient_failure/);
    expect(simulationSource).toMatch(/review_time_simulation_result_failed[\s\S]{0,520}status:\s*"blocked"/);
    expect(sdkApi).toMatch(/thrown simulation call[\s\S]{0,160}refreshable only[\s\S]{0,160}transport[\s\S]{0,160}RPC[\s\S]{0,160}timeout[\s\S]{0,160}endpoint availability/i);
    expect(sdkApi).toMatch(/malformed transaction material[\s\S]{0,160}request-shape bugs[\s\S]{0,160}adapter defects[\s\S]{0,80}blocked/i);
  });

  it("keeps DeepBook raw u64 validation on one shared source", () => {
    const sharedSource = readFileSync(join(process.cwd(), "src/core/numeric/rawU64.ts"), "utf8");
    const deepbookReadHelpers = readFileSync(join(process.cwd(), "src/core/read/deepbookReadHelpers.ts"), "utf8");
    const rawValidationDependentSource = [
      "src/core/action/schemas.ts",
      "src/core/action/reviewTimeSimulationEvidence.ts",
      "src/core/action/signableAdapterContract.ts",
      "src/core/action/swapQuotePolicyEvidence.ts",
      "src/adapters/deepbook/deepbookQuotePolicy.ts",
      "src/adapters/deepbook/deepbookTransactionMaterialProducer.ts"
    ].map((file) => readFileSync(join(process.cwd(), file), "utf8")).join("\n");

    expect(sharedSource).toMatch(/function parseRawU64/);
    expect(sharedSource).toMatch(/function makeRawU64StringSchema/);
    expect(sharedSource).toMatch(/function makeCanonicalRawU64StringSchema/);
    expect(sharedSource).toMatch(/function makeSignedRawIntegerStringSchema/);
    expect(deepbookReadHelpers).toMatch(/function parseDeepbookRawU64/);
    expect(deepbookReadHelpers).toMatch(/from "\.\.\/numeric\/rawU64\.js"/);
    expect(deepbookReadHelpers).not.toMatch(/from "\.\.\/action\/rawU64\.js"/);
    expect(rawValidationDependentSource).toMatch(/parseDeepbookRawU64|parseRawU64|makeRawU64StringSchema|makeCanonicalRawU64StringSchema|makeSignedRawIntegerStringSchema/);
    expect(rawValidationDependentSource).not.toMatch(/function parseRawU64/);
    expect(rawValidationDependentSource).not.toMatch(/const parseRawU64/);
    expect(rawValidationDependentSource).not.toMatch(/z\.string\(\)\.min\(1\)\.refine\(\(value\)[\s\S]{0,140}parseRawU64/);
    expect(rawValidationDependentSource).not.toMatch(/\/\^\\d\+\$\/|\/\^\[1-9\]\\d\*\$\//);
    expect(rawValidationDependentSource).not.toMatch(/regex\(\s*\/\^\(\?:0\|\[1-9\]\[0-9\]\*\)\$\//);
    expect(rawValidationDependentSource).not.toMatch(/regex\(\s*\/\^-?\(0\|\[1-9\]\[0-9\]\*\)\$\//);
    expect(rawValidationDependentSource).not.toMatch(/BigInt\(value\)/);
  });

  it("keeps asset flow preview amounts labeled as display intent only", () => {
    const docs = [
      "docs/AGENT_BEHAVIOR.md",
      "docs/FRONTEND_POLICY.md",
      "docs/MCP_TOOLS.md"
    ];
    const actionFiles = [
      "src/core/action/types.ts",
      "src/core/action/schemas.ts",
      "src/adapters/deepbook/deepbookSwapIntent.ts",
      "src/mcp/tools/action/prepareSuiActionReview.ts"
    ];
    const docsSource = docs.map((file) => readFileSync(join(process.cwd(), file), "utf8")).join("\n");
    const actionSource = actionFiles.map((file) => readFileSync(join(process.cwd(), file), "utf8")).join("\n");
    const source = `${docsSource}\n${actionSource}`;
    const displayIntent = ["display", "intent"].join("_");
    const forbiddenKinds = [
      ["signable", "raw"].join("_"),
      ["simulated", "actual"].join("_"),
      ["chain", "actual"].join("_"),
      ["balance", "snapshot"].join("_")
    ];

    expect(source).toMatch(/DisplayIntentAssetAmount/);
    expect(source).toMatch(/amountDisplay/);
    expect(source).toMatch(/assetFlowPreview\.amountKind/);
    expect(source).toContain(displayIntent);
    expect(actionSource).not.toMatch(new RegExp(forbiddenKinds.join("|")));
  });

  it("keeps public docs focused on current product surfaces", () => {
    const publicDocs = [
      "README.md",
      "docs/AGENT_BEHAVIOR.md",
      "docs/FRONTEND_POLICY.md",
      "docs/LOCAL_DB_ARCHITECTURE.md",
      "docs/MCP_SETUP.md",
      "docs/MCP_TOOLS.md",
      "docs/SIGNABLE_ADAPTER_CONTRACT.md",
      "docs/SDK_API.md",
      "docs/TRANSACTION_ACTIVITY_LOG.md",
      "docs/UTILITY_INDEX.md",
      "docs/WALLET_CONNECTION.md",
      "docs/golden-scenarios/BEHAVIOR_MATRIX.md",
      "protocols/deepbook-margin.md",
      "protocols/deepbook-v3.md"
    ];
    const source = publicDocs.map((file) => readFileSync(join(process.cwd(), file), "utf8")).join("\n");

    expect(source).not.toContain([".", "WORK", "/"].join(""));
    const processTerms = [
      ["previous", "plan"],
      ["this", "sprint"],
      ["earlier", "draft"],
      ["review", "found"],
      ["decision", "log"],
      ["historical", "drift"],
      ["current", "implementation", "standard"],
      ["tracked", "working", "tree", "clean"]
    ].map((term) => term.join(" "));
    expect(source).not.toMatch(new RegExp(processTerms.join("|"), "i"));
  });

  it("keeps Sui DeFi research notes out of product support surfaces", () => {
    for (const name of ["read_preview_portfolio_target", "read_compare_funding_routes", "read_explain_payment_readiness"]) {
      expect(name).toMatch(plannedRoutePaymentPortfolioToolPattern);
    }
    for (const file of protocolResearchDocs) {
      const source = readFileSync(join(process.cwd(), file), "utf8");

      expect(source).not.toMatch(/[\uAC00-\uD7A3]/u);
      expect(source).not.toContain([".", "WORK", "/"].join(""));
      expect(source).toMatch(/not an npm package\s+document/i);
      expect(source).toMatch(/not an MCP resource/i);
      expect(source).toMatch(/not a registry allowlist/i);
      expect(source).toMatch(/not a supported-protocol\s+list/i);
      expect(source).toMatch(/not signing readiness/i);
      expect(source).not.toMatch(/Future derived protocol classification/i);
      expect(source).not.toMatch(/If Sui MCP later auto-classifies/i);
      expect(source).not.toMatch(/Automatic protocol classification/i);
      expect(source).not.toMatch(/ProtocolClassifierMatch/i);
      expect(source).not.toMatch(/direct_package_match|object_match|event_match/i);
      expect(source).not.toMatch(/MCP output fields until/i);
      expect(source).not.toMatch(/kind: "balanceChange"/);
      expect(source).not.toMatch(/kind: "gas"/);
      expect(source).not.toMatch(/kind: "executionError"/);
      expect(source).not.toMatch(plannedRoutePaymentPortfolioToolPattern);
      for (const unsupportedPositiveClaim of unsupportedProtocolAuthorityClaims) {
        expect(source).not.toMatch(unsupportedPositiveClaim);
      }
    }

    const source = protocolResearchDocs
      .map((file) => readFileSync(join(process.cwd(), file), "utf8"))
      .join("\n");
    expect(source).toMatch(/Do not add adapters,\s+registry entries, or MCP tools from this note alone/i);

    const agentContract = readFileSync(join(process.cwd(), "AGENTS.md"), "utf8");
    expect(agentContract).toMatch(/Existing transaction-activity classifier research notes may name protocols only/i);
    expect(agentContract).toMatch(/implemented `compact\.protocolMatches` evidence boundary/);
    expect(agentContract).toMatch(/must not be copied into runtime guidance, MCP resources, roadmap labels, product\s+copy/i);

    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      files?: string[];
    };
    expect(packageJson.files?.filter((file) => file.startsWith("protocols/")).sort()).toEqual([
      "protocols/deepbook-margin.md",
      "protocols/deepbook-v3.md"
    ]);

    const mcpResourcesSource = readFileSync(join(process.cwd(), "src/mcp/resources.ts"), "utf8");
    for (const file of protocolResearchDocs) {
      expect(mcpResourcesSource).not.toContain(file);
    }
  });

  it("keeps protocol label evidence scoped to transaction activity labels", () => {
    const classifierSpec = readFileSync(
      join(process.cwd(), "protocols/sui-defi-activity-classifier-spec.md"),
      "utf8"
    );
    const survey = readFileSync(
      join(process.cwd(), "protocols/sui-defi-mainnet-survey.md"),
      "utf8"
    );
    const source = `${classifierSpec}\n${survey}`;

    expect(source).toMatch(/transaction activity label only/i);
    expect(source).toMatch(/not a supported-protocol inventory/i);
    expect(classifierSpec).toMatch(
      /not enough to infer[\s\S]{0,120}wallet positions[\s\S]{0,120}P&L[\s\S]{0,120}route quality[\s\S]{0,120}signing readiness/i
    );
    expect(classifierSpec).toMatch(/static mainnet research snapshots/i);
    expect(classifierSpec).toMatch(/deliberate source\s+refresh/i);
    expect(classifierSpec).toMatch(/does\s+not\s+perform\s+runtime\s+MVR\s+lookups/i);
    expect(classifierSpec).toMatch(/evidence provenance,\s+not a freshness\s+guarantee/i);
    expect(classifierSpec).toMatch(/matching behavior change[\s\S]{0,220}update `SUI_DEFI_ACTIVITY_CLASSIFIER_VERSION`/i);
    expect(classifierSpec).toMatch(/MVR resolves\s+package and type names/i);
    expect(classifierSpec).toMatch(/it does not verify shared objects/i);
    expect(classifierSpec).toMatch(/SUI_DEFI_ACTIVITY_CLASSIFIER_VERSION/);
    expect(classifierSpec).toMatch(
      /TransactionFilter\.function[\s\S]{0,120}sentAddress[\s\S]{0,120}affectedAddress[\s\S]{0,120}affectedObject[\s\S]{0,120}kind[\s\S]{0,120}atCheckpoint[\s\S]{0,120}afterCheckpoint[\s\S]{0,120}beforeCheckpoint/i
    );
    expect(classifierSpec).toMatch(/PROGRAMMABLE_TX[\s\S]{0,120}SYSTEM_TX/);
    expect(classifierSpec).toMatch(/schema\s+shape does not prove[\s\S]{0,220}live\s+mainnet GraphQL service[\s\S]{0,40}accepts/i);
    expect(classifierSpec).toMatch(/Network failures[\s\S]{0,160}inconclusive/i);
    expect(classifierSpec).toMatch(/accepted_with_rows[\s\S]{0,80}accepted_empty[\s\S]{0,160}accepted the filter combination/i);
    expect(classifierSpec).toMatch(/accepted_empty[\s\S]{0,120}does not prove matching activity exists/i);
    expect(classifierSpec).toMatch(/accepted_empty[\s\S]{0,160}does not prove no matching activity exists/i);
    expect(classifierSpec).toMatch(/accepted_empty[\s\S]{0,320}must not\s+be\s+treated as complete dApp history/i);
    expect(classifierSpec).toMatch(/recorded probe[\s\S]{0,120}graphql\.mainnet\.sui\.io/i);
    expect(classifierSpec).toMatch(
      /accepted[\s\S]{0,120}`function`[\s\S]{0,120}`function \+ sentAddress`[\s\S]{0,120}`function \+ atCheckpoint`[\s\S]{0,120}`function \+ sentAddress \+ atCheckpoint`[\s\S]{0,160}`function \+ sentAddress \+ afterCheckpoint \+ beforeCheckpoint`/i
    );
    expect(classifierSpec).toMatch(
      /rejected[\s\S]{0,120}`function \+ affectedAddress`[\s\S]{0,120}`function \+ affectedObject`[\s\S]{0,120}`function \+ kind: PROGRAMMABLE_TX`[\s\S]{0,120}`function \+ kind: SYSTEM_TX`[\s\S]{0,160}`function \+ affectedAddress \+ atCheckpoint`[\s\S]{0,160}`function \+ affectedAddress \+ afterCheckpoint \+ beforeCheckpoint`/i
    );
    expect(classifierSpec).toMatch(/At most one of \[affectedAddress,\s+affectedObject,\s+function,\s+kind\] can be specified/);
    expect(classifierSpec).toMatch(/source\s+evidence[\s\S]{0,220}not a permanent API guarantee/i);
    expect(classifierSpec).toMatch(
      /`package`[\s\S]{0,80}`package::module`[\s\S]{0,80}`package::module::function`/
    );
    expect(classifierSpec).toMatch(/first\s+function-diagnostics product slice[\s\S]{0,220}full `package::module::function`[\s\S]{0,80}identifiers only/i);
    expect(classifierSpec).toMatch(/less granular `package` and `package::module` forms[\s\S]{0,120}out of scope/i);
    expect(classifierSpec).toMatch(/broaden matches across unrelated functions/i);
    expect(classifierSpec).toMatch(/Function-only or\s+global scans must not\s+persist results by default/i);
    expect(classifierSpec).toMatch(/Sent-address scoped reads[\s\S]{0,120}only persistence\s+candidate[\s\S]{0,120}known-wallet\s+storage\s+rules/i);
    expect(classifierSpec).toMatch(/should reuse the existing\s+transaction\s+detail\s+fragment/i);
    expect(classifierSpec).toMatch(/unless\s+a separate plan provides verified evidence for a different\s+source/i);
    expect(source).not.toMatch(/function diagnostics is supported/i);
    expect(source).not.toMatch(/function diagnostics are implemented/i);
    expect(classifierSpec).toMatch(
      /classifier does not produce[\s\S]{0,260}wallet positions[\s\S]{0,260}P&L[\s\S]{0,260}route quality[\s\S]{0,260}transaction building inputs[\s\S]{0,260}signing readiness[\s\S]{0,260}protocol support claims/i
    );
    expect(survey).toMatch(/source snapshot status/i);
    expect(survey).toMatch(
      /does not add[\s\S]{0,160}wallet position discovery[\s\S]{0,160}route comparison[\s\S]{0,160}payment readiness[\s\S]{0,160}transaction building[\s\S]{0,160}signing/i
    );
    const protocolMatchesBoundary =
      survey.match(/`compact\.protocolMatches` is a transaction activity label only\.[\s\S]{0,260}/)?.[0] ??
      "";
    expect(protocolMatchesBoundary).toMatch(/It is not a/i);
    for (const unsupportedAuthority of [
      /supported-protocol list/i,
      /wallet\s+position inventory/i,
      /P&L/i,
      /route quality/i,
      /transaction-building input/i,
      /signing\s+data/i,
      /signing readiness/i
    ]) {
      expect(protocolMatchesBoundary).toMatch(unsupportedAuthority);
    }
    expect(survey).toMatch(/MVR current package resolution is package provenance,\s+not a freshness guarantee/i);
    expect(survey).toMatch(/Shared objects require separate source or mainnet object\s+verification/i);
    expect(source).not.toMatch(/supported-protocol inventory source/i);
    expect(source).not.toMatch(/route quality source/i);
    expect(source).not.toMatch(/P&L source/i);
    expect(source).not.toMatch(/wallet position inventory source/i);
    expect(source).not.toMatch(/transaction building source/i);
    expect(source).not.toMatch(/signing data source/i);
    expect(source).not.toMatch(/signing readiness source/i);
    expect(source).not.toMatch(plannedRoutePaymentPortfolioToolPattern);
    for (const unsupportedPositiveClaim of unsupportedProtocolAuthorityClaims) {
      expect(source).not.toMatch(unsupportedPositiveClaim);
    }
  });

  it("keeps generic signable review architecture independent from DeepBook ownership", () => {
    const files = [
      "README.md",
      "docs/AGENT_BEHAVIOR.md",
      "docs/MCP_SETUP.md",
      "docs/MCP_TOOLS.md",
      "docs/WALLET_CONNECTION.md",
      "src/mcp/serverInfo.ts",
      "src/mcp/tools/action/prepareSuiActionReview.ts",
      "src/review-server/server.ts"
    ];
    const source = files.map((file) => readFileSync(join(process.cwd(), file), "utf8")).join("\n");

    expect(source).toMatch(/account-bound DeepBook swap review/i);
    expect(source).toMatch(/protocol-agnostic adapters|protocol-agnostic adapter contracts|descriptor contract/i);
    const deepBookOwnedPhrases = [
      ["DeepBook", "signable", "adapter"],
      ["signable", "DeepBook", "adapter"],
      ["DeepBook", "signable", "review"]
    ].map((words) => new RegExp(`\\b${words.join("\\s+")}\\b`, "i"));
    for (const phrase of deepBookOwnedPhrases) {
      expect(source).not.toMatch(phrase);
    }
  });

  it("keeps adapter review evidence separate from backend signing authority", () => {
    const core = readFileSync(join(process.cwd(), "src/core/action/schemas.ts"), "utf8");
    const workflow = readFileSync(join(process.cwd(), "src/core/session/walletWorkflow.ts"), "utf8");
    const review = readFileSync(join(process.cwd(), "src/mcp-ui/view/review.ts"), "utf8");
    expect(core).toContain("producer_stage_missing requires at least one adapterLifecycle.missingStages entry");
    expect(core).toContain("simulation public evidence cannot be present while review_time_simulation is missing");
    expect(core).toContain("humanReadableReview public evidence cannot be present while human_readable_review is missing");
    expect(core).toContain("ready_for_wallet_review requires an emitted wallet review contract");
    expect(workflow).toContain("prepareReviewedTransaction");
    expect(workflow).toContain("admitRequest");
    expect(workflow).toContain("verifyTransactionSignature");
    expect(review).toContain("requiredUserChoices");
    expect(review).toContain("unsupportedClaims");
    expect(review).toContain('External proposal — view only');
    expect(review).not.toMatch(/signTransaction\(|executeTransaction\(|transactionBytes/);
  });

  it("keeps DeepBook review lifecycle stage catalogs adapter-owned", () => {
    const coreSource = [
      "src/core/action/types.ts",
      "src/core/action/schemas.ts"
    ].map((file) => readFileSync(join(process.cwd(), file), "utf8")).join("\n");
    const deepbookLifecycleSource = readFileSync(
      join(process.cwd(), "src/adapters/deepbook/deepbookReviewLifecycle.ts"),
      "utf8"
    );
    const adapterLifecycleValidatorsSource = readFileSync(
      join(process.cwd(), "src/adapters/adapterLifecycleValidators.ts"),
      "utf8"
    );
    const adapterLifecycleValidationSource = readFileSync(
      join(process.cwd(), "src/core/action/adapterLifecycleValidation.ts"),
      "utf8"
    );
    const reviewStateValidationSource = readFileSync(
      join(process.cwd(), "src/core/action/reviewStateValidation.ts"),
      "utf8"
    );
    const localDataValidationSource = readFileSync(
      join(process.cwd(), "src/core/activity/localDataValidation.ts"),
      "utf8"
    );
    const localDataServiceSource = readFileSync(
      join(process.cwd(), "src/core/activity/localDataService.ts"),
      "utf8"
    );
    const sqliteActivityStoreSource = readFileSync(
      join(process.cwd(), "src/core/activity/sqliteActivityStore.ts"),
      "utf8"
    );
    const sqliteActivityStoreTypesSource = readFileSync(
      join(process.cwd(), "src/core/activity/sqliteActivityStoreTypes.ts"),
      "utf8"
    );
    const reviewComputationResultSource = readFileSync(
      join(process.cwd(), "src/core/review/reviewComputationResult.ts"),
      "utf8"
    );
    const reviewComputationSource = readFileSync(
      join(process.cwd(), "src/core/review/reviewComputation.ts"),
      "utf8"
    );
    const docs = [
      "docs/AGENT_BEHAVIOR.md",
      "docs/MCP_TOOLS.md"
    ].map((file) => readFileSync(join(process.cwd(), file), "utf8")).join("\n");
    const sessionStoreSource = readFileSync(join(process.cwd(), "src/core/session/sessionStore.ts"), "utf8");
    const runtimeStartSource = readFileSync(join(process.cwd(), "src/runtime/application.ts"), "utf8");
    const smokeSource = readFileSync(join(process.cwd(), "src/runtime/smokeMainnetRead.ts"), "utf8");
    const constructorScanFiles = [
      ...sourceFilePathsUnder("src"),
      ...sourceFilePathsUnder("test").filter((file) => file !== "test/sourcePolicy.test.ts")
    ];
    const sessionStoreConstructorFiles = constructorScanFiles.filter((file) =>
      readFileSync(join(process.cwd(), file), "utf8").includes("new InMemorySessionStore({")
    );
    const constructorBlocks = sessionStoreConstructorFiles.flatMap((file) =>
      inMemorySessionStoreConstructorBlocks(readFileSync(join(process.cwd(), file), "utf8"))
    );
    const sqliteActivityStoreConstructorFiles = constructorScanFiles.filter((file) =>
      readFileSync(join(process.cwd(), file), "utf8").includes("new SqliteActivityStore({")
    );
    const sqliteActivityStoreBlocks = sqliteActivityStoreConstructorFiles.flatMap((file) =>
      sqliteActivityStoreConstructorBlocks(readFileSync(join(process.cwd(), file), "utf8"))
    );
    const filesImporting = (identifier: string): string[] =>
      constructorScanFiles
        .filter((file) => {
          const source = readFileSync(join(process.cwd(), file), "utf8");
          return new RegExp(`import[\\s\\S]{0,500}\\b${identifier}\\b`).test(source);
        })
        .sort();

    expect(coreSource).toMatch(/type AdapterLifecycle/);
    expect(coreSource).toMatch(/stageCatalogId/);
    expect(coreSource).not.toMatch(/quote_policy_derived|pool_resolved|DeepBook pool resolved/);
    expect(coreSource).toMatch(/reviewStateStructuralInvariantSchema/);
    expect(coreSource).toMatch(/reviewStateOutputSchema/);
    expect(coreSource).not.toMatch(/reviewStateSchema/);
    expect(coreSource).not.toMatch(/reviewStateShapeSchema|reviewStateOutputShapeSchema/);
    expect(deepbookLifecycleSource).toMatch(/DEEPBOOK_SWAP_REVIEW_LIFECYCLE_STAGES/);
    expect(deepbookLifecycleSource).toMatch(/quote_policy_derived/);
    expect(deepbookLifecycleSource).toMatch(/canonical DeepBook swap review lifecycle prefix/);
    expect(deepbookLifecycleSource).toMatch(/validateDeepbookSwapReviewLifecycle/);
    expect(adapterLifecycleValidatorsSource).toMatch(/validateSupportedAdapterLifecycle/);
    expect(adapterLifecycleValidatorsSource).toMatch(/DEEPBOOK_SWAP_REVIEW_LIFECYCLE_STAGE_CATALOG_ID/);
    expect(adapterLifecycleValidationSource).toMatch(/Unsupported adapter lifecycle stage catalog/);
    expect(reviewStateValidationSource).toMatch(/parseReviewStateStructuralInvariants/);
    expect(reviewStateValidationSource).toMatch(/parseLifecycleValidatedReviewState/);
    expect(reviewStateValidationSource).not.toMatch(/parseReviewStateShape|parseReviewStateWithAdapterLifecycle/);
    expect(filesImporting("reviewStateSchema")).toEqual([]);
    expect(filesImporting("reviewStateStructuralInvariantSchema")).toEqual([
      "src/core/action/reviewStateValidation.ts",
      "test/mcpSchemas.test.ts"
    ]);
    expect(filesImporting("reviewStateOutputSchema")).toEqual([
      "src/core/session/cardResult.ts", "src/core/session/sqliteWalletWorkflowStore.ts", "src/core/session/workflowState.ts", "src/core/session/workflowView.ts",
      "src/mcp/tools/read/reviewActivityTools.ts", "src/mcp/tools/session/shared.ts"
    ]);
    expect(localDataValidationSource).toMatch(/parseLocalDataEnvelope/);
    expect(localDataValidationSource).toMatch(/validateAdapterLifecycle:\s*AdapterLifecycleValidator/);
    expect(localDataValidationSource).toMatch(/validatePayloadSemantics\(parsed\.data\.data,\s*options\.validateAdapterLifecycle\)/);
    expect(localDataValidationSource).toMatch(/validateReviewStateJsonColumn\(row\.state_json,\s*"state_json",\s*validateAdapterLifecycle\)/);
    expect(localDataValidationSource).toMatch(/parseLifecycleValidatedReviewState\(parsed as ReviewState,\s*validateAdapterLifecycle\)/);
    expect(localDataValidationSource).not.toMatch(/reviewState(?:Schema|ShapeSchema|OutputShapeSchema|StructuralInvariantSchema|OutputSchema)/);
    expect(localDataServiceSource).toMatch(/private readonly validateAdapterLifecycle:\s*AdapterLifecycleValidator/);
    expect(localDataServiceSource).toMatch(/parseLocalDataEnvelope\(envelope,[\s\S]{0,180}validateAdapterLifecycle:\s*this\.validateAdapterLifecycle/);
    expect(localDataServiceSource).toMatch(/parseLocalDataEnvelope\(input,[\s\S]{0,180}validateAdapterLifecycle:\s*this\.validateAdapterLifecycle/);
    expect(sqliteActivityStoreTypesSource).toMatch(/validateAdapterLifecycle:\s*AdapterLifecycleValidator/);
    expect(sqliteActivityStoreTypesSource).not.toMatch(/validateAdapterLifecycle\?:/);
    expect(sqliteActivityStoreSource).toMatch(/private readonly validateAdapterLifecycle:\s*AdapterLifecycleValidator/);
    expect(sqliteActivityStoreSource).toMatch(/this\.validateAdapterLifecycle\s*=\s*options\.validateAdapterLifecycle/);
    expect(sqliteActivityStoreSource).toMatch(/parseLifecycleValidatedReviewState\(input\.state,\s*this\.validateAdapterLifecycle\)/);
    expect(sqliteActivityStoreSource).toMatch(/parseReviewStateEvidenceJson/);
    expect(sqliteActivityStoreSource).toMatch(/parseLifecycleValidatedReviewState\(parsed,\s*this\.validateAdapterLifecycle\)/);
    expect(sqliteActivityStoreSource).toMatch(/new SqliteLocalDataService\(this\.db,\s*options,\s*this\.validateAdapterLifecycle\)/);
    expect(sqliteActivityStoreSource).not.toMatch(/reviewState(?:Schema|ShapeSchema|OutputShapeSchema|StructuralInvariantSchema|OutputSchema)/);
    expect(reviewComputationSource).toMatch(/rejectAdapterLifecycle/);
    expect(reviewComputationSource).not.toMatch(/validateSupportedAdapterLifecycle/);
    expect(sessionStoreSource).toMatch(/validateAdapterLifecycle:\s*AdapterLifecycleValidator/);
    expect(sessionStoreSource).not.toMatch(/validateAdapterLifecycle\?:/);
    expect(sessionStoreSource).toMatch(/parseLifecycleValidatedReviewState/);
    expect(sessionStoreSource).toMatch(/PRIVATE_DERIVED_REVIEW_FIELD_BINDINGS/);
    expect(sessionStoreSource).toMatch(/assertPrivateDerivedReviewStateProjections/);
    expect(sessionStoreSource).not.toMatch(/assertHumanReadableReviewStateProjection/);
    expect(sessionStoreSource).not.toMatch(/assertReviewTimeSimulationStateProjection/);
    expect(reviewComputationResultSource).toMatch(/parseLifecycleValidatedReviewState/);
    expect(reviewComputationResultSource).toMatch(/AdapterLifecycleValidator/);
    expect(runtimeStartSource).toMatch(/validateAdapterLifecycle:\s*validateSupportedAdapterLifecycle/);
    expect(smokeSource).toMatch(/validateAdapterLifecycle:\s*validateSupportedAdapterLifecycle/);
    expect(constructorBlocks.length).toBeGreaterThan(0);
    for (const block of constructorBlocks) {
      expect(block).toMatch(/validateAdapterLifecycle:/);
    }
    expect(sqliteActivityStoreBlocks.length).toBeGreaterThan(0);
    for (const block of sqliteActivityStoreBlocks) {
      expect(block).toMatch(/validateAdapterLifecycle:/);
    }
    expect(docs).toMatch(/stageCatalogId[\s\S]{0,140}adapter-owned stage catalog/i);
  });

  it("keeps object ownership evidence producer protocol-agnostic", () => {
    const source = [
      "src/core/action/transactionObjectOwnershipEvidence.ts",
      "src/core/action/transactionObjectOwnershipProducer.ts"
    ].map((file) => readFileSync(join(process.cwd(), file), "utf8")).join("\n");

    expect(source).toMatch(/createTransactionObjectOwnershipProducer/);
    expect(source).toMatch(/stored_transaction_data_and_mainnet_object_read/);
    expect(source).not.toMatch(/DeepBook|deepbook_swap_review_v1|quote_policy_derived|pool_resolved/);
  });

  it("keeps human-readable review envelope separate from swap projection validation", () => {
    const typeSource = readFileSync(
      join(process.cwd(), "src/core/action/types.ts"),
      "utf8"
    );
    const schemaSource = readFileSync(
      join(process.cwd(), "src/core/action/schemas.ts"),
      "utf8"
    );
    const envelopeSource = readFileSync(
      join(process.cwd(), "src/core/action/humanReadableReviewEvidence.ts"),
      "utf8"
    );
    const swapProjectionSource = readFileSync(
      join(process.cwd(), "src/core/action/swapHumanReadableReviewProjection.ts"),
      "utf8"
    );
    const projectionVerifierSource = readFileSync(
      join(process.cwd(), "src/core/action/humanReadableReviewProjectionVerifier.ts"),
      "utf8"
    );
    const sessionStoreSource = readFileSync(
      join(process.cwd(), "src/core/session/sessionStore.ts"),
      "utf8"
    );
    const responseGuidanceSource = readFileSync(
      join(process.cwd(), "src/mcp/responseGuidance.ts"),
      "utf8"
    );
    const envelopeTypeBlock = typeSource.slice(
      typeSource.indexOf("export type HumanReadableReviewEnvelope"),
      typeSource.indexOf("export type HumanReadableReviewSummaryBase")
    );
    const envelopeSchemaBlock = schemaSource.slice(
      schemaSource.indexOf("export const humanReadableReviewEnvelopeSchema"),
      schemaSource.indexOf("export const swapHumanReadableReviewProjectionSchema")
    );

    expect(envelopeTypeBlock).toMatch(/proposedAction/);
    expect(envelopeTypeBlock).not.toMatch(/swap_human_readable_review|assetFlow|targets|swap_output_asset/);
    expect(typeSource).not.toMatch(/export type HumanReadableReviewAmount\b/);
    expect(typeSource).not.toMatch(/export type HumanReadableReviewTarget\b/);
    expect(typeSource).toMatch(/export type SwapHumanReadableReviewAmount\b/);
    expect(typeSource).toMatch(/export type SwapHumanReadableReviewTarget\b/);
    expect(typeSource).toMatch(/export type SwapHumanReadableReviewSummary/);
    expect(envelopeSchemaBlock).toMatch(/proposedAction/);
    expect(envelopeSchemaBlock).not.toMatch(/swap_human_readable_review|assetFlow|targets|swap_output_asset/);
    expect(schemaSource).not.toMatch(/const humanReadableReviewAmountSchema\b/);
    expect(schemaSource).not.toMatch(/const humanReadableReviewTargetSchema\b/);
    expect(schemaSource).toMatch(/const swapHumanReadableReviewAmountSchema\b/);
    expect(schemaSource).toMatch(/const swapHumanReadableReviewTargetSchema\b/);
    expect(schemaSource).toMatch(/humanReadableReviewSummarySchema = z\.discriminatedUnion\("kind"/);
    expect(envelopeSource).toMatch(/createHumanReadableReviewEvidence/);
    expect(envelopeSource).toMatch(/verifyHumanReadableReviewEvidence/);
    expect(envelopeSource).not.toMatch(/SwapQuotePolicyEvidence|TransactionObjectOwnershipEvidence|swap_output_asset/);
    expect(swapProjectionSource).toMatch(/createSwapHumanReadableReviewEvidence/);
    expect(swapProjectionSource).toMatch(/SwapQuotePolicyEvidence/);
    expect(swapProjectionSource).toMatch(/TransactionObjectOwnershipEvidence/);
    expect(swapProjectionSource).toMatch(/swap_output_asset/);
    expect(projectionVerifierSource.indexOf("verifyHumanReadableReviewEvidence")).toBeLessThan(
      projectionVerifierSource.indexOf("switch (evidence.review.kind)")
    );
    expect(projectionVerifierSource).toMatch(/switch \(evidence\.review\.kind\)/);
    expect(projectionVerifierSource).toMatch(/case "swap_human_readable_review"/);
    expect(projectionVerifierSource).toMatch(/verifySwapHumanReadableReviewEvidence/);
    expect(projectionVerifierSource).toMatch(/unsupported human-readable review projection kind/);
    expect(sessionStoreSource).toMatch(/verifySupportedHumanReadableReviewEvidence/);
    expect(sessionStoreSource).not.toMatch(/verifySwapHumanReadableReviewEvidence/);
    expect(responseGuidanceSource).toMatch(/reviewState\.humanReadableReview\.targets/);
    expect(responseGuidanceSource).toMatch(/reviewState\.humanReadableReview\.blockingChecks/);
  });

  it("keeps DeepBook review lifecycle completion inside the stage runner", () => {
    const source = readFileSync(
      join(process.cwd(), "src/adapters/deepbook/deepbookReviewEvidence.ts"),
      "utf8"
    );

    expect(source).toMatch(/runDeepbookReviewStage/);
    expect(source).toMatch(/input\.lifecycle\.complete\(input\.stage\)/);
    expect(source).not.toMatch(/lifecycle\.complete\("[^"]+"\)/);
  });

  it("keeps private review artifacts out of public review computation results", () => {
    const resultSource = readFileSync(
      join(process.cwd(), "src/core/review/reviewComputationResult.ts"),
      "utf8"
    );
    const reviewComputationSource = readFileSync(
      join(process.cwd(), "src/core/review/reviewComputation.ts"),
      "utf8"
    );
    const deepbookEvidenceSource = readFileSync(
      join(process.cwd(), "src/adapters/deepbook/deepbookReviewEvidence.ts"),
      "utf8"
    );

    expect(resultSource).toMatch(/export type ReviewComputationResultBase/);
    expect(resultSource).not.toMatch(/privateArtifacts/);
    expect(reviewComputationSource).toMatch(/export type ReviewComputationOutput[\s\S]{0,160}privateArtifacts/);
    expect(reviewComputationSource).toMatch(/mapReviewComputationResultToState/);
    expect(deepbookEvidenceSource).toMatch(/export type DeepbookSwapReviewEvidenceResult[\s\S]{0,160}privateArtifacts/);
    expect(deepbookEvidenceSource).not.toMatch(/blockedReviewResult\([^)]*privateArtifacts/s);
  });

  it("keeps test-only private artifact mutators out of the runtime session store", () => {
    const source = readFileSync(
      join(process.cwd(), "src/core/session/sessionStore.ts"),
      "utf8"
    );

    expect(source).not.toMatch(/setReviewSessionPrivateArtifactsForTest|ForTest/);
  });

  it("keeps src/core free of adapter imports", () => {
    const coreDir = join(process.cwd(), "src/core");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        const source = readFileSync(fullPath, "utf8");
        if (/from "[^"]*\/adapters\//.test(source)) {
          offenders.push(fullPath);
        }
      }
    };
    walk(coreDir);
    expect(offenders).toEqual([]);
  });

  it("routes DeepBook review through the adapter identity source of truth", () => {
    const reviewComputationSource = readFileSync(
      join(process.cwd(), "src/core/review/reviewComputation.ts"),
      "utf8"
    );
    const reviewAdaptersSource = readFileSync(
      join(process.cwd(), "src/adapters/reviewAdapters.ts"),
      "utf8"
    );
    const deepbookIntentSource = readFileSync(
      join(process.cwd(), "src/adapters/deepbook/deepbookSwapIntent.ts"),
      "utf8"
    );
    const deepbookLifecycleSource = readFileSync(
      join(process.cwd(), "src/adapters/deepbook/deepbookReviewLifecycle.ts"),
      "utf8"
    );

    expect(deepbookIntentSource).toMatch(/DEEPBOOK_SWAP_ADAPTER_ID/);
    expect(deepbookIntentSource).toMatch(/DEEPBOOK_SWAP_PROTOCOL/);
    expect(deepbookIntentSource).toMatch(/isDeepbookSwapActionPlanIdentity/);
    expect(reviewAdaptersSource).toMatch(/isDeepbookSwapActionPlanIdentity/);
    expect(reviewComputationSource).not.toMatch(/deepbook/i);
    expect(reviewComputationSource).not.toMatch(/adapterId === "deepbook-swap"[\s\S]{0,100}actionKind === "swap"/);
    expect(deepbookLifecycleSource).toMatch(/DeepbookSwapActionPlanIdentity/);
  });

  it("keeps PTB visualization contract separate from executable material and signing readiness", () => {
    const docs = [
      "docs/AGENT_BEHAVIOR.md",
      "docs/FRONTEND_POLICY.md",
      "docs/MCP_TOOLS.md",
      "docs/SIGNABLE_ADAPTER_CONTRACT.md",
      "src/mcp/serverInfo.ts"
    ].map((file) => readFileSync(join(process.cwd(), file), "utf8")).join("\n");
    const source = readFileSync(
      join(process.cwd(), "src/core/action/signableAdapterContract.ts"),
      "utf8"
    );

    expect(source).toMatch(/ptbVisualizationArtifactSchema/);
    expect(source).not.toMatch(/PTB_RENDERER_CANDIDATE_DECISION/);
    expect(source).not.toMatch(/status: "defer"/);
    expect(source).toMatch(/executableMaterial[\s\S]{0,160}included:\s*z\.literal\(false\)/);
    expect(source).toMatch(/PTB_VISUALIZATION_REQUIRED_UNSUPPORTED_USES[\s\S]{0,260}signing_readiness/);
    expect(source).toMatch(/unsupportedUse:\s*z\.array\(z\.enum\(PTB_VISUALIZATION_REQUIRED_UNSUPPORTED_USES\)\)/);
    expect(docs).toMatch(/PtbVisualizationArtifact/);
    expect(docs).toMatch(/Mermaid[\s\S]{0,120}diagnostics/i);
    expect(docs).toMatch(/executableMaterial\.included: false/);
    expect(docs).toMatch(/pinned renderer dependency is `@zktx\.io\/ptb-model@0\.5\.0`/i);
    expect(docs).toMatch(/recomputed to match the bound transaction material commitment/i);
    expect(docs).not.toMatch(/deferred renderer candidate/i);
    expect(docs).not.toMatch(/@zktx\.io\/ptb-cli/i);
    expect(docs).toMatch(/not transaction-building[\s\S]{0,180}signing readiness/i);
    expect(docs).toMatch(/No model or card receives[\s\S]{0,60}transaction bytes or signatures/i);
    expect(docs).toMatch(/A PTB graph is not signing data, not signing readiness/i);
    expect(docs).not.toMatch(/PTB graph[\s\S]{0,180}(provides|proves|indicates|establishes).{0,80}(signing readiness|execution safety|wallet authorization)/i);
  });

  it("does not publish planned portfolio and route preview tools as implemented surfaces", () => {
    const publicSurfaceFiles = [
      "README.md",
      "docs/AGENT_BEHAVIOR.md",
      "docs/FRONTEND_POLICY.md",
      "docs/LOCAL_DB_ARCHITECTURE.md",
      "docs/MCP_SETUP.md",
      "docs/MCP_TOOLS.md",
      "docs/SDK_API.md",
      "docs/TRANSACTION_ACTIVITY_LOG.md",
      "docs/UTILITY_INDEX.md",
      "docs/WALLET_CONNECTION.md",
      "docs/golden-scenarios/BEHAVIOR_MATRIX.md",
      "protocols/deepbook-margin.md",
      "protocols/deepbook-v3.md",
      "src/mcp/serverInfo.ts",
      "src/mcp/tools/read/index.ts"
    ];
    const source = publicSurfaceFiles
      .map((file) => readFileSync(join(process.cwd(), file), "utf8"))
      .join("\n");
    const plannedToolPattern = new RegExp(
      [
        "read",
        "\\.",
        "(preview_portfolio_target|compare_funding_routes|explain_payment_readiness)"
      ].join("")
    );

    expect(source).not.toMatch(plannedToolPattern);
  });

  it("keeps classifier-uninspected inventory boundaries separate from product capabilities", () => {
    const publicSurfaceFiles = [
      "README.md",
      "docs/AGENT_BEHAVIOR.md",
      "docs/FRONTEND_POLICY.md",
      "docs/LOCAL_DB_ARCHITECTURE.md",
      "docs/MCP_SETUP.md",
      "docs/MCP_TOOLS.md",
      "docs/SDK_API.md",
      "docs/TRANSACTION_ACTIVITY_LOG.md",
      "docs/UTILITY_INDEX.md",
      "docs/WALLET_CONNECTION.md",
      "docs/golden-scenarios/BEHAVIOR_MATRIX.md",
      "src/mcp/serverInfo.ts",
      "src/mcp/toolNames.ts",
      "src/mcp/tools/read/index.ts"
    ];
    const publicSource = publicSurfaceFiles
      .map((file) => readFileSync(join(process.cwd(), file), "utf8"))
      .join("\n");
    const runtimeSource = [
      "src/core/read/readService.ts",
      "src/mcp/toolNames.ts",
      "src/mcp/tools/read/index.ts"
    ].map((file) => readFileSync(join(process.cwd(), file), "utf8")).join("\n");
    const plannedStakeTool = ["read", "summarize_staked_sui"].join(".");
    const disallowedSuiJsonRpcStakeTerms = [
      ["get", "Stakes"].join(""),
      ["suix", ["get", "Stakes"].join("")].join("_"),
      ["Sui", "Json", "Rpc", "Client"].join(""),
      `@mysten/sui/${["json", "Rpc"].join("")}`
    ];

    expect(publicSource).not.toContain(plannedStakeTool);
    expect(runtimeSource).not.toContain(plannedStakeTool);
    expect(publicSource).toMatch(/uninspectedAssetClasses/);
    expect(publicSource).toMatch(/classifier-uninspected boundaries/i);
    expect(publicSource).toMatch(/not zero-balance claims/i);
    expect(publicSource).toMatch(/not.*portfolio completeness/is);
    expect(publicSource).not.toMatch(
      /(staked|locked|vesting) (SUI|assets?|positions?).{0,160}(can be used as|is a|are a).{0,160}(funding sources?|route liquidity|payment readiness|portfolio completeness|transaction-building inputs?|signing data|signing readiness)/i
    );
    expect(publicSource).not.toMatch(
      /(NFTs?|objects?|LP positions?|vault positions?).{0,160}(can be used as|is a|are a).{0,160}(funding sources?|route liquidity|payment readiness|portfolio completeness|transaction-building inputs?|signing data|signing readiness)/i
    );
    for (const term of disallowedSuiJsonRpcStakeTerms) {
      expect(runtimeSource).not.toContain(term);
    }
  });

  it("keeps user-requested Sui activity scans bounded and separate from unsupported history claims", () => {
    const activitySurfaceFiles = [
      "README.md",
      "docs/AGENT_BEHAVIOR.md",
      "docs/FRONTEND_POLICY.md",
      "docs/LOCAL_DB_ARCHITECTURE.md",
      "docs/MCP_SETUP.md",
      "docs/MCP_TOOLS.md",
      "docs/TRANSACTION_ACTIVITY_LOG.md",
      "docs/UTILITY_INDEX.md",
      "src/mcp/serverInfo.ts",
      "src/mcp/toolNames.ts",
      "src/mcp/tools/read/index.ts",
      "src/mcp/tools/read/transactionActivityTools.ts"
    ];
    const source = activitySurfaceFiles
      .map((file) => readFileSync(join(process.cwd(), file), "utf8"))
      .join("\n");
    const localDbArchitecture = readFileSync(join(process.cwd(), "docs/LOCAL_DB_ARCHITECTURE.md"), "utf8");
    const mcpSetup = readFileSync(join(process.cwd(), "docs/MCP_SETUP.md"), "utf8");

    expect(source).toMatch(/read_inspect_sui_transaction/);
    expect(source).toMatch(/read_scan_sui_account_activity/);
    expect(source).toMatch(/read_summarize_sui_activity_scan/);
    expect(source).toMatch(/read_scan_sui_function_activity/);
    expect(source).toMatch(/read_summarize_sui_function_activity_scan/);
    expect(source).toMatch(/read_summarize_sui_account_activity/);
    expect(source).toMatch(/user-requested bounded/i);
    expect(source).toMatch(/known (local )?wallet/i);
    expect(source).toMatch(/stored normalized/i);
    expect(source).toMatch(/function_scan/);
    expect(source).toMatch(/scan kind[\s\S]{0,120}provenance/i);
    expect(localDbArchitecture).toMatch(/external_activity_scans\.kind[\s\S]{0,160}`function_scan`[\s\S]{0,160}recorded kind/i);
    expect(mcpSetup).toMatch(/Current-format backups can contain `function_scan` provenance/i);
    expect(mcpSetup).toMatch(/Unsupported formats and scan-kind values are rejected/i);
    expect(source).toMatch(/does not accept[\s\S]{0,120}`kind`[\s\S]{0,120}`function`[\s\S]{0,120}function-history filters/i);
    expect(source).toMatch(/Provider retention and rate-limit behavior[\s\S]{0,160}not Sui MCP guarantees/i);
    expect(source).toMatch(/requestedAccountTransactionFacts/);
    expect(source).toMatch(/requestedAccount\.coinFlows/);
    expect(source).toMatch(/transactions\[\]\.requestedAccountEffect/);
    expect(source).toMatch(/transactionContext[\s\S]{0,180}transaction-level/i);
    expect(source).toMatch(/transactionContext[\s\S]{0,220}(has no|omits|excludes)[\s\S]{0,160}transaction-wide balance-change/i);
    expect(source).toMatch(/read_summarize_sui_activity_scan[\s\S]{0,220}without returning full `?details`?/i);
    expect(source).toMatch(/(Inspect|Stored summary rows and inspect rows|Inspect responses and stored-summary rows)[\s\S]{0,260}`compact`/i);
    expect(source).toMatch(/compact\.factScope[\s\S]{0,80}transaction/);
    expect(source).toMatch(/compact\.requestedAccountScoped[\s\S]{0,80}false/);
    expect(source).toMatch(/compact[\s\S]{0,220}transaction-level facts[\s\S]{0,260}not (the requested wallet|wallet-specific)/i);
    expect(source).toMatch(/wallet\/account-specific balance answers[\s\S]{0,180}requestedAccountTransactionFacts[\s\S]{0,220}requestedAccount\.coinFlows[\s\S]{0,220}transactions\[\]\.requestedAccountEffect/i);
    expect(source).toMatch(/requestedAccountTransactionFacts\[\][\s\S]{0,220}account-scoped row surface/i);
    expect(source).toMatch(/transactionDetailAvailability[\s\S]{0,260}transactions\[\]\.transactionContext/i);
    expect(source).toMatch(/transactions\[\]\.transactionContext[\s\S]{0,220}allReturnedTransactionsHaveDetails: true/i);
    expect(source).toMatch(/When `transactionContext` is present[\s\S]{0,120}omits transaction-wide balance-change aggregates/i);
    expect(source).toMatch(/userAnswerUse\.answerFields[\s\S]{0,180}omits `transactionContext`, `compact`, `details`/i);
    expect(source).toMatch(/requestedAccountEffect\.scope[\s\S]{0,80}requested_account/i);
    expect(source).toMatch(/requestedAccountEffect\.limitations/);
    expect(source).toMatch(/accountBalanceChangeEvidence/);
    expect(source).toMatch(/accountBalanceChangeInferencePolicy/);
    expect(source).toMatch(/do_not_infer_from_transaction_context/);
    expect(source).toMatch(/visible recipient patterns/);
    expect(source).toMatch(/incomplete_account_balance_changes/);
    expect(source).toMatch(/account_balance_changes_unavailable/);
    expect(source).toMatch(/not zero-balance evidence/i);
    // Each resource is read independently. A correct sentence in one resource
    // must not hide a removed field or a missing completeness rule in another.
    for (const file of ["docs/MCP_TOOLS.md", "docs/AGENT_BEHAVIOR.md"]) {
      const guidance = readFileSync(join(process.cwd(), file), "utf8");
      expect(guidance, file).not.toContain("accountBalanceChangeAbsenceProven");
      expect(guidance, file).toMatch(/Only `no_account_balance_changes_returned` with complete details supports saying no requested-account balance change was returned/i);
      expect(guidance, file).toMatch(/incomplete_account_balance_changes[^\n]*not zero-balance evidence/i);
      expect(guidance, file).toMatch(/account_balance_changes_unavailable[^\n]*not zero-balance evidence/i);
      expect(guidance, file).toMatch(/do_not_infer_from_transaction_context[^\n]*(must not|do not)[^\n]*infer/i);
    }
    expect(source).toMatch(/no_account_balance_changes_returned[\s\S]{0,160}complete evidence/i);
    expect(source).toMatch(/analysis\.coinFlows[\s\S]{0,120}transaction\/page aggregate[\s\S]{0,120}not wallet-specific evidence/i);
    expect(source).toMatch(/raw integer facts scoped to the requested account/i);
    expect(source).toMatch(/quantitySemantics/);
    expect(source).toMatch(/displayConversionRequires/);
    expect(source).toMatch(/display_conversion_without_verified_decimals/);
    expect(source).toMatch(/requestedAccountTransactionFacts\[\]\.requestedAccountEffect\.balanceChanges\[\]\.amountRaw/i);
    expect(source).toMatch(/balanceChangeCompleteness[\s\S]{0,120}(truncated|unavailable)[\s\S]{0,160}incomplete/i);
    expect(source).toMatch(/Do not convert raw token amounts into display units unless[\s\S]{0,120}verified decimals/i);
    expect(source).toMatch(/gasCost\.display|analysis\.gas\.netGasCost\.display/);
    expect(source).toMatch(/MIST_PER_SUI/);
    expect(source).toMatch(/Profit, tax, performance, and cost-basis calculations[\s\S]{0,120}not Sui MCP surfaces/i);
    expect(source).toMatch(/assumed acquisition price[\s\S]{0,220}unsupported/i);
    expect(source).toMatch(/Do not provide profit formulas or hypothetical profit examples/i);
    expect(source).toMatch(/fiat USD cash-out|fiat cash-out/i);
    expect(source).toMatch(/external market-price conversion|external_market_price_conversion/i);
    expect(source).toMatch(/transactions the (selected )?account sent/i);
    expect(source).toMatch(/full `?package::module::function`?/i);
    expect(source).toMatch(/do(?:es)? not include[\s\S]{0,120}affected/i);
    expect(source).toMatch(/non-conforming provider row[\s\S]{0,120}dropped from the tool response/i);
    expect(source).not.toMatch(/non-conforming provider row[\s\S]{0,120}ephemeral current-response data/i);
    expect(source).toMatch(/Empty function activity results[\s\S]{0,120}do not prove no matching activity exists/i);
    expect(source).toMatch(/accepted_empty[\s\S]{0,160}not user-facing tool output/i);
    expect(source).not.toMatch(/accepted_empty (is|as) (tool output|runtime response|MCP output)/i);
    expect(source).toMatch(/protocolMatches/);
    expect(source).toMatch(/transaction_not_found/);
    expect(source).toMatch(/do not treat[\s\S]{0,80}transaction\.status[\s\S]{0,40}unknown[\s\S]{0,80}not-found signal/);
    expect(source).toMatch(/transaction activity labels only|transaction activity label/i);
    expect(source).not.toMatch(/background (wallet )?index(er|ing) is supported/i);
    expect(source).not.toMatch(/complete wallet history is supported/i);
    expect(source).not.toMatch(/complete dApp history is supported/i);
    expect(source).not.toMatch(/provider retention (is|are) guaranteed by Sui MCP/i);
    expect(source).not.toMatch(/rate limits? (is|are) guaranteed by Sui MCP/i);
    expect(source).not.toMatch(/P&L is supported/i);
    expect(source).not.toMatch(/cost basis[\s\S]{0,120}(profit would be|profit is|calculate profit)/i);
    const boundedHistoryTerms =
      /background index|complete wallet history|P&L|raw GraphQL payload|non-known party address|signing readiness|route recommendation|protocol support|(?:wallet )?position inventory|supported-protocol list/i;
    for (const file of activitySurfaceFiles) {
      expect(unnegatedClaims(readFileSync(join(process.cwd(), file), "utf8"), file, boundedHistoryTerms), file).toEqual([]);
    }
  });

  it("documents mainnet smoke activity coverage without treating it as CI or raw activity evidence", () => {
    const source = [
      "docs/MCP_SETUP.md",
      "docs/UTILITY_INDEX.md"
    ].map((file) => readFileSync(join(process.cwd(), file), "utf8")).join("\n");

    expect(source).toMatch(/npm run build[\s\S]{0,200}npm run smoke:mainnet/);
    expect(source).toMatch(/read_scan_sui_account_activity[\s\S]{0,120}limit 5/);
    expect(source).toMatch(/read_summarize_sui_activity_scan[\s\S]{0,160}limit 5/);
    expect(source).toMatch(/SUI_MCP_SMOKE_FUNCTION_TARGET/);
    expect(source).toMatch(/read_scan_sui_function_activity[\s\S]{0,220}limit 5/);
    expect(source).toMatch(/read_summarize_sui_function_activity_scan[\s\S]{0,220}limit 5/);
    expect(source).toMatch(/Empty account or function activity pages are valid smoke outcomes/);
    expect(source).toMatch(/function activity smoke is recorded as not run/);
    expect(source).toMatch(/notRunReason:\s+"missing_env"/);
    expect(source).toMatch(/rowCount:\s+0/);
    expect(source).toMatch(/emptyAccepted:\s+true/);
    expect(source).toMatch(/fullDetailsReturned/);
    expect(source).toMatch(/compactReturned/);
    expect(source).toMatch(/compactBalanceChangeRowCount/);
    expect(source).toMatch(/compactAggregatedBalanceChangeRowCount/);
    expect(source).toMatch(/transactionContextCount/);
    expect(source).toMatch(/requestedAccountTransactionFactCount/);
    expect(source).toMatch(/requestedAccountTransactionFactBalanceChangeRowCount/);
    expect(source).toMatch(/requestedAccountEffectBalanceChangeRowCount/);
    expect(source).toMatch(/requestedAccountEffectTruncatedTransactionCount/);
    expect(source).toMatch(/requestedAccountCoinFlowCount/);
    expect(source).toMatch(/analysisCoinFlowCount/);
    expect(source).toMatch(/Activity scan and summary smoke paths fail if full transaction details or compact transaction aggregates are returned/);
    expect(source).toMatch(/SUI_MCP_GRAPHQL_URL/);
    expect(source).toMatch(/does not store raw GraphQL payloads/i);
    expect(source).toMatch(/does not store[\s\S]{0,120}raw transaction details/i);
    expect(source).toMatch(/Not part of CI or `release:check`/);
  });

  it("documents the GraphQL function filter probe as manual source evidence only", () => {
    const utilityDocs = readFileSync(join(process.cwd(), "docs/UTILITY_INDEX.md"), "utf8");
    const probeScript = readFileSync(
      join(process.cwd(), "scripts/sui-graphql-function-filter-probe.ts"),
      "utf8"
    );

    expect(utilityDocs).toMatch(/Sui GraphQL function filter probe/);
    expect(utilityDocs).toMatch(/Manual, source evidence only/);
    expect(utilityDocs).toMatch(/scripts\/sui-graphql-function-filter-probe\.ts/);
    expect(utilityDocs).toMatch(/TransactionFilter\.function[\s\S]{0,160}account, object, kind, and checkpoint axes/i);
    expect(utilityDocs).toMatch(/last: 1/);
    expect(utilityDocs).toMatch(/ignored local source-probe note/);
    expect(utilityDocs).toMatch(/git worktree state/i);
    expect(utilityDocs).toMatch(/probe script hash/i);
    expect(utilityDocs).toMatch(/redacts sampled digests, addresses, objects, and functions/i);
    expect(utilityDocs).toMatch(/does not store raw GraphQL payloads/i);
    expect(utilityDocs).toMatch(/not an MCP tool/i);
    expect(utilityDocs).toMatch(/not packaged product functionality/i);
    expect(utilityDocs).toMatch(/not CI/i);
    expect(utilityDocs).toMatch(/not a function diagnostics implementation/i);
    expect(utilityDocs).not.toMatch(/function diagnostics is supported/i);
    expect(utilityDocs).not.toMatch(/signing readiness source/i);
    expect(probeScript).toMatch(/FUNCTION_FILTER_PROBE_ROW_LIMIT = 1/);
    expect(probeScript).toMatch(/FUNCTION_FILTER_PROBE_SAMPLE_SIZE = 50/);
    expect(probeScript).toMatch(/FUNCTION_FILTER_PROBE_OUTPUT_PATH = "\.WORK\/function-filter-source-probe\.md"/);
    expect(probeScript).toMatch(/gitWorktreeState/);
    expect(probeScript).toMatch(/scriptSha256/);
    expect(probeScript).toMatch(/git", \["status", "--porcelain"\]/);
    expect(probeScript).toMatch(/REDACTED_SAMPLE_DIGEST/);
    expect(probeScript).toMatch(/REDACTED_SAMPLE_ADDRESS/);
    expect(probeScript).toMatch(/REDACTED_SAMPLE_OBJECT/);
    expect(probeScript).toMatch(/REDACTED_SAMPLE_FUNCTION/);
    expect(probeScript).toMatch(/inconclusive_mainnet_guard/);
    expect(probeScript).toMatch(/inconclusive_missing_sample/);
  });

  it("keeps Sui CLI diagnostics as manual debug evidence only", () => {
    const utilityDocs = readFileSync(join(process.cwd(), "docs/UTILITY_INDEX.md"), "utf8");
    const diagnosticsScriptFiles = readdirSync(join(process.cwd(), "scripts"))
      .filter((file) => /^sui-cli-transaction-diagnostics.*\.ts$/.test(file))
      .sort();
    const scriptSource = diagnosticsScriptFiles
      .map((file) => readFileSync(join(process.cwd(), "scripts", file), "utf8"))
      .join("\n");

    expect(diagnosticsScriptFiles).toContain("sui-cli-transaction-diagnostics.ts");
    expect(utilityDocs).toMatch(/Sui CLI transaction diagnostics/);
    expect(utilityDocs).toMatch(/Manual, source checkout only/);
    expect(utilityDocs).toMatch(/--object <objectId>/);
    expect(utilityDocs).toMatch(/--gas-profile/);
    expect(utilityDocs).toMatch(/--read-timeout-ms <ms>/);
    expect(utilityDocs).toMatch(/--help/);
    expect(utilityDocs).toMatch(/CLI env aliases must not contain redaction marker word forms/);
    expect(utilityDocs).toMatch(/private key.*mnemonic.*signature.*signed transaction.*transaction bytes.*suiprivkey/s);
    expect(utilityDocs).toMatch(/using `-`, `_`, a space, or no separator/);
    expect(utilityDocs).toMatch(/Artifact paths.*must not contain `suiprivkey`-style markers/);
    expect(utilityDocs).toMatch(/other redaction markers in paths are accepted and redacted/);
    expect(utilityDocs).toMatch(/not an MCP tool/i);
    expect(utilityDocs).toMatch(/not (a )?CI/i);
    expect(utilityDocs).toMatch(/not packaged product functionality/i);
    expect(utilityDocs).toMatch(/not review-time simulation/i);
    expect(utilityDocs).toMatch(/not wallet authorization/i);
    expect(utilityDocs).toMatch(/not signing readiness/i);
    expect(utilityDocs).toMatch(/not.*onchain transaction submission\/execution/i);
    expect(utilityDocs).toMatch(/local replay.*debug evidence/i);
    expect(scriptSource).toMatch(/debug_only_not_signing_readiness/);
    expect(scriptSource).toMatch(/FORBIDDEN_SUI_CLI_TERMS/);
    expect(scriptSource).toMatch(/keytool/);
    expect(scriptSource).toMatch(/execute-signed-tx/);
    expect(scriptSource).toMatch(/suiprivkey/);
  });

  it("keeps gas reserve policy deferred to the current not-evaluated warning", () => {
    const gasReserveSurfaceFiles = [
      "README.md",
      "docs/AGENT_BEHAVIOR.md",
      "docs/MCP_SETUP.md",
      "docs/MCP_TOOLS.md",
      "docs/UTILITY_INDEX.md",
      "src/core/read/readService.ts",
      "src/mcp/serverInfo.ts",
      "src/mcp/tools/read/index.ts"
    ];
    const source = gasReserveSurfaceFiles
      .map((file) => readFileSync(join(process.cwd(), file), "utf8"))
      .join("\n");

    expect(source).toMatch(/gas_reserve_not_evaluated/);
    expect(source).not.toMatch(
      new RegExp(
        [
          ["gas", "Reserve", "Status"].join(""),
          ["gas", "reserve", "satisfied"].join("_"),
          ["gas", "reserve", "would", "be", "violated"].join("_"),
          ["gas", "reserve", "not", "applicable"].join("_")
        ].join("|")
      )
    );
  });

  it("keeps coin metadata cache failures on one public MCP error kind", () => {
    const metadataCacheErrorFiles = [
      "README.md",
      "docs/AGENT_BEHAVIOR.md",
      "docs/LOCAL_DB_ARCHITECTURE.md",
      "docs/MCP_TOOLS.md",
      "src/core/action/types.ts",
      "src/core/read/readService.ts",
      "src/mcp/tools/read/index.ts"
    ];
    const source = metadataCacheErrorFiles
      .map((file) => readFileSync(join(process.cwd(), file), "utf8"))
      .join("\n");

    expect(source).toMatch(/metadata_cache_unavailable/);
    expect(source).not.toMatch(
      new RegExp(
        [
          ["metadata", "cache", "read", "failed"].join("_"),
          ["metadata", "cache", "write", "failed"].join("_"),
          ["cache", "unavailable", "transient"].join("_"),
          ["cache", "unavailable", "permanent"].join("_")
        ].join("|")
      )
    );
  });

  it("separates Sui JSON-RPC source exclusion from MCP JSON-RPC transport wording", () => {
    const files = [
      "README.md",
      "docs/MCP_SETUP.md",
      "docs/MCP_TOOLS.md",
      "docs/SDK_API.md",
      "src/runtime/config.ts"
    ];

    for (const file of files) {
      expect(unsupportedJsonRpcClaims(readFileSync(join(process.cwd(), file), "utf8"), file), file).toEqual([]);
    }
  });
});
