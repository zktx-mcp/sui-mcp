import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { createReviewRequestHandler } from "../src/review-server/server.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture() {
  const handler = createReviewRequestHandler({ logger: { info() {}, warn() {}, error() {} } });
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  cleanup.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve()); }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

it("rejects all retired pages, Settings mutations and assets without a URL fallback", async () => {
  const base = await fixture();
  for (const path of ["/", "/settings/old", "/review/old", "/connect/old", "/account", "/receipt", "/charts/deepbook-usdc",
    "/review-assets/settings.js", "/review-assets/settings.css", "/api/settings/old", "/api/review/old", "/api/account/assets", "/__identity"]) {
    const response = await fetch(base + path, { headers: { accept: "text/html" } });
    expect(response.status, path).toBe(404); expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "not_found" });
  }
  for (const action of ["clear-active-account", "sui-grpc-url", "sui-graphql-url", "local-data/import", "local-data/reset"]) {
    const response = await fetch(`${base}/api/settings/old/${action}`, { method: "POST", headers: { "x-sui-mcp-token": "old", origin: base }, body: "{" });
    expect(response.status, action).toBe(404);
  }
});

it("retains the Host/Origin and query-token guards before any unsupported route", async () => {
  const base = await fixture();
  const origin = await fetch(base + "/settings/old", { headers: { origin: "https://evil.example" } });
  expect(origin.status).toBe(403);
  for (const path of ["/settings/old?token=secret", "/api/settings/old?token=secret", "/api/receipt?token=secret"]) {
    const response = await fetch(base + path); expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "token_query_not_supported" });
  }
});
