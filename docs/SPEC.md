# Posterna v1 specification (open-source packages)

Status: v1 build spec, 26 October 2026. This file is the source of truth for the code in this repository. When code and spec disagree, fix one of them in the same change.

## 1. What Posterna is

Posterna lets any website or API verify which AI agents and crawlers are hitting it, decide what each may do, and see the result. It runs inside the site's own process. There is no proxy, no CDN and no DNS change.

Principles, in priority order:

1. Never break the site. Every error path fails open: the request proceeds, labeled, and a counter records the error.
2. Monitor by default. A fresh install changes nothing; it labels and counts. Enforcement is a deliberate switch.
3. Label, never score. Unknown automation is a label. No behavioral scoring, no fingerprinting, no challenge of our own.
4. Counters leave the origin; requests never do. Nothing per-request (IPs, full URLs, headers, bodies) is ever sent anywhere.
5. Build on standards and existing libraries: RFC 9421 HTTP Message Signatures, RFC 7638 JWK thumbprints, the IETF Web Bot Auth drafts, Cloudflare's open-source web-bot-auth packages. Never hand-roll canonicalization or cryptography.
6. Five milliseconds. The hot path stays under 5 ms at p99 with a warm cache.

## 2. Packages

| Package | License | Contents |
|---|---|---|
| `@posterna/core` | MIT | Schemas and types, directory loader and signature check, verifier, policy engine, counters client, `verify()` and `decide()` APIs |
| `@posterna/directory` | CC BY 4.0 (data), MIT (code) | The operator directory snapshot (directory.json, keys.json, agents.csv, summary.json) and its build pipeline |
| `@posterna/express` | MIT | Express middleware |
| `@posterna/next` | MIT | Next.js integration (middleware.ts on Next 15, proxy.ts on Next 16; check current Next.js docs) |
| `posterna` | MIT | CLI: `init`, `doctor`, `robots`, `policy check` |

`conformance/` holds language-neutral test vectors (JSON) so future PHP and Python ports can prove they match.

## 3. The operator directory

### 3.1 Files

- `directory.json`: one record per operator (schema below). Rebuilt daily by a scheduled GitHub Action that opens a pull request when data changes; a human reviews and merges. Which key-directory URLs and IP-list URLs are trusted is decided here, by review.
- `keys.json`: the current public keys fetched from each signing operator's key directory URL as listed in directory.json. Refreshed hourly by the Posterna cloud service without review, because the trust decision (which URL) was already reviewed and the key material comes from the operator's own HTTPS endpoint.
- `agents.csv`, `summary.json`: flat export and counts.

Both JSON files are published at `https://posterna.com/v1/directory.json` and `https://posterna.com/v1/keys.json`, each with a detached signature at the same URL plus `.sig`: Ed25519 over the exact file bytes, base64url. `@posterna/core` embeds the list of trusted Posterna directory public keys and rejects any file whose signature does not verify. Every package release also bundles a snapshot of both files as the fallback.

Build pipeline (in `packages/directory`):

- `sources/<slug>.yaml`: one hand-curated file per researched operator. Every fact cites a source page; quotes are verbatim. `sources/README.md` documents the format.
- `pnpm directory:fetch` downloads robots.json, every cited page, IP list and key directory into `raw/` (not committed) and records each outcome in `raw/manifest.json` (committed). It identifies as `PosternaDirectoryBuilder/0.1 (+https://posterna.com/directory)`, honors robots.txt (RFC 9309), uses timeouts and never retries.
- `pnpm directory:build` writes `data/` and `docs/directory-build-report.md`, validates both JSON files against the JSON Schemas in `packages/core/src/schema/`, and fails on invalid or duplicate data. It checks every quote, token and documented URL against the fetched copy of the page it cites and reports the result.
- `pnpm directory:sign <file>` writes the `.sig` file from a private JWK in `POSTERNA_DIRECTORY_SIGNING_KEY`.
- When this build cannot fetch an IP list, it keeps the last published prefixes with their original fetch date and says so in the list's note.

### 3.2 Operator record

