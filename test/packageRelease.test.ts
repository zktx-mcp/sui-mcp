import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PACKAGE_NAME, SERVER_NAME, SERVER_VERSION } from "../src/mcp/serverInfo.js";
import { assertPackContents, smokeInstalledRuntime } from "../scripts/release-check.js";
import { MCP_RESOURCES } from "../src/mcp/resources.js";

type PackageJson = {
  private?: boolean;
  version: string;
  license?: string;
  publishConfig?: {
    access?: string;
    tag?: string;
  };
  files: string[];
  scripts: Record<string, string>;
};

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as PackageJson;

describe("npm release metadata", () => {
  it("is configured for public latest-tag publishing", () => {
    expect(packageJson.private).toBeUndefined();
    // Validate the semver shape, not an exact value — pinning the version drifts every release.
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
    expect(PACKAGE_NAME).toBe("@zktx.io/sui-mcp");
    expect(SERVER_NAME).toBe("sui-mcp");
    expect(SERVER_VERSION).toBe(packageJson.version);
    expect(packageJson.license).toBe("MIT");
    expect(packageJson.publishConfig).toEqual({ access: "public", tag: "latest" });
    expect(packageJson.scripts.prepublishOnly).toBe("npm run release:check");
  });

  it("allowlists only product protocol notes", () => {
    expect(packageJson.files).toContain("protocols/deepbook-v3.md");
    expect(packageJson.files).toContain("protocols/deepbook-margin.md");
    expect(packageJson.files).not.toContain("protocols/");
  });

  it("keeps the lockfile and Registry identity bound to the released package", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
    const server = JSON.parse(readFileSync("server.json", "utf8"));
    expect([lock.name, lock.packages[""].name, server.packages[0].identifier]).toEqual([pkg.name, pkg.name, pkg.name]);
    expect([lock.version, lock.packages[""].version, server.version, server.packages[0].version]).toEqual(Array(4).fill(pkg.version));
    expect(server.name).toBe(pkg.mcpName);
    expect(pkg.mcpName).toBe("io.github.zktx-mcp/sui-mcp");
    expect(pkg.bin).toEqual({ "sui-mcp": "./dist/runtime/start.js" });
    expect(lock.packages[""].bin).toEqual({ "sui-mcp": "dist/runtime/start.js" });
    expect(pkg.files).toContain("LICENSES/");
    expect(pkg.files.some((file: string) => file.startsWith("submission"))).toBe(false);
    expect(MCP_RESOURCES.some((resource) => resource.path.startsWith("submission/"))).toBe(false);
  });
});

// Archive requirements come from the deployed surfaces, independently of the
// checker: six internal cards and the adapted backend; no external Settings page.
const archive = ["package.json", "README.md", "LICENSE", "dist/runtime/start.js",
  "dist/runtime/walletSdkChild.js", "dist/runtime/walletSdkChildRuntime.js", "dist/runtime/walletSdkProcess.js", "dist/runtime/walletSdkIpc.js", "docs/UTILITY_INDEX.md",
  "LICENSES/@mysten-sui-2.17.0-Apache-2.0.txt", ...MCP_RESOURCES.map((resource) => resource.path),
  "docs/LOCAL_DB_ARCHITECTURE.md", "docs/SDK_API.md", "docs/SIGNABLE_ADAPTER_CONTRACT.md", "docs/TRANSACTION_ACTIVITY_LOG.md",
  ...["account", "receipt", "chart", "connect", "review", "settings"].flatMap((name) => [`dist/mcp-app/${name}.html`, `dist/mcp-app/${name}.notices.txt`])];
const pack = (paths: string[]) => ({ filename: "fixture.tgz", files: paths.map((path) => ({ path })) });

it("accepts the complete current archive and rejects missing notices, backend license or the Settings card", () => {
  expect(() => assertPackContents(pack(archive))).not.toThrow();
  for (const missing of ["dist/runtime/walletSdkChild.js", "dist/runtime/walletSdkChildRuntime.js", "dist/runtime/walletSdkIpc.js", "dist/mcp-app/review.notices.txt", "LICENSES/@mysten-sui-2.17.0-Apache-2.0.txt", "dist/mcp-app/settings.html"]) {
    expect(() => assertPackContents(pack(archive.filter((path) => path !== missing)))).toThrow(missing);
  }
});

it.each(["submission/ethglobal-tokyo-2026/plan.md", ".WORK/session.sqlite", "dist/review-app/connect.js", "dist/review-app/settings.js", "dist/core/session/settingsSessions.js",
  "AGENTS.md", "docs/AGENT_DEVELOPMENT_POLICY.md", "docs/FRONTEND_POLICY.md", "docs/golden-scenarios/BEHAVIOR_MATRIX.md"])("rejects the excluded archive path %s", (path) => {
  expect(() => assertPackContents(pack([...archive, path]))).toThrow(path);
});

