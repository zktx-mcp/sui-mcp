import { SignClient } from "@walletconnect/sign-client";
import { Core, SUBSCRIBER_EVENTS } from "@walletconnect/core";
import type { CoreTypes, ICore } from "@walletconnect/types";
import { createWalletConnectTransport } from "../../src/runtime/walletConnectTransport.js";
import { runWalletSdkChild } from "../../src/runtime/walletSdkChildRuntime.js";

// This fixture entrypoint is excluded from the build and package. It changes
// the external relay endpoint. Cleanup-race cases additionally order a real
// storage read after real relay subscription; no SDK method/state is replaced.
const relayUrl = process.env.SUI_MCP_TEST_WALLET_RELAY;
if (!relayUrl || !/^ws:\/\/127\.0\.0\.1:[0-9]+$/.test(relayUrl)) throw new Error("Local fixture relay is required");
globalThis.fetch = async () => { throw new Error("External HTTP is disabled in the wallet SDK fixture"); };
runWalletSdkChild(({ projectId, dataDirectory, metadata }) => createWalletConnectTransport({ projectId, dataDirectory, metadata,
  initialize: async (options) => {
    if (process.env.SUI_MCP_TEST_WALLET_SUBSCRIBED_READ !== "1") return SignClient.init({ ...options, relayUrl });
    const original = options?.storage;
    if (!original) throw new Error("Actual SDK storage is required");
    const subscriptions = await original.getItem<unknown[]>("wc@2:core:0.3//subscription");
    if (!subscriptions?.length) return SignClient.init({ ...options, relayUrl });
    let release!: () => void;
    const subscribed = new Promise<void>((resolve) => { release = resolve; });
    const storage: NonNullable<CoreTypes.Options["storage"]> = {
      getKeys: () => original.getKeys(), getEntries: <T>() => original.getEntries<T>(),
      setItem: <T>(key: string, value: T) => original.setItem(key, value), removeItem: (key: string) => original.removeItem(key),
      getItem: async <T>(key: string) => {
      if (key === "wc@2:core:0.3//pairing" || key === "wc@2:client:0.3//session") await subscribed;
      return original.getItem<T>(key);
    } };
    const core = new Core({ projectId, relayUrl, storage, logger: "silent", telemetryEnabled: false });
    core.relayer.subscriber.once(SUBSCRIBER_EVENTS.created, release);
    // The pinned Core/ICore declarations disagree on exact optional properties;
    // this is the actual Core instance accepted by the same pinned SignClient.
    return SignClient.init({ ...options, core: core as unknown as ICore, relayUrl });
  } }));
