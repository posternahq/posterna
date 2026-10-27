import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createVerifier } from "../verifier/verifier";
import {
  type DirectoryKeyRole,
  directoryKeyThumbprint,
  type TrustedDirectoryKey,
} from "./signature";
import { DirectoryStore, type StoreHooks } from "./store";
import type { DirectoryFile, KeysFile } from "./types";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const fixture = (path: string) =>
  JSON.parse(readFileSync(join(REPO, "conformance", "fixtures", path), "utf8"));
const BASE = "https://directory.test/v1/";

/** A throwaway signing key, generated fresh for each test run. */
async function throwawayKey(generation: number, role: DirectoryKeyRole = "primary") {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = { kty: "OKP", crv: "Ed25519", x: publicKey.export({ format: "jwk" }).x } as const;
  const trusted: TrustedDirectoryKey = {
    kid: await directoryKeyThumbprint(jwk),
    role,
    generation,
    added: "2026-10-26",
    jwk: { ...jwk, x: jwk.x as string },
  };
  /** Signs file bytes the way scripts/sign-file.ts does. */
  const signBody = (body: string) =>
    sign(null, Buffer.from(body), privateKey).toString("base64url");
  return { trusted, signBody };
}

function hooks(clock: { now: number }): StoreHooks {
  return {
    now: () => clock.now,
    random: () => 0.5,
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
  };
}

function server(files: Record<string, string>) {
  const calls: string[] = [];
  const fetcher = (async (input: string | URL) => {
    const name = String(input).slice(BASE.length);
    calls.push(name);
    const body = files[name];
    return body === undefined ? new Response("", { status: 404 }) : new Response(body);
  }) as typeof fetch;
  return { calls, fetcher };
}

const directory = fixture("directory.json") as DirectoryFile;
const keys = fixture("keys.json") as KeysFile;

/** directory.json with a given version, signed by `key`. */
function signedDirectory(key: { signBody: (body: string) => string }, version: string) {
  const body = JSON.stringify({ ...directory, version });
  return { "directory.json": body, "directory.json.sig": key.signBody(body) };
}

function signedKeys(key: { signBody: (body: string) => string }, version: string) {
  const body = JSON.stringify({ ...keys, version });
  return { "keys.json": body, "keys.json.sig": key.signBody(body) };
}

/** A store over the fixtures whose server answers from `files`, which tests may change. */
async function storeWith(
  trustedKeys: readonly TrustedDirectoryKey[],
  files: Record<string, string>,
) {
  const { calls, fetcher } = server(files);
  const store = new DirectoryStore(
    { snapshot: () => ({ directory, keys }), baseUrl: BASE, trustedKeys, fetch: fetcher },
    hooks({ now: 0 }),
  );
  await store.ready;
  return { store, calls };
}

