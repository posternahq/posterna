import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkPublicJwk, jwkThumbprint, kidConvention, parseKeyDirectory } from "./keys";

// RFC 7638 section 3.1. The modulus is split across lines in the RFC.
const RFC7638_KEY = {
  kty: "RSA",
  n: [
    "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAt",
    "VT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn6",
    "4tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FD",
    "W2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n9",
    "1CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINH",
    "aQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
  ].join(""),
  e: "AQAB",
  alg: "RS256",
  kid: "2011-04-29",
};
const RFC7638_THUMBPRINT = "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs";

// RFC 8037 appendix A.2 and A.3.
const RFC8037_PUBLIC = {
  kty: "OKP",
  crv: "Ed25519",
  x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
};
const RFC8037_THUMBPRINT = "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k";

describe("jwkThumbprint", () => {
  it("matches the RFC 7638 example", async () => {
    expect(await jwkThumbprint(RFC7638_KEY)).toBe(RFC7638_THUMBPRINT);
  });

  it("matches the RFC 8037 Ed25519 example, whatever the kid says", async () => {
    expect(await jwkThumbprint(RFC8037_PUBLIC)).toBe(RFC8037_THUMBPRINT);
    expect(await jwkThumbprint({ ...RFC8037_PUBLIC, kid: "operator-key-1", use: "sig" })).toBe(
      RFC8037_THUMBPRINT,
    );
  });
});

describe("checkPublicJwk", () => {
  it("keeps only public members", () => {
    const result = checkPublicJwk({ ...RFC8037_PUBLIC, kid: "a", nbf: 1, custom: "dropped" });
    expect(result).toEqual({ ok: true, jwk: { ...RFC8037_PUBLIC, kid: "a", nbf: 1 } });
  });

  it("rejects a key that publishes private material", () => {
    // A throwaway private key made here, so no private key is ever committed.
    const throwaway = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
    const result = checkPublicJwk({ ...throwaway });
    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining("private key members (d)"),
    });
  });

  it.each([
    [{ kty: "oct", k: "c2VjcmV0" }],
    [{ kty: "OKP", crv: "X25519", x: RFC8037_PUBLIC.x }],
    [{ kty: "OKP", crv: "Ed25519", x: "dG9vLXNob3J0" }],
    [{ kty: "RSA", n: "AQAB", e: "AQAB" }],
    ["not an object"],
  ])("rejects %j", (value) => {
    expect(checkPublicJwk(value).ok).toBe(false);
  });
});

describe("parseKeyDirectory", () => {
  it("parses a JWK Set, computes thumbprints and reports rejected keys", async () => {
    const body = JSON.stringify({
      keys: [RFC8037_PUBLIC, { kty: "oct", k: "c2VjcmV0" }, RFC8037_PUBLIC],
      purpose: "rag",
    });
    const parsed = await parseKeyDirectory(body);
    expect(parsed.error).toBeNull();
    expect(parsed.keys).toEqual([
      { jwk: RFC8037_PUBLIC, thumbprint: RFC8037_THUMBPRINT, kid: null },
    ]);
    expect(parsed.rejected).toHaveLength(1);
    expect(parsed.purposeField).toBe("rag");
  });

  it("reports a body that is not a key directory", async () => {
    expect((await parseKeyDirectory("<html>")).error).toMatch(/invalid JSON/);
    expect((await parseKeyDirectory('{"jwks": []}')).error).toBe('no "keys" array');
  });
});

describe("kidConvention", () => {
  const key = (kid: string | null) => ({
    jwk: RFC8037_PUBLIC,
    thumbprint: RFC8037_THUMBPRINT,
    kid,
  });
  it("tells thumbprint kids from short ids and from none", () => {
    expect(kidConvention([])).toBeNull();
    expect(kidConvention([key(null)])).toBe("none");
    expect(kidConvention([key(RFC8037_THUMBPRINT)])).toBe("thumbprint");
    expect(kidConvention([key(RFC8037_THUMBPRINT), key("k1")])).toBe("short_id");
  });
});
