import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("vite", () => ({ build: vi.fn() }));
import { build } from "vite";

// Independent upstream text: lightweight-charts v5.2.1/NOTICE, not generated output.
const notice = "TradingView Lightweight Charts™\nCopyright (с) 2025 TradingView, Inc. https://www.tradingview.com/\n";
const noticePath = "LICENSES/lightweight-charts-5.2.1-NOTICE.txt";
let root: string;
let chartPackage: string;

beforeEach(async () => {
  vi.resetModules();
  root = await mkdtemp(join(tmpdir(), "say-mcp-notices-"));
  chartPackage = join(root, "node_modules/lightweight-charts");
  await mkdir(chartPackage, { recursive: true });
  await mkdir(join(root, "LICENSES"));
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "fixture" }));
  await writeFile(join(chartPackage, "package.json"), JSON.stringify({ name: "lightweight-charts", version: "5.2.1" }));
  await writeFile(join(chartPackage, "LICENSE"), "Fixture npm license retained separately.\n");
  await writeFile(join(root, noticePath), notice);
  vi.spyOn(process, "cwd").mockReturnValue(root);
  // Vite compilation is the external dependency here. Execute the real final
  // HTML/notices writer against real files; only Chart includes this package.
  // Native Rolldown handles are not used by that consumer and are not modeled.
  vi.mocked(build).mockImplementation(async (options) => ({
    output: [
      { type: "chunk", fileName: "card.js", code: "void 0;", imports: [], dynamicImports: [],
        modules: String(options?.build?.rollupOptions?.input).endsWith("chart-entry.ts")
          ? { [join(chartPackage, "dist/index.js")]: {} } : {} },
      { type: "asset", fileName: "card.css", source: "body { color: black; }" }
    ]
  }) as unknown as Awaited<ReturnType<typeof build>>);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

it("includes npm LICENSE and the pinned upstream NOTICE only in the consuming card", async () => {
  await import("../scripts/build-mcp-ui.js");
  const text = await readFile(join(root, "dist/mcp-app/chart.notices.txt"), "utf8");
  const html = await readFile(join(root, "dist/mcp-app/chart.html"), "utf8");
  expect(text).toContain("Fixture npm license retained separately.");
  expect(text).toContain(notice);
  expect(html).toContain(notice);
  for (const kind of ["account", "receipt"]) {
    expect(await readFile(join(root, `dist/mcp-app/${kind}.html`), "utf8")).not.toContain(notice);
  }
});

it.each(["missing", "altered", "version"] as const)("rejects a %s notice prerequisite with its package and path", async (failure) => {
  if (failure === "missing") await rm(join(root, noticePath));
  if (failure === "altered") await writeFile(join(root, noticePath), notice.replace("2025", "2024"));
  if (failure === "version") {
    await writeFile(join(chartPackage, "package.json"), JSON.stringify({ name: "lightweight-charts", version: "6.0.0" }));
  }
  await expect(import("../scripts/build-mcp-ui.js")).rejects.toThrow(new RegExp(`lightweight-charts.*${noticePath}`));
  await expect(readFile(join(root, "dist/mcp-app/chart.html"))).rejects.toMatchObject({ code: "ENOENT" });
});
