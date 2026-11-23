import { parseSuiAddress } from "../suiAddress.js";

export const protocolActivityPrimaryActions = [
  "order",
  "swap",
  "liquidity",
  "lending",
  "fee_or_reward",
  "admin_or_versioning",
  "unknown"
] as const;

export type ProtocolActivityPrimaryAction = typeof protocolActivityPrimaryActions[number];

export type ProtocolPackageRule = {
  source: string;
  mvrName?: string | undefined;
};

export type ProtocolRule = {
  protocolId: string;
  displayName: string;
  activityCategory: string;
  namedPackages?: Record<string, string>;
  typeOnlyPackages?: readonly string[];
  sharedObjects: Record<string, string>;
  actionForMoveCall?: ((call: { module: string; function: string }) => ProtocolActivityPrimaryAction) | undefined;
};

const DEEPBOOK_V7_PACKAGE =
  "0xf48222c4e057fa468baf136bff8e12504209d43850c5778f76159292a96f621e";
const DEEPTRADE_CORE_PACKAGE =
  "0xc10d536b6580d809711b9bb8eee3945d5e96f92a346c84d74ff7a0697e664695";
const CETUS_CLMM_PACKAGE =
  "0x25ebb9a7c50eb17b3fa9c5a30fb8b5ad8f97caaf4928943acbcff7153dfee5e3";
const SUILEND_MVR_CORE_PACKAGE =
  "0xe53906c2c058d1e369763114418f3c144d1b74960d29b2785718a782fec09b61";
const SUILEND_MAIN_MARKET_TYPE_PACKAGE =
  "0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf";

export const SUI_DEFI_ACTIVITY_PROTOCOL_RULES: ProtocolRule[] = [
  {
    protocolId: "deepbook-v3",
    displayName: "DeepBook V3",
    activityCategory: "CLOB / order book",
    namedPackages: { [DEEPBOOK_V7_PACKAGE]: "@deepbook/core" },
    sharedObjects: normalizeObjectMap({
      "0xaf16199a2dff736e9f07a845f23c5da6df6f756eddb631aed9d24a93efc4549d": "deepbook_registry"
    }),
    actionForMoveCall: deepbookActionForMoveCall
  },
  {
    protocolId: "deeptrade-core",
    displayName: "DeepTrade Core",
    activityCategory: "DeepBook wrapper and fee system",
    namedPackages: { [DEEPTRADE_CORE_PACKAGE]: "@deeptrade/deeptrade-core" },
    sharedObjects: normalizeObjectMap({
      "0xb90e2d3de41817016b7d39f49c724c5b0616bd30f1d5e6383048efafabe6232b": "deeptrade_treasury",
      "0xe6a7158cbbee252f2ef9488663d91b42d84b3933609c3f891937240f4be65086": "deeptrade_pool_creation_config",
      "0xcb757e55db3a502dc826c40b8ced507d017b41d926c5bf554e69855510bb855e": "deeptrade_trading_fee_config",
      "0x6a06100001533356fb2e9f68ee299c15565777dfb28c741ec440cb08b168cbff": "deeptrade_loyalty_program"
    }),
    actionForMoveCall: deeptradeActionForMoveCall
  },
  {
    protocolId: "cetus-clmm",
    displayName: "Cetus CLMM",
    activityCategory: "CLMM / AMM",
    namedPackages: { [CETUS_CLMM_PACKAGE]: "@cetuspackages/clmm" },
    sharedObjects: normalizeObjectMap({
      "0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f": "cetus_global_config",
      "0xf699e7f2276f5c9a75944b37a0c5b5d9ddfd2471bf6242483b03ab2887d198d0": "cetus_pools_table"
    }),
    actionForMoveCall: clmmActionForMoveCall
  },
  {
    protocolId: "suilend-lending",
    displayName: "Suilend Lending",
    activityCategory: "Lending market",
    namedPackages: { [SUILEND_MVR_CORE_PACKAGE]: "@suilend/core" },
    typeOnlyPackages: [SUILEND_MAIN_MARKET_TYPE_PACKAGE],
    sharedObjects: normalizeObjectMap({
      "0x84030d26d85eaa7035084a057f2f11f701b7e2e4eda87551becbc7c97505ece1": "suilend_main_market",
      "0xf7a4defe0b6566b6a2674a02a0c61c9f99bd012eed21bc741a069eaa82d35927": "suilend_main_market_owner_cap"
    }),
    actionForMoveCall: lendingActionForMoveCall
  },
  {
    protocolId: "aftermath-afsui",
    displayName: "Aftermath afSUI",
    activityCategory: "Liquid staking",
    sharedObjects: normalizeObjectMap({
      "0x2f8f6d5da7f13ea37daa397724280483ed062769813b6f31e9788e59cc88994d": "aftermath_staked_sui_vault",
      "0x55486449e41d89cfbdb20e005c1c5c1007858ad5b4d5d7c047d2b3b592fe8791": "aftermath_staked_sui_vault_state",
      "0xd2b95022244757b0ab9f74e2ee2fb2c3bf29dce5590fa6993a85d64bd219d7e8": "aftermath_afsui_treasury"
    })
  }
];

