import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import type { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { openWalletConnectStorage } from "../../src/runtime/walletConnectStorage.js";

type Socket = EventEmitter & { send(value: string): void; terminate(): void };
type Server = EventEmitter & { address(): AddressInfo; clients: Set<Socket>; close(callback: () => void): void };
// ws is the already installed relay transport dependency. The narrow types here
// describe only this external wire fixture, not a replacement SDK API.
const { Server: WebSocketServer } = createRequire(import.meta.url)("ws") as { Server: new (options: { port: number; host: string }) => Server };
export async function walletRelay() {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  let holdUnsubscribe = true;
  let respond: ((input: { topic: string; message: string }) => string | undefined | Promise<string | undefined>) | undefined;
  const responseErrors: unknown[] = [];
  let notification = 0;
  const calls: { method: string; topic?: string }[] = [], withheld: (() => void)[] = [];
  const id = (topic: string) => createHash("sha256").update(topic).digest("hex");
  server.on("connection", (socket: Socket) => socket.on("message", (raw: Buffer) => {
    const input = JSON.parse(raw.toString()) as { id: number; method?: string; params: { topic?: string; topics?: string[]; message?: string } };
    if (!input.method) return; // SDK acknowledgement of an inbound relay message.
    calls.push({ method: input.method, ...(input.params.topic ? { topic: input.params.topic } : {}) });
    const reply = (result: unknown) => () => socket.send(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }));
    if (input.method === "irn_unsubscribe") { if (holdUnsubscribe) withheld.push(reply(true)); else reply(true)(); }
    else if (input.method === "irn_subscribe") reply(id(input.params.topic!))();
    else if (input.method === "irn_batchSubscribe") reply(input.params.topics!.map(id))();
    else if (input.method === "wc_proposeSession") reply(true)();
    else if (input.method === "irn_publish") {
      reply(true)();
      void Promise.resolve().then(() => respond?.({ topic: input.params.topic!, message: input.params.message! })).then((message) => {
        if (message) socket.send(JSON.stringify({ jsonrpc: "2.0", id: ++notification, method: "irn_subscription",
          params: { id: id(input.params.topic!), data: { topic: input.params.topic, message, publishedAt: Date.now() } } }));
      }).catch((error: unknown) => responseErrors.push(error));
    }
    else socket.send(JSON.stringify({ jsonrpc: "2.0", id: input.id, error: { code: -32601, message: "Unsupported fixture relay method" } }));
  }));
  return { url: `ws://127.0.0.1:${server.address().port}`, calls, responseErrors,
    respondToPublish(handler: NonNullable<typeof respond>) { respond = handler; },
    deliver(topic: string, message: string) {
      for (const socket of server.clients) socket.send(JSON.stringify({ jsonrpc: "2.0", id: ++notification, method: "irn_subscription",
        params: { id: id(topic), data: { topic, message, publishedAt: Date.now() } } }));
    },
    release() { holdUnsubscribe = false; for (const send of withheld.splice(0)) send(); },
    async close() { for (const socket of server.clients) socket.terminate(); await new Promise<void>((resolve) => server.close(resolve)); }
  };
}

export const sdkFixtureTopic = "ab".repeat(32);
export const sdkFixtureAccount = `0x${"c".repeat(64)}`;
export async function seedWalletSdk(directory: string, kind: "session" | "expired_session" | "missing_key_session" | "inactive_pairing" | "expired_pairing", account = sdkFixtureAccount) {
  const storage = openWalletConnectStorage(directory);
  // Pinned SDK Store persists arrays; KeyChain persists a string-keyed object.
  // These synthetic previously approved facts are test input, not wallet proof.
  try {
    const expiry = Math.floor(Date.now() / 1000) + (kind.startsWith("expired") ? -1 : 3600);
    const topic = sdkFixtureTopic;
    await storage.storage.setItem("wc@2:core:0.3//keychain", kind === "missing_key_session" ? {} : { [topic]: "cd".repeat(32) });
    await storage.storage.setItem("wc@2:core:0.3//subscription", [{ topic, id: createHash("sha256").update(topic).digest("hex"), relay: { protocol: "irn" } }]);
    if (kind.endsWith("pairing")) await storage.storage.setItem("wc@2:core:0.3//pairing", [{ topic, expiry, relay: { protocol: "irn" }, active: false }]);
    else await storage.storage.setItem("wc@2:client:0.3//session", [{ topic, expiry, relay: { protocol: "irn" }, acknowledged: true,
      self: { publicKey: "ef".repeat(32), metadata: { name: "Local fixture", description: "No wallet network", url: "https://example.invalid", icons: [] } },
      peer: { publicKey: "12".repeat(32), metadata: { name: "Fixture wallet", description: "Synthetic approved state", url: "https://example.invalid", icons: [] } },
      namespaces: { sui: { accounts: [`sui:mainnet:${account}`], methods: ["sui_signTransaction"], events: ["accountsChanged", "chainChanged"] } },
      requiredNamespaces: {}, controller: "12".repeat(32) }]);
  } finally { storage.closeBeforeSdkUse(); }
}
