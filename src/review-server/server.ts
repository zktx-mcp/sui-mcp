import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "../runtime/logger.js";
import { validateHostOrigin } from "./middleware/hostOrigin.js";
import { sendJson } from "../runtime/shared/http.js";
import { ALLOWED_HOSTNAMES } from "./reviewServerPolicy.js";

// The shared runtime serves authenticated private MCP/control routes itself.
// There are no public browser pages, Settings APIs or static-asset fallbacks.
export function createReviewRequestHandler(options: { logger: Logger }) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const source = validateHostOrigin(request, { allowedHostnames: ALLOWED_HOSTNAMES });
      if (!source.ok) { sendJson(response, source.status, { error: source.reason }); return; }
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.searchParams.has("token")) { sendJson(response, 400, { error: "token_query_not_supported" }); return; }
      sendJson(response, 404, { error: "not_found" });
    } catch {
      options.logger.error("HTTP routing failed", { stage: "http_routing" });
      sendJson(response, 500, { error: "internal_error" });
    }
  };
}
