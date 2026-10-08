import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { HttpError, sendJson } from "./http.js";
import { createServerIdentity, IDENTITY_CHALLENGE_HEADER, IDENTITY_PATH, INTERNAL_MCP_PATH,
  singleHeader, validControlAuthorization, validInternalRequest, type ControlIdentity } from "./control.js";

export type SharedApplication = {
  handleMcp(request: IncomingMessage, response: ServerResponse): Promise<void>;
  handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void>;
  close(): Promise<void>;
};

export async function startSharedServer(input: {
  port: number;
  control: ControlIdentity;
  createApplication(instanceId: string): Promise<SharedApplication>;
  onError(error: unknown): void;
}) {
  const instanceId = randomUUID();
  let port = input.port;
  let application: Promise<SharedApplication>;
  let stopping = false;
  const server = createServer((request, response) => {
    response.setHeader("cache-control", "no-store");
    void (async () => {
      try {
        if (stopping) { sendJson(response, 503, { error: "runtime_stopping" }); return; }
        if (request.url === IDENTITY_PATH || request.url === INTERNAL_MCP_PATH) {
          if (!validInternalRequest(request, port)) { sendJson(response, 403, { error: "invalid_request_origin" }); return; }
          if (request.url === IDENTITY_PATH) {
            if (request.method !== "GET" || request.headers.authorization !== undefined) { sendJson(response, 400, { error: "invalid_identity_request" }); return; }
            const challenge = singleHeader(request, IDENTITY_CHALLENGE_HEADER);
            if (challenge === undefined || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) { sendJson(response, 400, { error: "invalid_identity_challenge" }); return; }
            sendJson(response, 200, createServerIdentity(input.control, instanceId, challenge)); return;
          }
          if (!validControlAuthorization(request, input.control, instanceId)) { sendJson(response, 401, { error: "control_authentication_required" }); return; }
          await (await application).handleMcp(request, response);
          return;
        }
        await (await application).handleHttp(request, response);
      } catch (error) {
        if (error instanceof HttpError) { if (!response.headersSent) sendJson(response, error.status, { error: error.code }); return; }
        input.onError(error);
        if (!response.headersSent) sendJson(response, 503, { error: "runtime_unavailable" });
        else response.destroy();
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => { server.off("listening", listening); reject(error); };
    const listening = () => { server.off("error", failed); resolve(); };
    server.once("error", failed); server.once("listening", listening); server.listen(port, "127.0.0.1");
  });
  port = (server.address() as AddressInfo).port;
  // Only the process that owns the port opens SQLite or initializes services.
  application = Promise.resolve().then(() => input.createApplication(instanceId));
  const closeListener = async () => {
    if (!server.listening) return;
    const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.closeAllConnections(); await closed;
  };
  try { await application; }
  catch (error) { stopping = true; await closeListener(); throw error; }
  return {
    host: "127.0.0.1" as const, port, instanceId,
    async close(): Promise<void> {
      if (stopping) return;
      stopping = true;
      try { await (await application).close(); } finally { await closeListener(); }
    }
  };
}
