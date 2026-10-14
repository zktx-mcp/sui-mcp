import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MCP_RESOURCES } from "../src/mcp/resources.js";
import { unnegatedClaims } from "./helpers/documentClaims.js";
import { SERVER_INSTRUCTIONS } from "../src/mcp/serverInfo.js";

function read(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

function requiredBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start, `missing block start marker ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(end, `missing block end marker ${endMarker}`).toBeGreaterThan(start);
  return source.slice(start + startMarker.length, end);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countLiteral(source: string, literal: string): number {
  return source.match(new RegExp(escapeRegExp(literal), "g"))?.length ?? 0;
}

function protocolFiles(): string[] {
  return readdirSync(join(process.cwd(), "protocols"))
    .filter((file) => file.endsWith(".md"))
    .map((file) => `protocols/${file}`)
    .sort();
}

function goldenScenarioFiles(): string[] {
  return readdirSync(join(process.cwd(), "docs/golden-scenarios"))
    .filter((file) => file.endsWith(".md"))
    .map((file) => `docs/golden-scenarios/${file}`)
    .sort();
}

describe("documentation responsibility boundaries", () => {
  it("distinguishes request/card/file bounds in the API and links them from concise injected guidance", () => {
    const api = requiredBlock(read("docs/MCP_TOOLS.md"), "The local stdio gateway", "## Read-Only Tools");
    expect(api).toMatch(/request body must fit within 4 MiB/);
    expect(api).toMatch(/entire MCP JSON-RPC\s+envelope and metadata/);
    expect(api).toMatch(/rejected before tool or card\s+dispatch/);
    expect(api).toMatch(/not an unsupported function, wallet\s+rejection or unconfirmed file delivery/);
    expect(api).toMatch(/Card calls also have a 64 KiB envelope budget/);
    expect(api).toMatch(/Ordinary MCP calls do not inherit\s+that smaller card limit/);
    expect(api).toMatch(/Restore files may contain up to 16 MiB and are sent in\s+separate messages/);
    expect(api).toMatch(/4 MiB request limit is not a\s+backup-file limit/);
    expect(SERVER_INSTRUCTIONS).toContain("suimcp://docs/mcp-tools");
  });

  it("keeps runtime resource metadata aligned with README documentation map wording", () => {
    expect(MCP_RESOURCES.map((resource) => [resource.uri, resource.description])).toEqual([
      [
        "suimcp://docs/readme",
        "Public entry document: product purpose, current release boundary, setup path, and documentation map."
      ],
      [
        "suimcp://docs/mcp-setup",
        "Setup guide: installation, MCP client connection, first-use flow, settings, and troubleshooting."
      ],
      [
        "suimcp://docs/mcp-tools",
        "API reference: tool contracts, response fields, statuses, follow-up fields, and output boundaries."
      ],
      [
        "suimcp://docs/wallet-connection",
        "Wallet connection reference: active read context, private SDK ownership and user-approved transaction requests."
      ],
      [
        "suimcp://docs/agent-behavior",
        "Answer playbook: user-question flows, tool selection, and response wording boundaries."
      ],
      [
        "suimcp://protocols/deepbook-v3",
        "Protocol reference only; use MCP tool responses and read_list_supported_protocols for current support."
      ],
      [
        "suimcp://protocols/deepbook-margin",
        "Protocol reference only; no margin MCP read tools or signable actions are exposed in this release."
      ]
    ]);

    const readme = read("README.md");
    for (const resource of MCP_RESOURCES) {
      expect(readme).toContain(`- \`${resource.path}\`: ${resource.description}`);
    }
  });

  it("keeps development policy Documentation Ownership as one responsibility table", () => {
    const ownership = requiredBlock(
      read("docs/AGENT_DEVELOPMENT_POLICY.md"),
      "## Documentation Ownership",
      "## Instruction Surface Ownership"
    );

    expect(ownership).toMatch(/\| Document \| Owns \| Must not own or claim \|/);
    expect(ownership).toMatch(/Use this single responsibility schema/);

    for (const documentEntry of [
      "README.md",
      "AGENTS.md",
      "docs/AGENT_DEVELOPMENT_POLICY.md",
      "docs/MCP_SETUP.md",
      "docs/MCP_TOOLS.md",
      "docs/AGENT_BEHAVIOR.md",
      "docs/WALLET_CONNECTION.md",
      "docs/TRANSACTION_ACTIVITY_LOG.md",
      "docs/UTILITY_INDEX.md",
      "docs/LOCAL_DB_ARCHITECTURE.md",
      "docs/SDK_API.md",
      "docs/FRONTEND_POLICY.md",
      "docs/golden-scenarios/*.md",
      "protocols/*.md",
      ".WORK/"
    ]) {
      expect(countLiteral(ownership, `\`${documentEntry}\``), `${documentEntry} entry count`).toBe(1);
    }

    expect(ownership).not.toMatch(/is the public first-entry document for humans and AI agents/);
    expect(ownership).not.toMatch(/are user-side AI agent and operator references/);
    expect(ownership).not.toMatch(/owns reusable utility and script boundaries/);
  });

  it("keeps MCP_TOOLS as an API reference rather than a user-question workflow playbook", () => {
    const mcpTools = read("docs/MCP_TOOLS.md");

    expect(mcpTools).toMatch(/This document is the MCP API reference/);
    expect(mcpTools).toMatch(/tool contracts, response fields, statuses, follow-up fields, and output boundaries/);
    expect(mcpTools).toMatch(/does not own installation steps or user-question playbooks/i);
    expect(mcpTools).toMatch(/userAnswerUse\.canAnswer/);
    expect(mcpTools).toMatch(/userAnswerUse\.cannotAnswer/);
    expect(mcpTools).toMatch(/userAnswerUse\.answerFields/);
    expect(mcpTools).toMatch(/userAnswerUse\.diagnosticOnlyFields/);
    expect(mcpTools).toMatch(/userAnswerUse\.followUp\.tool/);
    expect(mcpTools).toMatch(/toolAvailability\.requiredToolsAvailable/);
    expect(mcpTools).toMatch(/requiredPaymentAnswerTool:\s+"read_preview_intent_evidence"/);
    expect(mcpTools).toMatch(/requiredPaymentAnswerField:\s+"responseSummary"/);

    expect(mcpTools).not.toMatch(/^## Example Workflows/m);
    expect(mcpTools).not.toMatch(/Check server status with `read_get_server_status`/);
    expect(mcpTools).not.toMatch(/Use summary output first/);
    expect(mcpTools).not.toMatch(/immediately call `session_wait_wallet_identity`/);
  });

  it("keeps AGENT_BEHAVIOR as the answer playbook rather than a tool contract", () => {
    const agentBehavior = read("docs/AGENT_BEHAVIOR.md");

    expect(agentBehavior).toMatch(/MCP-exposed answer playbook/);
    expect(agentBehavior).toMatch(/does not define tool schemas or field contracts/i);
    expect(agentBehavior).toMatch(/Answer only from current tool evidence[\s\S]{0,220}read_get_server_status/);
    expect(agentBehavior).toMatch(/Can I cover a 1000 dollar payment/);
    expect(agentBehavior).toMatch(/How much are my USD-denominated assets together/);
    expect(agentBehavior).toMatch(/What is the shortfall/);
    expect(agentBehavior).toMatch(/Do not call quote tools for the same payment coverage, balance-total, or shortfall question/);
    expect(agentBehavior).toMatch(/session_wait_wallet_connection_card` use the/);
  });

  it("keeps MCP_SETUP focused on setup while linking to API and playbook references", () => {
    const mcpSetup = read("docs/MCP_SETUP.md");

    expect(mcpSetup).toMatch(/This is the setup guide/);
    expect(mcpSetup).toMatch(/does not define tool field contracts or response wording/i);
    expect(mcpSetup).toMatch(/Use `docs\/MCP_TOOLS\.md` for the MCP API reference/);
    expect(mcpSetup).toMatch(/`docs\/AGENT_BEHAVIOR\.md` for the answer playbook/);

    for (const fieldContractFragment of [
      "userAnswerUse.canAnswer",
      "userAnswerUse.cannotAnswer",
      "userAnswerUse.diagnosticOnlyFields",
      "toolAvailability.requiredToolsAvailable",
      "responseSummary.doNotUseForConclusion",
      "quantitySemantics.doNotCombineWithPaymentAnswer",
      "requiredPaymentAnswerField"
    ]) {
      expect(mcpSetup).not.toContain(fieldContractFragment);
    }
  });

  it("keeps protocol documents from reading as runtime registries or support declarations", () => {
    const mcpTools = read("docs/MCP_TOOLS.md");

    for (const file of ["protocols/deepbook-v3.md", "protocols/deepbook-margin.md"]) {
      const source = read(file);
      expect(source).toMatch(/not a runtime registry/i);
      expect(source).toMatch(/not a supported-protocol list/i);
      expect(source).toMatch(/not a live liquidity source/i);
      expect(source).toMatch(/not a route recommendation source/i);
      expect(source).toMatch(/not a signing-readiness signal/i);
      expect(source).not.toMatch(/^Current read-only support:/m);
      expect(source).not.toMatch(/^Current MCP surfaces/m);
      expect(source).not.toMatch(/^Current scope:/m);
    }

    for (const file of protocolFiles()) {
      const intro = read(file).slice(0, 900);
      expect(intro, file).toMatch(/not[\s\S]{0,260}supported-protocol/i);
      expect(intro, file).toMatch(/not[\s\S]{0,260}signing readiness|not[\s\S]{0,260}signing-readiness/i);
      expect(intro, file).not.toMatch(/runtime registry for supported protocols/i);
      expect(intro, file).not.toMatch(/supported-protocol registry/i);
    }

    expect(mcpTools).toMatch(/Protocol resources are not runtime registries, supported-protocol lists, live liquidity sources, route recommendations, or signing-readiness signals/);
    for (const resource of MCP_RESOURCES.filter((resource) => resource.uri.startsWith("suimcp://protocols/"))) {
      expect(resource.description).toMatch(/Protocol reference only/);
      expect(resource.description).not.toMatch(/support notes/i);
    }
  });

  it("keeps extended boundary documents inside their own responsibilities", () => {
    for (const file of goldenScenarioFiles()) {
      const source = read(file);
      expect(source, file).toMatch(/golden|scenario|matrix|release review/i);
      expect(source, file).not.toMatch(/This document is the MCP API reference/i);
      expect(source, file).not.toMatch(/owns tool contracts/i);
      expect(source, file).not.toMatch(/defines? tool schemas/i);
      expect(source, file).not.toMatch(/defines? field contracts/i);
    }

    const utility = read("docs/UTILITY_INDEX.md");
    expect(utility).toMatch(/manual utility and script boundaries/i);
    expect(utility).toMatch(/Source-checkout scripts are not packaged product commands, MCP tools, review-time simulation, transaction builders, signing readiness signals, or wallet authorization evidence/i);
    expect(utility).not.toMatch(/source-checkout scripts are packaged product commands/i);
    expect(utility).not.toMatch(/utility output is signing readiness/i);

    const transactionLog = read("docs/TRANSACTION_ACTIVITY_LOG.md");
    expect(transactionLog).toMatch(/local transaction activity storage boundaries/i);
    expect(transactionLog).toMatch(/does not claim complete wallet history/i);
    expect(unnegatedClaims(
      transactionLog,
      "docs/TRANSACTION_ACTIVITY_LOG.md",
      /complete wallet history|P&L|profit|cost basis|signing readiness/i
    )).toEqual([]);

    const walletIdentity = read("docs/WALLET_CONNECTION.md");
    expect(walletIdentity).toMatch(/active read account|read context/i);
    expect(walletIdentity).toMatch(/not login[\s\S]{0,100}custody[\s\S]{0,80}standing permission/i);
    expect(unnegatedClaims(
      walletIdentity,
      "docs/WALLET_CONNECTION.md",
      /login|authentication|signing authorization|custody|permission for transactions|private keys|executable transaction material/i
    )).toEqual([]);
  });

  it("keeps golden answer allowed conclusions separate from forbidden conclusions", () => {
    const golden = read("docs/golden-scenarios/INTENT_EVIDENCE_GOLDEN_ANSWERS.md");
    const quoteSection = requiredBlock(
      golden,
      "`quote_detour_shortfall_guard`",
      "`explicit_usdc_shortfall`"
    );
    const allowedConclusion = requiredBlock(quoteSection, "Allowed conclusion:", "Forbidden conclusions:");
    const forbiddenConclusions = requiredBlock(
      quoteSection,
      "Forbidden conclusions:",
      "Required evidence fields:"
    );
    const requiredEvidenceFields = requiredBlock(quoteSection, "Required evidence fields:", "Answer shape:");

    for (const requiredField of [
      "responseSummary.answerCompleteness.requiredAnswerFields",
      "responseSummary.doNotCallQuoteToolsForThisQuestion",
      "responseSummary.separateQuoteOutputs",
      "quantitySemantics.doNotCombineWithPaymentAnswer",
      'userAnswerUse.followUp.answerFields: ["responseSummary"]'
    ]) {
      expect(requiredEvidenceFields).toContain(requiredField);
    }

    for (const forbiddenFragment of [
      "other assets were considered",
      "everything can be converted",
      "quote outputs can be combined",
      "still short after adding quote outputs",
      "569.01226"
    ]) {
      expect(forbiddenConclusions.toLowerCase()).toContain(forbiddenFragment.toLowerCase());
      expect(allowedConclusion.toLowerCase()).not.toContain(forbiddenFragment.toLowerCase());
    }

    const standardClauses = requiredBlock(golden, "## Standard Clauses", "## Forbidden Claims");
    const forbiddenClaims = requiredBlock(golden, "## Forbidden Claims", "## Manual Client Observation");
    expect(standardClauses).toMatch(/pre-transaction intent evidence only/);
    expect(forbiddenClaims).toMatch(/Best route, route quality, route-dependent payment support, or venue comparison/);
    expect(forbiddenClaims).toMatch(/P&L, profit, tax, performance, or cost-basis calculations/);
    expect(standardClauses).not.toMatch(/USDC equals fiat USD|Best route|P&L|profit|tax|cost-basis/i);
  });
});

describe("disconnect request routing", () => {
  it("routes disconnect requests to the existing user-confirmed card, never to clearing read context", () => {
    const behavior = read("docs/AGENT_BEHAVIOR.md");
    const flow = requiredBlock(behavior, 'For "disconnect my wallet",', '3. `session_get_wallet_connection_card`');
    expect(flow).toContain("open `session_open_wallet_connection_card` with `intent: disconnect`");
    expect(flow).toContain("Confirm disconnect or Back");
    expect(flow).toContain("Back only returns to the connection view");
    expect(flow).toContain("does not submit Cancel review or disconnect");
    expect(flow).toContain("The card starts no pairing");
    expect(flow).toContain("Do not substitute the Settings action to clear the default read address");
    expect(flow).toContain("If disconnection is already pending");
    expect(behavior).toContain("For a connect request, if the requested wallet is already connected");
  });
});
