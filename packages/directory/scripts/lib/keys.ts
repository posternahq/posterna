import { calculateJwkThumbprint, type JWK } from "jose";
import type { KidConvention, PublicJwk } from "../../../core/src/directory/types";

/** JWK members that must never be published or stored. */
const PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k", "r", "t"];
const PUBLIC_MEMBERS = [
  "kty",
  "crv",
  "x",
  "y",
  "n",
  "e",
  "alg",
  "use",
  "kid",
  "key_ops",
  "nbf",
  "exp",
] as const;

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const CURVE_BYTES: Record<string, number> = {
  Ed25519: 32,
  Ed448: 57,
  "P-256": 32,
  "P-384": 48,
  "P-521": 66,
};

function base64UrlLength(value: string): number {
  return Buffer.from(value, "base64url").byteLength;
}

export type CheckedJwk = { ok: true; jwk: PublicJwk } | { ok: false; reason: string };

/** Accepts a well-formed public signing JWK and drops every member not on the public list. */
export function checkPublicJwk(value: unknown): CheckedJwk {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "not a JSON object" };
  }
  const input = value as Record<string, unknown>;
  const leaked = PRIVATE_MEMBERS.filter((member) => member in input);
  if (leaked.length > 0) {
    return {
      ok: false,
      reason: `contains private key members (${leaked.join(", ")}); key rejected`,
    };
  }
  const kty = input.kty;
  const str = (member: string) =>
    typeof input[member] === "string" ? (input[member] as string) : undefined;
  if (kty === "OKP" || kty === "EC") {
    const crv = str("crv");
    const size = crv ? CURVE_BYTES[crv] : undefined;
    if (!crv || !size || (kty === "OKP") !== crv.startsWith("Ed")) {
      return { ok: false, reason: `unsupported curve ${String(input.crv)} for ${kty}` };
    }
    for (const member of kty === "OKP" ? ["x"] : ["x", "y"]) {
      const coordinate = str(member);
      if (!coordinate || !BASE64URL.test(coordinate) || base64UrlLength(coordinate) !== size) {
        return { ok: false, reason: `bad "${member}" for ${crv}` };
      }
    }
  } else if (kty === "RSA") {
    const n = str("n");
    const e = str("e");
    if (!n || !e || !BASE64URL.test(n) || !BASE64URL.test(e)) {
      return { ok: false, reason: "RSA key without valid n and e" };
    }
    if (base64UrlLength(n) < 256)
      return { ok: false, reason: "RSA modulus shorter than 2048 bits" };
  } else {
    return { ok: false, reason: `unsupported key type ${String(kty)}` };
  }
  const jwk: Record<string, unknown> = {};
  for (const member of PUBLIC_MEMBERS) if (member in input) jwk[member] = input[member];
  return { ok: true, jwk: jwk as unknown as PublicJwk };
}

/** RFC 7638 SHA-256 thumbprint, base64url. Computed with jose, never by hand. */
export function jwkThumbprint(jwk: PublicJwk): Promise<string> {
  return calculateJwkThumbprint(jwk as JWK, "sha256");
}

export interface ParsedKey {
  jwk: PublicJwk;
  thumbprint: string;
  kid: string | null;
}

export interface ParsedKeyDirectory {
  keys: ParsedKey[];
  rejected: string[];
  /** A top-level `purpose` member, if the directory has one. */
  purposeField: string | null;
  error: string | null;
}

/** Parses an HTTP Message Signatures directory (a JWK Set). */
export async function parseKeyDirectory(body: string): Promise<ParsedKeyDirectory> {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch (error) {
    return {
      keys: [],
      rejected: [],
      purposeField: null,
      error: `invalid JSON: ${(error as Error).message}`,
    };
  }
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  if (!Array.isArray(record.keys)) {
    return { keys: [], rejected: [], purposeField: null, error: 'no "keys" array' };
  }
  const keys: ParsedKey[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const [index, value] of record.keys.entries()) {
    const checked = checkPublicJwk(value);
    if (!checked.ok) {
      rejected.push(`key ${index}: ${checked.reason}`);
      continue;
    }
    const thumbprint = await jwkThumbprint(checked.jwk);
    if (seen.has(thumbprint)) continue;
    seen.add(thumbprint);
    keys.push({ jwk: checked.jwk, thumbprint, kid: checked.jwk.kid ?? null });
  }
  keys.sort((a, b) => a.thumbprint.localeCompare(b.thumbprint));
  const purpose = record.purpose;
  return {
    keys,
    rejected,
    purposeField: typeof purpose === "string" && purpose.length > 0 ? purpose : null,
    error: null,
  };
}

/** How the operator sets kid: equal to the RFC 7638 thumbprint, some other id, or not at all. */
export function kidConvention(keys: readonly ParsedKey[]): KidConvention | null {
  if (keys.length === 0) return null;
  if (keys.every((key) => key.kid === null)) return "none";
  if (keys.every((key) => key.kid === key.thumbprint)) return "thumbprint";
  return "short_id";
}