- `slug`, `name`, `website`, `docs_url`, `coverage` (`researched` or `community`)
- `verification.signing`: `status` (`live`, `reported`, `none_found`, `pending`, `not_probed`), `directory_url`, `kid_convention` (`thumbprint`, `short_id`, `none`), `purpose_field`, `covers` (agent names), `note`, `sources`
- `verification.ip_lists`: list of `{agent, url, format, prefix_count, fetched_at, sha256}`
- `verification.reverse_dns`: `{suffixes: [...], forward_confirm: true}` or null
- `verification.asn`: list of `{asn, note}`
- `agents`: list of `{name, user_agent_tokens: [...], purpose, search_engine: bool, robots_token, robots_policy (honors, may_ignore, unstated), robots_quote, ip_list_agent, signs: bool, note, sources}`. Purposes: `training`, `search`, `user_fetch`, `agent`, `preview`, `ads`, `other`.
- `observed`: empty in v1 (filled later only from opted-in counters, always with sample sizes and date windows)
- `enrollment`: `{status: none | requested | enrolled}`
- `identity_anchors`: list, schema only in v1
- `sources`: list of `{url, title, fetched_at}`

Additions to the record above, used by the build:

- directory.json wraps the records: `{schema: 1, version (YYYY-MM-DD), generated_at, license: "CC-BY-4.0", attribution, operators: [...]}`, operators sorted by slug.
- Operator: `note`.
- Agent: `coverage` (`researched` when the facts come from the operator's own documentation, `community` when they come only from ai.robots.txt; a researched operator can have community agents), `aliases` (other names the operator's docs or ai.robots.txt use), and `purpose_quote` (the short quote behind `purpose`; null for community agents). `user_agent_tokens` may be empty for robots-only control tokens (such as Google-Extended) and for agents identified only by signature.
- `verification.ip_lists[]`: also `prefixes` (normalized: strict dotted-quad IPv4 or RFC 5952 IPv6, host bits cleared, deduplicated, IPv4 first then numeric order), `note` and `sources` (the page that documents the list URL). `prefix_count` counts normalized prefixes; `sha256` is of the fetched file bytes.
- `verification.reverse_dns` and each `verification.asn` entry: also `note` and `sources`.
- Signing `status`: `live` when the key directory was fetched in the build and held at least one valid public key; `none_found` when nothing is documented or reported, or the URL returned 404 or no valid keys; `reported` when a documented or reported directory could not be fetched (robots.txt, timeout, error) or no URL is known; `pending` only for Posterna's own probe; `not_probed` for community operators. `kid_convention` is derived from the fetched keys.

keys.json: `{version, generated_at, operators: {<slug>: {directory_url, fetched_at, status, keys: [{jwk, thumbprint, kid, first_seen, last_seen}]}}}`. `version` is the build hour, `YYYY-MM-DDTHH`. Every key carries an RFC 7638 thumbprint computed by Posterna, whatever kid convention the operator uses. Only public JWK members are stored; a key published with private members is rejected.

### 3.3 Content rules

- Never invent a URL, key, prefix, user-agent token or quote. Every fact has a source with a fetch date.
- `signs: true` and signing `status: live` only when a key directory was fetched and parsed. Third-party sightings are `reported`.
- Purposes come from the operator's own documentation with a short quote; otherwise from ai.robots.txt, labeled `community`.
- Breadth comes from ai.robots.txt (MIT, credited in NOTICE). The directory does not try to catalog every SEO or monitoring bot.
- Posterna lists itself as operator `posterna` with agent `PosternaProbe` (purpose `other`), signing through `https://posterna.com/.well-known/http-message-signatures-directory`.

### 3.4 Distribution to installs

On startup, core loads the bundled snapshot, then refreshes in the background: directory.json every 24 hours with jitter, keys.json every hour, and keys.json early when an unknown kid is seen (at most once per 10 minutes). Refresh never blocks a request. A failed refresh keeps the last good copy. Installs never fetch an operator's key directory directly, and never fetch any URL because a request named it.

## 4. The verifier

### 4.1 Inputs

A Fetch API `Request` or a Node `IncomingMessage`, plus configuration: `trustedProxies`, `publicHost`, `directory` options. Output is a `VerdictResult`; the verifier never throws to its caller.

### 4.2 Client IP and host resolution

