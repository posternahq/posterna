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

Both JSON files are published at `https://posterna.com/v1/directory.json` and `https://posterna.com/v1/keys.json`, each with a detached signature at the same URL plus `.sig`: Ed25519 over the exact file bytes, base64url. Every package release also bundles a snapshot of both files as the fallback.

Trusted keys. `@posterna/core` embeds `TRUSTED_DIRECTORY_KEYS`, a list of `{ kid, role, generation, added, jwk }`:

- `kid`: the RFC 7638 SHA-256 thumbprint of `jwk`, base64url.
- `role`: `primary` (its private half signs the published files and lives only in the cloud's environment) or `backup` (its private half is kept offline).
- `generation`: a positive integer, one per key, that grows with each new key.
- `added`: the date the key joined the list, `YYYY-MM-DD`.
- `jwk`: `{ kty: "OKP", crv: "Ed25519", x }` and no other member.

Every release from 0.1.0 trusts a primary and a backup, so the cloud can switch to the backup without every install upgrading first. `docs/KEYS.md` has the key table, who holds which private key, planned rotation and the emergency runbook.

Accepting a downloaded file. This runs on refresh, never on the request path.

1. Signature: the file is accepted only if its signature verifies under a trusted key at or above the install's minimum generation. Keys are tried from the highest generation down.
2. Ratchet: the minimum generation starts at the lowest generation in the list. When a file verifies under generation N, the minimum rises to N, and files signed only by lower generations are rejected from then on. The minimum is kept in memory only and is shared by every directory store in the process that uses the same trusted list; a restart starts again from the lowest generation.
3. Anti-rollback: a file signed at the same generation as the loaded copy must not carry an older `version` (`YYYY-MM-DD` for directory.json, `YYYY-MM-DDTHH` for keys.json) than the copy already loaded. The same version is accepted. The bundled snapshot counts as signed at the lowest generation. A file signed at a higher generation replaces the loaded copy whatever its version, so a far-future version signed with a leaked older key cannot block the switch to a newer one.
4. Any rejection keeps the last good copy, increments the error counter and records a specific reason in the last error: `download_failed`, `signature_malformed`, `signature_untrusted`, `signature_retired` (verifies only under a generation below the minimum), `invalid_file`, `version_rollback` or `directory_missing`. It never throws and never blocks a request (4.8).

The verifier state and the debug route report the current minimum generation (`directoryKeyGeneration`, `keyGeneration`).

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
- Signing `status`: `live` when the key directory was fetched in the build and held at least one valid public key; `none_found` when nothing is documented or reported, or the URL returned 404 or no valid keys; `reported` when a documented or reported directory could not be fetched (robots.txt, timeout, error) or no URL is known; `pending` only when set by hand in a source file, for a key directory that is announced but not served yet (Posterna's own until 27 October 2026); `not_probed` for community operators. `kid_convention` is derived from the fetched keys.

keys.json: `{version, generated_at, operators: {<slug>: {directory_url, fetched_at, status, keys: [{jwk, thumbprint, kid, first_seen, last_seen}]}}}`. `version` is the build hour, `YYYY-MM-DDTHH`. Every key carries an RFC 7638 thumbprint computed by Posterna, whatever kid convention the operator uses. Only public JWK members are stored; a key published with private members is rejected.

### 3.3 Content rules

- Never invent a URL, key, prefix, user-agent token or quote. Every fact has a source with a fetch date.
- `signs: true` and signing `status: live` only when a key directory was fetched and parsed. Third-party sightings are `reported`.
- Purposes come from the operator's own documentation with a short quote; otherwise from ai.robots.txt, labeled `community`.
- Breadth comes from ai.robots.txt (MIT, credited in NOTICE). The directory does not try to catalog every SEO or monitoring bot.
- Posterna lists itself as operator `posterna` with agents `PosternaProbe` (purpose `other`), signing through `https://posterna.com/.well-known/http-message-signatures-directory`, and `PosternaDirectoryBuilder` (purpose `other`, unsigned). The build fetches Posterna's key directory like any other operator's; it has been `live` since 27 October 2026.

### 3.4 Distribution to installs

On startup, core loads the bundled snapshot, then refreshes in the background: directory.json every 24 hours with jitter, keys.json every hour, and keys.json early when an unknown kid is seen (at most once per 10 minutes). Refresh never blocks a request. A failed refresh keeps the last good copy. Installs never fetch an operator's key directory directly, and never fetch any URL because a request named it.

## 4. The verifier

### 4.1 Inputs

A Fetch API `Request` or a Node `IncomingMessage`, plus configuration: `clientIpHeader`, `trustedProxies`, `forwardedHeader`, `publicHost`, `trustForwardedHost`, `directory` options. Output is a `VerdictResult`; the verifier never throws to its caller.

### 4.2 Client IP and host resolution

- `trustedProxies`: a list of CIDRs (or a hop count) for the proxies in front of the app. The client IP is the rightmost address in `X-Forwarded-For` (or `Forwarded`) that is not a trusted proxy. With no configuration, the socket address is used and `X-Forwarded-For` is ignored.
- `forwardedHeader` (`x-forwarded-for` by default, or `forwarded`) names the one header the trusted proxies maintain. The other is never read, so a client cannot inject it. Forwarding headers are read only when the socket peer is a trusted proxy. With a hop count N, the client is the address N hops to the left of the socket. An unreadable entry ends the walk at the nearest trusted hop.
- `clientIpHeader`: one request header the host's proxy documents overwriting with the client address (for example `x-vercel-forwarded-for` on Vercel). When set, it replaces the forwarding-header walk: the client is its value (the rightmost when the header carries several, since something appended to it), with no hop counting. A missing or unreadable value leaves the client unknown; there is no fallback to `X-Forwarded-For`. With CIDRs in `trustedProxies` it is read only when the socket peer is one of them, and otherwise the socket address is the client. With a hop count or no `trustedProxies`, or without a socket address, it is always read: the site states that all traffic arrives through that proxy. Only a header the host overwrites is safe, so `docs/install.md` recommends it only where the host documents that. `posterna doctor` forges it and fails if it is believed.
- No socket address (Next.js middleware and proxy never see it): with `trustedProxies` set, the forwarding header is read from its right end, as if the socket peer were a trusted proxy. With CIDRs, trusted entries are skipped from the right; with a hop count N, the client is the Nth entry from the right, or the leftmost when there are fewer. Without `trustedProxies`, forwarding headers are still ignored and the client address is unknown.
- `publicHost`: the hostname agents sign (`@authority`), or a list of them for a site served on several names. If set, it is used: the request's own host when it is in the list, else the first entry. Otherwise the `Host` header (for a Fetch request without one, the URL's host).
- `trustForwardedHost` (off by default): take the host from `X-Forwarded-Host` (its last value) when a trusted proxy sent the request; `publicHost` still wins. Several hosting proxies (Fly.io, AWS load balancers, nginx unless configured) pass a client's own `X-Forwarded-Host` through. Reading it by default would let a client choose the host signatures are checked against, and so replay a signature captured on another site within its validity window. A site opts in only behind a proxy that overwrites the header. `posterna doctor` sends a forged one and fails if it is believed.
- Runtime proxy guard: if 80 percent or more of the last 200 requests resolve to private, loopback, link-local or carrier-grade NAT addresses, the install marks itself `proxySuspect`, suspends all enforcement, and reports the state. This is the misconfiguration that would make real Googlebot look spoofed. Requests with no address at all are not counted.

### 4.3 Identifying the claim

1. If a `Signature-Agent` header is present, parse it (string or dictionary form) and match its URL against the directory's signing operators.
2. Otherwise match `User-Agent` against directory agents: exact token match first, then pattern.
3. No match: no claim.

Signature-Agent members of a type other than `directory`, or whose value is not an https origin, are ignored. When Signature-Agent names no listed operator (or cannot be read), nothing is fetched and the `User-Agent` is still matched as in step 2, so an invented Signature-Agent cannot turn a failed check into `declared_unverifiable`; only when that also finds nothing is the request `declared_unverifiable`. A Signature-Agent without Signature and Signature-Input is treated as an unsigned request.

### 4.4 Signature path

- Only operators whose `directory_url` is in the loaded directory are eligible. A `Signature-Agent` naming an unknown URL is a claim that cannot be verified: `declared_unverifiable`, never a network fetch.
- Keys come from keys.json. Match by kid; when the operator uses no kid, try each key; when the kid is unknown, the request is `declared_unverifiable` and an early keys refresh is scheduled.
- Verify the RFC 9421 signature with Cloudflare's libraries over the covered components the drafts require (including `@authority` and `signature-agent`), checking `created` and `expires` with 60 seconds of clock skew and a maximum validity window of 5 minutes, the `tag` parameter where the drafts define it, and nonce replay against a per-instance LRU.
- Valid: `verified_by_signature`. Present but invalid: `claimed_failed`.
- Key selection: by kid, then by the key's RFC 7638 thumbprint, then every key when the operator publishes no kid. Known test keys (the RFC 9421 example key) are never loaded. The `alg` parameter is optional, as in the drafts.
- Each Web Bot Auth signature on a request is checked on its own; one valid signature verifies the request.
- A signature the library cannot evaluate (for example one covering `@query-param`) fails open (4.8); it is not `claimed_failed`.
- Library gaps and the drafts' ambiguities, with the reading chosen: `docs/notes/upstream-gaps.md`, `docs/notes/drafts.md`.

### 4.5 IP and reverse DNS path

- IP lists are compiled at load time into a prefix matcher (IPv4 and IPv6). A match: `verified_by_ip`. An agent is checked against its own list (`ip_list_agent`), else against all of its operator's lists.
- If the operator documents reverse DNS: forward-confirmed reverse DNS (resolve PTR, require the suffix, resolve the name forward, require the original IP). Lookups run in the background with a 1 second timeout and are cached (positive 24 hours, negative 1 hour). A request whose lookup is not cached yet is `declared_unverifiable` while the lookup runs; later requests from that IP get the cached result.
- A claim for an operator that publishes ranges or rDNS rules, from an address that fails both: `claimed_failed`.
- A claim for an operator that publishes neither keys, nor ranges, nor rDNS rules: `declared_unverifiable`.
- Runtimes without `node:dns` (edge runtimes) skip rDNS and use `declared_unverifiable` where rDNS would have decided.
- A lookup that errors or times out is remembered for one minute; meanwhile requests from that address fail open (4.8).

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
  reason?: ReasonCode;    // why; set on every verdict except verified and human, and on fail-open results
  note?: string;          // human-readable reason
  error?: string;         // set when a fail-open path was taken
};
verify(request, options?): Promise<VerdictResult>
// engine = createPolicyEngine(agentsYaml, { verifier })
engine.decide(result, { path, kind?: "page" | "signup" }): Decision
type Decision = {
  action: Action;
  enforced: boolean;
  rule?: string;          // for example "paths./api/*.claimed_failed"
  reason: string;
  retryAfter?: number;    // seconds, for throttle
  guarded?: boolean;      // the search-engine guard downgraded the action (5.4)
  error?: string;         // set when a fail-open path was taken
};
```

Reason codes, a closed list (`REASON_CODES` in `@posterna/core`), so counters can say why without carrying request data: signature path `signature_invalid`, `expired`, `created_in_future`, `validity_too_long`, `nonce_replayed`, `nonce_rejected`, `profile_rejected`, `malformed_signature`, `unknown_kid`, `no_keys`, `unsigned`, `unlisted_signature_agent`; IP and rDNS path `outside_ip_list`, `rdns_mismatch`, `rdns_unconfirmed`, `rdns_pending`, `no_dns`, `no_client_address`, `nothing_published`, `community_token_on_browser`; automation signals `no_user_agent`, `non_browser_user_agent`, `automation_token`, `missing_accept`, `missing_accept_language`; fail-open paths `directory_unavailable`, `clock_invalid`, `rdns_error`, `library_unsupported`, `library_error`, `unexpected_error`. A signature over another host's authority cannot be told apart from any other bad signature, so it is `signature_invalid`.

`decide()` is a method of the policy engine, which holds the per-instance state the safety rails need (throttle buckets, breaker, guard history). It never throws.

### 4.7 Headers

- Inbound: strip any `X-Agent-*` and `X-Posterna-*` headers from the incoming request before anything else, so no client can forge a verdict for the application or downstream services.
- Outbound to the application (request headers, names configurable): `X-Agent-Verdict`, `X-Agent-Operator`, `X-Agent-Purpose`, `X-Agent-Method`.
- On enforced responses: `X-Posterna-Action`, and `Cache-Control: no-store` so no shared cache serves one agent's refusal to anyone else.

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

Every key but `version` is optional. The full reference is `docs/policy.md`; the JSON Schema is `packages/core/src/schema/agents.schema.json`. `posterna policy check` reports every error at once with its line and column.

### 5.2 Actions

- Page and API traffic, enforced by the middleware: `allow`, `block` (403), `throttle` (429 with `Retry-After`; token bucket per operator per instance; rate as `N/sec|min|hour`).
- Sign-up scopes, returned by `decide()` for the application to act on: `lift` (skip a friction step), `cap` (apply the app's own limits), `challenge` (hand to the app's existing CAPTCHA or similar). Posterna builds no challenge.

Block body (text/plain): `This site's policy does not allow this agent ({operator}, {purpose}). Operators can get verified at https://posterna.com/operators`. Throttle body: `Rate limited by this site's agent policy. Retry after {n} seconds.` `{operator}` and `{purpose}` are the directory slug and purpose, or `unknown`; nothing from the request appears in a response. Both responses carry `Content-Type: text/plain; charset=utf-8`, `Cache-Control: no-store` and `X-Posterna-Action`; throttle adds `Retry-After`.

Throttle: a rate is N from 1 to 1,000,000. Each throttle rule keeps one bucket per operator (claims without an operator share one per rule) that holds N tokens and refills continuously at N per period. Within the rate the decision is `allow`, naming the rule; over it, `throttle` with `Retry-After` set to the whole seconds until the next token, rounded up, at least 1. Buckets count in monitor mode too, and at most 10,000 are kept.

### 5.3 Evaluation order

1. Suspensions: `POSTERNA_MODE=monitor` environment variable, remote monitor override from the cloud, proxy guard, breaker for the claimed operator. Any of these turns the decision into "would have" (not enforced).
2. Human: always allow.
3. Guards.
4. The most specific matching path rule (verdict class and purpose keys).
5. Operator rule for the purpose.
6. `purposes` rule.
7. Defaults by verdict class.

`unknown_automation` is only ever acted on by a rule that names it explicitly; no template sets it to anything but allow. A rule with `monitor: true`, or global `mode: monitor`, records the action with `enforced: false`.

Path patterns start with `/` and match the request path without its query, case-sensitively. `*` matches any characters, including `/` and none; a pattern without `*` is exact. When several match, the most specific wins: an exact pattern beats a wildcard, then more literal characters win, then fewer wildcards, then the one written first. Within a path rule the verdict class key beats the purpose key, so a failed claim cannot borrow its claimed purpose's allowance. If the most specific matching rule has no key for the request, the next most specific is checked.

Operator and purpose rules come before defaults, so they also apply to unverified and failed claims of that operator or purpose; `posterna policy check` warns when one of them is looser than the default for those classes.

`enforced` is true only for a block or throttle the middleware applies, or a sign-up recommendation the application should act on; never for `allow`. Sign-up decisions (`kind: "signup"`) use only the `signup` section: the most specific matching scope's key for the verdict class, else `allow`.

### 5.4 Safety rails

- Search-engine guard (`protect`, the default): agents flagged `search_engine` in the directory are never blocked or throttled when verified. A `claimed_failed` or `declared_unverifiable` claim of a protected agent is enforced only if this instance has seen at least one verified request from that operator in the past 7 days and the breaker is not tripped for it; otherwise the action is downgraded to allow and recorded as `guarded`. A claim that names an operator but no agent is protected when any of that operator's agents is a search engine. `off` must be written explicitly.
- Breaker: for operators verified by IP or rDNS, in a rolling 10 minute window per instance, if there are at least 20 claims and 50 percent or more are `claimed_failed`, all enforcement against that operator's claims is suspended for 60 minutes and the state is reported. Claims are the conclusive IP and rDNS outcomes (`verified_by_ip`, and `claimed_failed` with method `ip` or `rdns`) of page decisions, counted in one-minute slots. Counting continues while tripped, so the breaker trips again at once if failures are still at 50 percent or more when the hour ends.
- Proxy guard: section 4.2.
- Kill switches: the local environment variable, and the remote override delivered in the ingest response. The remote switch can only move an install to monitor, never to enforce: it accepts `"monitor"` (on) and `null` (off) and refuses anything else. If the cloud is unreachable nothing changes. `POSTERNA_MODE=monitor` is read when the engine starts and ignores case; no value of it enables enforcement.

### 5.5 Templates

`monitor` (everything allow), `allow-list` (training blocked, everything else allowed), `saas-signup` (allow-list plus a signup scope with lift for verified and challenge for claimed_failed and unknown_automation). Every template starts with `mode: monitor`. They ship as YAML in `@posterna/core/templates/`.

### 5.6 Emitters

`posterna robots` writes robots.txt from the policy: one group per robots token for agents that honor robots, grouped by purpose, plus Content Signals. The policy engine enforces against agents that do not honor robots.txt.

- `emit` chooses the parts: `robots.txt` for the agent groups, `content-signals` for the signal lines. Without `emit`, only an open `User-agent: *` group is written.
- An agent's lines are the rules that apply to it when verified: operator, purpose and `defaults.verified` rules give `Disallow: /` or nothing, and path rules add `Allow` or `Disallow` lines where they differ from what covers them (an exact pattern ends in `$`, a trailing `*` is dropped). Agents allowed everywhere get no group; with the guard on, search engines get none. Throttle counts as allow. Tokens with the same lines share a group, and each token appears once.
- Content Signals go in the `User-agent: *` group: `purposes.training` sets `ai-train`, `purposes.search` sets `search`, `purposes.user_fetch` sets `ai-input`; block is `no`, allow and throttle are `yes`, no rule means no signal. Path rules with those keys add path-scoped lines. Only the signal lines and a pointer to https://contentsignals.org/ are written, never a legal statement on the site's behalf.
- The output states the rules whatever the mode.

## 6. Adapters

- Express: `app.use(posterna(options))`. Sets `req.posterna` (VerdictResult, Decision, and `decide(context)` for sign-up routes) and the verdict headers, applies enforced actions, records counters with response bytes from `Content-Length`. Policy from `policyPath`, `POSTERNA_POLICY` or `agents.yaml` in the working directory; a missing or invalid file is reported and every request is allowed.
- Next.js: `withPosterna(options, handler?)` for proxy.ts (Next 16, Node.js runtime) and middleware.ts (Next 15; the Node.js runtime from 15.5, else Edge). It composes with an existing proxy or middleware function, which runs after it and reads the verdict with `getPosterna(request)`; the verdict headers reach the app through Next.js's request-header override, merged with any the function sets. Flushes counters through the event's `waitUntil`. Hosts such as Vercel deploy the proxy without agents.yaml, so `withPosternaConfig(nextConfig)` from `@posterna/next/config` reads it when next.config loads and builds its text in through next.config `env` (`POSTERNA_POLICY_TEXT`); the adapter uses that copy unless its options set `policy` or `policyPath`, and a missing file is reported without stopping the build. On the Edge runtime there is no reverse DNS and no file access (use the built-in copy or pass the policy text). Route handlers verify and decide with `createPosterna()`; they run in another bundle, so they count nothing themselves.
- Settings come from options, else `POSTERNA_POLICY`, `POSTERNA_SITE_KEY`, `POSTERNA_DEBUG_TOKEN`, `POSTERNA_MODE` and `POSTERNA_BASE_URL` (the cloud, for counters and directory refreshes). Install guide: `docs/install.md`.
- Debug route `/.well-known/posterna/debug`: disabled unless `POSTERNA_DEBUG_TOKEN` is set, and then only answers requests carrying that token in `X-Posterna-Debug-Token`. Returns JSON: resolved client IP, which header or hop produced it, and the configured `clientIpHeader` when it was consulted, the host used for `@authority`, which signature headers arrived, the verdict for this request, directory version, the lowest directory signing-key generation it still accepts (3.1), where the policy came from (`file` for agents.yaml, read at run time or built in, `options`, or `fallback` for the built-in monitor policy used when neither loaded, with the reason) and its hash, mode and active suspensions. Used by `posterna doctor`.

## 7. Counters client

- Aggregates in memory per key `(hour, verdict, reason, operator, agent, purpose, pathGroup, action, enforced)` with `count` and `bytes` (response bytes when known). Recording is synchronous and constant time.
- `pathGroup` is the matched policy path pattern, else the first path segment (`/docs/*`), or the file itself for a single-segment path with a file extension (`/robots.txt`), capped at 50 distinct groups per flush with the rest in `other`. A first segment that looks like an identifier, with or without a file extension (digits, a UUID, long hex or token-like strings, anything with `@`, `%` or spaces, or over 32 characters), becomes `/:id/*`, so no user name or number in a URL is ever sent.
- Flushes every 60 seconds on a timer that never keeps the process alive, on exit (`beforeExit`, and `SIGTERM` and `SIGINT`: if the application handles the signal itself the client only starts a flush; otherwise it flushes for up to 2 seconds and then lets the signal end the process), and through `waitUntil` where the platform offers it. After a failure, retries back off from 15 seconds, doubling to 5 minutes. A batch is dropped once it has waited 10 minutes since it was first queued, and when the cloud refuses it (any 4xx except 408 and 429). Never blocks a request.
- Without a site key it runs local-only and sends nothing.
- `state` comes from the policy engine's `state()` (`docs/policy.md`). `mode` is `enforce` only when agents.yaml says so and neither kill switch is on; `guarded` counts guard downgrades since the process started.

Payload, `POST https://posterna.com/v1/ingest`, `Authorization: Bearer <site key>`, optionally gzip:

```json
{
  "schema": 1,
  "sdk": { "name": "@posterna/express", "version": "0.1.0", "runtime": "node-22" },
  "instance": "random-id-per-process",
  "mode": "monitor",
  "state": { "proxySuspect": false, "breakerTripped": [], "guarded": 0, "errors": 0, "directoryVersion": "2026-10-27", "keysVersion": "2026-10-27T18", "policyHash": "sha256-prefix" },
  "buckets": [
    { "hour": "2026-10-28T17:00:00Z", "verdict": "verified_by_ip", "reason": null, "operator": "google", "agent": "Googlebot", "purpose": "search", "pathGroup": "/docs/*", "action": "allow", "enforced": false, "count": 12, "bytes": 345678 }
  ]
}
```

Response: `{ "accepted": <n>, "modeOverride": null | "monitor" }`. `modeOverride` goes to the engine's remote override setter (5.4); any other value is ignored.

## 8. CLI

- `posterna init`: detect Express or Next.js (and its major version and runtime) from package.json, choose a template (default `monitor`; asked on a terminal, `--template` otherwise), write agents.yaml (an existing one only with confirmation or `--force`), print the exact code to add (v1 makes no automatic code edits), optionally take a site key from the dashboard and add `POSTERNA_SITE_KEY` to the env file (`.env.local` for Next.js, `.env` otherwise, created with mode 600) after confirmation, warning when the file is not in `.gitignore`.
- `posterna doctor --url <site>`: learn this machine's public IP from `https://posterna.com/v1/whoami`, send a request signed with an ephemeral key to the site's debug route (with `POSTERNA_DEBUG_TOKEN` from the environment, plus a forged `X-Forwarded-For` and `X-Forwarded-Host` that a correct setup ignores, and, when the debug report names a `clientIpHeader`, a second request with a forged copy of that header), and report pass, warn, fail or skip with the fix for: client IP resolution, `@authority` host, signature headers surviving proxies, whether the policy loaded, directory freshness, mode and suspensions. The client IP check runs once over IPv4 and once over IPv6: a family this machine or the site lacks is skipped, and a family whose request reaches a server without the Posterna debug route fails. When whoami cannot be reached, the report names that step. Exit code 1 on any failure.
- `--base-url` or `POSTERNA_BASE_URL` points the CLI at another cloud, for tests. Prompts use @clack/prompts and are skipped without a terminal or with `--yes`.
- `posterna robots`: print robots.txt and Content Signals from agents.yaml.
- `posterna policy check`: validate agents.yaml with clear errors.

## 9. Security requirements

1. Strip inbound verdict headers (4.7).
2. Never fetch a URL taken from a request (no SSRF from customer servers).
3. Verify signatures on directory.json and keys.json against embedded keys; reject unsigned or invalid files, files signed by a retired key generation, and older versions (3.1).
4. Trusted-proxy handling as in 4.2; with no configuration, ignore forwarding headers.
5. Never log or transmit IPs, full URLs, header values or bodies.
6. Fail open everywhere (4.8).
7. Pin dependency versions; no install scripts in published packages.

## 10. Performance

p99 under 5 ms per request on a warm cache for the signature and IP paths, measured by benchmarks that CI runs: one for verify and decide in core, one through the Express middleware inside a running app. rDNS lookups are excluded because they run in the background. Method and results: `docs/benchmark.md`.

## 11. Testing

- Conformance vectors in `conformance/` (JSON: request, config, directory fixture, expected VerdictResult and Decision). The TypeScript runner executes them; future ports reuse them. Format: `conformance/README.md`.
- Signed requests generated with throwaway Ed25519 keys; RFC 9421 published Ed25519 test vectors; snapshots of the live key directories for parsing and thumbprint tests.
- Interop edge cases: parameterized covered components, dictionary-form Signature-Agent, multiple signatures on one request, legacy kid derivation, nonce persistence, clock skew, sf-string serialization.
- Spoof cases: a claimed ClaudeBot from an AWS address, a claimed Googlebot from a non-crawler Google Cloud address, a valid-looking Signature-Agent not in the directory.
- Proxy cases, header stripping, failure injection, policy precedence, guards, breaker, kill switches, throttle timing, emitters, end-to-end tests against example apps with a mock ingest server.
- End-to-end (`pnpm test:e2e`, its own CI job): the four apps in `examples/` (Express, an Express sign-up route, Next.js 16 with proxy.ts, Next.js 15 with middleware.ts on Node.js) started from the built packages, with verified, spoofed, unknown, human, forged-header and throttled-burst requests, and the counters payload and remote override through a mock ingest server.

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