describe("DirectoryStore refresh", () => {
  it("accepts a file signed by a generation 1 key", async () => {
    const gen1 = await throwawayKey(1);
    const gen2 = await throwawayKey(2, "backup");
    const { store } = await storeWith([gen1.trusted, gen2.trusted], {
      ...signedDirectory(gen1, "2026-10-27"),
      ...signedKeys(gen1, "2026-10-27T01"),
    });
    expect(store.index?.directoryVersion).toBe("2026-10-26");
    expect(store.minGeneration).toBe(1);
    expect(await store.refreshDirectory()).toBe(true);
    expect(await store.refreshKeys()).toBe(true);
    expect(store.index?.directoryVersion).toBe("2026-10-27");
    expect(store.index?.keysVersion).toBe("2026-10-27T01");
    expect(store.minGeneration).toBe(1);
    expect(store.errors).toBe(0);
    store.close();
  });

  it("accepts a file signed by a generation 2 key and ratchets to generation 2", async () => {
    const gen1 = await throwawayKey(1);
    const gen2 = await throwawayKey(2, "backup");
    const list = [gen1.trusted, gen2.trusted];
    const files: Record<string, string> = signedDirectory(gen2, "2026-10-27");
    const { store } = await storeWith(list, files);
    expect(await store.refreshDirectory()).toBe(true);
    expect(store.index?.directoryVersion).toBe("2026-10-27");
    expect(store.minGeneration).toBe(2);

    // From now on this process rejects files signed only by generation 1,
    // even with a newer version, and keeps the generation 2 copy.
    Object.assign(files, signedDirectory(gen1, "2026-10-28"), signedKeys(gen1, "2026-10-28T00"));
    expect(await store.refreshDirectory()).toBe(false);
    expect(await store.refreshKeys()).toBe(false);
    expect(store.index?.directoryVersion).toBe("2026-10-27");
    expect(store.index?.keysVersion).toBe("2026-10-26T12");
    expect(store.refreshFailures).toEqual({ signature_retired: 2 });
    expect(store.lastError).toContain("signature_retired");

    // Another store in the same process with the same trusted list starts ratcheted.
    const { store: sibling } = await storeWith(list, files);
    expect(sibling.minGeneration).toBe(2);
    expect(await sibling.refreshDirectory()).toBe(false);
    // A store with a different list keeps its own ratchet.
    const { store: other } = await storeWith([gen1.trusted], files);
    expect(other.minGeneration).toBe(1);
    expect(await other.refreshDirectory()).toBe(true);
    for (const each of [store, sibling, other]) each.close();
  });

  it("rejects tampered bytes and a valid signature from a key not in the list", async () => {
    const gen1 = await throwawayKey(1);
    const stranger = await throwawayKey(1);
    const tampered = JSON.stringify({ ...directory, version: "2026-10-28" });
    const files: Record<string, string> = {
      "directory.json": tampered,
      "directory.json.sig": gen1.signBody(JSON.stringify({ ...directory, version: "2026-10-27" })),
      ...signedKeys(stranger, "2026-10-27T01"),
    };
    const { store } = await storeWith([gen1.trusted], files);
    expect(await store.refreshDirectory()).toBe(false);
    expect(await store.refreshKeys()).toBe(false);
    expect(store.refreshFailures).toEqual({ signature_untrusted: 2 });
    expect(store.index?.directoryVersion).toBe("2026-10-26");
    expect(store.index?.keysVersion).toBe("2026-10-26T12");
    expect(store.errors).toBe(2);
    store.close();
  });

  it("rejects an older version than the loaded copy (anti-rollback)", async () => {
    const gen1 = await throwawayKey(1);
    const files: Record<string, string> = {
      ...signedDirectory(gen1, "2026-10-25"),
      ...signedKeys(gen1, "2026-10-26T11"),
    };
    const { store } = await storeWith([gen1.trusted], files);
    expect(await store.refreshDirectory()).toBe(false);
    expect(await store.refreshKeys()).toBe(false);
    expect(store.refreshFailures).toEqual({ version_rollback: 2 });
    expect(store.lastError).toContain("2026-10-26T11 is older than the loaded 2026-10-26T12");
    expect(store.index?.directoryVersion).toBe("2026-10-26");
    expect(store.index?.keysVersion).toBe("2026-10-26T12");

    // The same version again is not a rollback.
    Object.assign(files, signedDirectory(gen1, "2026-10-26"), signedKeys(gen1, "2026-10-26T12"));
    expect(await store.refreshDirectory()).toBe(true);
    expect(await store.refreshKeys()).toBe(true);
    store.close();
  });

  it("lets a higher generation replace a copy whatever its version", async () => {
    // A leaked generation 1 key signs a far-future version. The switch to
    // generation 2 must still get through.
    const gen1 = await throwawayKey(1);
    const gen2 = await throwawayKey(2, "backup");
    const files: Record<string, string> = signedDirectory(gen1, "2099-12-31");
    const { store } = await storeWith([gen1.trusted, gen2.trusted], files);
    expect(await store.refreshDirectory()).toBe(true);
    expect(store.index?.directoryVersion).toBe("2099-12-31");
    Object.assign(files, signedDirectory(gen2, "2026-11-02"));
    expect(await store.refreshDirectory()).toBe(true);
    expect(store.index?.directoryVersion).toBe("2026-11-02");
    expect(store.minGeneration).toBe(2);
    store.close();
  });

  it("keeps the last good copy, without throwing, for every other kind of failure", async () => {
    const gen1 = await throwawayKey(1);
    const malformedVersion = JSON.stringify({ ...directory, version: "yesterday" });
    const files: Record<string, string> = {
      "directory.json": malformedVersion,
      "directory.json.sig": gen1.signBody(malformedVersion),
      "keys.json": "{not json",
      "keys.json.sig": gen1.signBody("{not json"),
    };
    const { store } = await storeWith([gen1.trusted], files);
    expect(await store.refreshDirectory()).toBe(false);
    expect(await store.refreshKeys()).toBe(false);
    files["directory.json.sig"] = "not a signature";
    expect(await store.refreshDirectory()).toBe(false);
    delete files["keys.json.sig"];
    expect(await store.refreshKeys()).toBe(false);
    expect(store.refreshFailures).toEqual({
      invalid_file: 2,
      signature_malformed: 1,
      download_failed: 1,
    });
    expect(store.errors).toBe(4);
    expect(store.index?.directoryVersion).toBe("2026-10-26");
    expect(store.index?.keysVersion).toBe("2026-10-26T12");
    store.close();
  });

  it("allows an early keys refresh at most once per 10 minutes", async () => {
    const clock = { now: 1_000_000 };
    const trustedKeys = [(await throwawayKey(1)).trusted];
    const { calls, fetcher } = server({});
    const store = new DirectoryStore(
      { snapshot: () => ({ directory, keys }), baseUrl: BASE, trustedKeys, fetch: fetcher },
      hooks(clock),
    );
    await store.ready;
    expect(store.requestKeysRefresh()).toBe(true);
    clock.now += 9 * 60 * 1000;
    expect(store.requestKeysRefresh()).toBe(false);
    clock.now += 2 * 60 * 1000;
    expect(store.requestKeysRefresh()).toBe(true);
    await store.settled();
    expect(calls.filter((name) => name === "keys.json")).toHaveLength(2);
    store.close();
  });

  it("never fetches when no trusted keys are configured", async () => {
    const { calls, fetcher } = server({});
    const store = new DirectoryStore(
      { snapshot: () => ({ directory, keys }), baseUrl: BASE, trustedKeys: [], fetch: fetcher },
      hooks({ now: 0 }),
    );
    await store.ready;
    expect(store.requestKeysRefresh()).toBe(false);
    expect(store.refreshEnabled).toBe(false);
    expect(calls).toEqual([]);
    store.close();
  });
});

describe("bundled snapshot", () => {
  it("loads the directory and keys shipped with @posterna/directory", async () => {
    const shipped = JSON.parse(
      readFileSync(join(REPO, "packages", "directory", "data", "directory.json"), "utf8"),
    );
    const verifier = createVerifier({ dns: null, directory: { refresh: false } });
    await verifier.settled();
    const state = verifier.state();
    expect(state.ready).toBe(true);
    expect(state.directoryVersion).toBe(shipped.version);
    expect(state.errors).toBe(0);
    verifier.close();
  });
});
