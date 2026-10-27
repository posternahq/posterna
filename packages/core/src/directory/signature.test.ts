import type { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  decodeBase64Url,
  TRUSTED_DIRECTORY_KEYS,
  type TrustedDirectoryKey,
  verifyDirectorySignature,
} from "./signature";

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A throwaway key pair, generated fresh for each test run. */
async function throwawayKey() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as webcrypto.CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const trusted: TrustedDirectoryKey = {
    kid: "test",
    jwk: { kty: "OKP", crv: "Ed25519", x: publicJwk.x ?? "" },
  };
  const sign = async (bytes: Uint8Array) =>
    toBase64Url(
      new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, bytes)),
    );
  return { trusted, sign };
}

const file = new TextEncoder().encode('{"schema":1,"operators":[]}\n');

describe("verifyDirectorySignature", () => {
  it("accepts a valid signature from a trusted key", async () => {
    const { trusted, sign } = await throwawayKey();
    const signature = await sign(file);
    expect(await verifyDirectorySignature(file, signature, [trusted])).toBe(true);
    expect(await verifyDirectorySignature(file, `${signature}\n`, [trusted])).toBe(true);
  });

  it("rejects a file changed after signing", async () => {
    const { trusted, sign } = await throwawayKey();
    const signature = await sign(file);
    const changed = new TextEncoder().encode('{"schema":1,"operators":[] }\n');
    expect(await verifyDirectorySignature(changed, signature, [trusted])).toBe(false);
  });

  it("rejects a signature from a key that is not trusted", async () => {
    const signer = await throwawayKey();
    const other = await throwawayKey();
    const signature = await signer.sign(file);
    expect(await verifyDirectorySignature(file, signature, [other.trusted])).toBe(false);
    expect(await verifyDirectorySignature(file, signature, [other.trusted, signer.trusted])).toBe(
      true,
    );
  });

  it("trusts the embedded production key, and only that by default", async () => {
    // keys.json and its .sig as the Posterna cloud published them on 26 October 2026.
    const here = dirname(fileURLToPath(import.meta.url));
    const release = join(here, "..", "..", "test", "fixtures", "production-release");
    const published = new Uint8Array(readFileSync(join(release, "keys.json")));
    const publishedSignature = readFileSync(join(release, "keys.json.sig"), "utf8");
    expect(TRUSTED_DIRECTORY_KEYS.map((key) => key.kid)).toEqual(["2026-10"]);
    expect(await verifyDirectorySignature(published, publishedSignature)).toBe(true);

    const tampered = published.slice();
    tampered[20] = (tampered[20] ?? 0) ^ 1;
    expect(await verifyDirectorySignature(tampered, publishedSignature)).toBe(false);
    const { sign } = await throwawayKey();
    expect(await verifyDirectorySignature(file, await sign(file))).toBe(false);
  });

  it("returns false instead of throwing on malformed input", async () => {
    const { trusted, sign } = await throwawayKey();
    const signature = await sign(file);
    const badKey: TrustedDirectoryKey = {
      kid: "bad",
      jwk: { kty: "OKP", crv: "Ed25519", x: "not-a-key" },
    };
    expect(await verifyDirectorySignature(file, "", [trusted])).toBe(false);
    expect(await verifyDirectorySignature(file, "!!!", [trusted])).toBe(false);
    expect(await verifyDirectorySignature(file, signature.slice(0, 40), [trusted])).toBe(false);
    expect(await verifyDirectorySignature(file, `${signature}==`, [trusted])).toBe(false);
    expect(await verifyDirectorySignature(file, signature, [badKey])).toBe(false);
  });
});

describe("decodeBase64Url", () => {
  it("decodes unpadded base64url and rejects other alphabets", () => {
    expect(decodeBase64Url("_-8")).toEqual(new Uint8Array([255, 239]));
    expect(decodeBase64Url("aGk")).toEqual(new TextEncoder().encode("hi"));
    expect(decodeBase64Url("aGk=")).toBeUndefined();
    expect(decodeBase64Url("a+/b")).toBeUndefined();
    expect(decodeBase64Url("abcde")).toBeUndefined();
  });
});
