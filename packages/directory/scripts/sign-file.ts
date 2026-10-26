// `pnpm directory:sign <file> [<file> ...]`: writes `<file>.sig`, a detached
// Ed25519 signature over the exact bytes of each file, base64url without
// padding (docs/SPEC.md section 3.1). @posterna/core verifies these with
// verifyDirectorySignature().
//
// The private key is an Ed25519 JWK (with "d") in the environment variable
// POSTERNA_DIRECTORY_SIGNING_KEY. It is never printed or written anywhere.

import { createPrivateKey, createPublicKey, type KeyObject, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const SIGNING_KEY_ENV = "POSTERNA_DIRECTORY_SIGNING_KEY";

/** Reads an Ed25519 private JWK. Throws without echoing any key material. */
export function privateKeyFromJwk(text: string | undefined): KeyObject {
  if (!text) throw new Error(`${SIGNING_KEY_ENV} is not set.`);
  let jwk: Record<string, unknown>;
  try {
    jwk = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${SIGNING_KEY_ENV} is not valid JSON.`);
  }
  if (
    jwk.kty !== "OKP" ||
    jwk.crv !== "Ed25519" ||
    typeof jwk.d !== "string" ||
    typeof jwk.x !== "string"
  ) {
    throw new Error(
      `${SIGNING_KEY_ENV} must be an Ed25519 private JWK (kty OKP, crv Ed25519, x and d).`,
    );
  }
  try {
    return createPrivateKey({
      key: { kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d },
      format: "jwk",
    });
  } catch {
    throw new Error(`${SIGNING_KEY_ENV} could not be read as an Ed25519 private key.`);
  }
}

/** Signs bytes with Ed25519 and returns the signature as unpadded base64url. */
export function signBytes(bytes: Uint8Array, privateKey: KeyObject): string {
  const signature = sign(null, bytes, privateKey);
  // Check against the public half before anything is written.
  if (!verify(null, bytes, createPublicKey(privateKey), signature)) {
    throw new Error("The signature did not verify with the matching public key.");
  }
  return signature.toString("base64url");
}

function main(files: string[]): void {
  if (files.length === 0) {
    console.error("Usage: pnpm directory:sign <file> [<file> ...]");
    process.exitCode = 1;
    return;
  }
  const key = privateKeyFromJwk(process.env[SIGNING_KEY_ENV]);
  for (const file of files) {
    writeFileSync(`${file}.sig`, signBytes(readFileSync(file), key));
    console.log(`Signed ${file} -> ${file}.sig`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
