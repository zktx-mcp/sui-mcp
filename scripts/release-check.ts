import { connectViewSchema } from "../src/core/session/workflowView.js";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { CARD_RESOURCE_URIS, CARD_METADATA_KEY, CARD_TOOLS, cardReferenceSchema, cardSnapshotSchema } from "../src/mcp-ui/contracts.js";
import { workflowViewSchema } from "../src/core/session/workflowView.js";
import { WALLET_CONNECTION_POLL_SECONDS } from "../src/core/session/walletConnection.js";
import { acquireDataDirectoryOwner } from "../src/runtime/shared/ownerLease.js";
import { TOOL_NAMES } from "../src/mcp/toolNames.js";
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/client";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { assertSqliteEngineAvailable } from "../src/core/activity/sqliteActivityStore.js";
import { MCP_RESOURCES } from "../src/mcp/resources.js";
import { SERVER_NAME } from "../src/mcp/serverInfo.js";

type PackFile = {
  path: string;
};

type PackInfo = {
  filename: string;
  files: PackFile[];
};

const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { name: string; version: string; mcpName: string; files: string[] };

const requiredFiles = [
  "package.json",
  "README.md",
  "LICENSE",
  "dist/runtime/start.js",
  "dist/runtime/walletSdkChild.js",
  "dist/runtime/walletSdkChildRuntime.js",
  "dist/runtime/walletSdkProcess.js",
  "dist/runtime/walletSdkIpc.js",
  ...["account", "receipt", "chart", "connect", "disconnect", "review", "settings"].flatMap((kind) => [`dist/mcp-app/${kind}.html`, `dist/mcp-app/${kind}.notices.txt`]),
  "LICENSES/@mysten-sui-2.17.0-Apache-2.0.txt",
  "docs/UTILITY_INDEX.md",
  ...manifest.files.filter((path) => path.endsWith(".md")),
  ...MCP_RESOURCES.map((resource) => resource.path)
] as const;

const forbiddenPrefixes = [
  "src/",
  "test/",
  ".WORK/",
  "scripts/",
  "registry/generated/",
  "submission/",
  "AGENTS.md",
  "docs/AGENT_DEVELOPMENT_POLICY.md",
  "docs/FRONTEND_POLICY.md",
  "docs/golden-scenarios/",
  "dist/review-app/",
  "dist/review-server/settingsApi.",
  "dist/review-server/html.",
  "dist/review-server/assets.",
  "dist/core/session/settingsSession.",
  "dist/core/session/settingsSessions.",
  "dist/core/session/keyedRecordStore."
] as const;

function run(command: string, args: string[], cwd = process.cwd()): void {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: false
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

function capture(command: string, args: string[], cwd = process.cwd()): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    shell: false
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
  return result.stdout;
}

function parsePackOutput(output: string): PackInfo {
  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("Unexpected npm pack --json output shape.");
  }
  const [packInfo] = parsed as PackInfo[];
  if (!packInfo || !Array.isArray(packInfo.files)) {
    throw new Error("npm pack output did not include a files array.");
  }
  return packInfo;
}

export function assertPackContents(packInfo: PackInfo): void {
  const paths = new Set(packInfo.files.map((file) => file.path));

  for (const required of requiredFiles) {
    if (!paths.has(required)) {
      throw new Error(`Packed tarball is missing required file: ${required}`);
    }
  }

  for (const file of paths) {
    for (const prefix of forbiddenPrefixes) {
      if (file.startsWith(prefix)) {
        throw new Error(`Packed tarball includes forbidden path: ${file}`);
      }
    }
  }
}

function assertLocalFiles(): void {
  if (!existsSync("LICENSE")) {
    throw new Error("LICENSE file is required before publishing.");
  }
  if (!existsSync("dist/runtime/start.js")) {
    throw new Error("dist/runtime/start.js is required before publishing.");
  }


  const startJs = readFileSync("dist/runtime/start.js", "utf8");
  if (!startJs.startsWith("#!/usr/bin/env node")) {
    throw new Error("dist/runtime/start.js must keep the node shebang.");
  }
}