- `trustedProxies`: a list of CIDRs (or a hop count) for the proxies in front of the app. The client IP is the rightmost address in `X-Forwarded-For` (or `Forwarded`) that is not a trusted proxy. With no configuration, the socket address is used and `X-Forwarded-For` is ignored.
- `publicHost`: the hostname agents sign (`@authority`). If set, it is used. Otherwise `X-Forwarded-Host` is honored only from a trusted proxy, else `Host`.
- Runtime proxy guard: if 80 percent or more of the last 200 requests resolve to private, loopback, link-local or carrier-grade NAT addresses, the install marks itself `proxySuspect`, suspends all enforcement, and reports the state. This is the misconfiguration that would make real Googlebot look spoofed.

### 4.3 Identifying the claim

1. If a `Signature-Agent` header is present, parse it (string or dictionary form) and match its URL against the directory's signing operators.
2. Otherwise match `User-Agent` against directory agents: exact token match first, then pattern.
3. No match: no claim.

### 4.4 Signature path

- Only operators whose `directory_url` is in the loaded directory are eligible. A `Signature-Agent` naming an unknown URL is a claim that cannot be verified: `declared_unverifiable`, never a network fetch.
- Keys come from keys.json. Match by kid; when the operator uses no kid, try each key; when the kid is unknown, the request is `declared_unverifiable` and an early keys refresh is scheduled.
- Verify the RFC 9421 signature with Cloudflare's libraries over the covered components the drafts require (including `@authority` and `signature-agent`), checking `created` and `expires` with 60 seconds of clock skew and a maximum validity window of 5 minutes, the `tag` parameter where the drafts define it, and nonce replay against a per-instance LRU.
- Valid: `verified_by_signature`. Present but invalid: `claimed_failed`.

### 4.5 IP and reverse DNS path

- IP lists are compiled at load time into a prefix matcher (IPv4 and IPv6). A match: `verified_by_ip`.
- If the operator documents reverse DNS: forward-confirmed reverse DNS (resolve PTR, require the suffix, resolve the name forward, require the original IP). Lookups run in the background with a 1 second timeout and are cached (positive 24 hours, negative 1 hour). A request whose lookup is not cached yet is `declared_unverifiable` while the lookup runs; later requests from that IP get the cached result.
- A claim for an operator that publishes ranges or rDNS rules, from an address that fails both: `claimed_failed`.
- A claim for an operator that publishes neither keys, nor ranges, nor rDNS rules: `declared_unverifiable`.
- Runtimes without `node:dns` (edge runtimes) skip rDNS and use `declared_unverifiable` where rDNS would have decided.

### 4.6 Verdicts and API

Verdicts: `verified_by_signature`, `verified_by_ip`, `declared_unverifiable`, `claimed_failed`, `unknown_automation`, `human`.

`unknown_automation` versus `human` uses only signals already in the request (a non-browser User-Agent token, absent headers every mainstream browser sends). This is labeling, not scoring, and must never grow into fingerprinting.

```ts
type VerdictResult = {
  verdict: Verdict;
  operator?: string;      // directory slug
  agent?: string;
  purpose?: Purpose;
  method?: "signature" | "ip" | "rdns" | "none";
  note?: string;          // human-readable reason
  error?: string;         // set when a fail-open path was taken
};
verify(request, options?): Promise<VerdictResult>
decide(result, { path, kind?: "page" | "signup" }): Decision
type Decision = { action: Action; enforced: boolean; rule?: string; reason: string };
```

### 4.7 Headers

- Inbound: strip any `X-Agent-*` and `X-Posterna-*` headers from the incoming request before anything else, so no client can forge a verdict for the application or downstream services.
- Outbound to the application (request headers, names configurable): `X-Agent-Verdict`, `X-Agent-Operator`, `X-Agent-Purpose`, `X-Agent-Method`.
- On enforced responses: `X-Posterna-Action`.

### 4.8 Failing open

Missing or malformed directory, signature library errors, DNS errors or timeouts, clock problems, unexpected exceptions: the request proceeds with `unknown_automation` (if it looked automated) or `human`, `error` is set, and an error counter increments. A failure never produces `claimed_failed` and never blocks.

## 5. Policy: agents.yaml

### 5.1 Example

