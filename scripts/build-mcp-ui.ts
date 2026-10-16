import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { build } from "vite";
import { PRODUCT_DISPLAY_NAME } from "../src/mcp/serverInfo.js";

const root = process.cwd();
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };

// The pinned npm archive omits this upstream notice. Its UTF-8 contents, including
// the final newline, come from https://raw.githubusercontent.com/tradingview/lightweight-charts/v5.2.1/NOTICE.
const chartNotice = {
  packageName: "lightweight-charts",
  version: "5.2.1",
  path: "LICENSES/lightweight-charts-5.2.1-NOTICE.txt",
  sha256: "f76c6afab94884448f0426e30d6e9d555ca7247894cd3484e477d2f87513036e"
};

async function notices(moduleIds: string[]): Promise<string> {
  const packages = new Set<string>();
  for (const moduleId of moduleIds) {
    const normalized = moduleId.replaceAll("\\", "/").split("?")[0]!;
    const marker = normalized.lastIndexOf("/node_modules/");
    if (marker < 0) continue;
    const relative = normalized.slice(marker + "/node_modules/".length).split("/");
    const depth = relative[0]?.startsWith("@") ? 2 : 1;
    packages.add(normalized.slice(0, marker + "/node_modules/".length) + relative.slice(0, depth).join("/"));
  }
  const sections: string[] = [];
  for (const directory of [...packages].sort()) {
    const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as { name: string; version: string; license?: unknown };
    const entries = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile() && /^(licen[cs]e|notice|copying)(\.|$)/i.test(entry.name));
    const texts = await Promise.all(entries.map((entry) => readFile(join(directory, entry.name), "utf8")));
    if (texts.length === 0) {
      // Some npm archives omit their upstream license. Keep an exact-version
      // license copy with the source instead of treating package metadata as its text.
      texts.push(await readFile(join(root, "LICENSES", `${pkg.name.replaceAll("/", "-")}-${pkg.version}-${String(pkg.license)}.txt`), "utf8"));
    }
    if (pkg.name === chartNotice.packageName) {
      if (pkg.version !== chartNotice.version) {
        throw new Error(`${pkg.name} ${pkg.version} requires an updated upstream notice declaration: ${chartNotice.path}`);
      }
      const notice = await readFile(join(root, chartNotice.path), "utf8").catch((cause: unknown) => {
        throw new Error(`${pkg.name} ${pkg.version} requires ${chartNotice.path}`, { cause });
      });
      if (createHash("sha256").update(notice).digest("hex") !== chartNotice.sha256) {
        throw new Error(`${pkg.name} ${pkg.version} upstream notice does not match ${chartNotice.path}`);
      }
      texts.push(notice);
    }
    sections.push(`${pkg.name} ${pkg.version}\n${texts.join("\n")}\n`);
  }
  return sections.join("\n---\n\n");
}
const outDir = resolve(root, "dist/mcp-app");
await mkdir(outDir, { recursive: true });
for (const kind of ["account", "receipt", "chart", "connect", "disconnect", "review", "settings"]) {
  // Assemble only after Vite has finalized CSS and dynamic-import helpers.
  // Moving chunks into HTML in generateBundle prevents later plugins from
  // processing them, even when the user plugin has enforce: "post".
  const built = await build({
    configFile: false,
    root,
    define: {
      __SUI_MCP_VERSION__: JSON.stringify(manifest.version)
    },
    build: {
      outDir, write: false, emptyOutDir: false,
      cssCodeSplit: false, assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      rollupOptions: { input: join(root, `src/mcp-ui/view/${kind}-entry.ts`), output: { codeSplitting: false, format: "es" } }
    }
  });
  if (Array.isArray(built) || !("output" in built)) throw new Error(`${kind} card requires one completed build output.`);
  const scripts = built.output.filter((item) => item.type === "chunk");
  const styles = built.output.filter((item) => item.type === "asset" && item.fileName.endsWith(".css"));
  const script = scripts[0];
  const style = styles[0];
  // Rolldown retains self-references for imports inlined into this very chunk.
  // Only references to a different file imply an external runtime dependency.
  if (scripts.length !== 1 || !script || script.imports.length !== 0 || script.dynamicImports.some((name) => name !== script.fileName) ||
      styles.length !== 1 || !style || style.type !== "asset" || built.output.length !== 2) {
    throw new Error(`${kind} card must contain one self-contained script and inline styles.`);
  }
  const css = typeof style.source === "string" ? style.source : Buffer.from(style.source).toString("utf8");
  if (css.trim().length === 0) throw new Error(`${kind} card requires non-empty inline styles.`);
  if (/__VITE_PRELOAD__|__VITE_ASSET__|__VITE_CSS_URL__/.test(script.code + css)) {
    throw new Error(`${kind} card contains unfinished Vite output.`);
  }
  const licenseText = await notices(Object.keys(script.modules));
  const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(PRODUCT_DISPLAY_NAME)}</title><style>${css.replaceAll("</style", "<\\/style")}</style></head><body><main id="app" aria-live="polite"></main><template id="dependency-notices">${escape(licenseText)}</template><script type="module">${script.code.replaceAll("</script", "<\\/script")}</script></body></html>`;
  await writeFile(join(outDir, `${kind}.html`), html);
  await writeFile(join(outDir, `${kind}.notices.txt`), licenseText);
}
