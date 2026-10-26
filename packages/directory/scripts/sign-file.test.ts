import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyDirectorySignature } from "../../core/src/directory/signature";
import { privateKeyFromJwk, signBytes } from "./sign-file";

/** A throwaway Ed25519 key, generated for this test run only. */
function throwawayKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  const pub = publicKey.export({ format: "jwk" });
  return {
    privateJwk: JSON.stringify(jwk),
    trusted: { kid: "test", jwk: { kty: "OKP" as const, crv: "Ed25519" as const, x: pub.x ?? "" } },
  };
}

describe("sign-file", () => {
  it("writes signatures that @posterna/core verifies", async () => {
    const { privateJwk, trusted } = throwawayKey();
    const bytes = new TextEncoder().encode('{"schema":1}\n');
    const signature = signBytes(bytes, privateKeyFromJwk(privateJwk));
    expect(signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(await verifyDirectorySignature(bytes, signature, [trusted])).toBe(true);
    expect(
      await verifyDirectorySignature(new TextEncoder().encode("{}"), signature, [trusted]),
    ).toBe(false);
  });

  it("rejects keys that are missing, malformed or not Ed25519, without echoing them", () => {
    const secret = "do-not-print-this-value";
    expect(() => privateKeyFromJwk(undefined)).toThrow(/is not set/);
    expect(() => privateKeyFromJwk(`{"kty":"OKP","crv":"Ed25519","x":"${secret}"`)).toThrow(
      /not valid JSON/,
    );
    expect(() => privateKeyFromJwk(`{"kty":"OKP","crv":"Ed25519","x":"${secret}"}`)).toThrow(
      /must be an Ed25519 private JWK/,
    );
    try {
      privateKeyFromJwk(`{"kty":"OKP","crv":"Ed25519","x":"${secret}","d":"${secret}"}`);
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });
});
