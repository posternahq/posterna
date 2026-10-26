import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createVerifier } from "../verifier/verifier";
import { DirectoryStore, type StoreHooks } from "./store";
import type { DirectoryFile } from "./types";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const fixture = (path: string) =>
  JSON.parse(readFileSync(join(REPO, "conformance", "fixtures", path), "utf8"));
const signerJwk = fixture("keys/directory-signer.json").jwk as {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  d: string;
};
const trustedKeys = [
  { kid: "test", jwk: { kty: "OKP" as const, crv: "Ed25519" as const, x: signerJwk.x } },
];
const BASE = "https://directory.test/v1/";

/** Signs file bytes the way scripts/sign-file.ts does, with the throwaway fixture key. */
function signBody(body: string): string {
  const key = createPrivateKey({ key: signerJwk, format: "jwk" });
  return sign(null, Buffer.from(body), key).toString("base64url");
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
const keys = fixture("keys.json");

describe("DirectoryStore refresh", () => {
  it("swaps in a refreshed directory whose signature verifies", async () => {
    const updated = JSON.stringify({ ...directory, version: "2026-10-27" });
    const { fetcher } = server({
      "directory.json": updated,
      "directory.json.sig": signBody(updated),
    });
    const store = new DirectoryStore(
      { snapshot: () => ({ directory, keys }), baseUrl: BASE, trustedKeys, fetch: fetcher },
      hooks({ now: 0 }),
    );
    await store.ready;
    expect(store.index?.directoryVersion).toBe("2026-10-26");
    expect(await store.refreshDirectory()).toBe(true);
    expect(store.index?.directoryVersion).toBe("2026-10-27");
    store.close();
  });

  it("keeps the last good copy when the signature, the body or the network fails", async () => {
    const tampered = JSON.stringify({ ...directory, version: "2026-10-28" });
    const { fetcher } = server({
      "directory.json": tampered,
      "directory.json.sig": signBody(JSON.stringify(directory)),
      "keys.json": "{not json",
      "keys.json.sig": signBody("{not json"),
    });
    const store = new DirectoryStore(
      { snapshot: () => ({ directory, keys }), baseUrl: BASE, trustedKeys, fetch: fetcher },
      hooks({ now: 0 }),
    );
    await store.ready;
    expect(await store.refreshDirectory()).toBe(false);
    expect(await store.refreshKeys()).toBe(false);
    expect(store.index?.directoryVersion).toBe("2026-10-26");
    expect(store.errors).toBe(2);
    store.close();
  });

  it("allows an early keys refresh at most once per 10 minutes", async () => {
    const clock = { now: 1_000_000 };
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