function deepbookActionForMoveCall(call: { module: string; function: string }): ProtocolActivityPrimaryAction {
  if (call.module === "balance_manager") {
    if (/^(deposit|withdraw|withdraw_all|mint_trade_cap|mint_deposit_cap|mint_withdraw_cap)/.test(call.function)) {
      return "liquidity";
    }
    return "unknown";
  }
  if (call.module !== "pool") {
    return "unknown";
  }
  if (/^(place_|modify_order|cancel_|withdraw_settled)/.test(call.function)) {
    return "order";
  }
  if (/^swap_/.test(call.function)) {
    return "swap";
  }
  if (/^(claim_|mint_referral|update_.*referral|burn_deep)/.test(call.function)) {
    return "fee_or_reward";
  }
  if (/^(stake|unstake|submit_proposal|vote|create_|update_|adjust_|enable_|set_)/.test(call.function)) {
    return "admin_or_versioning";
  }
  if (/^borrow_flashloan|^return_flashloan/.test(call.function)) {
    return "liquidity";
  }
  return "unknown";
}

function deeptradeActionForMoveCall(call: { module: string; function: string }): ProtocolActivityPrimaryAction {
  if (call.module === "dt_order") {
    return "order";
  }
  const combined = `${call.module}_${call.function}`;
  if (isAdminOrVersioningCall(combined) || /multisig|dt_pool/.test(call.module) || /create_permissionless_pool/.test(call.function)) {
    return "admin_or_versioning";
  }
  if (call.module === "swap") {
    return "swap";
  }
  if (/fee|treasury|loyalty/.test(call.module) || /fee|loyalty|reserve/.test(call.function)) {
    return "fee_or_reward";
  }
  return "unknown";
}

function clmmActionForMoveCall(call: { module: string; function: string }): ProtocolActivityPrimaryAction {
  const combined = `${call.module}_${call.function}`;
  if (isAdminOrVersioningCall(combined)) {
    return "admin_or_versioning";
  }
  if (/swap|exchange/.test(combined)) {
    return "swap";
  }
  if (/fee|reward|collect|claim/.test(combined)) {
    return "fee_or_reward";
  }
  if (/liquidity|position|mint|burn|open|close|increase|decrease/.test(combined)) {
    return "liquidity";
  }
  return "unknown";
}

function lendingActionForMoveCall(call: { module: string; function: string }): ProtocolActivityPrimaryAction {
  const combined = `${call.module}_${call.function}`;
  if (isAdminOrVersioningCall(combined) || /config|owner|risk|isolated|oracle/.test(combined)) {
    return "admin_or_versioning";
  }
  if (/deposit|withdraw|borrow|repay|liquidat|redeem|mint|supply/.test(combined)) {
    return "lending";
  }
  if (/reward|fee|claim/.test(combined)) {
    return "fee_or_reward";
  }
  return "unknown";
}

function isAdminOrVersioningCall(value: string): boolean {
  const tokens = value.split("_").filter((token) => token.length > 0);
  return tokens.some((token) => [
    "admin",
    "config",
    "owner",
    "risk",
    "oracle",
    "version",
    "registry",
    "govern",
    "pause",
    "upgrade",
    "set",
    "update",
    "allowed"
  ].includes(token));
}

function normalizeObjectMap(objects: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(objects).flatMap(([address, label]) => {
      const normalized = parseSuiAddress(address);
      return normalized === undefined ? [] : [[normalized, label]];
    })
  );
}
