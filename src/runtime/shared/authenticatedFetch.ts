import { Agent, request as httpRequest } from "node:http";
import { connect, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { MAX_JSON_BODY_BYTES } from "./http.js";
import { IDENTITY_CHALLENGE_HEADER, IDENTITY_PATH, IDENTITY_TIMEOUT_MS, INTERNAL_MCP_PATH,
  SERVER_INSTANCE_HEADER, verifyServerIdentity, type ControlIdentity, type ServerIdentity } from "./control.js";

// Proof and authenticated request use the same TCP socket. A closed socket is never
// transparently replaced: no credential or UI permission can reach a new listener.
async function authenticatedChannel(port: number, control: ControlIdentity, signal?: AbortSignal): Promise<{
  agent: Agent; socket: Socket; identity: ServerIdentity; close(): void;
}> {
  signal?.throwIfAborted();
  const socket = connect({ host: "127.0.0.1", port });
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  agent.createConnection = (() => socket) as typeof agent.createConnection;
  const close = () => { agent.destroy(); socket.destroy(); };
  const abort = () => socket.destroy(new Error("Local server connection aborted."));
  const timer = setTimeout(() => socket.destroy(new Error("Local server identity timed out.")), IDENTITY_TIMEOUT_MS);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const challenge = randomBytes(32).toString("base64url");
    const identity = await new Promise<ServerIdentity>((resolve, reject) => {
      const request = httpRequest({ host: "127.0.0.1", port, path: IDENTITY_PATH, method: "GET", agent,
        headers: { Host: `127.0.0.1:${port}`, [IDENTITY_CHALLENGE_HEADER]: challenge, Connection: "keep-alive" }
      }, (response) => {
        if (response.socket !== socket || response.statusCode !== 200 ||
            response.headers["content-type"] !== "application/json; charset=utf-8" ||
            response.headers["cache-control"] !== "no-store") {
          response.destroy(); reject(new Error("Incompatible local server response.")); return;
        }
        const chunks: Buffer[] = []; let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_JSON_BODY_BYTES) response.destroy(new Error("Local server identity is too large."));
          else chunks.push(chunk);
        });
        response.once("error", reject);
        response.once("end", () => {
          try { resolve(verifyServerIdentity(JSON.parse(Buffer.concat(chunks).toString("utf8")), control, challenge)); }
          catch { reject(new Error("Local server authentication or compatibility check failed.")); }
        });
      });
      request.once("error", reject);
      request.end();
    });
    return { agent, socket, identity, close };
  } catch (error) { close(); throw error; }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

export async function probeAuthenticatedServer(port: number, control: ControlIdentity): Promise<ServerIdentity> {
  const channel = await authenticatedChannel(port, control);
  try { return channel.identity; } finally { channel.close(); }
}

export function createAuthenticatedFetch(port: number, control: ControlIdentity, expectedInstanceId?: string): FetchLike {
  return async (input, init) => {
    const url = new URL(input);
    if (url.origin !== `http://127.0.0.1:${port}` || url.pathname !== INTERNAL_MCP_PATH || url.search !== "") {
      throw new Error("Only the internal MCP endpoint is allowed.");
    }
    const channel = await authenticatedChannel(port, control, init?.signal ?? undefined);
    if (expectedInstanceId !== undefined && channel.identity.instanceId !== expectedInstanceId) {
      channel.close();
      throw new Error("Shared server changed before dispatch. The operation was not sent.");
    }
    const headers = new Headers(init?.headers);
    headers.set("host", url.host);
    headers.set("authorization", `Bearer ${control.key}`);
    headers.set(SERVER_INSTANCE_HEADER, channel.identity.instanceId);
    headers.set("connection", "close");
    const body = init?.body;
    if (body !== undefined && body !== null && typeof body !== "string") { channel.close(); throw new Error("Invalid internal MCP body."); }
    if (typeof body === "string") headers.set("content-length", String(Buffer.byteLength(body)));
    return new Promise<Response>((resolve, reject) => {
      const request = httpRequest({ host: "127.0.0.1", port, path: INTERNAL_MCP_PATH,
        method: init?.method ?? "GET", headers: Object.fromEntries(headers), agent: channel.agent,
        ...(init?.signal ? { signal: init.signal } : {})
      }, (response) => {
        if (response.socket !== channel.socket) { channel.close(); reject(new Error("Local server socket changed.")); return; }
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        response.once("close", channel.close);
        const status = response.statusCode ?? 500;
        if ([204, 205, 304].includes(status)) { response.resume(); resolve(new Response(null, { status, headers: responseHeaders })); }
        else resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, headers: responseHeaders }));
      });
      request.once("socket", (socket) => { if (socket !== channel.socket || socket.destroyed) request.destroy(new Error("Authenticated socket unavailable.")); });
      request.once("error", (error) => { channel.close(); reject(error); });
      request.end(body);
    });
  };
}
