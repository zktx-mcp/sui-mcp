import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const BARE_INTERACTIVE_ELEMENTS = ["button", "input", "select", "textarea"];

it("internal cards do not invoke clipboard APIs or offer copy controls", () => {
  for (const file of ["src/mcp-ui/view/lifecycle.ts", "src/mcp-ui/view/account.ts", "src/mcp-ui/view/receipt.ts", "src/mcp-ui/view/chart.ts", "src/mcp-ui/view/review.ts", "src/mcp-ui/view/connect.ts", "src/mcp-ui/view/settings.ts", "review-app/src/ui/receiptSummary.ts", "review-app/src/ui/receiptView.ts", "review-app/src/ui/chainReceiptView.ts", "review-app/src/ui/ui.ts", "review-app/src/ui/ptbDiagram.ts"]) {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    expect(source, file).not.toMatch(/navigator\.clipboard|execCommand|copyTextButton|copyIconButton|copyButton|Copy Markdown|window\.prompt/);
  }
});

function readCss(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

function selectorsOf(cssSource: string): string[] {
  const withoutComments = cssSource.replace(/\/\*[\s\S]*?\*\//g, "");
  return withoutComments
    .split("}")
    .map((block) => block.split("{")[0] ?? "")
    .flatMap((selectorList) => selectorList.split(","))
    .map((selector) => selector.trim())
    .filter((selector) => selector.length > 0 && !selector.startsWith("@"));
}

function targetsBareInteractiveElement(selector: string): boolean {
  return selector.split(/[\s>+~]+/).some((compound) => {
    const head = compound.match(/^[a-zA-Z]+/)?.[0]?.toLowerCase();
    return head !== undefined && BARE_INTERACTIVE_ELEMENTS.includes(head);
  });
}

describe("shared-vs-page styling boundary (Plan B B1)", () => {
  it("keeps the single Settings operation action scoped and depth motion optional", () => {
    const ui = readCss("review-app/public/ui.css");
    const row = ui.match(/\.settings-card \.settings-action-row\s*\{([^}]+)\}/)?.[1];
    expect(row).toContain("display: grid");
    expect(row).toContain("grid-template-columns: minmax(0, 1fr)");
    const controls = ui.match(/\.settings-card \.settings-action-row > \.ui-btn\s*\{([^}]+)\}/)?.[1];
    expect(controls).toContain("min-width: 0"); expect(controls).toContain("white-space: normal");
    expect(ui).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*settings-page--forward[^}]*settings-page--back[^}]*animation: none/s);
    expect(ui).toContain("translateX(16px)"); expect(ui).toContain("translateX(-16px)");
    expect(selectorsOf(ui).filter((selector) => selector.includes("settings-action-row")))
      .toEqual([".settings-card .settings-action-row", ".settings-card .settings-action-row > .ui-btn"]);
  });
  it("the shared stylesheet owns the ui- atomic components", () => {
    const ui = readCss("review-app/public/ui.css");
    const atoms = [
      ".ui-btn",
      ".ui-btn-row",
      ".ui-input",
      ".ui-card",
      ".ui-row",
      ".ui-select",
      ".ui-status-banner",
      ".ui-detail-item",
      ".ui-ptb-graph",
      ".ui-accordion",
      ".ui-feedback",
      ".ui-placeholder"
    ];
    for (const atom of atoms) {
      expect(ui, `ui.css declares ${atom}`).toContain(atom);
    }
  });

  // Current layouts consume shared controls without defining a second style source.
  const migratedPageCss = [
    "review-app/src/account.css",
    "src/mcp-ui/view/workflow.css",
    "src/mcp-ui/view/style.css"
  ];

  it("migrated page stylesheets declare no ui- class rule and no bare interactive-element rule", () => {
    for (const path of migratedPageCss) {
      for (const selector of selectorsOf(readCss(path))) {
        expect(selector.includes(".ui-"), `${path}: "${selector}" must not target a shared atom`).toBe(false);
        expect(
          targetsBareInteractiveElement(selector),
          `${path}: "${selector}" must not style a bare interactive element`
        ).toBe(false);
      }
    }
  });
});
