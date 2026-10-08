import { ADAPTER_PROMPT_SURFACES } from "../../src/adapters/adapterPromptSurfaces.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { validateSupportedAdapterLifecycle } from "../../src/adapters/adapterLifecycleValidators.js";
import { TransactionActivityService } from "../../src/core/activity/transactionActivityService.js";
import { SuiReadService, type DeepBookReadClient } from "../../src/core/read/readService.js";
import { InMemorySessionStore } from "../../src/core/session/sessionStore.js";
import { createMcpServer, startMcp } from "../../src/mcp/server.js";
import { InMemoryActivityStore } from "./inMemoryActivityStore.js";
import { InMemoryLocalSettingsService } from "./inMemoryLocalSettings.js";
import { MemoryCoinMetadataCache } from "./memoryCoinMetadataCache.js";

const deepbook: DeepBookReadClient = {
  async midPrice() {
    return 1;
  },
  async poolBookParams() {
    return { tickSize: 1, lotSize: 1, minSize: 1 };
  },
  async getLevel2TicksFromMid() {
    return {
      bid_prices: [1],
      bid_quantities: [2],
      ask_prices: [3],
      ask_quantities: [4]
    };
  },
  async getQuoteQuantityOutRaw() {
    return { baseOutRaw: "0", quoteOutRaw: "1000000", deepRequiredRaw: "0" };
  },
  async getQuoteQuantityOutInputFeeRaw() {
    return { baseOutRaw: "0", quoteOutRaw: "1000000", deepRequiredRaw: "0" };
  },
  async getBaseQuantityOutRaw() {
    return { baseOutRaw: "1000000000", quoteOutRaw: "0", deepRequiredRaw: "0" };
  },
  async getBaseQuantityOutInputFeeRaw() {
    return { baseOutRaw: "1000000000", quoteOutRaw: "0", deepRequiredRaw: "0" };
  },
  async getBalanceManagerIds() {
    return [`0x${"c".repeat(64)}`];
  },
  async accountExists() {
    return true;
  },
  async account() {
    return {
      epoch: "42",
      open_orders: { contents: [] },
      taker_volume: 0,
      maker_volume: 0,
      active_stake: 0,
      inactive_stake: 0,
      created_proposal: false,
      voted_proposal: null,
      unclaimed_rebates: { base: 0, quote: 0, deep: 0 },
      settled_balances: { base: 0, quote: 0, deep: 0 },
      owed_balances: { base: 0, quote: 0, deep: 0 }
    };
  },
  async lockedBalance() {
    return { base: 0, quote: 0, deep: 0 };
  },
  async accountOpenOrders() {
    return [];
  }
};

const activityStore = new InMemoryActivityStore();
const logger = {
  error(_message: string, _meta?: Record<string, unknown>) {}
};
const server = createMcpServer({
  promptSurfaces: ADAPTER_PROMPT_SURFACES,
  sessions: new InMemorySessionStore({
    activityStore,
    logger,
    validateAdapterLifecycle: validateSupportedAdapterLifecycle
  }),
  activityStore,
  localSettings: new InMemoryLocalSettingsService(),
  logger,
  readService: new SuiReadService({
    network: "mainnet",
    chainIdentifier: "4c78adac",
    coinMetadataCache: new MemoryCoinMetadataCache(),
    now: () => new Date("2026-05-11T00:00:00.000Z"),
    deepbookFactory: () => deepbook,
    client: {
      core: {
        async listBalances() {
          return {
            balances: [],
            hasNextPage: false,
            cursor: null
          };
        },
        async getCoinMetadata() {
          return { coinMetadata: null };
        }
      }
    }
  }),
  transactionActivityService: new TransactionActivityService({
    activityStore,
    source: {
      async verifyMainnet() {
        return {
          transport: "graphql",
          endpointHost: "graphql.mainnet.sui.io",
          chainIdentifier: "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"
        };
      },
      async getTransaction(digest) {
        return { digest, status: "unknown" };
      },
      async scanAccount() {
        return { transactions: [], hasMore: false };
      },
      async scanFunction() {
        return { transactions: [], hasMore: false };
      }
    }
  })
});

await startMcp(server, new StdioServerTransport());

async function shutdown(): Promise<void> {
  await server.close();
}

process.on("SIGTERM", () => {
  void shutdown()
    .catch((error: unknown) => {
      logger.error("shutdown failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    })
    .finally(() => process.exit(143));
});
process.on("SIGINT", () => {
  void shutdown()
    .catch((error: unknown) => {
      logger.error("shutdown failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    })
    .finally(() => process.exit(130));
});
