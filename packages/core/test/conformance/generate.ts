// Writes the language-neutral conformance fixtures and vectors in conformance/.
//
//   pnpm conformance:generate
//
// Signed requests are produced with Cloudflare's web-bot-auth and
// http-message-sig signers and throwaway Ed25519 keys kept in
// conformance/fixtures/keys/. Expected verdicts are written here by hand from
// docs/SPEC.md; they are never computed by Posterna's verifier. Ed25519 is
// deterministic, so running this again with the same keys gives the same files.

import type { webcrypto } from "node:crypto";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  component,
  createSignature,
  type FieldOccurrence,
  type RequestDescriptor,
} from "http-message-sig";
import { jwkToKeyID, sign, type WebBotSigner } from "web-bot-auth";
import { signerFromJWK } from "web-bot-auth/crypto";
import type { DirectoryFile, KeysFile, OperatorRecord } from "../../src/directory/types";
import { parseAddress } from "../../src/ip/address";
import { PrefixMatcher } from "../../src/ip/prefix-matcher";
import { policyVectors } from "./policy-vectors";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const CONFORMANCE = join(REPO, "conformance");
const FIXTURES = join(CONFORMANCE, "fixtures");
const VECTORS = join(CONFORMANCE, "vectors");
const DIRECTORY_DATA = join(REPO, "packages", "directory", "data");
const DIRECTORY_RAW = join(REPO, "packages", "directory", "raw");
const TEMPLATES = join(REPO, "packages", "core", "templates");

const NOW_ISO = "2026-10-26T12:00:00Z";
const NOW = Date.parse(NOW_ISO) / 1000;
const FIXTURE_DATE = "2026-10-26";
const SITE = "www.site.example";

const write = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};
const base64Url = (buffer: ArrayBuffer) => Buffer.from(buffer).toString("base64url");

// ---------------------------------------------------------------- keys

interface PrivateJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  d: string;
}

function fixtureKey(name: string): PrivateJwk {
  const path = join(FIXTURES, "keys", `${name}.json`);
  if (existsSync(path)) return (JSON.parse(readFileSync(path, "utf8")) as { jwk: PrivateJwk }).jwk;
  const { privateKey } = generateKeyPairSync("ed25519");
  const exported = privateKey.export({ format: "jwk" });
  const jwk: PrivateJwk = {
    kty: "OKP",
    crv: "Ed25519",
    x: exported.x as string,
    d: exported.d as string,
  };
  write(path, {
    note: "Throwaway Ed25519 key generated for the Posterna conformance suite. Test use only.",
    jwk,
  });
  return jwk;
}

const publicJwk = (jwk: PrivateJwk) => ({ kty: "OKP" as const, crv: "Ed25519" as const, x: jwk.x });
const thumbprint = (jwk: { kty: string; crv?: string; x?: string }) =>
  jwkToKeyID(
    jwk as webcrypto.JsonWebKey,
    (value) => crypto.subtle.digest("SHA-256", value),
    base64Url,
  );

async function signer(name: string, keyid?: string): Promise<WebBotSigner> {
  const real = await signerFromJWK(fixtureKey(name));
  if (!keyid) return real;
  return { algorithm: real.algorithm, keyid, sign: (data) => real.sign(data) };
}

/** A canonical base64 nonce of 64 bytes, derived from a seed so output is stable. */
const nonce = (seed: string) => createHash("sha512").update(seed).digest("base64");

// ---------------------------------------------------------------- fixture directory

const fixtureSource = (path: string) => ({
  url: `https://fixtures.example/${path}`,
  title: "Conformance fixture",
  fetched_at: FIXTURE_DATE,
});

interface FixtureOperator {
  slug: string;
  name: string;
  coverage?: "researched" | "community";
  agent: {
    name: string;
    token: string | null;
    purpose: OperatorRecord["agents"][number]["purpose"];
  };
  directoryUrl?: string;
  signs?: boolean;
  ipList?: { id: string; prefixes: string[] };
  reverseDns?: string[];
}

function operator(spec: FixtureOperator): OperatorRecord {
  const coverage = spec.coverage ?? "researched";
  const source = fixtureSource(spec.slug);
  return {
    slug: spec.slug,
    name: spec.name,
    website: null,
    docs_url: null,
    coverage,
    note: "Synthetic conformance fixture.",
    verification: {
      signing: {
        status: spec.directoryUrl ? "live" : coverage === "community" ? "not_probed" : "none_found",
        directory_url: spec.directoryUrl ?? null,
        kid_convention: null,
        purpose_field: null,
        covers: spec.signs ? [spec.agent.name] : [],
        note: null,
        sources: [],
      },
      ip_lists: spec.ipList
        ? [
            {
              agent: spec.ipList.id,
              url: `https://fixtures.example/${spec.ipList.id}.json`,
              format: "ipranges-json",
              prefix_count: spec.ipList.prefixes.length,
              fetched_at: `${NOW_ISO}`,
              sha256: null,
              prefixes: spec.ipList.prefixes,
              note: null,
              sources: [source],
            },
          ]
        : [],
      reverse_dns: spec.reverseDns
        ? { suffixes: spec.reverseDns, forward_confirm: true, note: null, sources: [source] }
        : null,
      asn: [],
    },
    agents: [
      {
        name: spec.agent.name,
        coverage,
        user_agent_tokens: spec.agent.token ? [spec.agent.token] : [],
        aliases: [],
        purpose: spec.agent.purpose,
        purpose_quote: null,
        search_engine: false,
        robots_token: spec.agent.token,
        robots_policy: "unstated",
        robots_quote: null,
        ip_list_agent: spec.ipList?.id ?? null,
        signs: Boolean(spec.signs),
        note: null,
        sources: [source],
      },
    ],
    observed: {},
    enrollment: { status: "none" },
    identity_anchors: [],
    sources: [source],
  };
}

const directoryUrl = (host: string) =>
  `https://${host}/.well-known/http-message-signatures-directory`;

// The RFC 9421 example key (Appendix B.1.4), used by the protocol draft's test vectors.
const RFC9421_TEST_KEY = {
  kty: "OKP",
  crv: "Ed25519",
  x: "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs",
};

async function buildFixtures(): Promise<{ directory: DirectoryFile; keys: KeysFile }> {
  const real = JSON.parse(
    readFileSync(join(DIRECTORY_DATA, "directory.json"), "utf8"),
  ) as DirectoryFile;
  const frozen = ["anthropic", "google"].map((slug) => {
    const record = real.operators.find((op) => op.slug === slug);
    if (!record) throw new Error(`${slug} is missing from packages/directory/data/directory.json`);
    return record;
  });

  const directory: DirectoryFile = {
    schema: 1,
    version: FIXTURE_DATE,
    generated_at: NOW_ISO,
    license: "CC-BY-4.0",
    attribution:
      "Posterna conformance fixture. The anthropic and google records are frozen copies of the operator directory.",
    operators: [
      ...frozen,
      operator({
        slug: "example-signer",
        name: "Example Signer",
        agent: { name: "ExampleAgent", token: "ExampleAgent", purpose: "agent" },
        directoryUrl: directoryUrl("signer.example"),
        signs: true,
      }),
      operator({
        slug: "label-signer",
        name: "Label Signer",
        agent: { name: "LabelAgent", token: "LabelAgent", purpose: "agent" },
        directoryUrl: directoryUrl("labels.example"),
        signs: true,
      }),
      operator({
        slug: "nokid-signer",
        name: "No-Kid Signer",
        agent: { name: "NoKidAgent", token: "NoKidAgent", purpose: "user_fetch" },
        directoryUrl: directoryUrl("nokid.example"),
        signs: true,
      }),
      operator({
        slug: "draft-test-signer",
        name: "Draft Test Signer",
        agent: { name: "DraftAgent", token: null, purpose: "agent" },
        directoryUrl: directoryUrl("signature-agent.test"),
        signs: true,
      }),
      operator({
        slug: "ip-crawler",
        name: "IP Crawler",
        agent: { name: "ExampleBot", token: "ExampleBot", purpose: "search" },
        ipList: { id: "examplebot", prefixes: ["192.0.2.0/24", "2001:db8:10::/48"] },
      }),
      operator({
        slug: "rdns-crawler",
        name: "Reverse DNS Crawler",
        agent: { name: "ExampleRdnsBot", token: "ExampleRdnsBot", purpose: "training" },
        ipList: { id: "rdnsbot", prefixes: ["198.51.100.0/25"] },
        reverseDns: ["crawl.example"],
      }),
      operator({
        slug: "quiet-operator",
        name: "Quiet Operator",
        agent: { name: "QuietBot", token: "QuietBot", purpose: "other" },
      }),
      operator({
        slug: "community-operator",
        name: "Community Operator",
        coverage: "community",
        agent: { name: "CommunityBot", token: "CommunityBot", purpose: "training" },
      }),
    ].sort((a, b) => a.slug.localeCompare(b.slug)),
  };

  const key = async (name: string, kid: "thumbprint" | string | null) => {
    const jwk = publicJwk(fixtureKey(name));
    const print = await thumbprint(jwk);
    const resolvedKid = kid === "thumbprint" ? print : kid;
    return {
      jwk: resolvedKid ? { ...jwk, kid: resolvedKid } : jwk,
      thumbprint: print,
      kid: resolvedKid,
      first_seen: NOW_ISO,
      last_seen: NOW_ISO,
    };
  };
  const keys: KeysFile = {
    version: "2026-10-26T12",
    generated_at: NOW_ISO,
    operators: {
      "draft-test-signer": {
        directory_url: directoryUrl("signature-agent.test"),
        fetched_at: NOW_ISO,
        status: "live",
        keys: [
          {
            jwk: { ...RFC9421_TEST_KEY, kid: await thumbprint(RFC9421_TEST_KEY) },
            thumbprint: await thumbprint(RFC9421_TEST_KEY),
            kid: await thumbprint(RFC9421_TEST_KEY),
            first_seen: NOW_ISO,
            last_seen: NOW_ISO,
          },
        ],
      },
      "example-signer": {
        directory_url: directoryUrl("signer.example"),
        fetched_at: NOW_ISO,
        status: "live",
        keys: [await key("signer-a", "thumbprint"), await key("signer-b", "thumbprint")],
      },
      "label-signer": {
        directory_url: directoryUrl("labels.example"),
        fetched_at: NOW_ISO,
        status: "live",
        keys: [await key("label-k1", "k1"), await key("label-k2", "k2")],
      },
      "nokid-signer": {
        directory_url: directoryUrl("nokid.example"),
        fetched_at: NOW_ISO,
        status: "live",
        keys: [await key("nokid-1", null), await key("nokid-2", null), await key("nokid-3", null)],
      },
    },
  };
  return { directory, keys };
}

