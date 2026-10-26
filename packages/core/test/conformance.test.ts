// Runs every vector in conformance/ against @posterna/core. Ports to other
// languages read the same files; see conformance/README.md for the format.

import type { webcrypto } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { type RequestDescriptor, verifySignature } from "http-message-sig";
import { describe, expect, it } from "vitest";
import { jwkToKeyID, verify as webBotAuthVerify } from "web-bot-auth";
import { verifierFromJWK } from "web-bot-auth/crypto";
import { buildIndex } from "../src/directory/index-builder";
import type { DirectoryFile, KeysFile } from "../src/directory/types";
import { stripInboundHeaders, verdictHeaders } from "../src/verifier/headers";
import type { DnsResolver } from "../src/verifier/rdns";
import { normalizeRequest } from "../src/verifier/request";
import type { SignatureLibrary } from "../src/verifier/signature-path";
import { createVerifier } from "../src/verifier/verifier";

const CONFORMANCE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "conformance");
const BASE_URL = "https://directory.fixtures.example/v1/";
const read = (path: string) => JSON.parse(readFileSync(join(CONFORMANCE, path), "utf8"));

type Pair = [string, string];
interface RequestSpec {
  method: string;
  scheme: "http" | "https";
  path: string;
  remote_address: string | null;
  headers: Pair[];
}
interface Expected {
  verdict: string;
  operator?: string | null;
  agent?: string | null;
  purpose?: string | null;
  method?: string;
  error?: boolean;
  stripped?: string[];
  client?: { address: string | null };
  verdict_headers?: Record<string, string>;
}
interface Step {
  action?: "refresh";
  settle_before?: boolean;
  repeat?: number;
  request?: RequestSpec;
  expected?: Expected;
}
interface VerifyVector {
  id: string;
  description: string;
  type: "verify";
  now: string;
  config?: Record<string, unknown>;
  dns?: { reverse: Record<string, string[]>; forward: Record<string, string[]> } | null;
  inject?: {
    snapshot?: "missing" | "malformed";
    dns?: "timeout" | "error";
    clock?: "invalid";
    signature_library?: "throws";
  };
  refresh?: { enabled: boolean; responses: Record<string, { status: number; body: string }> };
  steps: Step[];
  expected_state?: {
    proxySuspect?: boolean;
    keys_refresh_requested?: boolean;
    fetches?: number;
    errors_at_least?: number;
  };
}
interface Rfc9421Vector {
  id: string;
  description: string;
  type: "rfc9421";
  profile: "rfc9421" | "web-bot-auth";
  public_key: webcrypto.JsonWebKey;
  keyid: string;
  label: string;
  now: number;
  request: { method: string; target_uri: string; headers: Pair[] };
  expected: { valid: boolean };
}
interface KeyDirectoryVector {
  id: string;
  description: string;
  type: "key_directory";
  snapshot: string;
  expected: {
    key_count: number;
    kid_convention: string;
    keys: { kid: string | null; thumbprint: string }[];
  };
}
type Vector = VerifyVector | Rfc9421Vector | KeyDirectoryVector;

function listJson(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listJson(path);
    return name.endsWith(".json") ? [path] : [];
  });
}

const vectors: Vector[] = listJson(join(CONFORMANCE, "vectors"))
  .sort()
  .map((path) => {
    const vector = JSON.parse(readFileSync(path, "utf8")) as Vector;
    expect(`${relative(join(CONFORMANCE, "vectors"), path)}`).toBe(`${vector.id}.json`);
    return vector;
  });
const fixtures = {
  directory: read("fixtures/directory.json") as DirectoryFile,
  keys: read("fixtures/keys.json") as KeysFile,
};
const directorySigner = (
  read("fixtures/directory-signer.json") as { jwk: { kty: "OKP"; crv: "Ed25519"; x: string } }
).jwk;

function fakeDns(vector: VerifyVector): DnsResolver | null {
  if (vector.dns === null) return null;
  const answers = vector.dns ?? { reverse: {}, forward: {} };
  const failure = vector.inject?.dns;
  return {
    reverse: async (ip) => {
      if (failure === "timeout") return new Promise<string[]>(() => {});
      if (failure === "error")
        throw Object.assign(new Error("queryPtr ESERVFAIL"), { code: "ESERVFAIL" });
      return answers.reverse[ip] ?? [];
    },
    forward: async (name) => answers.forward[name] ?? [],
  };
}

