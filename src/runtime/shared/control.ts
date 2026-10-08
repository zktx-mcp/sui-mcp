import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { link, lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { IncomingMessage } from "node:http";

import { SERVER_VERSION } from "../../mcp/serverInfo.js";

// Peers use the one package release identity, with no separate API counter.
export const IDENTITY_PATH = "/__runtime/identity";
export const INTERNAL_MCP_PATH = "/__runtime/mcp";
export const IDENTITY_CHALLENGE_HEADER = "x-sui-mcp-identity-challenge";
export const SERVER_INSTANCE_HEADER = "x-sui-mcp-server-instance";
// The existing review-server identity probe allows one second for a local response.
export const IDENTITY_TIMEOUT_MS = 1000;
const secretSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const serverIdentitySchema = z.object({
  service: z.literal("sui-mcp"),
  role: z.literal("shared-server"),
  packageVersion: z.literal(SERVER_VERSION),
  databaseId: z.string().regex(/^[0-9a-f]{64}$/),
  configurationId: z.string().regex(/^[0-9a-f]{64}$/),
  instanceId: z.string().uuid(),
  pid: z.number().int().positive(),
  challenge: secretSchema,
  proof: secretSchema
}).strict();
export type ServerIdentity = z.infer<typeof serverIdentitySchema>;
export type ControlIdentity = { key: string; databaseId: string; configurationId: string };

export async function loadControlIdentity(databasePath: string, configuration: unknown): Promise<ControlIdentity> {
  await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
  const directory = await realpath(dirname(databasePath));
  const path = join(directory, "runtime-control.key");
  const temporary = join(directory, `.runtime-control-${randomUUID()}.tmp`);
  await writeFile(temporary, randomBytes(32).toString("base64url"), { flag: "wx", mode: 0o600 });
  try {
    try { await link(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally { await unlink(temporary); }
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== "win32" &&
      ((stat.mode & 0o077) !== 0 || (process.getuid !== undefined && stat.uid !== process.getuid())))) {
    throw new Error("The runtime control key must be a private file owned by the current OS user.");
  }
  return {
    key: secretSchema.parse(await readFile(path, "utf8")),
    databaseId: createHash("sha256").update(join(directory, basename(databasePath))).digest("hex"),
    configurationId: createHash("sha256").update(JSON.stringify(configuration)).digest("hex")
  };
}

function identityPayload(identity: Omit<ServerIdentity, "proof">): string {
  return JSON.stringify([identity.service, identity.role, identity.packageVersion, identity.databaseId,
    identity.configurationId, identity.instanceId, identity.pid, identity.challenge]);
}
export function createServerIdentity(control: ControlIdentity, instanceId: string, challenge: string): ServerIdentity {
  secretSchema.parse(challenge);
  const identity = { service: "sui-mcp", role: "shared-server", packageVersion: SERVER_VERSION,
    databaseId: control.databaseId, configurationId: control.configurationId,
    instanceId, pid: process.pid, challenge } as const;
  return { ...identity, proof: createHmac("sha256", control.key).update(identityPayload(identity)).digest("base64url") };
}
export function verifyServerIdentity(input: unknown, control: ControlIdentity, challenge: string): ServerIdentity {
  const identity = serverIdentitySchema.parse(input);
  if (identity.databaseId !== control.databaseId || identity.configurationId !== control.configurationId ||
      identity.challenge !== challenge) throw new Error("Local server identity does not match this runtime.");
  const expected = createHmac("sha256", control.key).update(identityPayload(identity)).digest();
  const actual = Buffer.from(identity.proof, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("Local server authentication failed.");
  }
  return identity;
}
export function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const values = request.headersDistinct[name];
  return values?.length === 1 ? values[0] : undefined;
}
export function validInternalRequest(request: IncomingMessage, port: number): boolean {
  return singleHeader(request, "host") === `127.0.0.1:${port}` &&
    request.headers.origin === undefined && request.headers.cookie === undefined;
}
export function validControlAuthorization(request: IncomingMessage, control: ControlIdentity, instanceId: string): boolean {
  const authorization = singleHeader(request, "authorization");
  if (authorization === undefined || singleHeader(request, SERVER_INSTANCE_HEADER) !== instanceId) return false;
  const expected = Buffer.from(`Bearer ${control.key}`);
  const actual = Buffer.from(authorization);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
