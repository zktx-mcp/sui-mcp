import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

type NpmPublication = { name: string; version: string; mcpName: string };
type WaitOptions = {
  integrity?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  fetch?: typeof globalThis.fetch;
  log?: (message: string) => void;
};

// CI policy, not an npm SLA: reuse the npm job's 20-minute budget and make at
// most two reads per minute. Request timeout matches the MCP Registry validator.
const PUBLICATION_TIMEOUT_MS = 20 * 60_000;
const POLL_INTERVAL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;

function publicationMetadata(input: unknown, source: string): NpmPublication {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${source} metadata must be an object.`);
  const value = input as Record<string, unknown>;
  for (const key of ["name", "version", "mcpName"] as const) {
    if (typeof value[key] !== "string" || !value[key].trim()) throw new Error(`${source} metadata requires ${key}.`);
  }
  return { name: value.name as string, version: value.version as string, mcpName: value.mcpName as string };
}

function retryAfterMs(value: string | null): number {
  if (value === null) return 0;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

export async function waitForNpmPublication(input: unknown, options: WaitOptions = {}): Promise<void> {
  const expected = publicationMetadata(input, "Local package");
  const timeoutMs = options.timeoutMs ?? PUBLICATION_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  if (![timeoutMs, pollIntervalMs].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error("Publication timeout and poll interval must be positive safe integers.");
  }
  const fetchMetadata = options.fetch ?? globalThis.fetch;
  const log = options.log ?? console.log;
  const url = `https://registry.npmjs.org/${encodeURIComponent(expected.name)}/${encodeURIComponent(expected.version)}`;
  const deadline = Date.now() + timeoutMs;
  const label = `${expected.name}@${expected.version}`;
  let lastReason = "no public response";

  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()));
    let status: number | undefined;
    let retryAfter: string | null = null;
    let metadata: unknown;
    try {
      const response = await fetchMetadata(url, {
        headers: { accept: "application/json" }, credentials: "omit", redirect: "manual", signal: controller.signal
      });
      status = response.status;
      retryAfter = response.headers.get("retry-after");
      if (status === 200) metadata = await response.json();
    } catch (error) {
      if (!controller.signal.aborted && !(error instanceof TypeError)) {
        throw new Error("Public npm metadata could not be decoded as JSON.", { cause: error });
      }
      status = undefined;
      lastReason = controller.signal.aborted ? "npm metadata request timed out" : "npm metadata network request failed";
    } finally {
      clearTimeout(timer);
      // Release an unread error body as well as any outstanding request work.
      controller.abort();
    }

    if (Date.now() >= deadline) break;
    if (status === 200) {
      const actual = publicationMetadata(metadata, "Public npm");
      if (actual.name !== expected.name || actual.version !== expected.version || actual.mcpName !== expected.mcpName) {
        throw new Error("Public npm name, version or mcpName differs from the release metadata. Registry publication was not attempted.");
      }
      if (options.integrity && (metadata as { dist?: { integrity?: string } }).dist?.integrity !== options.integrity) {
        throw new Error("Public npm integrity differs from the tested tarball.");
      }
      log(`Confirmed public npm package ${label} for ${expected.mcpName}.`);
      return;
    }
    if (status !== undefined) {
      if (status !== 404 && status !== 429 && !(status >= 500 && status < 600)) {
        throw new Error(`Public npm lookup returned HTTP ${status}. Registry publication was not attempted.`);
      }
      lastReason = `npm lookup returned HTTP ${status}`;
    }
    const delay = Math.min(Math.max(pollIntervalMs, retryAfterMs(retryAfter)), deadline - Date.now());
    log(`Waiting for ${label}: ${lastReason}; next check in ${Math.ceil(delay / 1000)}s.`);
    await new Promise<void>((done) => setTimeout(done, delay));
  }
  throw new Error(`Timed out waiting for public npm package ${label}: ${lastReason}. Registry publication was not attempted. Check npm availability and re-run only the Registry job; do not re-publish this version.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const release = JSON.parse(await readFile(process.argv[2] ?? "package.json", "utf8"));
    if (process.argv[2] && !/^sha512-[A-Za-z0-9+/]{86}==$/.test(release.integrity)) throw new Error("Missing release integrity.");
    await waitForNpmPublication(release, { ...(release.integrity ? { integrity: release.integrity } : {}) });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Public npm availability check failed.");
    process.exitCode = 1;
  }
}