const THROWING_LIBRARY: SignatureLibrary = {
  verify: () => {
    throw new TypeError("simulated failure inside the signature library");
  },
  verifySignature: () => {
    throw new TypeError("simulated failure inside the signature library");
  },
};

function buildRequest(spec: RequestSpec, api: "fetch" | "node"): Request | IncomingMessage {
  const host = spec.headers.find(([name]) => name.toLowerCase() === "host")?.[1] ?? "localhost";
  if (api === "fetch") {
    return new Request(`${spec.scheme}://${host}${spec.path}`, {
      method: spec.method,
      headers: spec.headers,
    });
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of spec.headers) {
    const key = name.toLowerCase();
    headers[key] = headers[key] ? `${headers[key]}, ${value}` : value;
  }
  return {
    method: spec.method,
    url: spec.path,
    rawHeaders: spec.headers.flat(),
    headers,
    socket: { remoteAddress: spec.remote_address ?? undefined, encrypted: spec.scheme === "https" },
  } as unknown as IncomingMessage;
}

async function runVerify(vector: VerifyVector, api: "fetch" | "node"): Promise<void> {
  const fetches: string[] = [];
  const fakeFetch = (async (input: string | URL) => {
    const url = String(input);
    fetches.push(url);
    const response = vector.refresh?.responses[url.slice(BASE_URL.length)];
    return new Response(response?.body ?? "", { status: response?.status ?? 404 });
  }) as typeof fetch;
  const snapshot =
    vector.inject?.snapshot === "missing"
      ? () => {
          throw new Error("ENOENT: the bundled snapshot is missing");
        }
      : vector.inject?.snapshot === "malformed"
        ? () => ({ directory: { schema: 1, operators: "not a list" }, keys: null })
        : () => fixtures;
  const refresh = Boolean(vector.refresh?.enabled);
  const verifier = createVerifier({
    ...(vector.config as object),
    now: vector.inject?.clock === "invalid" ? () => Number.NaN : () => Date.parse(vector.now),
    dns: fakeDns(vector),
    directory: {
      snapshot,
      refresh,
      baseUrl: BASE_URL,
      fetch: fakeFetch,
      trustedKeys: refresh ? [{ kid: "conformance", jwk: directorySigner }] : [],
    },
    ...(vector.inject?.signature_library === "throws"
      ? { signatureLibrary: THROWING_LIBRARY }
      : {}),
  });
  try {
    for (const [index, step] of vector.steps.entries()) {
      if (step.action === "refresh") {
        await verifier.refresh();
        continue;
      }
      if (step.settle_before) await verifier.settled();
      if (!step.request || !step.expected) continue;
      const expected = step.expected;
      for (let round = 0; round < (step.repeat ?? 1); round++) {
        const input = buildRequest(step.request, api);
        const remoteAddress = api === "fetch" ? step.request.remote_address : undefined;
        const result = await verifier.verify(input, { remoteAddress });
        const where = `${vector.id} [${api}] step ${index + 1}`;
        expect(result.verdict, where).toBe(expected.verdict);
        if (expected.operator !== undefined)
          expect(result.operator ?? null, where).toBe(expected.operator);
        if (expected.agent !== undefined) expect(result.agent ?? null, where).toBe(expected.agent);
        if (expected.purpose !== undefined)
          expect(result.purpose ?? null, where).toBe(expected.purpose);
        if (expected.method !== undefined) expect(result.method, where).toBe(expected.method);
        if (expected.error !== undefined)
          expect(Boolean(result.error), `${where}: ${result.error}`).toBe(expected.error);
        if (expected.stripped) {
          expect(
            normalizeRequest(buildRequest(step.request, api), remoteAddress).stripped,
            where,
          ).toEqual(expected.stripped);
          const copy = buildRequest(step.request, api);
          const removed = stripInboundHeaders(
            api === "fetch" ? (copy as Request).headers : (copy as IncomingMessage).headers,
          );
          expect(removed, where).toEqual(expected.stripped);
        }
        if (expected.client) {
          expect(
            verifier.resolve(buildRequest(step.request, api), { remoteAddress }).address?.text ??
              null,
            where,
          ).toBe(expected.client.address);
        }
        if (expected.verdict_headers)
          expect(verdictHeaders(result), where).toEqual(expected.verdict_headers);
      }
    }
    await verifier.settled();
    const state = verifier.state();
    const want = vector.expected_state;
    if (want?.proxySuspect !== undefined) expect(state.proxySuspect).toBe(want.proxySuspect);
    if (want?.keys_refresh_requested !== undefined) {
      expect(fetches.some((url) => url.endsWith("keys.json"))).toBe(want.keys_refresh_requested);
    }
    if (want?.fetches !== undefined) expect(fetches).toHaveLength(want.fetches);
    if (want?.errors_at_least !== undefined)
      expect(state.errors).toBeGreaterThanOrEqual(want.errors_at_least);
  } finally {
    verifier.close();
  }
}

