import type { ServerResponse } from "node:http";

export { MAX_JSON_BODY_BYTES } from "../../core/session/settingsFileProtocol.js";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code);
  }
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