async function smokeInstallPackedTarball(tarballPath: string): Promise<void> {
  const installDir = mkdtempSync(join(tmpdir(), "sui-mcp-install-"));
  let runtimeOwnsCleanup = false;
  try {
    run(
      "npm",
      ["install", "--no-audit", "--no-fund", "--package-lock=false", tarballPath],
      installDir
    );

    const binPath = resolve(installDir, "node_modules/.bin/sui-mcp");
    if (!existsSync(binPath)) {
      throw new Error("Packed install did not create node_modules/.bin/sui-mcp.");
    }
    const stat = statSync(binPath);
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      throw new Error("Packed install bin path is neither a file nor a symlink.");
    }

    run(
      "node",
      [
        "-e",
        "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY); INSERT INTO t VALUES (1);'); if (db.prepare('SELECT id FROM t').get().id !== 1) throw new Error('better-sqlite3 install smoke failed'); db.close();"
      ],
      installDir
    );
    runtimeOwnsCleanup = true;
    await smokeInstalledRuntime(installDir, binPath);
  } finally {
    if (!runtimeOwnsCleanup) rmSync(installDir, { recursive: true, force: true });
  }
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
  const address = server.address();
  await new Promise<void>((yes, no) => server.close((error) => error ? no(error) : yes()));
  if (!address || typeof address === "string") throw new Error("Could not reserve a smoke-test port.");
  // Runtime identity checks refuse a different process if the port is taken
  // between this reservation and startup; the smoke must fail in that case.
  return address.port;
}

