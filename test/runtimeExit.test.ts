import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { acquireDataDirectoryOwner } from "../src/runtime/shared/ownerLease.js";
import { ACTIVITY_DATABASE_FILENAME } from "../src/core/activity/sqliteActivityStore.js";

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return (server.address() as { port: number }).port;
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
async function freePort() { const server = createServer(); const port = await listen(server); await close(server); return port; }

it.each(["foreign_port", "endpoint", "endpoint_timeout", "configuration", "database_format", "EOF", "SIGINT", "SIGTERM"] as const)(
  "preserves the real bootstrap exit and diagnostics for %s", async (condition) => {
    const directory = mkdtempSync(join(tmpdir(), "say-runtime-exit-"));
    const databasePath = join(directory, ACTIVITY_DATABASE_FILENAME);
    let originalDatabase: Buffer | undefined;
    if (condition === "database_format") {
      const database = new Database(databasePath);
      database.exec("CREATE TABLE retained_data (value TEXT NOT NULL); INSERT INTO retained_data VALUES ('synthetic retained value')");
      database.close();
      originalDatabase = readFileSync(databasePath);
    }
    let endpointCalls = 0;
    const endpoint = createServer((_request, response) => {
      endpointCalls++;
      if (condition === "endpoint") { response.writeHead(503); response.end("Unavailable"); }
      // Other cases intentionally await endpoint verification when EOF/signal arrives.
    });
    const endpointPort = await listen(endpoint);
    const holder = createServer((_request, response) => { response.writeHead(404); response.end(); });
    const holderPort = await listen(holder);
    const port = condition === "foreign_port" ? holderPort : await freePort();
    const child = spawn(process.execPath, ["--import", "tsx", "src/runtime/start.ts"], { cwd: process.cwd(),
      env: { ...process.env, SUI_MCP_DATA_DIR: directory, SUI_MCP_REVIEW_PORT: String(port),
        SUI_MCP_GRPC_URL: `http://127.0.0.1:${endpointPort}`, SUI_MCP_NETWORK: condition === "configuration" ? "fixture-invalid" : "mainnet" },
      stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const ended = once(child, "exit");
    child.stdin.on("error", () => {});
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "exit-fixture", version: "1" } } }) + "\n");
    try {
      if (["EOF", "SIGINT", "SIGTERM"].includes(condition)) {
        await vi.waitFor(() => expect(endpointCalls).toBeGreaterThan(0), { timeout: 10000 });
        if (condition === "EOF") child.stdin.end(); else child.kill(condition as "SIGINT" | "SIGTERM");
      }
      await vi.waitFor(() => expect(child.exitCode).not.toBeNull(), { timeout: 15000 });
      const [code, signal] = await ended;
      expect(code).toBe(condition === "EOF" ? 0 : condition === "SIGINT" ? 130 : condition === "SIGTERM" ? 143 : 1);
      expect(signal).toBeNull();
      if (["foreign_port", "endpoint", "endpoint_timeout", "configuration", "database_format"].includes(condition)) {
        expect(stderr).toContain("fatal runtime error");
        expect(stderr).toContain(condition === "foreign_port" ? "foreign or incompatible" : condition === "endpoint" ? "endpoint_unreachable" : condition === "endpoint_timeout" ? "endpoint_timeout" : condition === "database_format" ? "Local database format does not match this runtime" : "configuration");
      } else expect(stderr).not.toContain("fatal runtime error");
      if (condition === "database_format") {
        expect(stderr).toContain("Data migration is not supported");
        expect(stderr).toContain("explicitly choose to delete");
        expect(stderr).not.toContain("synthetic retained value");
        expect(readFileSync(databasePath)).toEqual(originalDatabase);
        expect(endpointCalls).toBe(0);
      }
      if (condition !== "configuration" && condition !== "database_format") expect(stdout).toContain('"id":1');
      for (const line of stdout.trim().split("\n").filter(Boolean)) expect(JSON.parse(line)).toHaveProperty("jsonrpc", "2.0");
      expect(holder.listening).toBe(true);
      const lease = acquireDataDirectoryOwner(join(directory, "activity.sqlite")); lease.close();
      if (condition !== "foreign_port") {
        const probe = createServer(); probe.listen(port, "127.0.0.1"); await once(probe, "listening"); await close(probe);
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await ended; }
      await close(endpoint); await close(holder); rmSync(directory, { recursive: true, force: true });
    }
  }, 20000);
