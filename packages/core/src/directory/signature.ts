/**
 * Detached signatures for directory.json and keys.json (docs/SPEC.md section
 * 3.1): Ed25519 over the exact file bytes, encoded as base64url without
 * padding, published next to the file with a `.sig` suffix.
 *
 * Verification uses the platform's Web Crypto API, so it runs in Node and in
 * edge runtimes. Cryptography is never implemented here by hand: thumbprints
 * come from Cloudflare's web-bot-auth.
 */

import { jwkToKeyID } from "web-bot-auth";

/** What a directory signing key is for. */
export type DirectoryKeyRole = "primary" | "backup";

/** An Ed25519 public key as a JWK, with no other members. */
export interface DirectoryPublicJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
}

/** A Posterna directory signing key that installs trust (docs/KEYS.md). */
export interface TrustedDirectoryKey {
  /** RFC 7638 SHA-256 thumbprint of `jwk`, base64url. */
  kid: string;
  /** `primary` signs the published files; `backup` is kept offline for an emergency switch. */
  role: DirectoryKeyRole;
  /**
   * A positive integer that grows with each new key. Once a file verifies
   * under generation N, the install stops trusting lower generations.
   */
  generation: number;
  /** The date the key joined this list, `YYYY-MM-DD`. */
  added: string;
  jwk: DirectoryPublicJwk;
}

/**
 * Public keys that may sign directory.json and keys.json. The primary's
 * private half is the Posterna cloud's POSTERNA_DIRECTORY_SIGNING_KEY; the
 * backup's private half is kept offline. Rotation and the emergency runbook
 * are in docs/KEYS.md; keep its table in step with this list.
 */
export const TRUSTED_DIRECTORY_KEYS: readonly TrustedDirectoryKey[] = [
  {
    kid: "2qUSU6hxNFv8aoHtbtW12lPokB8olcots8I1Re8Ow04",
    role: "primary",
    generation: 1,
    added: "2026-10-26",
    jwk: { kty: "OKP", crv: "Ed25519", x: "PcUCBGLBJ4zjasNQKZJI5FupfvUDtyey6NeLpxwaJyk" },
  },
  {
    kid: "8l853J2OG3QMQmih_3xjxkE6kL-aYERKjaCza171yBQ",
    role: "backup",
    generation: 2,
    added: "2026-10-26",
    jwk: { kty: "OKP", crv: "Ed25519", x: "eOX0yQWZuN2z500aITEU5gcu4_PqVKsaZ2bZIW7Z7iE" },
  },
];

const ED25519_SIGNATURE_BYTES = 64;
const ED25519_PUBLIC_KEY_BYTES = 32;

/**
 * Decodes unpadded base64url. Returns undefined for anything that is not
 * strict base64url.
 */
export function decodeBase64Url(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return undefined;
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeBase64Url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The RFC 7638 SHA-256 thumbprint of an Ed25519 public key, base64url: the
 * `kid` of a {@link TrustedDirectoryKey}. Only `kty`, `crv` and `x` are read,
 * so passing a private JWK gives the thumbprint of its public half.
 */
export async function directoryKeyThumbprint(jwk: {
  kty?: string;
  crv?: string;
  x?: string;
}): Promise<string> {
  return jwkToKeyID(
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
    (value) => crypto.subtle.digest("SHA-256", value),
    encodeBase64Url,
  );
}

/** Why a signature was not accepted. */
export type DirectorySignatureFailure =
  /** The `.sig` contents are not 64 bytes of base64url. */
  | "signature_malformed"
  /** No trusted key verifies the signature. */
  | "signature_untrusted"
  /** Only a key below the minimum generation verifies it: that generation is retired here. */
  | "signature_retired";

export type DirectorySignatureResult =
  | { ok: true; kid: string; generation: number }
  | { ok: false; reason: DirectorySignatureFailure };

function usable(key: TrustedDirectoryKey): boolean {
  const { kty, crv, x } = key.jwk ?? {};
  return (
    kty === "OKP" &&
    crv === "Ed25519" &&
    typeof x === "string" &&
    decodeBase64Url(x)?.length === ED25519_PUBLIC_KEY_BYTES &&
    Number.isSafeInteger(key.generation) &&
    key.generation > 0
  );
}

async function verifiesUnder(
  key: TrustedDirectoryKey,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  try {
    const { kty, crv, x } = key.jwk;
    const imported = await crypto.subtle.importKey(
      "jwk",
      { kty, crv, x },
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify({ name: "Ed25519" }, imported, signature, data);
  } catch {
    // A key this runtime cannot import never verifies.
    return false;
  }
}

/**
 * Checks a detached Ed25519 signature over the exact bytes of a directory
 * file, trying trusted keys from the highest generation down. A signature is
 * accepted only under a key at or above `minGeneration`; one that verifies
 * only under a lower generation is reported as `signature_retired`.
 *
 * Never throws. Runs when a file is refreshed, never on the request path.
 *
 * @param bytes - The file exactly as downloaded.
 * @param signature - Contents of the `.sig` file. Surrounding whitespace is ignored.
 * @param trustedKeys - Defaults to {@link TRUSTED_DIRECTORY_KEYS}.
 * @param minGeneration - The lowest generation still accepted. Defaults to every generation.
 */
export async function checkDirectorySignature(
  bytes: Uint8Array,
  signature: string,
  trustedKeys: readonly TrustedDirectoryKey[] = TRUSTED_DIRECTORY_KEYS,
  minGeneration = 0,
): Promise<DirectorySignatureResult> {
  try {
    const sig = decodeBase64Url(signature.trim());
    if (!sig || sig.length !== ED25519_SIGNATURE_BYTES) {
      return { ok: false, reason: "signature_malformed" };
    }
    const data = new Uint8Array(bytes);
    const sigBytes = new Uint8Array(sig);
    const keys = trustedKeys.filter(usable).sort((a, b) => b.generation - a.generation);

    for (const key of keys) {
      if (key.generation < minGeneration) continue;
      if (await verifiesUnder(key, sigBytes, data)) {
        return { ok: true, kid: key.kid, generation: key.generation };
      }
    }
    for (const key of keys) {
      if (key.generation >= minGeneration) continue;
      if (await verifiesUnder(key, sigBytes, data))
        return { ok: false, reason: "signature_retired" };
    }
    return { ok: false, reason: "signature_untrusted" };
  } catch {
    return { ok: false, reason: "signature_untrusted" };
  }
}

/**
 * True when at least one of `trustedKeys`, of any generation, verifies the
 * signature. Never throws. Installs use {@link checkDirectorySignature}, which
 * also applies the generation ratchet.
 *
 * @param bytes - The file exactly as downloaded.
 * @param signature - Contents of the `.sig` file. Surrounding whitespace is ignored.
 * @param trustedKeys - Defaults to {@link TRUSTED_DIRECTORY_KEYS}.
 */
export async function verifyDirectorySignature(
  bytes: Uint8Array,
  signature: string,
  trustedKeys: readonly TrustedDirectoryKey[] = TRUSTED_DIRECTORY_KEYS,
): Promise<boolean> {
  return (await checkDirectorySignature(bytes, signature, trustedKeys)).ok;
}
