// `pnpm bench`, second part: the hot path through the Express middleware
// (docs/SPEC.md section 10). Each sample is the time the middleware takes for
// one real HTTP request inside a running Express app: stripping headers,
// verify(), decide(), the verdict headers, counting, and the block or throttle
// response when there is one. Fails when any scenario's p99 is 5 ms or more.
// Method: docs/benchmark.md.

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import {
  BROWSER,
  BUDGET_MS,
  crawlerAddress,
  directory,
  keys,
  machine,
  POLICY,
  percentiles,
  SAMPLES,
  SITE,
  signedRequests,
  WARMUP,
} from "../../core/bench/fixtures";
import { posterna } from "../src/index";

interface Scenario {
  name: string;
  expected: string;
  requests: { path: string; headers: Record<string, string> }[];
}

async function main(): Promise<void> {
  const middleware = posterna({
    policy: POLICY,
    directory: { snapshot: () => ({ directory, keys }), refresh: false },
    dns: null,
    trustedProxies: ["127.0.0.1/32", "::1/128"],
    publicHost: SITE,
    // Counting stays on the measured path; without a site key nothing is sent.
    siteKey: null,
    env: {},
    onError: () => {},
  });
  await middleware.verifier.settled();

  let durations: number[] = [];
  let last = "";
  const app = express();
  app.use(async (req, res, next) => {
    const start = performance.now();
    let timed = false;
    const stop = () => {
      if (timed) return;
      timed = true;
      durations.push(performance.now() - start);
    };
    await middleware(req, res, (error) => {
      stop();
      next(error);
    });
    stop();
    last = `${req.posterna?.result.verdict ?? "?"} ${req.posterna?.decision.action ?? "?"}`;
  });
  app.get(/.*/, (_req, res) => {
    res.end("ok");
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const signed = (await signedRequests(WARMUP + SAMPLES, nowSeconds)).map((request) => {
    const headers: Record<string, string> = { "x-forwarded-for": "203.0.113.20" };
    request.headers.forEach((value, name) => {
      if (name !== "host") headers[name] = value;
    });
    return { path: new URL(request.url).pathname, headers };
  });
  const scenarios: Scenario[] = [
    {
      name: "signature (verified_by_signature)",
      expected: "verified_by_signature allow",
      requests: signed,
    },
    {
      name: "ip (verified_by_ip)",
      expected: "verified_by_ip allow",
      requests: [
        {
          path: "/docs",
          headers: {
            "user-agent":
              "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
            "x-forwarded-for": crawlerAddress,
          },
        },
      ],
    },
    {
      name: "ip (claimed_failed)",
      expected: "claimed_failed block",
      requests: [
        {
          path: "/docs",
          headers: {
            "user-agent": "Mozilla/5.0 (compatible; ClaudeBot/1.0)",
            "x-forwarded-for": "216.244.7.10",
          },
        },
      ],
    },
    {
      name: "no claim (human)",
      expected: "human allow",
      requests: [{ path: "/", headers: { ...BROWSER, "x-forwarded-for": "203.0.113.30" } }],
    },
  ];

  const results: {
    name: string;
    outcome: string;
    expected: string;
    p50: number;
    p95: number;
    p99: number;
    max: number;
  }[] = [];
  for (const scenario of scenarios) {
    durations = [];
    for (let i = 0; i < WARMUP + SAMPLES; i++) {
      const { path, headers } = scenario.requests[
        i % scenario.requests.length
      ] as Scenario["requests"][number];
      const response = await fetch(`${base}${path}`, { headers });
      await response.arrayBuffer();
      if (i === WARMUP - 1) durations = [];
    }
    results.push({
      name: scenario.name,
      outcome: last,
      expected: scenario.expected,
      ...percentiles(durations),
    });
  }
  middleware.close();
  await new Promise((resolve) => server.close(resolve));

  console.log(`\nExpress middleware (@posterna/express), ${machine()}`);
  console.log(
    `${SAMPLES} requests per scenario over HTTP after ${WARMUP} warm-up requests; time inside the middleware.\n`,
  );
  console.log("| Scenario | Verdict and action | p50 ms | p95 ms | p99 ms | max ms |");
  console.log("|---|---|---|---|---|---|");
  for (const r of results) {
    console.log(
      `| ${r.name} | ${r.outcome} | ${r.p50.toFixed(3)} | ${r.p95.toFixed(3)} | ${r.p99.toFixed(3)} | ${r.max.toFixed(3)} |`,
    );
  }
  const wrong = results.filter((r) => r.outcome !== r.expected);
  const over = results.filter((r) => r.p99 >= BUDGET_MS);
  if (wrong.length > 0) {
    console.error(
      `\nUnexpected results: ${wrong.map((r) => `${r.name} got ${r.outcome}`).join("; ")}`,
    );
    process.exitCode = 1;
  }
  if (over.length > 0) {
    console.error(`\nOver the ${BUDGET_MS} ms p99 budget: ${over.map((r) => r.name).join(", ")}`);
    process.exitCode = 1;
  } else {
    const worst = Math.max(...results.map((r) => r.p99));
    console.log(
      `\nAll scenarios are under the ${BUDGET_MS} ms p99 budget (worst p99 ${worst.toFixed(3)} ms).`,
    );
  }
}

await main();
