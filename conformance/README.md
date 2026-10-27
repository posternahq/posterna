# Conformance vectors

Language-neutral test vectors for the Posterna verifier and policy engine.

Each vector is a JSON file describing requests or labeled results, the configuration, policy and directory they run against, and the exact result an implementation must produce. The TypeScript runner (`packages/core/test/conformance.test.ts`) runs every vector as part of `pnpm test`; `verify` vectors run once with a Fetch API `Request` and once with a Node `IncomingMessage`. Future ports (PHP and Python are planned) prove they behave the same by running the same files. Nothing in a vector depends on a programming language.

`pnpm conformance:generate` rewrites the fixtures and vectors (`packages/core/test/conformance/generate.ts`). Signed requests are made with Cloudflare's `web-bot-auth` and `http-message-sig` signers and the throwaway keys in `fixtures/keys/`. Ed25519 is deterministic, so regenerating gives identical files. Expected results are written by hand in the generator from docs/SPEC.md and docs/policy.md (policy vectors live in `packages/core/test/conformance/policy-vectors.ts`); they are never computed by Posterna's verifier or policy engine.

## Layout

```text
conformance/
  vectors/<area>/<name>.json     one vector per file; the id is the path without .json
  fixtures/directory.json        operator directory used by every verify, decide and robots vector
  fixtures/keys.json             signing keys for the fixture operators
  fixtures/keys/*.json           throwaway Ed25519 private keys (test use only)
  fixtures/directory-signer.json public key the runner trusts for refresh tests
  fixtures/key-directories/      snapshots of live operator key directories
```

The fixture directory holds synthetic operators under reserved names (`.example`, `.test`, documentation address ranges), plus frozen copies of the real Anthropic and Google records for the spoof cases, taken from the operator directory on 26 October 2026.

## Vector types

### `verify`

```json
{
  "id": "ip/rdns-confirmed",
  "description": "One sentence on what is tested and why.",
  "spec": ["4.5"],
  "type": "verify",
  "now": "2026-10-26T12:00:00Z",
  "config": { "trustedProxies": ["10.0.0.0/8"], "forwardedHeader": "x-forwarded-for", "publicHost": "www.site.example", "reverseDns": { "timeoutMs": 50 } },
  "dns": { "reverse": { "203.0.113.40": ["node-7.crawl.example."] }, "forward": { "node-7.crawl.example": ["203.0.113.40"] } },
  "inject": { "snapshot": "missing", "dns": "timeout", "clock": "invalid", "signature_library": "throws" },
  "refresh": { "enabled": true, "responses": { "directory.json": { "status": 200, "body": "..." } } },
  "steps": [
    {
      "settle_before": false,
      "repeat": 1,
      "request": { "method": "GET", "scheme": "https", "path": "/", "remote_address": "203.0.113.40", "headers": [["host", "www.site.example"], ["user-agent", "..."]] },
      "expected": { "verdict": "verified_by_ip", "reason": null, "operator": "rdns-crawler", "agent": "ExampleRdnsBot", "purpose": "training", "method": "rdns", "error": false }
    }
  ],
  "expected_state": { "proxySuspect": false, "keys_refresh_requested": true, "fetches": 0, "errors_at_least": 1 }
}
```

- `now` is the verifier's clock for the whole vector.
- `config` holds verifier options. Absent means defaults (docs/SPEC.md section 12).
- `dns` answers reverse and forward lookups. `null` means the runtime has no DNS (edge). Absent means every lookup finds nothing.
- `inject` simulates failures: a `missing` or `malformed` snapshot, a DNS `timeout` or `error`, an `invalid` clock, or a signature library that `throws`.
- `refresh`, when enabled, makes the runner trust `fixtures/directory-signer.json` and answer downloads from `responses` (keyed by file name under the base URL; anything else is 404). Without it, refresh is off.
- Each step either has `"action": "refresh"` (refresh the directory now) or a `request` and its `expected` result. `headers` is an ordered list of name and value pairs because order and repeats matter. `settle_before` waits for background work (reverse DNS lookups, refreshes) before the step. `repeat` sends the same request that many times.
- `expected` fields: `verdict` always; `reason` (the reason code, `null` when there must be none); `operator`, `agent`, `purpose` (`null` means absent); `method`; `error` (whether `error` is set, meaning a fail-open path was taken); optionally `stripped` (inbound headers removed), `client` (the resolved client address) and `verdict_headers`.
- `expected_state` is checked after all steps: the proxy guard, whether an early keys refresh was requested, how many fetches happened, and a minimum error count.