// Only the external MCP process is synthetic. The release helper, Client and
// StdioClientTransport are real; no SDK close/start/pid method is replaced.
function runtimePeer(mode: "initialize_error" | "version_mismatch" | "name_mismatch" | "package_mismatch" | "early_exit") {
  const root = mkdtempSync(join(tmpdir(), "sui-mcp-release-close-"));
  const installDir = join(root, "installed"), binPath = join(installDir, "peer.mjs");
  const pidFile = join(root, "pid"), closingFile = join(root, "closing"), releaseFile = join(root, "release");
  mkdirSync(installDir);
  writeFileSync(binPath, `
import { existsSync, writeFileSync } from "node:fs";
const mode = ${JSON.stringify(mode)};
const version = ${JSON.stringify(SERVER_VERSION)};
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
if (mode === "early_exit") process.exit(0);
// Test-only coordination, not a runtime deadline: the parent decides when
// this peer may exit. Keep the marker outside the installation being tested.
setInterval(() => { if (existsSync(${JSON.stringify(releaseFile)})) process.exit(0); }, 10);
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    let response;
    if (request.method === "initialize") {
      response = mode === "initialize_error"
        ? { error: { code: -32000, message: "Fixture initialization refused" } }
        : { result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: {
          name: mode === "name_mismatch" ? "fixture" : "sui-mcp",
          version: mode === "version_mismatch" ? "unexpected-fixture-version" : version
        } } };
    } else if (request.method === "tools/call" && request.params.name === "read.get_server_status") {
      response = { result: { content: [], structuredContent: { ok: true, data: {
        packageName: "@fixture/other-package", version, serverName: "sui-mcp", network: "mainnet"
      } } } };
    } else continue;
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...response }) + "\\n");
  }
});
process.stdin.on("end", () => writeFileSync(${JSON.stringify(closingFile)}, "stdin ended"));
`);
  const alive = () => {
    if (!existsSync(pidFile)) return false;
    const pid = Number(readFileSync(pidFile, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid fixture PID");
    try { process.kill(pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  };
  return { root, installDir, binPath, closingFile, alive,
    release: () => writeFileSync(releaseFile, "exit allowed"),
    async cleanup() {
      writeFileSync(releaseFile, "exit allowed");
      await vi.waitFor(() => expect(alive()).toBe(false));
      rmSync(root, { recursive: true, force: true });
    }
  };
}

it.each([
  ["initialize_error", "Fixture initialization refused"],
  ["version_mismatch", "Installed server version mismatch."],
  ["name_mismatch", "Installed server name mismatch."],
  ["package_mismatch", "Installed package identity mismatch."]
] as const)("keeps installation files until the child really exits after %s", async (mode, message) => {
  const peer = runtimePeer(mode);
  let settled = false;
  const result = smokeInstalledRuntime(peer.installDir, peer.binPath).then(
    () => { settled = true; return undefined; },
    (error: unknown) => { settled = true; return error; }
  );
  try {
    // This marker proves the SDK already requested termination. In the init
    // failure case its pid is already null, but the peer is deliberately alive.
    await vi.waitFor(() => expect(existsSync(peer.closingFile)).toBe(true));
    expect(peer.alive()).toBe(true);
    expect(settled).toBe(false);
    expect(existsSync(peer.installDir)).toBe(true);
    peer.release();
    const failure = await result;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).cause).toMatchObject({ message });
    if (mode === "initialize_error") expect((failure as Error).cause).toMatchObject({ code: -32000 });
    expect(peer.alive()).toBe(false);
    expect(existsSync(peer.installDir)).toBe(false);
  } finally { await peer.cleanup(); }
});

it("remembers a child that closes before initialization finishes", async () => {
  const peer = runtimePeer("early_exit");
  try {
    await expect(smokeInstalledRuntime(peer.installDir, peer.binPath)).rejects.toMatchObject({ cause: { code: "CONNECTION_CLOSED" } });
    expect(peer.alive()).toBe(false);
    expect(existsSync(peer.installDir)).toBe(false);
  } finally { await peer.cleanup(); }
});

it("settles a spawn failure without waiting for a nonexistent process", async () => {
  const root = mkdtempSync(join(tmpdir(), "sui-mcp-release-spawn-"));
  try {
    // A nonexistent cwd makes real Node spawn fail with ENOENT. The transport's
    // error and close are different events; the latter must still be handled.
    const missingDirectory = join(root, "missing");
    await expect(smokeInstalledRuntime(missingDirectory, join(root, "unused.mjs"))).rejects.toMatchObject({ cause: { code: "ENOENT" } });
    expect(existsSync(missingDirectory)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
