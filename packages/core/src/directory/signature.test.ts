import { createHash, type webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkDirectorySignature,
  type DirectoryKeyRole,
  decodeBase64Url,
  directoryKeyThumbprint,
  TRUSTED_DIRECTORY_KEYS,
  type TrustedDirectoryKey,
  verifyDirectorySignature,
} from "./signature";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A throwaway key pair, generated fresh for each test run. */
async function throwawayKey(generation = 1, role: DirectoryKeyRole = "primary") {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as webcrypto.CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const jwk = { kty: "OKP", crv: "Ed25519", x: publicJwk.x ?? "" } as const;
  const trusted: TrustedDirectoryKey = {
    kid: await directoryKeyThumbprint(jwk),
    role,
    generation,
    added: "2026-10-26",
    jwk,
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

  it("returns false instead of throwing on malformed input", async () => {
    const { trusted, sign } = await throwawayKey();
    const signature = await sign(file);
    const badKey: TrustedDirectoryKey = {
      ...trusted,
      jwk: { kty: "OKP", crv: "Ed25519", x: "not-a-key" },
    };
    expect(await verifyDirectorySignature(file, "", [trusted])).toBe(false);
    expect(await verifyDirectorySignature(file, "!!!", [trusted])).toBe(false);
    expect(await verifyDirectorySignature(file, signature.slice(0, 40), [trusted])).toBe(false);
    expect(await verifyDirectorySignature(file, `${signature}==`, [trusted])).toBe(false);
    expect(await verifyDirectorySignature(file, signature, [badKey])).toBe(false);
    expect(await verifyDirectorySignature(file, signature, [{ ...trusted, generation: 0 }])).toBe(
      false,
    );
  });
});

describe("checkDirectorySignature", () => {
  it("reports the generation of the key that verified", async () => {
    const gen1 = await throwawayKey(1);
    const gen2 = await throwawayKey(2, "backup");
    const list = [gen1.trusted, gen2.trusted];
    expect(await checkDirectorySignature(file, await gen1.sign(file), list)).toEqual({
      ok: true,
      kid: gen1.trusted.kid,
      generation: 1,
    });
    expect(await checkDirectorySignature(file, await gen2.sign(file), list, 2)).toEqual({
      ok: true,
      kid: gen2.trusted.kid,
      generation: 2,
    });
  });

  it("names the reason for each rejection", async () => {
    const gen1 = await throwawayKey(1);
    const gen2 = await throwawayKey(2, "backup");
    const stranger = await throwawayKey(3);
    const list = [gen1.trusted, gen2.trusted];
    expect(await checkDirectorySignature(file, await gen1.sign(file), list, 2)).toEqual({
      ok: false,
      reason: "signature_retired",
    });
    expect(await checkDirectorySignature(file, await stranger.sign(file), list)).toEqual({
      ok: false,
      reason: "signature_untrusted",
    });
    expect(await checkDirectorySignature(file, "AAAA", list)).toEqual({
      ok: false,
      reason: "signature_malformed",
    });
  });
});

describe("TRUSTED_DIRECTORY_KEYS", () => {
  it("gives every key its RFC 7638 thumbprint as kid", async () => {
    for (const key of TRUSTED_DIRECTORY_KEYS) {
      expect(await directoryKeyThumbprint(key.jwk)).toBe(key.kid);
      // The same thumbprint computed independently from the RFC 7638 canonical form.
      const canonical = JSON.stringify({ crv: key.jwk.crv, kty: key.jwk.kty, x: key.jwk.x });
      expect(createHash("sha256").update(canonical).digest("base64url")).toBe(key.kid);
    }
  });

  it("holds public Ed25519 keys only, with no member besides kty, crv and x", () => {
    for (const key of TRUSTED_DIRECTORY_KEYS) {
      expect(Object.keys(key.jwk).sort()).toEqual(["crv", "kty", "x"]);
      expect(key.jwk.kty).toBe("OKP");
      expect(key.jwk.crv).toBe("Ed25519");
      expect(decodeBase64Url(key.jwk.x)).toHaveLength(32);
      expect(Object.keys(key).sort()).toEqual(["added", "generation", "jwk", "kid", "role"]);
    }
  });

  it("numbers generations uniquely, with one primary", () => {
    const generations = TRUSTED_DIRECTORY_KEYS.map((key) => key.generation);
    expect(new Set(generations).size).toBe(generations.length);
    for (const key of TRUSTED_DIRECTORY_KEYS) {
      expect(Number.isSafeInteger(key.generation) && key.generation > 0).toBe(true);
      expect(["primary", "backup"]).toContain(key.role);
      expect(key.added).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(TRUSTED_DIRECTORY_KEYS.filter((key) => key.role === "primary")).toHaveLength(1);
  });

  it("keeps every backup above the primary, so switching to it ratchets installs away", () => {
    const primary = TRUSTED_DIRECTORY_KEYS.find((key) => key.role === "primary");
    const backups = TRUSTED_DIRECTORY_KEYS.filter((key) => key.role === "backup");
    expect(backups.length).toBeGreaterThan(0);
    for (const backup of backups)
      expect(backup.generation).toBeGreaterThan(primary?.generation ?? 0);
  });

  it("matches the table in docs/KEYS.md", () => {
    const doc = readFileSync(join(REPO, "docs", "KEYS.md"), "utf8");
    const rows = [
      ...doc.matchAll(/^\| `([A-Za-z0-9_-]{43})` \| (\w+) \| (\d+) \| (\d{4}-\d{2}-\d{2}) \|$/gm),
    ];
    expect(
      rows.map(([, kid, role, generation, added]) => ({
        kid,
        role,
        generation: Number(generation),
        added,
      })),
    ).toEqual(
      TRUSTED_DIRECTORY_KEYS.map(({ kid, role, generation, added }) => ({
        kid,
        role,
        generation,
        added,
      })),
    );
  });

  it("verifies a production release under the primary, and nothing else by default", async () => {
    // keys.json and its .sig as the Posterna cloud published them on 26 October 2026.
    const release = join(REPO, "packages", "core", "test", "fixtures", "production-release");
    const published = new Uint8Array(readFileSync(join(release, "keys.json")));
    const publishedSignature = readFileSync(join(release, "keys.json.sig"), "utf8");
    const primary = TRUSTED_DIRECTORY_KEYS.find((key) => key.role === "primary");
    expect(await checkDirectorySignature(published, publishedSignature)).toEqual({
      ok: true,
      kid: primary?.kid,
      generation: primary?.generation,
    });

    const tampered = published.slice();
    tampered[20] = (tampered[20] ?? 0) ^ 1;
    expect(await verifyDirectorySignature(tampered, publishedSignature)).toBe(false);
    const { sign } = await throwawayKey();
    expect(await verifyDirectorySignature(file, await sign(file))).toBe(false);
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
