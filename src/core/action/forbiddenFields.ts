const FORBIDDEN_EDGE_TERMS = [
  "bytes",
  "signature",
  "sessiontoken",
  "reviewtoken",
  "wallettoken",
  "fragmenttoken",
  "tokenhash",
  "privatekey",
  "secretkey",
  "seed",
  "mnemonic"
] as const;
const FORBIDDEN_PREFIX_OR_SUFFIX_TERMS = ["serialized", "signable"] as const;

function isForbiddenFieldKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    FORBIDDEN_EDGE_TERMS.some((term) => normalized === term || normalized.endsWith(term)) ||
    FORBIDDEN_PREFIX_OR_SUFFIX_TERMS.some(
      (term) => normalized === term || normalized.startsWith(term) || normalized.endsWith(term)
    )
  );
}

function* forbiddenFields(value: unknown, path: string): Generator<string> {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) yield* forbiddenFields(value[index], `${path}[${index}]`);
    return;
  }
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    const current = `${path}.${key}`;
    if (isForbiddenFieldKey(key)) yield current;
    yield* forbiddenFields((value as Record<string, unknown>)[key], current);
  }
}

export function findForbiddenMcpFields(value: unknown, path = "$"): string[] {
  return [...forbiddenFields(value, path)];
}

export function assertNoForbiddenMcpFields(value: unknown): void {
  for (const path of forbiddenFields(value, "$")) throw new Error(`MCP payload contains forbidden field(s): ${path}`);
}
