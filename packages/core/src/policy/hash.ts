import type { Policy } from "./types";

/** JSON with object keys sorted, so the same policy always serializes the same way. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Identifies a policy without revealing it: `sha256-` and the first 16 hex
 * characters of the SHA-256 of its canonical JSON. Comments and formatting in
 * agents.yaml do not change it. Path rules and sign-up scopes keep their order,
 * which can matter for ties.
 */
export async function policyHash(policy: Policy): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(policy));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  const hex = Array.from(digest.subarray(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `sha256-${hex}`;
}
