# Checks to run against real traffic

The verifier was built and tested against the drafts, published test vectors, live key directories and synthetic requests. None of it has seen real signed traffic yet. Before anyone turns on `mode: enforce`, check each item below against counts from real installs (and the Posterna cloud's own canary sites, once they exist). Each item says what could go wrong and which way it would push the verdicts.

The most dangerous failures are false `claimed_failed` results, because that is the verdict policies block on. Items that could cause them come first.

## Could cause false `claimed_failed`

1. **Signature validity windows.** docs/SPEC.md caps `expires - created` at 300 seconds; the protocol draft recommends up to 24 hours and its own test vectors use about a hundred years. Measure the windows real signers use (Google-Agent, Browserbase, ChatGPT agent, Meta, DuckDuckGo). If any exceed 300 seconds, raise the cap or make it per operator before enforcing. See `docs/notes/drafts.md`, item 5.
2. **Nonce length.** Cloudflare's `web-bot-auth` 0.2.0 accepts only 64-byte nonces; the draft sets no length. Check what real signers send. A shorter nonce is currently `claimed_failed` on the `alg` path. See `docs/notes/upstream-gaps.md`, item 6.
3. **Clock skew.** The verifier allows 60 seconds. Look for signatures rejected as "created in the future" or "expired" by small margins, which would point at the skew rather than a forgery.
4. **Signed host behind proxies.** A signature over the public host fails when the app sees an internal Host header and `publicHost` or `trustedProxies` is not set. A cluster of `claimed_failed` on signed requests from one install, with otherwise valid keys, is that misconfiguration rather than spoofing. `posterna doctor` should catch it; check that it does.
5. **Stale IP lists.** A claim from outside an operator's published list is `claimed_failed` when the operator documents no reverse DNS. Bing's list was last regenerated in January 2024, and several others change often. Watch for a high `claimed_failed` share on a single agent that should be legitimate, and compare the addresses against the operator's current list before trusting the verdict.
6. **Reverse DNS suffixes.** Confirm that real Googlebot, Applebot, Bingbot and CCBot traffic resolves under the documented suffixes, over IPv6 as well as IPv4. Google's `googleusercontent.com` is excluded on purpose (it is where Google Cloud customers live); make sure no real Google crawler depends on it.

## Could hide a real verification (`declared_unverifiable` or fail-open instead of verified)

7. **Which agents sign.** Meta's and DuckDuckGo's key directories are live, but neither operator says which agent signs, so the directory marks no agent as signing. Look at the Signature-Agent and User-Agent pairs that verify, and update `signing.covers` in `packages/directory/sources/*.yaml` with a source.
8. **Key ID conventions.** Google signs with short kid labels and Meta with no kid; the verifier matches by kid, then thumbprint, then tries every key. Check how often an unknown kid triggers the early keys refresh: a steady rate means a signer uses an ID scheme we do not recognize.
9. **Signatures without `alg`, and unsupported components.** Count how often the no-`alg` fallback runs and how often a signature covers `@query-param` or uses the `sf`, `bs` or `tr` parameters, which fail open today. Both are worth reporting upstream with numbers.
10. **Signature-Agent forms.** Count the legacy string form against the dictionary form, members with a `type` other than `directory`, and requests carrying more than one signature (a remote browser plus an agent, for example).
11. **Reverse DNS failures.** Lookups time out after 1 second and failures fail open for a minute. Measure the timeout and error rate in real hosting environments; a high rate means verified crawlers are being labeled `unknown_automation`.
12. **Edge runtimes.** Where there is no DNS, operators that depend on reverse DNS stay `declared_unverifiable` outside their IP lists. Measure how much traffic that leaves unverified on edge deployments.

## Could mislabel people or ordinary tools

13. **Generic community tokens.** Some ai.robots.txt names are ordinary words (`Code`, `Dot`, `Spider`, `Cursor`, `Operator`, `Muse`, `Instinct`, `Trae`). Check that they never match real browser User-Agent strings; a match would turn a person into a `declared_unverifiable` claim.
14. **Human versus `unknown_automation`.** The label uses only the User-Agent and whether Accept and Accept-Language are present. Check privacy-focused browsers, in-app browsers and accessibility tools, which may omit headers, and make sure they are not labeled automation in volume.
15. **Proxy guard.** The guard trips when 80 percent of the last 200 requests come from internal addresses. Confirm it trips on real misconfigured installs and does not trip on apps that legitimately see private client addresses (intranets, VPN users).

## Performance

16. **Hot path in production.** The benchmark measured p99 of 0.17 ms on a laptop and 1.4 ms on a 2-CPU CI runner for the signature path. Confirm the p99 holds with real header sizes, real directory refreshes and concurrent load.

## Making these measurable

Most of these need the reason behind a verdict, and today that is only the human-readable `note`. The counters client (docs/SPEC.md section 7) aggregates by verdict, operator, agent and path group, not by reason.

**Decision (26 October 2026): reason codes are added when the counters client is built**, so they are part of the counter format from the start rather than retrofitted. That work adds an optional `reason` to `VerdictResult` (docs/SPEC.md section 4.6), a `reason` counter dimension (section 7) with the matching ingest schema in the cloud, and conformance vectors that assert the code. A reason code carries no per-request data, so it keeps to the rule that requests never leave the origin.

Starting list of codes, to be settled then: `expired`, `created_in_future`, `validity_too_long`, `nonce_replayed`, `nonce_rejected`, `wrong_authority`, `signature_invalid`, `unknown_kid`, `no_keys`, `outside_ip_list`, `rdns_mismatch`, `rdns_unconfirmed`, `rdns_pending`, `rdns_error`, `no_dns`, `library_unsupported`, `library_error`, `directory_unavailable`, `clock_invalid`. Items 13 and 14 need narrower codes (for example `community_token_on_browser`, `missing_accept_language`) because the User-Agent itself must never leave the site.

Until reason codes and counters exist, the only way to check these items is directly on a site Posterna controls, once an adapter runs there.