```yaml
version: 1
mode: monitor              # monitor | enforce
defaults:                  # by verdict class; human is always allowed and not configurable
  verified: allow
  declared_unverifiable: allow
  claimed_failed: allow
  unknown_automation: allow
guards:
  search_engines: protect  # protect | off
purposes:                  # applies to every operator
  training: block
operators:
  openai:
    agent: { action: throttle, rate: 60/min }
paths:
  "/api/*":
    claimed_failed: block
    monitor: true          # this rule logs what it would do even when mode is enforce
signup:                    # recommendations returned by decide(); the application enforces them
  "/signup":
    verified: lift
    claimed_failed: challenge
    unknown_automation: challenge
emit: [robots.txt, content-signals]
```

### 5.2 Actions

- Page and API traffic, enforced by the middleware: `allow`, `block` (403), `throttle` (429 with `Retry-After`; token bucket per operator per instance; rate as `N/sec|min|hour`).
- Sign-up scopes, returned by `decide()` for the application to act on: `lift` (skip a friction step), `cap` (apply the app's own limits), `challenge` (hand to the app's existing CAPTCHA or similar). Posterna builds no challenge.

Block body (text/plain): `This site's policy does not allow this agent ({operator}, {purpose}). Operators can get verified at https://posterna.com/operators`. Throttle body: `Rate limited by this site's agent policy. Retry after {n} seconds.`

### 5.3 Evaluation order

1. Suspensions: `POSTERNA_MODE=monitor` environment variable, remote monitor override from the cloud, proxy guard, breaker for the claimed operator. Any of these turns the decision into "would have" (not enforced).
2. Human: always allow.
3. Guards.
4. The most specific matching path rule (verdict class and purpose keys).
5. Operator rule for the purpose.
6. `purposes` rule.
7. Defaults by verdict class.

`unknown_automation` is only ever acted on by a rule that names it explicitly; no template sets it to anything but allow. A rule with `monitor: true`, or global `mode: monitor`, records the action with `enforced: false`.

### 5.4 Safety rails

- Search-engine guard (`protect`, the default): agents flagged `search_engine` in the directory are never blocked or throttled when verified. A `claimed_failed` claim of a protected agent is enforced only if this instance has seen at least one verified request from that operator in the past 7 days and the breaker is not tripped for it; otherwise the action is downgraded to allow and recorded as `guarded`. `off` must be written explicitly.
- Breaker: for operators verified by IP or rDNS, in a rolling 10 minute window per instance, if there are at least 20 claims and 50 percent or more are `claimed_failed`, all enforcement against that operator's claims is suspended for 60 minutes and the state is reported.
- Proxy guard: section 4.2.
- Kill switches: the local environment variable, and the remote override delivered in the ingest response. The remote switch can only move an install to monitor, never to enforce. If the cloud is unreachable nothing changes.

### 5.5 Templates

`monitor` (everything allow), `allow-list` (training blocked, everything else allowed), `saas-signup` (allow-list plus a signup scope with lift for verified and challenge for claimed_failed and unknown_automation). Every template starts with `mode: monitor`.

### 5.6 Emitters

`posterna robots` writes robots.txt from the policy: one group per robots token for agents that honor robots, grouped by purpose, plus Content Signals. The policy engine enforces against agents that do not honor robots.txt.

## 6. Adapters

- Express: `app.use(posterna(options))`. Sets `req.posterna` (VerdictResult and Decision) and the verdict headers, applies enforced actions, records counters.
- Next.js: a wrapper for middleware.ts (Next 15, Node runtime where available) and proxy.ts (Next 16). Route handlers can call `verify()` and `decide()` directly.
- Debug route `/.well-known/posterna/debug`: disabled unless `POSTERNA_DEBUG_TOKEN` is set, and then only answers requests carrying that token in `X-Posterna-Debug-Token`. Returns JSON: resolved client IP and which header or hop produced it, the host used for `@authority`, which signature headers arrived, the verdict for this request, directory version, mode and active suspensions. Used by `posterna doctor`.

## 7. Counters client

- Aggregates in memory per key `(hour, verdict, operator, agent, purpose, pathGroup, action, enforced)` with `count` and `bytes` (response bytes when known).
- `pathGroup` is the matched policy path pattern, else the first path segment (`/docs/*`), capped at 50 distinct groups per flush with the rest in `other`.
- Flushes every 60 seconds, on process exit, and through `waitUntil` where the platform offers it. Exponential backoff; data older than 10 minutes is dropped. Never blocks a request.
- Without a site key it runs local-only and sends nothing.

