// `pnpm bench`: the hot path budget (docs/SPEC.md section 10). Fails when p99
// for the signature or IP path is 5 ms or more. Each timed request runs
// verify(), decide() and enforcementResponse(), as the middleware does.
// Method: docs/benchmark.md.

import { createPolicyEngine, type PolicyEngine } from "../src/policy/engine";
import { enforcementResponse } from "../src/policy/respond";
import { createVerifier } from "../src/verifier/verifier";
import {
  BROWSER,
  BUDGET_MS,
  crawlerAddress,
  directory,
  keys,
  machine,
  POLICY,
  SAMPLES,
  SITE,
  signedRequests,
  WARMUP,
} from "./fixtures";

interface Result {
  scenario: string;
  verdict: string;
  action: string;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

async function measure(
  scenario: string,
  verifier: ReturnType<typeof createVerifier>,
  engine: PolicyEngine,
  requests: { request: Request; remoteAddress: string }[],
): Promise<Result> {
  const durations: number[] = [];
  let verdict = "";
  let action = "";
  for (let i = 0; i < WARMUP + SAMPLES; i++) {
    const { request, remoteAddress } = requests[i % requests.length] as {
      request: Request;
      remoteAddress: string;
    };
    const start = performance.now();
    const result = await verifier.verify(request, { remoteAddress });
    const decision = engine.decide(result, { path: new URL(request.url).pathname });
    enforcementResponse(decision, result);
    const elapsed = performance.now() - start;
    if (i >= WARMUP) durations.push(elapsed);
    verdict = result.verdict;
    action = `${decision.action}${decision.enforced ? " (enforced)" : ""}`;
  }
  durations.sort((a, b) => a - b);
  const at = (q: number) =>
    durations[Math.min(durations.length - 1, Math.floor(q * durations.length))] ?? 0;
  return {
    scenario,
    verdict,
    action,
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
  const engine = createPolicyEngine(POLICY, { verifier, env: {} });

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
      engine,
      signed.map((request) => ({ request, remoteAddress: "203.0.113.20" })),
    ),
    await measure("ip (verified_by_ip)", verifier, engine, [
      { request: ipRequest(), remoteAddress: crawlerAddress },
    ]),
    await measure("ip (claimed_failed)", verifier, engine, [
      {
        request: new Request(`https://${SITE}/docs`, {
          headers: { host: SITE, "user-agent": "Mozilla/5.0 (compatible; ClaudeBot/1.0)" },
        }),
        remoteAddress: "216.244.7.10",
      },
    ]),
    await measure("no claim (human)", verifier, engine, [
      {
        request: new Request(`https://${SITE}/`, { headers: { host: SITE, ...BROWSER } }),
        remoteAddress: "203.0.113.30",
      },
    ]),
  ];
  verifier.close();

  console.log(machine());
  console.log(
    `Directory: ${directory.operators.length} operators, ${keys.operators ? Object.keys(keys.operators).length : 0} key sets. Policy: ${engine.policy.paths.length} path rules, enforce mode. ${SAMPLES} samples after ${WARMUP} warm-up requests.\n`,
  );
  console.log("| Scenario | Verdict | Decision | p50 ms | p95 ms | p99 ms | max ms |");
  console.log("|---|---|---|---|---|---|---|");
  for (const r of results) {
    console.log(
      `| ${r.scenario} | ${r.verdict} | ${r.action} | ${r.p50.toFixed(3)} | ${r.p95.toFixed(3)} | ${r.p99.toFixed(3)} | ${r.max.toFixed(3)} |`,
    );
  }
  const expected = [
    ["verified_by_signature", "allow"],
    ["verified_by_ip", "allow"],
    // 5,500 failed claims in a row trip the breaker after the first 20, as a real
    // spoofing flood would, so the block is recorded and not enforced.
    ["claimed_failed", "block"],
    ["human", "allow"],
  ];
  const wrong = results.filter(
    (r, i) => r.verdict !== expected[i]?.[0] || r.action !== expected[i]?.[1],
  );
  const over = results.filter((r) => r.p99 >= BUDGET_MS);
  if (wrong.length > 0) {
    console.error(
      `\nUnexpected results: ${wrong.map((r) => `${r.scenario} got ${r.verdict}, ${r.action}`).join("; ")}`,
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
