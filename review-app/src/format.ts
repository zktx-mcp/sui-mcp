// Shared client-side amount formatting. Pure BigInt math with no @mysten/sui
// dependency, so any page bundle can turn a raw integer amount into a decimal
// display string without pulling server-core code into the browser bundle. The
// per-coin decimals come from the server (which alone reaches the fullnode and
// the coin-metadata cache); this module only renders them.

export const SUI_DECIMALS = 9;

// Unsigned raw integer string -> decimal string, trailing zeros trimmed.
// `raw` must be an unsigned integer string; callers handle the sign separately.
export function rawToDisplay(raw: string, decimals: number): string {
  const value = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

// Signed raw integer string (may start with '-') -> signed decimal string. A
// zero magnitude never renders as "-0".
export function signedRawToDisplay(raw: string, decimals: number): string {
  const negative = raw.startsWith("-");
  const magnitude = negative ? raw.slice(1) : raw;
  const display = rawToDisplay(magnitude, decimals);
  return negative && display !== "0" ? `-${display}` : display;
}

// Gas and other SUI-denominated mist amounts: SUI decimals are a known constant,
// so no coin-metadata lookup is needed to display them.
export function mistToSui(mist: string): string {
  return signedRawToDisplay(mist, SUI_DECIMALS);
}

// A mist amount rendered as a "<sui> SUI" display string — the single source for the
// "amount + SUI ticker" idiom shared by the review fee rows, the receipt gas rows, and
// other SUI display consumers, so the ticker convention lives in exactly one place.
export function suiAmount(mist: string): string {
  return `${mistToSui(mist)} SUI`;
}

// Shorten a longer 0x value (full object id, digest, or a package id inside a Move
// type) for compact display. The full value stays in accessible details.
export function shortHex(value: string): string {
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

// Shorten a fully-qualified Move type for display: shorten only the 0x address
// segments (package ids) inside it, leaving the module/struct names and the
// generic `<...>` structure intact (e.g. `0x…::coin::Coin<0x…::usdc::USDC>`).
export function shortType(value: string): string {
  return value
    .split("<")
    .map((part) =>
      part
        .split("::")
        .map((segment) => (segment.startsWith("0x") && segment.length > 14 ? shortHex(segment) : segment))
        .join("::")
    )
    .join("<");
}

// The bare leaf name of a Move type: the last `::` segment with any generic
// parameters stripped (e.g. `0x2::coin::Coin<0x…::usdc::USDC>` -> `Coin`,
// `0x2::sui::SUI` -> `SUI`). Single source for coin-symbol and struct-name display
// so no page re-implements its own `::`-splitting leaf-name helper.
export function typeName(type: string): string {
  const base = type.split("<")[0] ?? type;
  const parts = base.split("::");
  return parts[parts.length - 1] || type;
}

// The short, qualified name of a Move type, call target, or event type: the module and member
// (the last two `::` segments), dropping the package address and stripping any generic `<...>`
// parameters (e.g. `0x…::universal_router::start_routing` -> `universal_router::start_routing`,
// `0x2::coin::Coin<0x…::usdc::USDC>` -> `coin::Coin`). Single source so neither the receipt view
// nor the account inventory re-implements its own `::`-splitting qualified-name helper.
export function qualifiedName(value: string): string {
  const base = value.split("<")[0] ?? value;
  const parts = base.split("::");
  return parts.length >= 2 ? parts.slice(-2).join("::") : base || value;
}

// Presentation only: never feed this lower-precision label back into a query.
export function formatUtc(value: string | number): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return typeof value === "number"
    ? `${value} milliseconds since 1970-01-01T00:00:00Z` : value;
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}
