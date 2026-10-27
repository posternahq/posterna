# Hot path benchmark

`pnpm bench` runs two benchmarks: `packages/core/bench/verify.bench.ts` (verify and decide, called directly) and `packages/express/bench/middleware.bench.ts` (the same requests through the Express middleware in a running app). CI runs both in the `Bench` job on every push and pull request, and the job fails when any scenario's p99 is 5 ms or more (docs/SPEC.md section 10). Shared setup is in `packages/core/bench/fixtures.ts`.

## Method

- **Directory:** the real snapshot in `packages/directory/data` (every operator, every IP prefix, every key), plus the conformance suite's `example-signer` operator and its keys. All keys are imported before timing starts (warm cache).
- **Scenarios**, each measured on its own:
  - `signature`: a request signed by `example-signer`, covering `@authority`, `Signature-Agent`, `@method` and `@path`. Every sample has its own nonce, so the replay check records a new entry each time, as it would in production. Result `verified_by_signature`.
  - `ip (verified_by_ip)`: a Googlebot claim from an address in Google's published common-crawlers list.
  - `ip (claimed_failed)`: a ClaudeBot claim from an AWS address outside Anthropic's list.
  - `no claim (human)`: an ordinary browser request.
- **Policy:** an enforcing policy with a rule at every evaluation step (defaults, purposes, an operator throttle, sign-up scopes) and 40 path rules, so every decision scans the full path list.
- **Timing:** 500 warm-up requests, then 5,000 timed requests per scenario, one at a time, with `performance.now()` around the work the middleware does per request: `verify()`, then `decide()`, then `enforcementResponse()`. That includes request normalization, client address resolution, claim identification, the signature or IP check, and policy evaluation with its safety rails. Building the `Request` objects and signing the test requests happen beforehand and are not timed.
- **Excluded:** reverse DNS, which runs in the background and never on the request path (`dns: null` in the benchmark), and directory refreshes.
- **Reported:** p50, p95, p99 and max per scenario, with the verdict and decision. The run fails on p99 of 5 ms or more, or on an unexpected verdict or decision. The `claimed_failed` scenario is a flood of 5,500 failed claims, so the breaker trips after the first 20 and later blocks are recorded as not enforced, as they would be in production.

## Through the Express middleware

The second benchmark starts an Express app with `posterna()` in front of a trivial route, sends 5,500 requests per scenario over HTTP on the loopback interface (500 warm-up), and times only the middleware for each request:
- stripping inbound headers;
- `verify()` and `decide()`;
- setting `req.posterna` and the verdict headers;
- counting (local-only, no site key);
- the block or throttle response when there is one.

The requests come from 127.0.0.1 with `X-Forwarded-For` naming the client, and the middleware trusts the loopback proxy, as behind nginx. The HTTP client and Express routing are not timed.

## Results

| Machine | Signature p99 | IP p99 | Worst p99 | Headroom |
|---|---|---|---|---|
| Apple M3, Node 24.13, macOS (26 October 2026), Express middleware | 0.232 ms | 0.025 ms | 0.232 ms | about 21x |
| Apple M3, Node 24.13, macOS (26 October 2026), verify and decide | 0.176 ms | 0.007 ms | 0.176 ms | about 28x |
| Apple M3, Node 24.13, macOS (26 October 2026), verify only | 0.170 ms | 0.005 ms | 0.170 ms | about 29x |
| GitHub Actions `ubuntu-latest`, 2 vCPUs (AMD EPYC 7763), Node 22.23 (26 October 2026, commit `eab371d`), verify and decide | 1.284 ms | 0.049 ms | 1.284 ms | about 3.9x |
| GitHub Actions `ubuntu-latest`, 2 vCPUs (Intel Xeon Platinum 8573C), Node 22.23 (26 October 2026, commit `b6dbcdd`), verify only | 1.379 ms | 0.026 ms | 1.379 ms | about 3.6x |

Every run prints its numbers in the `Bench` job log. GitHub's standard Linux runners have 2 vCPUs for private repositories and 4 for public ones, and are noisy: on the `b6dbcdd` run the signature path's p50 was 0.263 ms but its single slowest request took 6.6 ms. The budget applies to p99, which stayed at 1.4 ms, so CI has about 3.6x headroom on the signature path and far more on the IP path. If the signature p99 in CI starts creeping toward 5 ms, look at the runner before the code: the same commit runs eight times faster on a laptop.

Almost all of the signature path is the Ed25519 verification itself (Web Crypto, inside Cloudflare's library). The IP path is a binary search over merged prefix ranges compiled when the directory loads. Policy evaluation adds about a microsecond: path patterns are compiled and sorted once, and each decision is a short scan plus map lookups.
