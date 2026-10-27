// Shared setup for the hot path benchmarks: the real directory snapshot plus
// the conformance suite's signing operator, an enforcing policy, and signed
// requests. Used by verify.bench.ts here and by the Express middleware bench.

import type { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { availableParallelism, cpus, platform, release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sign } from "web-bot-auth";
import { signerFromJWK } from "web-bot-auth/crypto";
import type { DirectoryFile, KeysFile } from "../src/directory/types";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const json = <T>(...path: string[]) => JSON.parse(readFileSync(join(REPO, ...path), "utf8")) as T;

export const BUDGET_MS = 5;
export const WARMUP = 500;
export const SAMPLES = 5_000;

// The real snapshot, plus the conformance suite's signing operator and its keys.
const realDirectory = json<DirectoryFile>("packages", "directory", "data", "directory.json");
const realKeys = json<KeysFile>("packages", "directory", "data", "keys.json");
const fixtureDirectory = json<DirectoryFile>("conformance", "fixtures", "directory.json");
const fixtureKeys = json<KeysFile>("conformance", "fixtures", "keys.json");
const signerOperator = fixtureDirectory.operators.find((op) => op.slug === "example-signer");
const signerKeys = fixtureKeys.operators["example-signer"];
if (!signerOperator || !signerKeys)
  throw new Error("conformance fixtures are missing example-signer");
export const directory: DirectoryFile = {
  ...realDirectory,
  operators: [...realDirectory.operators, signerOperator],
};
export const keys: KeysFile = {
  ...realKeys,
  operators: { ...realKeys.operators, "example-signer": signerKeys },
};

const google = realDirectory.operators.find((op) => op.slug === "google");
const crawlerPrefix = google?.verification.ip_lists.find((list) => list.agent === "common-crawlers")
  ?.prefixes[0];
if (!crawlerPrefix) throw new Error("the snapshot has no Google common-crawlers prefix");
export const crawlerAddress = crawlerPrefix.replace(/\.0\/\d+$/, ".1").replace(/\/\d+$/, "");

export const SITE = "www.site.example";

// An enforcing policy with a rule at every evaluation step and 40 path rules to scan.
export const POLICY = `version: 1
mode: enforce
defaults:
  claimed_failed: block
purposes:
  training: block
operators:
  example-signer:
    agent: { action: throttle, rate: 1000000/sec }
paths:
${Array.from({ length: 36 }, (_, i) => `  "/section-${i}/*":\n    claimed_failed: block\n    training: allow`).join("\n")}
  "/api/*":
    claimed_failed: block
    monitor: true
  "/api/public/*":
    verified: allow
  "/docs/*":
    verified: allow
  "/admin/*":
    unknown_automation: block
signup:
  "/signup":
    verified: lift
    claimed_failed: challenge
`;
export const BROWSER = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  accept: "text/html",
  "accept-language": "en-US",
};

export async function signedRequests(count: number, now: number): Promise<Request[]> {
  const jwk = json<{ jwk: webcrypto.JsonWebKey }>(
    "conformance",
    "fixtures",
    "keys",
    "signer-a.json",
  ).jwk;
  const signer = await signerFromJWK(jwk);
  const requests: Request[] = [];
  for (let i = 0; i < count; i++) {
    const headers: [string, string][] = [
      ["host", SITE],
      ["user-agent", "Mozilla/5.0 (compatible; ExampleAgent/1.0)"],
      ["signature-agent", 'sig1="https://signer.example"'],
    ];
    const nonce = Buffer.alloc(64);
    nonce.writeUInt32BE(i, 0);
    const fields = await sign(
      {
        kind: "request",
        method: "GET",
        targetUri: `https://${SITE}/page/${i}`,
        fields: headers.map(([name, value]) => ({ name, value })),
      },
      {
        signer,
        created: new Date((now - 5) * 1000),
        expires: new Date((now + 60) * 1000),
        nonce: nonce.toString("base64"),
        additionalComponents: ["@method", "@path"],
      },
    );
    headers.push(["signature", fields.signature], ["signature-input", fields.signatureInput]);
    requests.push(new Request(`https://${SITE}/page/${i}`, { headers }));
  }
  return requests;
}

/** p50, p95, p99 and max of a list of durations in milliseconds. */
export function percentiles(durations: number[]): {
  p50: number;
  p95: number;
  p99: number;
  max: number;
} {
  const sorted = [...durations].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[sorted.length - 1] ?? 0 };
}

export function machine(): string {
  const cpu = cpus()[0]?.model ?? "unknown CPU";
  return `Node ${process.version} on ${platform()} ${release()}, ${availableParallelism()} CPUs (${cpu})`;
}
