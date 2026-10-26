// `pnpm bench`: the hot path budget (docs/SPEC.md section 10). Fails when p99
// for the signature or IP path is 5 ms or more. Method: docs/benchmark.md.

import type { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { availableParallelism, cpus, platform, release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sign } from "web-bot-auth";
import { signerFromJWK } from "web-bot-auth/crypto";
import type { DirectoryFile, KeysFile } from "../src/directory/types";
import { createVerifier } from "../src/verifier/verifier";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const json = <T>(...path: string[]) => JSON.parse(readFileSync(join(REPO, ...path), "utf8")) as T;

const BUDGET_MS = 5;
const WARMUP = 500;
const SAMPLES = 5_000;

// The real snapshot, plus the conformance suite's signing operator and its keys.
const realDirectory = json<DirectoryFile>("packages", "directory", "data", "directory.json");
const realKeys = json<KeysFile>("packages", "directory", "data", "keys.json");
const fixtureDirectory = json<DirectoryFile>("conformance", "fixtures", "directory.json");
const fixtureKeys = json<KeysFile>("conformance", "fixtures", "keys.json");
const signerOperator = fixtureDirectory.operators.find((op) => op.slug === "example-signer");
const signerKeys = fixtureKeys.operators["example-signer"];
if (!signerOperator || !signerKeys)
  throw new Error("conformance fixtures are missing example-signer");
const directory: DirectoryFile = {
  ...realDirectory,
  operators: [...realDirectory.operators, signerOperator],
};
const keys: KeysFile = {
  ...realKeys,
  operators: { ...realKeys.operators, "example-signer": signerKeys },
};

const google = realDirectory.operators.find((op) => op.slug === "google");
const crawlerPrefix = google?.verification.ip_lists.find((list) => list.agent === "common-crawlers")
  ?.prefixes[0];
if (!crawlerPrefix) throw new Error("the snapshot has no Google common-crawlers prefix");
const crawlerAddress = crawlerPrefix.replace(/\.0\/\d+$/, ".1").replace(/\/\d+$/, "");

const SITE = "www.site.example";
const BROWSER = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  accept: "text/html",
  "accept-language": "en-US",
};

async function signedRequests(count: number, now: number): Promise<Request[]> {
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

interface Result {
  scenario: string;
  verdict: string;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

async function measure(
  scenario: string,
  verifier: ReturnType<typeof createVerifier>,
  requests: { request: Request; remoteAddress: string }[],
): Promise<Result> {
  const durations: number[] = [];
  let verdict = "";
  for (let i = 0; i < WARMUP + SAMPLES; i++) {
    const { request, remoteAddress } = requests[i % requests.length] as {
      request: Request;
      remoteAddress: string;
    };
    const start = performance.now();
    const result = await verifier.verify(request, { remoteAddress });
    const elapsed = performance.now() - start;
    if (i >= WARMUP) durations.push(elapsed);
    verdict = result.verdict;
  }
  durations.sort((a, b) => a - b);
  const at = (q: number) =>
    durations[Math.min(durations.length - 1, Math.floor(q * durations.length))] ?? 0;
  return {
    scenario,
    verdict,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: durations[durations.length - 1] ?? 0,
  };
}

async function main(): Promise<void> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const verifier = createVerifier({
    dns: null,
    directory: { snapshot: () => ({ directory, keys }), refresh: false },
  });
  await verifier.settled();

  const signed = await signedRequests(WARMUP + SAMPLES, nowSeconds);
  const ipRequest = () =>
    new Request(`https://${SITE}/docs`, {
      headers: {
        host: SITE,
        "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      },
    });
  const results = [
    await measure(
      "signature (verified_by_signature)",
      verifier,
      signed.map((request) => ({ request, remoteAddress: "203.0.113.20" })),
    ),
    await measure("ip (verified_by_ip)", verifier, [
      { request: ipRequest(), remoteAddress: crawlerAddress },
    ]),
    await measure("ip (claimed_failed)", verifier, [
      {
        request: new Request(`https://${SITE}/docs`, {
          headers: { host: SITE, "user-agent": "Mozilla/5.0 (compatible; ClaudeBot/1.0)" },
        }),
        remoteAddress: "216.244.7.10",
      },
    ]),
    await measure("no claim (human)", verifier, [
      {
        request: new Request(`https://${SITE}/`, { headers: { host: SITE, ...BROWSER } }),
        remoteAddress: "203.0.113.30",
      },
    ]),
  ];
  verifier.close();

  const cpu = cpus()[0]?.model ?? "unknown CPU";
  console.log(
    `Node ${process.version} on ${platform()} ${release()}, ${availableParallelism()} CPUs (${cpu})`,
  );
  console.log(
    `Directory: ${directory.operators.length} operators, ${keys.operators ? Object.keys(keys.operators).length : 0} key sets. ${SAMPLES} samples after ${WARMUP} warm-up requests.\n`,
  );
  console.log("| Scenario | Verdict | p50 ms | p95 ms | p99 ms | max ms |");
  console.log("|---|---|---|---|---|---|");
  for (const r of results) {
    console.log(
      `| ${r.scenario} | ${r.verdict} | ${r.p50.toFixed(3)} | ${r.p95.toFixed(3)} | ${r.p99.toFixed(3)} | ${r.max.toFixed(3)} |`,
    );
  }
  const expected = ["verified_by_signature", "verified_by_ip", "claimed_failed", "human"];
  const wrong = results.filter((r, i) => r.verdict !== expected[i]);
  const over = results.filter((r) => r.p99 >= BUDGET_MS);
  if (wrong.length > 0) {
    console.error(
      `\nUnexpected verdicts: ${wrong.map((r) => `${r.scenario} got ${r.verdict}`).join(", ")}`,
    );
    process.exitCode = 1;
  }
  if (over.length > 0) {
    console.error(
      `\nOver the ${BUDGET_MS} ms p99 budget: ${over.map((r) => r.scenario).join(", ")}`,
    );
    process.exitCode = 1;
  } else {
    const worst = Math.max(...results.map((r) => r.p99));
    console.log(
      `\nAll scenarios are under the ${BUDGET_MS} ms p99 budget (worst p99 ${worst.toFixed(3)} ms, ${(BUDGET_MS / worst).toFixed(0)}x headroom).`,
    );
  }
}

await main();
