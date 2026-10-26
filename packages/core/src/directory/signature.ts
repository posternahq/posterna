/**
 * Detached signatures for directory.json and keys.json (docs/SPEC.md section
 * 3.1): Ed25519 over the exact file bytes, encoded as base64url without
 * padding, published next to the file with a `.sig` suffix.
 *
 * Verification uses the platform's Web Crypto API, so it runs in Node and in
 * edge runtimes. Cryptography is never implemented here by hand.
 */

/** A trusted Posterna directory signing key: an Ed25519 public key as a JWK. */
export interface TrustedDirectoryKey {
  /** A label for logs and rotation, for example `2026-11`. */
  kid: string;
  jwk: { kty: "OKP"; crv: "Ed25519"; x: string };
}

/**
 * Public keys that may sign directory.json and keys.json.
 *
 * TODO: add Posterna's production directory signing public key(s) here before
 * the first release, together with the key rotation plan. While this list is
 * empty, no downloaded directory file can verify, so core must keep using the
 * snapshot bundled with the package.
 */
export const TRUSTED_DIRECTORY_KEYS: readonly TrustedDirectoryKey[] = [];

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

/**
 * Checks a detached Ed25519 signature over the exact bytes of a directory file.
 *
 * Returns true only when at least one of `trustedKeys` verifies the signature.
 * Never throws: malformed signatures, malformed keys and crypto errors all
 * return false, so the caller rejects the file and keeps its last good copy.
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
  try {
    const sig = decodeBase64Url(signature.trim());
    if (!sig || sig.length !== ED25519_SIGNATURE_BYTES) return false;
    const data = new Uint8Array(bytes);
    const sigBytes = new Uint8Array(sig);

    for (const trusted of trustedKeys) {
      const { kty, crv, x } = trusted.jwk;
      if (kty !== "OKP" || crv !== "Ed25519") continue;
      if (decodeBase64Url(x)?.length !== ED25519_PUBLIC_KEY_BYTES) continue;
      try {
        const key = await crypto.subtle.importKey(
          "jwk",
          { kty, crv, x },
          { name: "Ed25519" },
          false,
          ["verify"],
        );
        if (await crypto.subtle.verify({ name: "Ed25519" }, key, sigBytes, data)) return true;
      } catch {
        // A key this runtime cannot import never verifies. Try the next one.
      }
    }
    return false;
  } catch {
    return false;
  }
}
