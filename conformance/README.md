# Conformance vectors

Language-neutral test vectors for the Posterna verifier.

Each vector is a JSON file describing requests, the configuration and directory they run against, and the exact result an implementation must produce. The TypeScript runner (`packages/core/test/conformance.test.ts`) runs every vector as part of `pnpm test`, once with a Fetch API `Request` and once with a Node `IncomingMessage`. Future ports (PHP and Python are planned) prove they behave the same by running the same files. Nothing in a vector depends on a programming language.

`pnpm conformance:generate` rewrites the fixtures and vectors (`packages/core/test/conformance/generate.ts`). Signed requests are made with Cloudflare's `web-bot-auth` and `http-message-sig` signers and the throwaway keys in `fixtures/keys/`. Ed25519 is deterministic, so regenerating gives identical files. Expected results are written by hand in the generator from docs/SPEC.md; they are never computed by Posterna's verifier.

## Layout

```text
conformance/
  vectors/<area>/<name>.json     one vector per file; the id is the path without .json
  fixtures/directory.json        operator directory used by every verify vector
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
      "expected": { "verdict": "verified_by_ip", "operator": "rdns-crawler", "agent": "ExampleRdnsBot", "purpose": "training", "method": "rdns", "error": false }
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
- `expected` fields: `verdict` always; `operator`, `agent`, `purpose` (`null` means absent); `method`; `error` (whether `error` is set, meaning a fail-open path was taken); optionally `stripped` (inbound headers removed), `client` (the resolved client address) and `verdict_headers`.
- `expected_state` is checked after all steps: the proxy guard, whether an early keys refresh was requested, how many fetches happened, and a minimum error count.

### `rfc9421`

Published test vectors checked directly against Cloudflare's library: RFC 9421 Appendix B.2.6 (`profile: "rfc9421"`, verified with `http-message-sig`) and the protocol draft's Appendix E.2 (`profile: "web-bot-auth"`). Fields: `public_key` (JWK), `keyid`, `label`, `now` (seconds), `request` (`method`, `target_uri`, `headers`), and `expected.valid`.

### `key_directory`

A snapshot of a live operator key directory with the expected key count, kid convention (`thumbprint`, `short_id` or `none`), and each key's kid and RFC 7638 thumbprint.

## Rules

- **No network, no wall clock.** DNS answers come from the vector and time from `now`. A runner never makes a real network call.
- **Throwaway keys only.** The keys in `fixtures/keys/` exist only for these tests. Never use them anywhere else. The RFC 9421 example key appears only where a published vector uses it.
- **Every verifier or policy change adds or updates a vector.**
