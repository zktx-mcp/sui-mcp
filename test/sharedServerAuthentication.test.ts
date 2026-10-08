import { readFileSync } from "node:fs";
import { randomBytes, randomUUID, createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { startSharedServer } from "../src/runtime/shared/server.js";
import { createAuthenticatedFetch, probeAuthenticatedServer } from "../src/runtime/shared/authenticatedFetch.js";
import { IDENTITY_CHALLENGE_HEADER, IDENTITY_PATH, INTERNAL_MCP_PATH, SERVER_INSTANCE_HEADER, type ControlIdentity } from "../src/runtime/shared/control.js";

const packageVersion = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

const control: ControlIdentity = { key: randomBytes(32).toString("base64url"), databaseId: "1".repeat(64), configurationId: "2".repeat(64) };

function flipFirstByte(value: string): string {
  const bytes = Buffer.from(value, "base64url");
  bytes[0] = bytes[0]! ^ 1;
  return bytes.toString("base64url");
}

describe("authenticated loopback dispatch", () => {
  it("authenticates dispatch on the same connection and refuses unauthenticated callers", async () => {
    let calls = 0;
    let applicationClosed = false;
    const server = await startSharedServer({ port: 0, control, onError: () => {},
      createApplication: async () => ({
        handleHttp: async (_request, response) => { response.writeHead(404).end(); },
        handleMcp: async (_request, response) => { calls += 1; response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ observed: "authenticated" })); },
        close: async () => { applicationClosed = true; }
      }) });
    try {
      const fetch = createAuthenticatedFetch(server.port, control);
      const identity = await probeAuthenticatedServer(server.port, control);
      expect(identity).toMatchObject({ service: "sui-mcp", role: "shared-server", packageVersion, instanceId: server.instanceId });
      await expect(createAuthenticatedFetch(server.port, control, randomUUID())(
        `http://127.0.0.1:${server.port}${INTERNAL_MCP_PATH}`, { method: "POST", body: "{}" }
      )).rejects.toThrow("Shared server changed before dispatch");
      expect(calls).toBe(0);
      expect(await (await fetch(`http://127.0.0.1:${server.port}${INTERNAL_MCP_PATH}`, { method: "POST", body: "{}" })).json()).toEqual({ observed: "authenticated" });
      expect(calls).toBe(1);
      const refusedRequests: Array<{ headers: Record<string, string>; status: number; error: string }> = [
        {
          headers: { [SERVER_INSTANCE_HEADER]: server.instanceId },
          status: 401, error: "control_authentication_required"
        },
        {
          headers: { authorization: `Bearer ${control.key}`, [SERVER_INSTANCE_HEADER]: server.instanceId, origin: "https://example.invalid" },
          status: 403, error: "invalid_request_origin"
        }
      ];
      for (const { headers, status, error } of refusedRequests) {
        const refused = await globalThis.fetch(`http://127.0.0.1:${server.port}${INTERNAL_MCP_PATH}`, { method: "POST", headers, body: "{}" });
        expect(refused.status).toBe(status);
        expect(await refused.json()).toEqual({ error });
        expect(calls).toBe(1);
      }
    } finally { await server.close(); }
    expect(applicationClosed).toBe(true);
  });

  it.each(["valid", "proof", "databaseId", "configurationId", "role", "service", "packageVersion", "challenge"] as const)("checks the %s identity case before credential delivery", async (field) => {
    const seen: Array<{ path: string; method: string | undefined; authorization: string | undefined; instance: string | string[] | undefined }> = [];
    const instanceId = randomUUID();
    const server = createServer((request, response) => {
      seen.push({ path: request.url ?? "", method: request.method,
        authorization: request.headers.authorization, instance: request.headers[SERVER_INSTANCE_HEADER] });
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      if (request.url !== IDENTITY_PATH) {
        response.end(JSON.stringify({ observed: "operation_dispatched" }));
        return;
      }
      const identity = { service: "sui-mcp", role: "shared-server", packageVersion,
        databaseId: control.databaseId, configurationId: control.configurationId, instanceId, pid: process.pid,
        challenge: String(request.headers[IDENTITY_CHALLENGE_HEADER]) };
      if (field === "databaseId" || field === "configurationId") identity[field] = "3".repeat(64);
      else if (field === "role") identity.role = "foreign";
      else if (field === "service") identity.service = "say-ur-intent";
      else if (field === "packageVersion") identity.packageVersion = "0.0.0-incompatible";
      else if (field === "challenge") identity.challenge = flipFirstByte(identity.challenge);
      // Sign the final wire payload so identity mismatch cases have valid HMACs.
      // The valid case exercises this same fixture through the actual client.
      const proof = createHmac("sha256", control.key).update(JSON.stringify([identity.service, identity.role, identity.packageVersion,
        identity.databaseId, identity.configurationId, identity.instanceId, identity.pid, identity.challenge])).digest("base64url");
      response.end(JSON.stringify({ ...identity, proof: field === "proof" ? flipFirstByte(proof) : proof }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const operation = createAuthenticatedFetch(port, control)(`http://127.0.0.1:${port}${INTERNAL_MCP_PATH}`, { method: "POST", body: "{}" });
      const probe = { path: IDENTITY_PATH, method: "GET", authorization: undefined, instance: undefined };
      if (field === "valid") {
        const response = await operation;
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ observed: "operation_dispatched" });
        expect(seen).toEqual([probe, { path: INTERNAL_MCP_PATH, method: "POST",
          authorization: `Bearer ${control.key}`, instance: instanceId }]);
      } else {
        await expect(operation).rejects.toThrow("Local server authentication or compatibility check failed.");
        expect(seen).toEqual([probe]);
      }
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