// ---------------------------------------------------------------- requests

type Pair = [string, string];

interface RequestSpec {
  method: string;
  scheme: "http" | "https";
  path: string;
  remote_address: string | null;
  headers: Pair[];
}

const BROWSER: Pair[] = [
  [
    "user-agent",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  ],
  ["accept", "text/html,application/xhtml+xml"],
  ["accept-language", "en-US,en;q=0.9"],
];
const ua = {
  exampleAgent: "Mozilla/5.0 (compatible; ExampleAgent/1.0; +https://signer.example/agent)",
  labelAgent: "Mozilla/5.0 (compatible; LabelAgent/1.0)",
  noKidAgent: "Mozilla/5.0 (compatible; NoKidAgent/1.0)",
  exampleBot: "Mozilla/5.0 (compatible; ExampleBot/2.0; +https://crawler.example/bot)",
  rdnsBot: "Mozilla/5.0 (compatible; ExampleRdnsBot/1.0)",
  googlebot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  claudebot: "Mozilla/5.0 (compatible; ClaudeBot/1.0)",
};

function request(
  headers: Pair[],
  options: Partial<Omit<RequestSpec, "headers">> = {},
): RequestSpec {
  return {
    method: options.method ?? "GET",
    scheme: options.scheme ?? "https",
    path: options.path ?? "/",
    remote_address: options.remote_address === undefined ? "203.0.113.20" : options.remote_address,
    headers,
  };
}

function descriptor(spec: RequestSpec, authority: string): RequestDescriptor {
  return {
    kind: "request",
    method: spec.method,
    targetUri: `https://${authority}${spec.path}`,
    fields: spec.headers.map(([name, value]): FieldOccurrence => ({ name, value })),
  };
}

interface SignSpec {
  key: string;
  keyid?: string;
  label?: string;
  agentKey?: string;
  created?: number;
  expires?: number;
  nonceSeed?: string | null;
  components?: Parameters<typeof component>[0][];
  noAlg?: boolean;
  /** The authority signed, when it differs from the Host header. */
  authority?: string;
}

/** Signs a request and returns its headers with Signature and Signature-Input appended. */
async function signed(base: RequestSpec, ...signatures: SignSpec[]): Promise<RequestSpec> {
  const host = base.headers.find(([name]) => name === "host")?.[1] ?? SITE;
  const results: { signature: string; signatureInput: string }[] = [];
  for (const spec of signatures) {
    const target = descriptor(base, spec.authority ?? host);
    const created = spec.created ?? NOW - 5;
    const expires = spec.expires ?? NOW + 60;
    const label = spec.label ?? "sig1";
    const nonceValue =
      spec.nonceSeed === null
        ? undefined
        : nonce(spec.nonceSeed ?? `${label}-${created}-${spec.key}`);
    const webBotSigner = await signer(spec.key, spec.keyid);
    if (spec.noAlg) {
      results.push(
        await createSignature(target, {
          label,
          components: ["@authority", component("signature-agent", { key: spec.agentKey ?? label })],
          parameters: {
            created,
            expires,
            keyid: webBotSigner.keyid,
            nonce: nonceValue,
            tag: "web-bot-auth",
          },
          signer: webBotSigner,
        }),
      );
    } else {
      results.push(
        await sign(target, {
          signer: webBotSigner,
          created: new Date(created * 1000),
          expires: new Date(expires * 1000),
          nonce: nonceValue,
          label,
          signatureAgentKey: spec.agentKey,
          additionalComponents: spec.components?.map((name) => component(name)),
        }),
      );
    }
  }
  return {
    ...base,
    headers: [
      ...base.headers,
      ["signature", results.map((result) => result.signature).join(", ")],
      ["signature-input", results.map((result) => result.signatureInput).join(", ")],
    ],
  };
}

// ---------------------------------------------------------------- vectors

