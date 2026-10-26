# Hot path benchmark

`pnpm bench` runs `packages/core/bench/verify.bench.ts`. CI runs it in the `Bench` job on every push and pull request, and the job fails when any scenario's p99 is 5 ms or more (docs/SPEC.md section 10).

## Method

- **Directory:** the real snapshot in `packages/directory/data` (every operator, every IP prefix, every key), plus the conformance suite's `example-signer` operator and its keys. All keys are imported before timing starts (warm cache).
- **Scenarios**, each measured on its own:
  - `signature`: a request signed by `example-signer`, covering `@authority`, `Signature-Agent`, `@method` and `@path`. Every sample has its own nonce, so the replay check records a new entry each time, as it would in production. Result `verified_by_signature`.
  - `ip (verified_by_ip)`: a Googlebot claim from an address in Google's published common-crawlers list.
  - `ip (claimed_failed)`: a ClaudeBot claim from an AWS address outside Anthropic's list.
  - `no claim (human)`: an ordinary browser request.
- **Timing:** 500 warm-up requests, then 5,000 timed requests per scenario, one at a time, with `performance.now()` around each `verify()` call. That includes request normalization, client address resolution, claim identification and the signature or IP check. Building the `Request` objects and signing the test requests happen beforehand and are not timed.
- **Excluded:** reverse DNS, which runs in the background and never on the request path (`dns: null` in the benchmark), and directory refreshes.
- **Reported:** p50, p95, p99 and max per scenario. The run fails on p99 of 5 ms or more, or on an unexpected verdict.

## Results

| Machine | Signature p99 | IP p99 | Worst p99 | Headroom |
|---|---|---|---|---|
| Apple M3, Node 24.13, macOS (26 October 2026) | 0.170 ms | 0.005 ms | 0.170 ms | about 29x |

The CI numbers are printed in the `Bench` job log. GitHub's standard Linux runners have 2 vCPUs for private repositories and 4 for public ones and are several times slower than a laptop for single-threaded work. Even a 10x slowdown keeps the signature path under 2 ms, so the 5 ms budget leaves room for runner noise without making the check meaningless.

Almost all of the signature path is the Ed25519 verification itself (Web Crypto, inside Cloudflare's library). The IP path is a binary search over merged prefix ranges compiled when the directory loads.
