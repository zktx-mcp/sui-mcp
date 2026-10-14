import { describe, expect, it } from "vitest";
import { claimUnits, unnegatedClaims, unsupportedJsonRpcClaims } from "./helpers/documentClaims.js";

const readiness = /signing readiness/i;
const failures = (text: string) => unnegatedClaims(text, "fixture.md", readiness);

describe("document claim boundaries", () => {
  it.each([
    "Availability describes the backend dependency, not account ownership, wallet approval or signing readiness.",
    "Availability describes the backend dependency, not account ownership, wallet\napproval or signing readiness.",
    "Availability describes the backend dependency, **not** account ownership, wallet approval or **signing readiness**.",
    "Signing readiness is not supported.",
    "Signing readiness and transaction authorization are unsupported.",
    "It marks P&L and signing readiness as not available.",
    "Signing readiness and transaction authorization are classified as unsupported.",
    "This tool does not execute transactions or provide signing readiness.",
    "This tool must not rank routes, compute profit, or provide signing readiness.",
    "This evidence does not establish:\n\n- wallet approval or\n  signing readiness.",
    "This evidence does not establish:\n\n1. wallet approval or\n   signing readiness."
  ])("keeps the same exclusion through formatting: %s", (text) => {
    expect(failures(text)).toEqual([]);
  });

  it.each([
    "This server provides signing readiness.",
    "This server does not calculate tax. It provides signing readiness.",
    "This server does not calculate tax; it provides signing readiness.",
    "This server does not calculate tax but provides signing readiness.",
    "This server does not calculate tax and provides signing readiness.",
    "This server does not calculate tax and signing readiness is provided.",
    "This server does not calculate tax while signing readiness is provided.",
    "This server does not calculate tax and adds signing readiness.",
    "This is not about tax and creatively supplies signing readiness.",
    "Signing readiness adds benefits and tax is not supported.",
    "This is not tax evidence, signing readiness is supported.",
    "This server provides not only signing readiness but also authorization.",
    "This server provides not merely signing readiness but also authorization.",
    "Signing readiness is not unavailable.",
    "It describes tax as unavailable and provides signing readiness.",
    "It provides signing readiness and describes tax as not available.",
    "This evidence does not establish:\n\n- It provides signing readiness.",
    "This is not about tax:\n\n- signing readiness.",
    "This evidence does not establish:\n\n- account ownership\n\nNew claims:\n\n- signing readiness.",
    "| Exclusion | Claim |\n| --- | --- |\n| No tax calculations | Signing readiness is provided. |",
    "No tax calculations.\n\n## Signing readiness is provided",
    "No tax calculations.\n\n```text\nSigning readiness is provided.\n```",
    "Not a forbidden example:\n\n```text\nThis server provides signing readiness.\n```",
    "Not forbidden claims:\n\n- This server provides signing readiness."
  ])("does not borrow unrelated negation: %s", (text) => {
    expect(failures(text).length).toBeGreaterThan(0);
  });

  it("keeps a forbidden example separate from a subsequent product claim", () => {
    const text = "Forbidden example:\n\n```text\nThis server provides signing readiness.\n```";
    expect(failures(text)).toEqual([]);
    expect(failures(`${text}\n\nThis server provides signing readiness.`)).toHaveLength(1);
  });

  it("keeps a forbidden-claim list separate from an independent list", () => {
    const text = "Do not claim:\n\n- This server provides signing readiness.";
    expect(failures(text)).toEqual([]);
    expect(failures(`${text}\n\nProduct claims:\n\n- This server provides signing readiness.`)).toHaveLength(1);
  });

  it("never carries a document's exclusion into another document", () => {
    expect(unnegatedClaims("This evidence does not establish:", "first.md", readiness)).toEqual([]);
    expect(unnegatedClaims("- signing readiness", "second.md", readiness)).toHaveLength(1);
  });

  it("reports the location of the owning block", () => {
    const [failure] = failures("# Evidence\n\nThis server provides\nsigning readiness.");
    expect(failure).toMatchObject({ file: "fixture.md", line: 3, text: "This server provides signing readiness." });
  });

  it("reads TypeScript literals independently without treating code as Markdown or executing it", () => {
    const source = [
      'const unrelated = "This server does not calculate tax.";',
      'const claim = `This server provides signing readiness.`;',
      'const denial = `These ${unavailableExpression()} facts are not signing readiness.`;'
    ].join("\n");
    expect(unnegatedClaims(source, "fixture.ts", readiness)).toEqual([
      { file: "fixture.ts", line: 2, text: "This server provides signing readiness." }
    ]);
    expect(claimUnits(source, "fixture.ts")).toHaveLength(3);
  });
});

describe("Sui source and MCP transport JSON-RPC boundaries", () => {
  it.each([
    "Sui JSON-RPC client imports are\nnot used.",
    "MCP JSON-RPC is supported. Sui JSON-RPC is not supported.",
    "stdout is reserved for JSON-RPC protocol messages.",
    "MCP JSON-RPC is supported and Sui JSON-RPC is excluded."
  ])("keeps correctly scoped transport and source statements: %s", (text) => {
    expect(unsupportedJsonRpcClaims(text, "fixture.md")).toEqual([]);
  });

  it.each([
    "MCP JSON-RPC is supported. Sui JSON-RPC is supported.",
    "MCP JSON-RPC and Sui JSON-RPC are supported.",
    "MCP JSON-RPC is supported but Sui JSON-RPC is supported too.",
    "stdout is reserved for messages; Sui JSON-RPC is supported.",
    "stdout carries Sui JSON-RPC responses.",
    "Sui JSON-RPC is not only supported but recommended.",
    "| Transport | Source |\n| --- | --- |\n| MCP JSON-RPC | Sui JSON-RPC is supported. |"
  ])("does not extend a transport exception to a Sui source claim: %s", (text) => {
    expect(unsupportedJsonRpcClaims(text, "fixture.md").length).toBeGreaterThan(0);
  });
});