interface Expected {
  verdict: string;
  /** The reason code; null when the result must carry none (verified and human). */
  reason: string | null;
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

interface Vector {
  id: string;
  description: string;
  spec: string[];
  type: "verify" | "rfc9421" | "key_directory" | "decide" | "policy_check" | "robots";
  [key: string]: unknown;
}

const vectors: Vector[] = [];
function verifyVector(
  id: string,
  description: string,
  spec: string[],
  steps: Step[],
  extra: Record<string, unknown> = {},
): void {
  vectors.push({ id, description, spec, type: "verify", now: NOW_ISO, ...extra, steps });
}

const site = (extra: Pair[] = []): Pair[] => [["host", SITE], ...extra];
const signerHeaders = (
  agent = 'sig1="https://signer.example"',
  userAgent = ua.exampleAgent,
): Pair[] =>
  site([
    ["user-agent", userAgent],
    ["signature-agent", agent],
  ]);
const verifiedSigner: Expected = {
  verdict: "verified_by_signature",
  reason: null,
  operator: "example-signer",
  agent: "ExampleAgent",
  purpose: "agent",
  method: "signature",
  error: false,
};
const failedSigner = (reason: string, method = "signature"): Expected => ({
  verdict: "claimed_failed",
  reason,
  operator: "example-signer",
  agent: "ExampleAgent",
  purpose: "agent",
  method,
  error: false,
});

async function signatureVectors(): Promise<void> {
  verifyVector(
    "signature/valid-dictionary",
    "A dictionary-form Signature-Agent naming a listed operator, signed with its current key, verifies.",
    ["4.3", "4.4"],
    [
      {
        request: await signed(request(signerHeaders()), { key: "signer-a" }),
        expected: verifiedSigner,
      },
    ],
  );
  verifyVector(
    "signature/valid-dictionary-with-type",
    "A Signature-Agent member with an explicit type=directory parameter verifies.",
    ["4.4"],
    [
      {
        request: await signed(
          request(signerHeaders('sig1="https://signer.example";type=directory')),
          {
            key: "signer-a",
          },
        ),
        expected: verifiedSigner,
      },
    ],
  );
  verifyVector(
    "signature/legacy-sf-string",
    "The legacy sf-string form of Signature-Agent (a bare string), covered whole, verifies.",
    ["4.3", "4.4"],
    [
      {
        request: await signed(request(signerHeaders('"https://signer.example"')), {
          key: "signer-a",
        }),
        expected: verifiedSigner,
      },
    ],
  );
  verifyVector(
    "signature/expired",
    "A signature that expired more than the 60 second skew ago fails.",
    ["4.4", "12"],
    [
      {
        request: await signed(request(signerHeaders()), {
          key: "signer-a",
          created: NOW - 200,
          expires: NOW - 100,
        }),
        expected: failedSigner("expired"),
      },
    ],
  );
  verifyVector(
    "signature/expired-within-skew",
    "A signature that expired 30 seconds ago is still accepted within the 60 second skew.",
    ["4.4", "12"],
    [
      {
        request: await signed(request(signerHeaders()), {
          key: "signer-a",
          created: NOW - 200,
          expires: NOW - 30,
        }),
        expected: verifiedSigner,
      },
    ],
  );
  verifyVector(
    "signature/created-in-future",
    "A signature created 120 seconds in the future, beyond the 60 second skew, fails.",
    ["4.4", "12"],
    [
      {
        request: await signed(request(signerHeaders()), {
          key: "signer-a",
          created: NOW + 120,
          expires: NOW + 200,
        }),
        expected: failedSigner("created_in_future"),
      },
    ],
  );
  verifyVector(
    "signature/validity-too-long",
    "A signature valid for 600 seconds, longer than the 300 second maximum, fails.",
    ["4.4", "12"],
    [
      {
        request: await signed(request(signerHeaders()), {
          key: "signer-a",
          created: NOW - 10,
          expires: NOW + 590,
        }),
        expected: failedSigner("validity_too_long"),
      },
    ],
  );
  verifyVector(
    "signature/wrong-authority",
    "A signature over another host's authority fails.",
    ["4.4"],
    [
      {
        request: await signed(request(signerHeaders()), {
          key: "signer-a",
          authority: "other.example",
        }),
        expected: failedSigner("signature_invalid"),
      },
    ],
  );
  const tampered = await signed(request(signerHeaders(), { path: "/original" }), {
    key: "signer-a",
    components: ["@path"],
  });
  verifyVector(
    "signature/tampered-component",
    "A covered component (@path) changed after signing fails.",
    ["4.4"],
    [{ request: { ...tampered, path: "/changed" }, expected: failedSigner("signature_invalid") }],
  );
  const replay = await signed(request(signerHeaders()), { key: "signer-a", nonceSeed: "replayed" });
  verifyVector(
    "signature/replayed-nonce",
    "The same signed request sent twice: the first verifies, the replay with the same nonce fails.",
    ["4.4", "12"],
    [
      { request: replay, expected: verifiedSigner },
      { request: replay, expected: failedSigner("nonce_replayed") },
    ],
  );
  const twoAgents = 'sig1="https://signer.example", sig2="https://signer.example"';
  const good = await signed(request(signerHeaders(twoAgents)), { key: "signer-b", label: "sig2" });
  const bad = await signed(request(signerHeaders(twoAgents)), { key: "rogue", label: "sig1" });
  const pick = (spec: RequestSpec, name: string) =>
    spec.headers.find(([header]) => header === name)?.[1] ?? "";
  verifyVector(
    "signature/multiple-one-valid",
    "Two signatures on one request: one from a key the operator does not publish, one valid. The valid one wins.",
    ["4.4"],
    [
      {
        request: {
          ...good,
          headers: [
            ...signerHeaders(twoAgents),
            ["signature", `${pick(bad, "signature")}, ${pick(good, "signature")}`],
            [
              "signature-input",
              `${pick(bad, "signature-input")}, ${pick(good, "signature-input")}`,
            ],
          ],
        },
        expected: verifiedSigner,
      },
    ],
  );
  verifyVector(
    "signature/no-alg-parameter",
    "A signature without the optional alg parameter, which the protocol draft allows, verifies.",
    ["4.4"],
    [
      {
        request: await signed(request(signerHeaders()), { key: "signer-a", noAlg: true }),
        expected: verifiedSigner,
      },
    ],
  );
  verifyVector(
    "signature/parameterized-signature-agent-key",
    "A signature labeled sig2 that covers the Signature-Agent member under a different key (agent2) verifies.",
    ["4.4"],
    [
      {
        request: await signed(request(signerHeaders('agent2="https://signer.example"')), {
          key: "signer-a",
          label: "sig2",
          agentKey: "agent2",
        }),
        expected: verifiedSigner,
      },
    ],
  );
  const queryParam =
    'sig1=("@authority" "signature-agent";key="sig1" "@query-param";name="page");created=';
  verifyVector(
    "signature/unsupported-query-param",
    "A signature covering @query-param, which web-bot-auth 0.2.0 cannot verify: the request fails open with an error, never claimed_failed.",
    ["4.4", "4.8"],
    [
      {
        request: request(
          [
            ...signerHeaders(),
            ["signature", `sig1=:${Buffer.alloc(64, 1).toString("base64")}:`],
            [
              "signature-input",
              `${queryParam}${NOW - 5};expires=${NOW + 60};keyid="unused";alg="ed25519";tag="web-bot-auth"`,
            ],
          ],
          { path: "/docs?page=2" },
        ),
        expected: {
          verdict: "unknown_automation",
          reason: "library_unsupported",
          operator: null,
          agent: null,
          purpose: null,
          method: "none",
          error: true,
        },
      },
    ],
  );
  verifyVector(
    "signature/unsupported-sf-parameter",
    "A signature covering a header with the ;sf parameter, unsupported by the library: fails open with an error.",
    ["4.4", "4.8"],
    [
      {
        request: request([
          ...signerHeaders(),
          ["accept", "text/html"],
          ["signature", `sig1=:${Buffer.alloc(64, 2).toString("base64")}:`],
          [
            "signature-input",
            `sig1=("@authority" "signature-agent";key="sig1" "accept";sf);created=${NOW - 5};expires=${NOW + 60};keyid="unused";alg="ed25519";tag="web-bot-auth"`,
          ],
        ]),
        expected: {
          verdict: "unknown_automation",
          reason: "library_unsupported",
          operator: null,
          agent: null,
          purpose: null,
          method: "none",
          error: true,
        },
      },
    ],
  );

  // sf-string edge cases in Signature-Agent.
  verifyVector(
    "signature/sf-uppercase-origin",
    "Signature-Agent with an uppercase scheme and host still names the listed origin, and the signature covers the member as sent.",
    ["4.3", "4.4"],
    [
      {
        request: await signed(request(signerHeaders('sig1="HTTPS://SIGNER.EXAMPLE"')), {
          key: "signer-a",
        }),
        expected: verifiedSigner,
      },
    ],
  );
  verifyVector(
    "signature/sf-trailing-slash",
    "Signature-Agent with an empty path (a trailing slash) names the same origin.",
    ["4.3", "4.4"],
    [
      {
        request: await signed(request(signerHeaders('sig1="https://signer.example/"')), {
          key: "signer-a",
        }),
        expected: verifiedSigner,
      },
    ],
  );
  const unattributable: Expected = {
    verdict: "declared_unverifiable",
    reason: "unsigned",
    operator: "example-signer",
    agent: "ExampleAgent",
    purpose: "agent",
    method: "none",
    error: false,
  };
  verifyVector(
    "signature/sf-member-with-path",
    "A directory member with a path is ignored (the draft requires an origin), so the signature names no listed operator. The User-Agent claim is then checked: the operator signs and publishes no IP list.",
    ["4.3", "4.4"],
    [
      {
        request: await signed(request(signerHeaders('sig1="https://signer.example/keys"')), {
          key: "signer-a",
        }),
        expected: unattributable,
      },
    ],
  );
  verifyVector(
    "signature/sf-escaped-quote",
    "A Signature-Agent string with an escaped quote is not a valid URI and is ignored; nothing is fetched.",
    ["4.3", "9"],
    [
      {
        request: request(signerHeaders('sig1="https://signer.example/\\"x"')),
        expected: unattributable,
      },
    ],
  );
  verifyVector(
    "signature/sf-token-not-string",
    "A Signature-Agent member that is a token rather than a string cannot be read; the User-Agent claim is checked instead.",
    ["4.3"],
    [{ request: request(signerHeaders("sig1=signer")), expected: unattributable }],
  );
  verifyVector(
    "signature/sf-jwks-uri-type-ignored",
    "A member of type jwks_uri is ignored: only the directory type is supported, as the draft requires.",
    ["4.3"],
    [
      {
        request: await signed(
          request(signerHeaders('sig1="https://signer.example";type=jwks_uri')),
          { key: "signer-a" },
        ),
        expected: unattributable,
      },
    ],
  );
  verifyVector(
    "signature/sf-http-scheme-ignored",
    "A member with an http (not https) URL is ignored.",
    ["4.3"],
    [{ request: request(signerHeaders('sig1="http://signer.example"')), expected: unattributable }],
  );

  // Key selection.
  const label = (keyid?: string): Promise<RequestSpec> =>
    signed(request(signerHeaders('sig1="https://labels.example"', ua.labelAgent)), {
      key: "label-k1",
      keyid,
    });
  const labelVerified: Expected = {
    verdict: "verified_by_signature",
    reason: null,
    operator: "label-signer",
    agent: "LabelAgent",
    purpose: "agent",
    method: "signature",
    error: false,
  };
  verifyVector(
    "keys/legacy-kid-label",
    "An operator-chosen kid label (not a thumbprint), as some live directories publish, selects the key.",
    ["4.4"],
    [{ request: await label("k1"), expected: labelVerified }],
  );
  verifyVector(
    "keys/thumbprint-keyid-with-label-kid",
    "A keyid equal to the RFC 7638 thumbprint, as the current draft requires, selects the key even when the directory labels it k1.",
    ["4.4"],
    [{ request: await label(), expected: labelVerified }],
  );
  vectors.push({
    id: "keys/unknown-kid",
    description:
      "A kid this install does not hold: declared_unverifiable, and an early keys.json refresh is requested.",
    spec: ["3.4", "4.4"],
    type: "verify",
    now: NOW_ISO,
    refresh: { enabled: true, responses: {} },
    steps: [
      {
        request: await label("k9"),
        expected: { ...labelVerified, verdict: "declared_unverifiable", reason: "unknown_kid" },
      },
    ],
    expected_state: { keys_refresh_requested: true },
  });
  const noKid = (keyid?: string, key = "nokid-2") =>
    signed(request(signerHeaders('sig1="https://nokid.example"', ua.noKidAgent)), { key, keyid });
  const noKidVerified: Expected = {
    verdict: "verified_by_signature",
    reason: null,
    operator: "nokid-signer",
    agent: "NoKidAgent",
    purpose: "user_fetch",
    method: "signature",
    error: false,
  };
  verifyVector(
    "keys/no-kid-several-keys",
    "The operator's keys carry no kid and the signature's keyid is not a thumbprint: every key is tried, and the second verifies.",
    ["4.4"],
    [{ request: await noKid("unlabeled-key"), expected: noKidVerified }],
  );
  verifyVector(
    "keys/no-kid-thumbprint",
    "The operator's keys carry no kid and the signature's keyid is the RFC 7638 thumbprint: that key is selected.",
    ["4.4"],
    [{ request: await noKid(), expected: noKidVerified }],
  );
  verifyVector(
    "keys/no-kid-wrong-key",
    "No kid, and the signature was made with a key the operator does not publish: every key is tried and none verifies.",
    ["4.4"],
    [
      {
        request: await noKid("unlabeled-key", "rogue"),
        expected: { ...noKidVerified, verdict: "claimed_failed", reason: "signature_invalid" },
      },
    ],
  );
}

async function draftVectors(): Promise<void> {
  // draft-ietf-webbotauth-httpsig-protocol-00, Appendix E.2.1, through Posterna's verifier.
  verifyVector(
    "keys/published-test-key-rejected",
    "The protocol draft's test vector E.2.1 is signed with the RFC 9421 example key. Verifiers SHOULD reject known test keys, so this install holds no usable key: declared_unverifiable.",
    ["4.4"],
    [
      {
        request: request([
          ["host", "example.com"],
          ["signature-agent", 'agent2="https://signature-agent.test"'],
          [
            "signature-input",
            'sig2=("@authority" "signature-agent";key="agent2");created=1735689600;keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";alg="ed25519";expires=4889289600;nonce="n9p433xm+NJ3ph3upfBIGmsuwHw387YV7Q/F+6BSpGCVjYCqQw6rznNA8PVVLySrAWsv0hQtFioQb6E1YsauiA==";tag="web-bot-auth"',
          ],
          [
            "signature",
            "sig2=:RdNFx5Bj6au3YgAMQL/RzmUlZE8QZLIaXGRpw985hWnwPfMxT228NMk6ehRS1PSl4e8PhbNZACSanGdhEwYCCg==:",
          ],
        ]),
        expected: {
          verdict: "declared_unverifiable",
          reason: "no_keys",
          operator: "draft-test-signer",
          agent: null,
          purpose: null,
          method: "none",
          error: false,
        },
      },
    ],
  );

  const rfcRequest: Pair[] = [
    ["host", "example.com"],
    ["date", "Tue, 20 Apr 2021 02:07:55 GMT"],
    ["content-type", "application/json"],
    [
      "content-digest",
      "sha-512=:WZDPaVn/7XgHaAy8pmojAkGWoRx2UFChF41A2svX+TaPm+AbwAgBWnrIiYllu7BNNyealdVLvRwEmTHWXvJwew==:",
    ],
    ["content-length", "18"],
  ];
  const rfcKey = { ...RFC9421_TEST_KEY };
  const b26 = {
    method: "POST",
    target_uri: "https://example.com/foo?param=Value&Pet=dog",
    headers: [
      ...rfcRequest,
      [
        "signature-input",
        'sig-b26=("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"',
      ],
      [
        "signature",
        "sig-b26=:wqcAqbmYJ2ji2glfAMaRy4gruYYnx2nEFN2HN6jrnDnQCK1u02Gb04v9EDgwUPiu4A0w6vuQv5lIp5WPpBKRCw==:",
      ],
    ],
  };
  vectors.push({
    id: "rfc9421/b26-ed25519",
    description:
      "RFC 9421 Appendix B.2.6: signing a request using ed25519, verified with Cloudflare's http-message-sig.",
    spec: ["11"],
    type: "rfc9421",
    profile: "rfc9421",
    source: "https://www.rfc-editor.org/rfc/rfc9421#appendix-B.2.6",
    public_key: rfcKey,
    keyid: "test-key-ed25519",
    label: "sig-b26",
    now: 1618884483,
    request: b26,
    expected: { valid: true },
  });
  vectors.push({
    id: "rfc9421/b26-ed25519-tampered",
    description:
      "RFC 9421 Appendix B.2.6 with the covered Date header changed: verification fails.",
    spec: ["11"],
    type: "rfc9421",
    profile: "rfc9421",
    source: "https://www.rfc-editor.org/rfc/rfc9421#appendix-B.2.6",
    public_key: rfcKey,
    keyid: "test-key-ed25519",
    label: "sig-b26",
    now: 1618884483,
    request: {
      ...b26,
      headers: b26.headers.map(([name, value]) =>
        name === "date" ? [name, "Tue, 20 Apr 2021 02:07:56 GMT"] : [name, value],
      ),
    },
    expected: { valid: false },
  });
  const draftRequest = (agent: string, input: string, signature: string) => ({
    method: "POST",
    target_uri: "https://example.com/foo?param=Value&Pet=dog",
    headers: [
      ...rfcRequest,
      ["signature-agent", agent],
      ["signature-input", input],
      ["signature", signature],
    ],
  });
  vectors.push({
    id: "rfc9421/draft-e21-dictionary",
    description:
      "draft-ietf-webbotauth-httpsig-protocol-00 Appendix E.2.1: dictionary-form Signature-Agent, verified with Cloudflare's web-bot-auth.",
    spec: ["11"],
    type: "rfc9421",
    profile: "web-bot-auth",
    source:
      "https://datatracker.ietf.org/doc/html/draft-ietf-webbotauth-httpsig-protocol-00#appendix-E.2.1",
    public_key: rfcKey,
    keyid: "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U",
    label: "sig2",
    now: 1735689610,
    request: draftRequest(
      'agent2="https://signature-agent.test"',
      'sig2=("@authority" "signature-agent";key="agent2");created=1735689600;keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";alg="ed25519";expires=4889289600;nonce="n9p433xm+NJ3ph3upfBIGmsuwHw387YV7Q/F+6BSpGCVjYCqQw6rznNA8PVVLySrAWsv0hQtFioQb6E1YsauiA==";tag="web-bot-auth"',
      "sig2=:RdNFx5Bj6au3YgAMQL/RzmUlZE8QZLIaXGRpw985hWnwPfMxT228NMk6ehRS1PSl4e8PhbNZACSanGdhEwYCCg==:",
    ),
    expected: { valid: true },
  });
  vectors.push({
    id: "rfc9421/draft-e22-legacy-string",
    description:
      "draft-ietf-webbotauth-httpsig-protocol-00 Appendix E.2.2: legacy sf-string Signature-Agent, verified with Cloudflare's web-bot-auth.",
    spec: ["11"],
    type: "rfc9421",
    profile: "web-bot-auth",
    source:
      "https://datatracker.ietf.org/doc/html/draft-ietf-webbotauth-httpsig-protocol-00#appendix-E.2.2",
    public_key: rfcKey,
    keyid: "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U",
    label: "sig2",
    now: 1735689610,
    request: draftRequest(
      '"https://signature-agent.test"',
      'sig2=("@authority" "signature-agent");created=1735689600;keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";alg="ed25519";expires=1735693200;nonce="e8N7S2MFd/qrd6T2R3tdfAuuANngKI7LFtKYI/vowzk4lAZYadIX6wW25MwG7DCT9RUKAJ0qVkU0mEeLElW1qg==";tag="web-bot-auth"',
      "sig2=:jdq0SqOwHdyHr9+r5jw3iYZH6aNGKijYp/EstF4RQTQdi5N5YYKrD+mCT1HA1nZDsi6nJKuHxUi/5Syp3rLWBA==:",
    ),
    expected: { valid: true },
  });
}

async function keyDirectoryVectors(): Promise<void> {
  const manifest = JSON.parse(readFileSync(join(DIRECTORY_RAW, "manifest.json"), "utf8")) as {
    entries: {
      operator: string;
      kind: string;
      outcome: string;
      file: string | null;
      fetched_at: string;
      url: string;
    }[];
  };
  const keys = JSON.parse(readFileSync(join(DIRECTORY_DATA, "keys.json"), "utf8")) as KeysFile;
  for (const slug of ["google", "meta", "browserbase"]) {
    const entry = manifest.entries.find(
      (candidate) => candidate.kind === "key_directory" && candidate.operator === slug,
    );
    if (!entry?.file || entry.outcome !== "ok")
      throw new Error(`no fetched key directory for ${slug}; run pnpm directory:fetch`);
    const body = readFileSync(join(DIRECTORY_RAW, entry.file), "utf8");
    const snapshot = `fixtures/key-directories/${slug}.json`;
    mkdirSync(join(FIXTURES, "key-directories"), { recursive: true });
    writeFileSync(join(CONFORMANCE, snapshot), body.endsWith("\n") ? body : `${body}\n`);
    const published = keys.operators[slug];
    if (!published) throw new Error(`keys.json has no ${slug}`);
    const kids = published.keys.map((key) => key.kid);
    const convention = kids.every((kid) => kid === null)
      ? "none"
      : published.keys.every((key) => key.kid === key.thumbprint)
        ? "thumbprint"
        : "short_id";
    vectors.push({
      id: `key-directories/${slug}`,
      description: `Snapshot of ${slug}'s live key directory, fetched ${entry.fetched_at}. Parsing, kid convention and RFC 7638 thumbprints (expected values computed by the directory pipeline with jose).`,
      spec: ["3.2", "11"],
      type: "key_directory",
      source: entry.url,
      snapshot,
      expected: {
        key_count: published.keys.length,
        kid_convention: convention,
        keys: published.keys.map((key) => ({ kid: key.kid, thumbprint: key.thumbprint })),
      },
    });
  }
}

function ipVectors(directory: DirectoryFile): void {
  const bot = (address: string | null, userAgent = ua.exampleBot) =>
    request(site([["user-agent", userAgent]]), { remote_address: address });
  const exampleBot = { operator: "ip-crawler", agent: "ExampleBot", purpose: "search" };
  verifyVector(
    "ip/in-list-ipv4",
    "A claimed ExampleBot from an address in its published IPv4 list.",
    ["4.5"],
    [
      {
        request: bot("192.0.2.77"),
        expected: {
          verdict: "verified_by_ip",
          reason: null,
          ...exampleBot,
          method: "ip",
          error: false,
        },
      },
    ],
  );
  verifyVector(
    "ip/in-list-ipv6",
    "A claimed ExampleBot from an address in its published IPv6 list.",
    ["4.5"],
    [
      {
        request: bot("2001:db8:10:ff::1"),
        expected: {
          verdict: "verified_by_ip",
          reason: null,
          ...exampleBot,
          method: "ip",
          error: false,
        },
      },
    ],
  );
  verifyVector(
    "ip/ipv4-mapped-ipv6",
    "A socket address in IPv4-mapped IPv6 form is read as the IPv4 address it carries.",
    ["4.2", "4.5"],
    [
      {
        request: bot("::ffff:192.0.2.77"),
        expected: {
          verdict: "verified_by_ip",
          reason: null,
          ...exampleBot,
          method: "ip",
          error: false,
        },
      },
    ],
  );
  verifyVector(
    "ip/outside-list-no-rdns",
    "A claimed ExampleBot from outside its list, for an operator that documents no reverse DNS: claimed_failed.",
    ["4.5"],
    [
      {
        request: bot("203.0.113.9"),
        expected: {
          verdict: "claimed_failed",
          reason: "outside_ip_list",
          ...exampleBot,
          method: "ip",
          error: false,
        },
      },
    ],
  );
  const rdnsBot = { operator: "rdns-crawler", agent: "ExampleRdnsBot", purpose: "training" };
  const pending: Expected = {
    verdict: "declared_unverifiable",
    reason: "rdns_pending",
    ...rdnsBot,
    method: "none",
    error: false,
  };
  verifyVector(
    "ip/rdns-confirmed",
    "Outside the IP list, with forward-confirmed reverse DNS under the documented suffix. The first request starts the lookup in the background; the next one gets its result.",
    ["4.5"],
    [
      { request: bot("203.0.113.40", ua.rdnsBot), expected: pending },
      {
        settle_before: true,
        request: bot("203.0.113.40", ua.rdnsBot),
        expected: {
          verdict: "verified_by_ip",
          reason: null,
          ...rdnsBot,
          method: "rdns",
          error: false,
        },
      },
    ],
    {
      dns: {
        reverse: { "203.0.113.40": ["node-7.crawl.example."] },
        forward: { "node-7.crawl.example": ["203.0.113.40"] },
      },
    },
  );
  verifyVector(
    "ip/rdns-wrong-suffix",
    "Reverse DNS points outside the documented suffix (a lookalike domain): claimed_failed.",
    ["4.5"],
    [
      { request: bot("203.0.113.41", ua.rdnsBot), expected: pending },
      {
        settle_before: true,
        request: bot("203.0.113.41", ua.rdnsBot),
        expected: {
          verdict: "claimed_failed",
          reason: "rdns_mismatch",
          ...rdnsBot,
          method: "rdns",
          error: false,
        },
      },
    ],
    {
      dns: {
        reverse: { "203.0.113.41": ["crawl.example.attacker.example"] },
        forward: { "crawl.example.attacker.example": ["203.0.113.41"] },
      },
    },
  );
  verifyVector(
    "ip/rdns-not-forward-confirmed",
    "The PTR name has the right suffix but does not resolve back to the address: claimed_failed.",
    ["4.5"],
    [
      { request: bot("203.0.113.42", ua.rdnsBot), expected: pending },
      {
        settle_before: true,
        request: bot("203.0.113.42", ua.rdnsBot),
        expected: {
          verdict: "claimed_failed",
          reason: "rdns_unconfirmed",
          ...rdnsBot,
          method: "rdns",
          error: false,
        },
      },
    ],
    {
      dns: {
        reverse: { "203.0.113.42": ["node-8.crawl.example"] },
        forward: { "node-8.crawl.example": ["203.0.113.99"] },
      },
    },
  );
  verifyVector(
    "ip/no-dns-runtime",
    "In a runtime without DNS (edge), a claim that reverse DNS would decide is declared_unverifiable.",
    ["4.5"],
    [{ request: bot("203.0.113.43", ua.rdnsBot), expected: { ...pending, reason: "no_dns" } }],
    { dns: null },
  );
  verifyVector(
    "ip/operator-publishes-nothing",
    "A claim for a researched operator that publishes no keys, IP lists or reverse DNS rules is declared_unverifiable.",
    ["4.5"],
    [
      {
        request: bot("203.0.113.9", "Mozilla/5.0 (compatible; QuietBot/1.0)"),
        expected: {
          verdict: "declared_unverifiable",
          reason: "nothing_published",
          operator: "quiet-operator",
          agent: "QuietBot",
          purpose: "other",
          method: "none",
          error: false,
        },
      },
    ],
  );
  verifyVector(
    "ip/community-agent",
    "A claim for a community agent, which has nothing to verify against, is declared_unverifiable.",
    ["4.5"],
    [
      {
        request: bot("203.0.113.9", "CommunityBot/3.1"),
        expected: {
          verdict: "declared_unverifiable",
          reason: "nothing_published",
          operator: "community-operator",
          agent: "CommunityBot",
          purpose: "training",
          method: "none",
          error: false,
        },
      },
    ],
  );
  verifyVector(
    "ip/verdict-headers",
    "The verdict headers passed to the application for a verified request.",
    ["4.7"],
    [
      {
        request: bot("192.0.2.77"),
        expected: {
          verdict: "verified_by_ip",
          reason: null,
          ...exampleBot,
          method: "ip",
          error: false,
          verdict_headers: {
            "X-Agent-Verdict": "verified_by_ip",
            "X-Agent-Operator": "ip-crawler",
            "X-Agent-Purpose": "search",
            "X-Agent-Method": "ip",
          },
        },
      },
    ],
  );

  // Spoofs with real operators (frozen copies) and real cloud addresses.
  const aws = "216.244.7.10"; // AWS EC2 us-east-1, 216.244.7.0/24 in ip-ranges.amazonaws.com of 2026-10-26.
  const gcp = "8.34.210.10"; // Google Cloud us-central1, 8.34.210.0/24 in gstatic.com/ipranges/cloud.json of 2026-10-26.
  for (const [slug, address] of [
    ["anthropic", aws],
    ["google", gcp],
  ] as const) {
    const record = directory.operators.find((op) => op.slug === slug);
    const matcher = PrefixMatcher.compile(
      record?.verification.ip_lists.flatMap((list) => list.prefixes) ?? [],
    );
    const parsed = parseAddress(address);
    if (!parsed || matcher.has(parsed.parsed))
      throw new Error(`${address} must not be in ${slug}'s lists`);
  }
  verifyVector(
    "spoof/claudebot-from-aws",
    "A claimed ClaudeBot from an AWS EC2 address (216.244.7.0/24, from AWS's published ranges) that is not in Anthropic's crawler list: claimed_failed.",
    ["4.5", "11"],
    [
      {
        request: bot(aws, ua.claudebot),
        expected: {
          verdict: "claimed_failed",
          reason: "outside_ip_list",
          operator: "anthropic",
          agent: "ClaudeBot",
          purpose: "training",
          method: "ip",
          error: false,
        },
      },
    ],
  );
  verifyVector(
    "spoof/googlebot-from-google-cloud",
    "A claimed Googlebot from a Google Cloud customer address (8.34.210.0/24, from Google's cloud.json) whose reverse DNS is under googleusercontent.com, which Posterna does not accept for Google crawlers: claimed_failed once the lookup finishes.",
    ["4.5", "11"],
    [
      {
        request: bot(gcp, ua.googlebot),
        expected: {
          verdict: "declared_unverifiable",
          reason: "rdns_pending",
          operator: "google",
          agent: "Googlebot",
          purpose: "search",
          method: "none",
          error: false,
        },
      },
      {
        settle_before: true,
        request: bot(gcp, ua.googlebot),
        expected: {
          verdict: "claimed_failed",
          reason: "rdns_mismatch",
          operator: "google",
          agent: "Googlebot",
          purpose: "search",
          method: "rdns",
          error: false,
        },
      },
    ],
    {
      dns: {
        reverse: { [gcp]: ["10.210.34.8.bc.googleusercontent.com"] },
        forward: { "10.210.34.8.bc.googleusercontent.com": [gcp] },
      },
    },
  );
}

async function spoofSignatureVectors(): Promise<void> {
  vectors.push({
    id: "spoof/signature-agent-not-in-directory",
    description:
      "A valid-looking, correctly signed request whose Signature-Agent names a directory that is not listed. It must never trigger a fetch: declared_unverifiable.",
    spec: ["4.4", "9"],
    type: "verify",
    now: NOW_ISO,
    refresh: { enabled: true, responses: {} },
    steps: [
      {
        request: await signed(
          request(
            site([
              ["user-agent", "Mozilla/5.0 (compatible; HelpfulAgent/1.0)"],
              ["signature-agent", 'sig1="https://agents.attacker.example"'],
            ]),
          ),
          { key: "rogue" },
        ),
        expected: {
          verdict: "declared_unverifiable",
          reason: "unlisted_signature_agent",
          operator: null,
          agent: null,
          purpose: null,
          method: "none",
          error: false,
        },
      },
    ],
    expected_state: { fetches: 0 },
  });
  verifyVector(
    "spoof/fake-signature-agent-with-googlebot",
    "A claimed Googlebot from a documentation address with an invented Signature-Agent: the User-Agent claim is still checked, so the invented header cannot soften the result.",
    ["4.3", "4.5"],
    [
      {
        request: request(
          site([
            ["user-agent", ua.googlebot],
            ["signature-agent", 'sig1="https://agents.attacker.example"'],
          ]),
          { remote_address: "203.0.113.50" },
        ),
        expected: {
          verdict: "declared_unverifiable",
          reason: "rdns_pending",
          operator: "google",
          agent: "Googlebot",
          purpose: "search",
          method: "none",
          error: false,
        },
      },
      {
        settle_before: true,
        request: request(
          site([
            ["user-agent", ua.googlebot],
            ["signature-agent", 'sig1="https://agents.attacker.example"'],
          ]),
          { remote_address: "203.0.113.50" },
        ),
        expected: {
          verdict: "claimed_failed",
          reason: "rdns_unconfirmed",
          operator: "google",
          agent: "Googlebot",
          purpose: "search",
          method: "rdns",
          error: false,
        },
      },
    ],
    { dns: { reverse: {}, forward: {} } },
  );
}

async function proxyVectors(): Promise<void> {
  const bot = (remote: string, extra: Pair[] = []) =>
    request(site([["user-agent", ua.exampleBot], ...extra]), { remote_address: remote });
  const ok: Expected = {
    verdict: "verified_by_ip",
    reason: null,
    operator: "ip-crawler",
    agent: "ExampleBot",
    purpose: "search",
    method: "ip",
    error: false,
  };
  const failed: Expected = { ...ok, verdict: "claimed_failed", reason: "outside_ip_list" };
  verifyVector(
    "proxy/no-config-ignores-forwarding",
    "With no trustedProxies, X-Forwarded-For is ignored and the socket address is the client.",
    ["4.2", "9"],
    [
      {
        request: bot("10.0.0.5", [["x-forwarded-for", "192.0.2.10"]]),
        expected: { ...failed, client: { address: "10.0.0.5" } },
      },
    ],
  );
  verifyVector(
    "proxy/one-trusted-hop",
    "One trusted proxy: the client is the rightmost X-Forwarded-For entry.",
    ["4.2"],
    [
      {
        request: bot("10.0.0.5", [["x-forwarded-for", "192.0.2.10"]]),
        expected: { ...ok, client: { address: "192.0.2.10" } },
      },
    ],
    { config: { trustedProxies: ["10.0.0.0/8"] } },
  );
  verifyVector(
    "proxy/two-trusted-hops",
    "Two trusted proxies: trusted hops are skipped from the right.",
    ["4.2"],
    [
      {
        request: bot("10.0.0.5", [["x-forwarded-for", "198.51.100.200, 192.0.2.10, 172.16.0.9"]]),
        expected: { ...ok, client: { address: "192.0.2.10" } },
      },
    ],
    { config: { trustedProxies: ["10.0.0.0/8", "172.16.0.0/12"] } },
  );
  verifyVector(
    "proxy/hop-count",
    "trustedProxies as a hop count of 2.",
    ["4.2"],
    [
      {
        request: bot("10.0.0.5", [["x-forwarded-for", "198.51.100.66, 192.0.2.10, 10.0.0.7"]]),
        expected: { ...ok, client: { address: "192.0.2.10" } },
      },
    ],
    { config: { trustedProxies: 2 } },
  );
  verifyVector(
    "proxy/forged-from-untrusted-client",
    "A client that is not a trusted proxy sends its own X-Forwarded-For naming a crawler address: ignored.",
    ["4.2", "9"],
    [
      {
        request: bot("203.0.113.50", [["x-forwarded-for", "192.0.2.10"]]),
        expected: { ...failed, client: { address: "203.0.113.50" } },
      },
    ],
    { config: { trustedProxies: ["10.0.0.0/8"] } },
  );
  verifyVector(
    "proxy/forged-leftmost-entry",
    "A client prepends a crawler address to X-Forwarded-For; the trusted proxy appends the real one. The rightmost untrusted entry wins.",
    ["4.2", "9"],
    [
      {
        request: bot("10.0.0.5", [["x-forwarded-for", "192.0.2.10, 203.0.113.50"]]),
        expected: { ...failed, client: { address: "203.0.113.50" } },
      },
    ],
    { config: { trustedProxies: ["10.0.0.0/8"] } },
  );
  verifyVector(
    "proxy/forwarded-header",
    "The Forwarded header (RFC 7239), with quoted IPv6 and a port, when the proxies are configured to use it.",
    ["4.2"],
    [
      {
        request: bot("10.0.0.5", [
          ["forwarded", 'for="[2001:db8:10::5]:4711";proto=https, for=10.0.0.7'],
        ]),
        expected: { ...ok, client: { address: "2001:db8:10::5" } },
      },
    ],
    { config: { trustedProxies: ["10.0.0.0/8"], forwardedHeader: "forwarded" } },
  );
  verifyVector(
    "proxy/forwarded-ignored-by-default",
    "A Forwarded header is not read when the proxies are configured for X-Forwarded-For (the default), so a client cannot inject it.",
    ["4.2", "9"],
    [
      {
        request: bot("10.0.0.5", [["forwarded", "for=192.0.2.10"]]),
        expected: { ...failed, client: { address: "10.0.0.5" } },
      },
    ],
    { config: { trustedProxies: ["10.0.0.0/8"] } },
  );

  // @authority behind a proxy.
  const internal = await signed(
    request(
      [
        ["host", "app.internal:8080"],
        ["user-agent", ua.exampleAgent],
        ["signature-agent", 'sig1="https://signer.example"'],
      ],
      { scheme: "http", remote_address: "10.0.0.5" },
    ),
    { key: "signer-a", authority: SITE },
  );
  verifyVector(
    "proxy/internal-host-with-public-host",
    "The app sees an internal Host header; publicHost names the host agents sign, so the signature verifies.",
    ["4.2", "4.4"],
    [{ request: internal, expected: verifiedSigner }],
    { config: { publicHost: SITE } },
  );
  const apexHost = "site.example";
  const apex = await signed(
    request(
      [
        ["host", apexHost],
        ["user-agent", ua.exampleAgent],
        ["signature-agent", 'sig1="https://signer.example"'],
      ],
      { remote_address: "203.0.113.20" },
    ),
    { key: "signer-a", authority: apexHost, nonceSeed: "apex-host" },
  );
  verifyVector(
    "proxy/public-host-list",
    "A site served on both the apex and www lists both names: a request signed for the apex host it arrived on verifies, and an internal Host falls back to the first name.",
    ["4.2", "4.4"],
    [
      { request: apex, expected: verifiedSigner },
      { request: internal, expected: verifiedSigner },
    ],
    { config: { publicHost: [SITE, apexHost] } },
  );
  verifyVector(
    "proxy/internal-host-without-public-host",
    "The same request without publicHost: the signed authority does not match the internal Host, so it fails.",
    ["4.2", "4.4"],
    [
      {
        request: {
          ...internal,
          headers: internal.headers.map(([name, value]) => [name, value]) as Pair[],
        },
        expected: failedSigner("signature_invalid"),
      },
    ],
  );
  verifyVector(
    "proxy/forwarded-host-from-trusted-proxy",
    "With trustForwardedHost, X-Forwarded-Host from a trusted proxy supplies the signed host.",
    ["4.2", "4.4"],
    [
      {
        request: { ...internal, headers: [...internal.headers, ["x-forwarded-host", SITE]] },
        expected: verifiedSigner,
      },
    ],
    { config: { trustedProxies: ["10.0.0.0/8"], trustForwardedHost: true } },
  );
  verifyVector(
    "proxy/forwarded-host-ignored-by-default",
    "Without trustForwardedHost, X-Forwarded-Host is ignored even from a trusted proxy: the internal Host header is the signed host, so the signature fails.",
    ["4.2", "4.4"],
    [
      {
        request: { ...internal, headers: [...internal.headers, ["x-forwarded-host", SITE]] },
        expected: failedSigner("signature_invalid"),
      },
    ],
    { config: { trustedProxies: ["10.0.0.0/8"] } },
  );
  const behindPassThroughProxy = await signed(
    request(
      [
        ["host", SITE],
        ["user-agent", ua.exampleAgent],
        ["signature-agent", 'sig1="https://signer.example"'],
        ["x-forwarded-for", "203.0.113.60"],
        // A proxy that passes the client's own X-Forwarded-Host through.
        ["x-forwarded-host", "victim.example"],
      ],
      { remote_address: "10.0.0.5" },
    ),
    { key: "signer-a", authority: SITE, nonceSeed: "pass-through-proxy" },
  );
  verifyVector(
    "proxy/client-forwarded-host-ignored-by-default",
    "A client's own X-Forwarded-Host, passed through by a trusted proxy, cannot choose the signed host unless the site opts in: the Host header is used and the signature verifies.",
    ["4.2", "9"],
    [{ request: behindPassThroughProxy, expected: verifiedSigner }],
    { config: { trustedProxies: ["10.0.0.0/8"] } },
  );
  verifyVector(
    "proxy/forwarded-host-from-untrusted-client",
    "X-Forwarded-Host from a client that is not a trusted proxy is ignored, even with trustForwardedHost.",
    ["4.2", "9"],
    [
      {
        request: {
          ...internal,
          remote_address: "203.0.113.50",
          headers: [...internal.headers, ["x-forwarded-host", SITE]],
        },
        expected: failedSigner("signature_invalid"),
      },
    ],
    { config: { trustedProxies: ["10.0.0.0/8"], trustForwardedHost: true } },
  );

  // Next.js middleware and proxy never see the socket address.
  const socketless = (forwardedFor: string) =>
    request(
      site([
        ["user-agent", ua.exampleBot],
        ["x-forwarded-for", forwardedFor],
      ]),
      {
        remote_address: null,
      },
    );
  verifyVector(
    "proxy/no-socket-hop-count",
    "Without a socket address (as in Next.js middleware), trustedProxies: 1 takes the last X-Forwarded-For entry, so a client-written entry to its left is ignored.",
    ["4.2"],
    [
      {
        request: socketless("198.51.100.200, 192.0.2.77"),
        expected: { ...ok, client: { address: "192.0.2.77" } },
      },
      {
        request: socketless("192.0.2.77, 203.0.113.9"),
        expected: { ...failed, client: { address: "203.0.113.9" } },
      },
    ],
    { config: { trustedProxies: 1 } },
  );
  verifyVector(
    "proxy/no-socket-short-header",
    "Without a socket address, a header with fewer entries than trustedProxies falls back to its leftmost entry, as with a socket address.",
    ["4.2"],
    [{ request: socketless("192.0.2.77"), expected: { ...ok, client: { address: "192.0.2.77" } } }],
    { config: { trustedProxies: 2 } },
  );
  verifyVector(
    "proxy/no-socket-cidrs",
    "Without a socket address, trusted proxy CIDRs are skipped from the right of X-Forwarded-For.",
    ["4.2"],
    [
      {
        request: socketless("203.0.113.9, 192.0.2.77, 10.0.0.5"),
        expected: { ...ok, client: { address: "192.0.2.77" } },
      },
    ],
    { config: { trustedProxies: ["10.0.0.0/8"] } },
  );
  verifyVector(
    "proxy/no-socket-no-config",
    "Without a socket address and without trustedProxies, X-Forwarded-For is still ignored: the client is unknown and an IP claim cannot be checked.",
    ["4.2", "9"],
    [
      {
        request: socketless("192.0.2.77"),
        expected: {
          ...ok,
          verdict: "declared_unverifiable",
          reason: "no_client_address",
          method: "none",
          client: { address: null },
        },
      },
    ],
  );

  // One header the host documents overwriting with the client address.
  const viaHeader = (headers: Pair[], remote: string | null = "10.0.0.5") =>
    request(site([["user-agent", ua.exampleBot], ...headers]), { remote_address: remote });
  verifyVector(
    "proxy/client-ip-header",
    "clientIpHeader names the header the host overwrites with the client address: it is read instead of X-Forwarded-For, so a forged X-Forwarded-For changes nothing.",
    ["4.2"],
    [
      {
        request: viaHeader([
          ["x-forwarded-for", "203.0.113.9"],
          ["x-vercel-forwarded-for", "192.0.2.77"],
        ]),
        expected: { ...ok, client: { address: "192.0.2.77" } },
      },
      {
        request: viaHeader([["x-vercel-forwarded-for", "203.0.113.9"]]),
        expected: { ...failed, client: { address: "203.0.113.9" } },
      },
    ],
    { config: { clientIpHeader: "X-Vercel-Forwarded-For" } },
  );
  verifyVector(
    "proxy/client-ip-header-rightmost",
    "A client-ip header with several values, or repeated, means something appended to it: the rightmost value, written by the nearest proxy, is the client.",
    ["4.2"],
    [
      {
        request: viaHeader([["x-real-ip", "203.0.113.9, 192.0.2.77"]]),
        expected: { ...ok, client: { address: "192.0.2.77" } },
      },
      {
        request: viaHeader([
          ["x-real-ip", "203.0.113.9"],
          ["x-real-ip", "192.0.2.77"],
        ]),
        expected: { ...ok, client: { address: "192.0.2.77" } },
      },
      {
        request: viaHeader([["x-real-ip", "192.0.2.77:46532"]]),
        expected: { ...ok, client: { address: "192.0.2.77" } },
      },
    ],
    { config: { clientIpHeader: "x-real-ip" } },
  );
  verifyVector(
    "proxy/client-ip-header-missing",
    "When the client-ip header is missing or unreadable, the client is unknown: there is no fallback to X-Forwarded-For, and an IP claim cannot be checked.",
    ["4.2", "4.8"],
    [
      {
        request: viaHeader([["x-forwarded-for", "192.0.2.77"]]),
        expected: {
          ...ok,
          verdict: "declared_unverifiable",
          reason: "no_client_address",
          method: "none",
          client: { address: null },
        },
      },
      {
        request: viaHeader([["x-real-ip", "unknown"]]),
        expected: {
          ...ok,
          verdict: "declared_unverifiable",
          reason: "no_client_address",
          method: "none",
          client: { address: null },
        },
      },
    ],
    { config: { clientIpHeader: "x-real-ip" } },
  );
  verifyVector(
    "proxy/client-ip-header-untrusted-peer",
    "With trustedProxies CIDRs, the client-ip header is read only from those proxies. A request straight from the internet is judged by its socket address.",
    ["4.2", "9"],
    [
      {
        request: viaHeader([["x-real-ip", "192.0.2.77"]], "203.0.113.50"),
        expected: { ...failed, client: { address: "203.0.113.50" } },
      },
      {
        request: viaHeader([["x-real-ip", "192.0.2.77"]], "10.0.0.5"),
        expected: { ...ok, client: { address: "192.0.2.77" } },
      },
    ],
    { config: { clientIpHeader: "x-real-ip", trustedProxies: ["10.0.0.0/8"] } },
  );
  verifyVector(
    "proxy/client-ip-header-no-socket",
    "Without a socket address (Next.js middleware and proxy), the client-ip header is read directly.",
    ["4.2"],
    [
      {
        request: viaHeader([["x-vercel-forwarded-for", "192.0.2.77"]], null),
        expected: { ...ok, client: { address: "192.0.2.77" } },
      },
    ],
    { config: { clientIpHeader: "x-vercel-forwarded-for" } },
  );

  vectors.push({
    id: "proxy/guard-trips",
    description:
      "200 requests from private addresses with no trustedProxies configured: the install marks itself proxySuspect.",
    spec: ["4.2"],
    type: "verify",
    now: NOW_ISO,
    steps: [
      {
        repeat: 200,
        request: request(BROWSER.concat([["host", SITE]]), { remote_address: "10.1.2.3" }),
        expected: { verdict: "human", reason: null, method: "none", error: false },
      },
    ],
    expected_state: { proxySuspect: true },
  });
  vectors.push({
    id: "proxy/guard-below-threshold",
    description:
      "159 private and 41 public addresses in the last 200 requests stay under the 80 percent threshold.",
    spec: ["4.2"],
    type: "verify",
    now: NOW_ISO,
    steps: [
      {
        repeat: 159,
        request: request(BROWSER.concat([["host", SITE]]), { remote_address: "192.168.1.10" }),
        expected: { verdict: "human", reason: null, method: "none", error: false },
      },
      {
        repeat: 41,
        request: request(BROWSER.concat([["host", SITE]]), { remote_address: "203.0.113.70" }),
        expected: { verdict: "human", reason: null, method: "none", error: false },
      },
    ],
    expected_state: { proxySuspect: false },
  });
}

function headerVectors(): void {
  verifyVector(
    "headers/strip-inbound",
    "Inbound X-Agent-* and X-Posterna-* headers are dropped before anything reads them, so a client cannot forge a verdict.",
    ["4.7", "9"],
    [
      {
        request: request([
          ["host", SITE],
          ...BROWSER,
          ["x-agent-verdict", "verified_by_signature"],
          ["X-Agent-Operator", "google"],
          ["x-posterna-action", "allow"],
        ]),
        expected: {
          verdict: "human",
          reason: null,
          method: "none",
          error: false,
          stripped: ["x-agent-operator", "x-agent-verdict", "x-posterna-action"],
        },
      },
    ],
  );
  verifyVector(
    "headers/human-and-automation",
    "A browser is human; curl is unknown_automation.",
    ["4.6"],
    [
      {
        request: request([["host", SITE], ...BROWSER]),
        expected: { verdict: "human", reason: null, operator: null, method: "none", error: false },
      },
      {
        request: request([
          ["host", SITE],
          ["user-agent", "curl/8.4.0"],
          ["accept", "*/*"],
        ]),
        expected: {
          verdict: "unknown_automation",
          reason: "non_browser_user_agent",
          operator: null,
          method: "none",
          error: false,
        },
      },
      {
        request: request([
          ["host", SITE],
          ["user-agent", BROWSER[0]?.[1] ?? ""],
        ]),
        expected: {
          verdict: "unknown_automation",
          reason: "missing_accept",
          operator: null,
          method: "none",
          error: false,
        },
      },
    ],
  );
}

function automationSignalVectors(): void {
  const lacking = (headers: Pair[], reason: string): Step => ({
    request: request([["host", SITE], ...headers]),
    expected: {
      verdict: "unknown_automation",
      reason,
      operator: null,
      method: "none",
      error: false,
    },
  });
  const [userAgent, accept, language] = BROWSER as [Pair, Pair, Pair];
  verifyVector(
    "headers/automation-signals",
    "Each signal that labels a request with no claim as automated gives its own reason code; none of them carries the header's value.",
    ["4.6", "7"],
    [
      lacking([accept, language], "no_user_agent"),
      lacking([["user-agent", "Go-http-client/2.0"], accept, language], "non_browser_user_agent"),
      lacking(
        [
          [
            "user-agent",
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/130.0.0.0",
          ],
          accept,
          language,
        ],
        "automation_token",
      ),
      lacking([userAgent, language], "missing_accept"),
      lacking([userAgent, accept], "missing_accept_language"),
    ],
  );
}

async function failureVectors(): Promise<void> {
  const failOpen = (verdict: "human" | "unknown_automation", reason: string): Expected => ({
    verdict,
    reason,
    operator: null,
    agent: null,
    purpose: null,
    method: "none",
    error: true,
  });
  for (const [kind, description] of [
    ["missing", "The bundled directory snapshot is missing."],
    ["malformed", "The directory snapshot is malformed (operators is not a list)."],
  ] as const) {
    verifyVector(
      `failure/${kind}-directory`,
      `${description} Every request fails open with an error: a browser is human, a bot is unknown_automation, nothing is claimed_failed.`,
      ["4.8"],
      [
        {
          request: request([["host", SITE], ...BROWSER]),
          expected: failOpen("human", "directory_unavailable"),
        },
        {
          request: request(site([["user-agent", ua.googlebot]]), { remote_address: "203.0.113.9" }),
          expected: failOpen("unknown_automation", "directory_unavailable"),
        },
      ],
      { inject: { snapshot: kind } },
    );
  }
  vectors.push({
    id: "failure/bad-directory-signature",
    description:
      "A refreshed directory.json whose signature does not verify is rejected; the last good copy stays and requests are labeled as before.",
    spec: ["3.1", "3.4", "4.8", "9"],
    type: "verify",
    now: NOW_ISO,
    refresh: {
      enabled: true,
      responses: {
        "directory.json": { status: 200, body: '{"schema":1,"operators":[]}' },
        "directory.json.sig": { status: 200, body: Buffer.alloc(64, 7).toString("base64url") },
        "keys.json": { status: 404, body: "" },
        "keys.json.sig": { status: 404, body: "" },
      },
    },
    steps: [
      { action: "refresh" },
      {
        request: request(site([["user-agent", ua.exampleBot]]), { remote_address: "192.0.2.77" }),
        expected: {
          verdict: "verified_by_ip",
          reason: null,
          operator: "ip-crawler",
          agent: "ExampleBot",
          purpose: "search",
          method: "ip",
          error: false,
        },
      },
    ],
    expected_state: { errors_at_least: 1 },
  });
  for (const [kind, description] of [
    ["timeout", "The reverse DNS lookup times out."],
    ["error", "The DNS server fails (SERVFAIL)."],
  ] as const) {
    verifyVector(
      `failure/dns-${kind}`,
      `${description} The first request is declared_unverifiable while the lookup runs; afterwards the request fails open with an error, never claimed_failed.`,
      ["4.5", "4.8"],
      [
        {
          request: request(site([["user-agent", ua.rdnsBot]]), { remote_address: "203.0.113.44" }),
          expected: {
            verdict: "declared_unverifiable",
            reason: "rdns_pending",
            operator: "rdns-crawler",
            agent: "ExampleRdnsBot",
            purpose: "training",
            method: "none",
            error: false,
          },
        },
        {
          settle_before: true,
          request: request(site([["user-agent", ua.rdnsBot]]), { remote_address: "203.0.113.44" }),
          expected: failOpen("unknown_automation", "rdns_error"),
        },
      ],
      { inject: { dns: kind }, config: { reverseDns: { timeoutMs: 50 } } },
    );
  }
  verifyVector(
    "failure/clock-invalid",
    "The system clock returns an invalid time: a correctly signed request fails open with an error instead of being judged.",
    ["4.8"],
    [
      {
        request: await signed(request(signerHeaders()), { key: "signer-a" }),
        expected: failOpen("unknown_automation", "clock_invalid"),
      },
    ],
    { inject: { clock: "invalid" } },
  );
  verifyVector(
    "failure/signature-library-throws",
    "The signature library throws an unexpected exception: the request fails open with an error, never claimed_failed.",
    ["4.8"],
    [
      {
        request: await signed(request(signerHeaders()), { key: "signer-a" }),
        expected: failOpen("unknown_automation", "library_error"),
      },
    ],
    { inject: { signature_library: "throws" } },
  );
}

async function main(): Promise<void> {
  const { directory, keys } = await buildFixtures();
  write(join(FIXTURES, "directory.json"), directory);
  write(join(FIXTURES, "keys.json"), keys);
  fixtureKey("rogue");
  write(join(FIXTURES, "directory-signer.json"), {
    note: "Throwaway key the conformance runner trusts for refresh tests. Its private half is in keys/directory-signer.json.",
    jwk: publicJwk(fixtureKey("directory-signer")),
  });

  rmSync(VECTORS, { recursive: true, force: true });
  await signatureVectors();
  await draftVectors();
  await keyDirectoryVectors();
  ipVectors(directory);
  await spoofSignatureVectors();
  await proxyVectors();
  headerVectors();
  automationSignalVectors();
  await failureVectors();
  const templates = Object.fromEntries(
    ["monitor", "allow-list", "saas-signup"].map((name) => [
      name,
      readFileSync(join(TEMPLATES, `${name}.yaml`), "utf8"),
    ]),
  );
  vectors.push(...policyVectors(templates));
  for (const vector of vectors) write(join(VECTORS, `${vector.id}.json`), vector);
  console.log(`Wrote ${vectors.length} vectors and fixtures to ${CONFORMANCE}`);
}

await main();