Payload, `POST https://posterna.com/v1/ingest`, `Authorization: Bearer <site key>`, optionally gzip:

```json
{
  "schema": 1,
  "sdk": { "name": "@posterna/express", "version": "0.1.0", "runtime": "node-22" },
  "instance": "random-id-per-process",
  "mode": "monitor",
  "state": { "proxySuspect": false, "breakerTripped": [], "guarded": 0, "errors": 0, "directoryVersion": "2026-10-27", "keysVersion": "2026-10-27T18", "policyHash": "sha256-prefix" },
  "buckets": [
    { "hour": "2026-10-28T17:00:00Z", "verdict": "verified_by_ip", "operator": "google", "agent": "Googlebot", "purpose": "search", "pathGroup": "/docs/*", "action": "allow", "enforced": false, "count": 12, "bytes": 345678 }
  ]
}
```

Response: `{ "accepted": <n>, "modeOverride": null | "monitor" }`.

## 8. CLI

- `posterna init`: detect Express or Next.js from package.json, choose a template (default `monitor`), write agents.yaml, print the exact code to add (v1 makes no automatic code edits), optionally take a site key from the dashboard and add `POSTERNA_SITE_KEY` to the env file after confirmation.
- `posterna doctor --url <site>`: learn this machine's public IP from `https://posterna.com/v1/whoami`, send a request signed with an ephemeral key to the site's debug route, and report pass or fail with the fix for: client IP resolution, `@authority` host, signature headers surviving proxies, directory freshness, mode and suspensions.
- `posterna robots`: print robots.txt and Content Signals from agents.yaml.
- `posterna policy check`: validate agents.yaml with clear errors.

## 9. Security requirements

1. Strip inbound verdict headers (4.7).
2. Never fetch a URL taken from a request (no SSRF from customer servers).
3. Verify signatures on directory.json and keys.json against embedded keys; reject unsigned or invalid files.
4. Trusted-proxy handling as in 4.2; with no configuration, ignore forwarding headers.
5. Never log or transmit IPs, full URLs, header values or bodies.
6. Fail open everywhere (4.8).
7. Pin dependency versions; no install scripts in published packages.

## 10. Performance

p99 under 5 ms per request on a warm cache for the signature and IP paths, measured by a benchmark that CI runs. rDNS lookups are excluded because they run in the background.

## 11. Testing

- Conformance vectors in `conformance/` (JSON: request, config, directory fixture, expected VerdictResult and Decision). The TypeScript runner executes them; future ports reuse them.
- Signed requests generated with throwaway Ed25519 keys; RFC 9421 published Ed25519 test vectors; snapshots of the live key directories for parsing and thumbprint tests.
- Interop edge cases: parameterized covered components, dictionary-form Signature-Agent, multiple signatures on one request, legacy kid derivation, nonce persistence, clock skew, sf-string serialization.
- Spoof cases: a claimed ClaudeBot from an AWS address, a claimed Googlebot from a non-crawler Google Cloud address, a valid-looking Signature-Agent not in the directory.
- Proxy cases, header stripping, failure injection, policy precedence, guards, breaker, kill switches, throttle timing, emitters, end-to-end tests against example apps with a mock ingest server.

## 12. Defaults

| Setting | Default |
|---|---|
| Clock skew | 60 s |
| Max signature validity | 300 s |
| Nonce LRU | 10,000 entries |
| rDNS timeout, positive TTL, negative TTL | 1 s, 24 h, 1 h |
| directory.json refresh | 24 h with jitter |
| keys.json refresh | 1 h, early on unknown kid at most every 10 min |
| Breaker | 10 min window, 20 claims, 50% failed, 60 min trip |
| Proxy guard | last 200 requests, 80% private |
| Counters flush, path groups, backlog | 60 s, 50, 10 min |
| Hot path budget | 5 ms p99 |

## 13. Not in v1

WordPress plugin, Python adapter, markdown shaping for agents, cost classes, crawl-to-referral threshold, alerts, analytics exports, billing, self-hosted collector, a shared rate-limit store across instances, CDN edge modules, HTTP 402 payments, attribution.