export async function smokeInstalledRuntime(installDir: string, binPath: string): Promise<void> {
  let transport: StdioClientTransport | undefined;
  let client: Client | undefined;
  let childClosed: Promise<void> | undefined;
  let walletChecked = false;
  let stage = "startup/mainnet prerequisites";
  try {
    const port = await unusedPort();
    transport = new StdioClientTransport({ command: process.execPath, args: [binPath], cwd: installDir,
      env: { SUI_MCP_NETWORK: "mainnet", SUI_MCP_DATA_DIR: join(installDir, "runtime-data"), SUI_MCP_REVIEW_PORT: String(port),
        ...(process.env.SUI_MCP_GRPC_URL ? { SUI_MCP_GRPC_URL: process.env.SUI_MCP_GRPC_URL } : {}),
        ...(process.env.SUI_MCP_GRAPHQL_URL ? { SUI_MCP_GRAPHQL_URL: process.env.SUI_MCP_GRAPHQL_URL } : {}) }, stderr: "pipe" });
    // Drain SDK diagnostics without publishing a project identifier or token.
    transport.stderr?.on("data", () => {});
    client = new Client({ name: "installed-package-check", version: manifest.version }, {
      capabilities: { extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } } }
    });
    // Register before connect: the SDK starts closing on initialize failure and
    // clears its pid before the child exits. Protocol.connect chains this hook.
    const childTransport = transport;
    childClosed = new Promise<void>((resolve) => { childTransport.onclose = resolve; });
    await client.connect(transport);
    if (client.getServerVersion()?.version !== manifest.version) throw new Error("Installed server version mismatch.");
    if (client.getServerVersion()?.name !== SERVER_NAME) throw new Error("Installed server name mismatch.");
    stage = "MCP package identity";
    const identityResult = await client.callTool({ name: TOOL_NAMES.readGetServerStatus, arguments: {} });
    const identity = identityResult.structuredContent as { ok?: boolean; data?: {
      packageName?: string; version?: string; serverName?: string; network?: string;
    } } | undefined;
    if (identityResult.isError || identity?.ok !== true || identity.data?.packageName !== manifest.name ||
        identity.data.version !== manifest.version || identity.data.serverName !== SERVER_NAME || identity.data.network !== "mainnet") {
      throw new Error("Installed package identity mismatch.");
    }
    // A published dependency's overrides are not consumer-root overrides.
    // The browser renderer is embedded during build and must not bring an
    // unfixed, unused renderer dependency into the Node runtime installation.
    const installedTree = JSON.parse(capture("npm", ["ls", "--all", "--omit=dev", "--json"], installDir));
    const hasBrowserRenderer = (tree: { dependencies?: Record<string, unknown> }): boolean =>
      Object.entries(tree.dependencies ?? {}).some(([name, dependency]) =>
        name === "mermaid" || name === "katex" || hasBrowserRenderer(dependency as typeof tree));
    if (hasBrowserRenderer(installedTree)) throw new Error("Browser renderer libraries must be embedded in cards, not installed as server runtime dependencies.");
    stage = "MCP request-body rejection and recovery";
    try {
      await client.callTool({ name: TOOL_NAMES.readGetServerStatus, arguments: {},
        _meta: { requestSizeFixture: "x".repeat(4 * 1024 * 1024) } });
      throw new Error("Installed runtime admitted an oversized MCP request.");
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== 413 ||
          !("message" in error) || !String(error.message).includes("Payload Too Large")) throw error;
    }
    const afterRejection = await client.callTool({ name: TOOL_NAMES.readGetServerStatus, arguments: {} });
    if (afterRejection.isError || (afterRejection.structuredContent as { ok?: boolean } | undefined)?.ok !== true) {
      throw new Error("Installed MCP connection did not recover after request-body rejection.");
    }
    stage = "MCP tools and resources";
    const tools = await client.listTools();
    for (const name of [TOOL_NAMES.readGetServerStatus, TOOL_NAMES.sessionOpenWalletConnectionCard,
      TOOL_NAMES.actionStartReview, TOOL_NAMES.uiOpenAccount, TOOL_NAMES.uiOpenReceipt,
      TOOL_NAMES.uiOpenChart, TOOL_NAMES.settingsCreateLocalSettingsSession]) {
      if (!tools.tools.some((tool) => tool.name === name)) throw new Error(`Installed tool is missing: ${name}`);
    }
    const listed = await client.listResources();
    const expected = [...MCP_RESOURCES.map((resource) => resource.uri), ...Object.values(CARD_RESOURCE_URIS)];
    if (listed.resources.length !== expected.length || listed.resources.some((resource) => !expected.includes(resource.uri as typeof expected[number]))) {
      throw new Error("Installed resources differ from the product resource contract.");
    }
    for (const uri of expected) {
      if (!listed.resources.some((resource) => resource.uri === uri)) throw new Error(`Installed resource is missing: ${uri}`);
      const read = await client.readResource({ uri });
      if (!read.contents.some((item) => "text" in item && item.text.trim().length > 0)) throw new Error(`Installed resource is empty: ${uri}`);
    }
    stage = "Settings card and retired-route rejection";
    const result = await client.callTool({ name: TOOL_NAMES.settingsCreateLocalSettingsSession, arguments: {} });
    const body = result.structuredContent as { ok?: boolean; data?: unknown } | undefined;
    if (result.isError || body?.ok !== true || !body.data) throw new Error("Installed Settings card could not be created.");
    const settings = cardSnapshotSchema.parse(body.data);
    const settingsRef = cardReferenceSchema.parse(result._meta?.[CARD_METADATA_KEY]);
    if (settings.kind !== "settings" || settings.state !== "ready" ||
        JSON.stringify(body.data).match(/settingsUrl|openTarget|settingsSessionId|permission/)) throw new Error("Installed Settings card contract mismatch.");
    for (const name of [CARD_TOOLS.act, CARD_TOOLS.readSettingsFile]) {
      const tool = tools.tools.find((tool) => tool.name === name);
      if (JSON.stringify(tool?._meta?.ui) !== JSON.stringify({ visibility: ["app"] })) throw new Error(`Installed tool must be app-only: ${name}`);
    }
    const readSettings = await client.callTool({ name: CARD_TOOLS.read, arguments: settingsRef });
    const readBody = readSettings.structuredContent as { ok?: boolean; data?: unknown } | undefined;
    if (readSettings.isError || readBody?.ok !== true || !readBody.data) throw new Error("Installed Settings card read failed.");
    const currentSettings = cardSnapshotSchema.parse(readBody.data);
    const facts = (currentSettings.data as { facts?: { server?: { version?: string; network?: string } } }).facts;
    if (facts?.server?.version !== manifest.version || facts.server.network !== "mainnet") throw new Error("Installed Settings server metadata mismatch.");
    for (const path of ["/settings/retired", "/api/settings/retired", "/review-assets/settings.js"]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MSEC), redirect: "error" });
      if (response.status !== 404) throw new Error(`Retired Settings route is still exposed: ${path}`);
    }
    stage = "packaged wallet child and scoped-input rejection";
    const parentPid = transport.pid;
    const resultData = (value: Awaited<ReturnType<Client["callTool"]>>) => {
      const payload = value.structuredContent as { ok?: boolean; data?: unknown } | undefined;
      if (value.isError || payload?.ok !== true) throw new Error("Installed wallet service call failed.");
      return payload.data;
    };
    const created = await client.callTool({ name: TOOL_NAMES.sessionOpenWalletConnectionCard, arguments: {} });
    const reference = cardReferenceSchema.parse(created._meta?.[CARD_METADATA_KEY]);
    let card = cardSnapshotSchema.parse(resultData(created));
    const current = async () => cardSnapshotSchema.parse(resultData(await client!.callTool({ name: CARD_TOOLS.read, arguments: reference })));
    const started = Date.now();
    while (workflowViewSchema.parse(card.data).walletAvailability.status === "initializing" && Date.now() - started < DEFAULT_REQUEST_TIMEOUT_MSEC) {
      await new Promise((resolve) => setTimeout(resolve, WALLET_CONNECTION_POLL_SECONDS * 1000)); card = await current();
    }
    const before = workflowViewSchema.parse(card.data);
    if (before.walletAvailability.status !== "available") throw new Error("Installed wallet SDK did not become available.");
    const storePath = join(installDir, "runtime-data/walletconnect/sessions.sqlite");
    if (!existsSync(storePath) || process.platform !== "win32" && (statSync(storePath).mode & 0o077) !== 0) throw new Error("Installed SDK storage is missing or not private.");
    const priorRun = before.walletAvailability.walletRunId;
    const refused = await client.callTool({ name: CARD_TOOLS.act, arguments: {
      ...reference, revision: card.revision, input: { action: "restart_wallet_service", walletRunId: priorRun }
    } });
    if (!refused.isError) throw new Error("Installed Connect card accepted its retired restart action.");
    card = await current();
    const after = connectViewSchema.parse(card.data);
    if (card.state !== "ready" || after.walletAvailability.status !== "available" ||
        after.walletAvailability.walletRunId !== priorRun || after.operation || after.automaticAction?.action !== "connect" || after.automaticAction.operationId !== card.input.operationId ||
        !after.allowedActions.includes("connect") || JSON.stringify(after.requestedChains) !== JSON.stringify(["sui:mainnet"]) || Object.hasOwn(after, "connection") || parentPid === undefined || transport.pid !== parentPid) {
      throw new Error("Installed wallet controls changed the SDK run or started pairing without user input.");
    }
    try {
      const conflictingLease = acquireDataDirectoryOwner(storePath); conflictingLease.close();
      throw new Error("Installed SDK child did not retain its exclusive storage lease.");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "DATA_DIRECTORY_OWNED") throw error;
    }
    walletChecked = true;
    process.stderr.write("Installed package MCP, card resources, Settings and wallet-child ownership checks passed.\n");
  } catch (error) {
    throw new Error(`Installed package check failed at ${stage}.${stage === "startup/mainnet prerequisites" ? " Startup requires reachable Sui mainnet endpoints." : ""}`, { cause: error });
  } finally {
    await client?.close();
    // Undefined only if setup failed before attempting to start a child.
    // Also waits when the SDK already started closing or returned after SIGKILL.
    await childClosed;
    if (walletChecked) {
      const lease = acquireDataDirectoryOwner(join(installDir, "runtime-data/walletconnect/sessions.sqlite")); lease.close();
    }
    rmSync(installDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const server = JSON.parse(readFileSync("server.json", "utf8"));
  if (lock.name !== manifest.name || lock.version !== manifest.version || lock.packages?.[""]?.name !== manifest.name ||
      lock.packages?.[""]?.version !== manifest.version || server.version !== manifest.version || server.name !== manifest.mcpName ||
      server.packages?.[0]?.identifier !== manifest.name || server.packages?.[0]?.version !== manifest.version) {
    throw new Error("Release package, lockfile and MCP Registry metadata must agree before checking the release.");
  }

  run("npm", ["run", "typecheck"]);
  run("npm", ["test"]);
  run("npm", ["run", "build"]);

  assertLocalFiles();
  assertSqliteEngineAvailable();

  const dryRunInfo = parsePackOutput(capture("npm", ["pack", "--dry-run", "--json"]));
  assertPackContents(dryRunInfo);

  const packDir = mkdtempSync(join(tmpdir(), "sui-mcp-pack-"));
  try {
    const packedInfo = parsePackOutput(
      capture("npm", ["pack", "--json", "--pack-destination", packDir])
    );
    assertPackContents(packedInfo);
    const paths = new Set(packedInfo.files.map((file) => file.path));
    for (const file of paths) {
      if (!file.endsWith(".md")) continue;
      for (const match of readFileSync(file, "utf8").matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = match[1]!.trim().replace(/^<|>$/g, "").split("#")[0]!;
        if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        const path = relative(process.cwd(), resolve(dirname(file), decodeURIComponent(target))).replaceAll("\\", "/");
        if (!paths.has(path)) throw new Error(`Packed documentation link has no shipped target: ${file} -> ${target}`);
      }
    }
    const packedPath = resolve(packDir, packedInfo.filename);
    process.stderr.write(`Checked package SHA256: ${createHash("sha256").update(readFileSync(packedPath)).digest("hex")}\n`);
    await smokeInstallPackedTarball(packedPath);
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }

  process.stderr.write("Release check passed.\n");

}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