async function runRfc9421(vector: Rfc9421Vector): Promise<boolean> {
  const imported = await verifierFromJWK(vector.public_key);
  const request: RequestDescriptor = {
    kind: "request",
    method: vector.request.method,
    targetUri: vector.request.target_uri,
    fields: vector.request.headers.map(([name, value]) => ({ name, value })),
  };
  try {
    if (vector.profile === "rfc9421") {
      await verifySignature(request, {
        label: vector.label,
        policy: {
          algorithms: ["ed25519"],
          requiredComponents: [],
          requiredParameters: [],
          now: vector.now,
        },
        resolveVerifier: () => imported,
      });
    } else {
      await webBotAuthVerify(request, {
        label: vector.label,
        maxAge: 10_000_000_000,
        now: new Date(vector.now * 1000),
        resolver: () => ({ ...imported, keyid: vector.keyid }),
      });
    }
    return true;
  } catch {
    return false;
  }
}

const base64Url = (buffer: ArrayBuffer) => Buffer.from(buffer).toString("base64url");

async function runKeyDirectory(vector: KeyDirectoryVector): Promise<void> {
  const body = read(vector.snapshot) as { keys: (webcrypto.JsonWebKey & { kid?: string })[] };
  expect(body.keys).toHaveLength(vector.expected.key_count);
  const computed = await Promise.all(
    body.keys.map(async (jwk) => ({
      kid: jwk.kid ?? null,
      thumbprint: await jwkToKeyID(
        jwk,
        (value) => crypto.subtle.digest("SHA-256", value),
        base64Url,
      ),
    })),
  );
  const sort = (keys: { kid: string | null; thumbprint: string }[]) =>
    [...keys].sort((a, b) => a.thumbprint.localeCompare(b.thumbprint));
  expect(sort(computed)).toEqual(sort(vector.expected.keys));
  const convention = computed.every((key) => key.kid === null)
    ? "none"
    : computed.every((key) => key.kid === key.thumbprint)
      ? "thumbprint"
      : "short_id";
  expect(convention).toBe(vector.expected.kid_convention);
  // Every key imports into the verifier's index without being skipped.
  const index = await buildIndex(
    {
      ...fixtures.directory,
      operators: [
        {
          ...(fixtures.directory.operators[0] as DirectoryFile["operators"][number]),
          slug: "snapshot",
        },
      ],
    },
    {
      version: "x",
      generated_at: "x",
      operators: {
        snapshot: {
          directory_url: "https://snapshot.example/.well-known/http-message-signatures-directory",
          fetched_at: null,
          status: "live",
          keys: computed.map((key, position) => ({
            jwk: body.keys[position] as never,
            thumbprint: key.thumbprint,
            kid: key.kid,
            first_seen: "x",
            last_seen: "x",
          })),
        },
      },
    },
  );
  expect(index.skippedKeys).toEqual([]);
  expect(
    index.keys
      .get("snapshot")
      ?.keys.map((key) => key.thumbprint)
      .sort(),
  ).toEqual(computed.map((key) => key.thumbprint).sort());
}

describe("conformance vectors", () => {
  it("has vectors to run", () => {
    expect(vectors.length).toBeGreaterThan(50);
  });

  for (const vector of vectors) {
    if (vector.type === "verify") {
      for (const api of ["fetch", "node"] as const) {
        it(`${vector.id} (${api})`, () => runVerify(vector, api));
      }
    } else if (vector.type === "rfc9421") {
      it(vector.id, async () => {
        expect(await runRfc9421(vector)).toBe(vector.expected.valid);
      });
    } else {
      it(vector.id, () => runKeyDirectory(vector));
    }
  }
});