### `rfc9421`

Published test vectors checked directly against Cloudflare's library: RFC 9421 Appendix B.2.6 (`profile: "rfc9421"`, verified with `http-message-sig`) and the protocol draft's Appendix E.2 (`profile: "web-bot-auth"`). Fields: `public_key` (JWK), `keyid`, `label`, `now` (seconds), `request` (`method`, `target_uri`, `headers`), and `expected.valid`.

### `key_directory`

A snapshot of a live operator key directory with the expected key count, kid convention (`thumbprint`, `short_id` or `none`), and each key's kid and RFC 7638 thumbprint.

### `decide`

Runs labeled results through the policy engine (docs/SPEC.md section 5) and checks each decision and, where given, the HTTP response the middleware would send.

```json
{
  "id": "policy/throttle/timing",
  "description": "One sentence on what is tested and why.",
  "spec": ["5.2"],
  "type": "decide",
  "now": "2026-10-26T12:00:00Z",
  "policy": "version: 1\nmode: enforce\n...",
  "template": "saas-signup",
  "env": { "POSTERNA_MODE": "monitor" },
  "proxy_suspect": false,
  "steps": [
    { "set_remote_override": "monitor", "expected_accepted": true },
    {
      "at": 5,
      "repeat": 1,
      "result": { "verdict": "verified_by_signature", "operator": "example-signer", "agent": "ExampleAgent", "purpose": "agent", "method": "signature" },
      "context": { "path": "/", "kind": "page" },
      "expected": {
        "action": "throttle", "enforced": true, "rule": "operators.example-signer.agent", "retry_after": 15, "guarded": false, "error": false,
        "response": { "status": 429, "headers": { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Posterna-Action": "throttle", "Retry-After": "15" }, "body": "Rate limited by this site's agent policy. Retry after 15 seconds." }
      }
    }
  ],
  "expected_state": { "mode": "monitor", "configured_mode": "enforce", "suspensions": ["env"], "remote_override": null, "proxy_suspect": false, "breaker_tripped": [], "guarded": 0, "errors_at_least": 0 }
}
```

- `policy` is agents.yaml text. `template` names the shipped template it must equal byte for byte.
- `env` is the environment the engine reads at start (absent means empty). `proxy_suspect` is what the verifier's proxy guard reports.
- The engine looks up operators and agents in `fixtures/directory.json`, which decides who is a search engine.
- `at` is seconds after `now` (fractions allowed); a step without it keeps the previous step's time. `repeat` decides the same result that many times, and `expected` holds for every repetition.
- A step with `set_remote_override` passes that value to the remote override setter and checks whether it was accepted.
- `expected`: `rule` and `retry_after` are null when absent; `guarded` and `error` say whether those fields are set. `response` is the enforcement response (header names compared case-insensitively), or null when the request proceeds. The `reason` text is not compared.
- `expected_state` is checked after the last step, at its time.

### `policy_check`

Validation of agents.yaml documents: `cases` is a list of `{ policy, valid, mode?, template?, errors? }`. `errors`, when given, is every error's dotted path and line (`""` for the document itself). YAML syntax errors are only checked for `valid: false`, since parsers place them differently.

### `robots`

`policy` and `directory` in, the exact robots.txt text out (`expected`), as `posterna robots` prints it (docs/SPEC.md section 5.6).

## Rules

- **No network, no wall clock.** DNS answers come from the vector and time from `now` (plus `at` in policy vectors). A runner never makes a real network call. A `remote_address` of `null` is a request without a socket address, as in Next.js middleware.
- **Throwaway keys only.** The keys in `fixtures/keys/` exist only for these tests. Never use them anywhere else. The RFC 9421 example key appears only where a published vector uses it.
- **Every verifier or policy change adds or updates a vector.**
