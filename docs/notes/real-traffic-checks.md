# Checks to run against real traffic

The verifier was built and tested against the drafts, published test vectors, live key directories and synthetic requests. None of it has seen real signed traffic yet. Before anyone turns on `mode: enforce`, check each item below against counts from real installs (and the Posterna cloud's own canary sites, once they exist). Each item says what could go wrong and which way it would push the verdicts.

The most dangerous failures are false `claimed_failed` results, because that is the verdict policies block on. Items that could cause them come first.

## Could cause false `claimed_failed`

1. **Signature validity windows.** docs/SPEC.md caps `expires - created` at 300 seconds; the protocol draft recommends up to 24 hours and its own test vectors use about a hundred years. Measure the windows real signers use (Google-Agent, Browserbase, ChatGPT agent, Meta, DuckDuckGo). If any exceed 300 seconds, raise the cap or make it per operator before enforcing. See `docs/notes/drafts.md`, item 5. **First measurement, 28 October 2026:** Duck.ai's DuckAssistBot signs with 600-second windows; the signature verified, and the 300-second cap alone made it `claimed_failed` (`validity_too_long`). The cap is now 3,600 seconds (manual lab observations, below).
2. **Nonce length.** Cloudflare's `web-bot-auth` 0.2.0 accepts only 64-byte nonces; the draft sets no length. Check what real signers send. A shorter nonce is currently `claimed_failed` on the `alg` path. See `docs/notes/upstream-gaps.md`, item 6. DuckAssistBot sends no nonce at all (28 October 2026), which both paths accept.
3. **Clock skew.** The verifier allows 60 seconds. Look for signatures rejected as "created in the future" or "expired" by small margins, which would point at the skew rather than a forgery.
4. **Signed host behind proxies.** A signature over the public host fails when the app sees an internal Host header and `publicHost` or `trustedProxies` is not set. A cluster of `claimed_failed` on signed requests from one install, with otherwise valid keys, is that misconfiguration rather than spoofing. `posterna doctor` should catch it; check that it does.
5. **Stale IP lists.** A claim from outside an operator's published list is `claimed_failed` when the operator documents no reverse DNS. Bing's list was last regenerated in January 2024, and several others change often. Watch for a high `claimed_failed` share on a single agent that should be legitimate, and compare the addresses against the operator's current list before trusting the verdict. First API fetcher results (28 October 2026, below): Anthropic's API web fetch sends `Claude-User` from addresses outside Anthropic's published list, while OpenAI's API web search verifies as `ChatGPT-User`. The manual run the same day found claude.ai's own `Claude-User` fetches outside the list too.
6. **Reverse DNS suffixes.** Confirm that real Googlebot, Applebot, Bingbot and CCBot traffic resolves under the documented suffixes, over IPv6 as well as IPv4. Google's `googleusercontent.com` is excluded on purpose (it is where Google Cloud customers live); make sure no real Google crawler depends on it.

## Could hide a real verification (`declared_unverifiable` or fail-open instead of verified)

7. **Which agents sign.** Meta's and DuckDuckGo's key directories are live, but neither operator says which agent signs, so the directory marks no agent as signing. Look at the Signature-Agent and User-Agent pairs that verify, and update `signing.covers` in `packages/directory/sources/*.yaml` with a source. None of the five API fetchers tried on 28 October 2026 signed (below). **Answered for DuckDuckGo, 28 October 2026:** DuckAssistBot signs with the key in DuckDuckGo's directory, so the directory now lists it in `signing.covers`, citing the manual lab observations below. Meta AI fetched as `meta-webindexer`, unsigned.
8. **Key ID conventions.** Google signs with short kid labels and Meta with no kid; the verifier matches by kid, then thumbprint, then tries every key. Check how often an unknown kid triggers the early keys refresh: a steady rate means a signer uses an ID scheme we do not recognize.
9. **Signatures without `alg`, and unsupported components.** Count how often the no-`alg` fallback runs and how often a signature covers `@query-param` or uses the `sf`, `bs` or `tr` parameters, which fail open today. Both are worth reporting upstream with numbers.
10. **Signature-Agent forms.** Count the legacy string form against the dictionary form, members with a `type` other than `directory`, and requests carrying more than one signature (a remote browser plus an agent, for example). DuckAssistBot uses the string form (28 October 2026).
11. **Reverse DNS failures.** Lookups time out after 1 second and failures fail open for a minute. Measure the timeout and error rate in real hosting environments; a high rate means verified crawlers are being labeled `unknown_automation`. First measurement, on a Vercel canary site on 27 October 2026: on a fresh instance, the first lookups timed out at 1 second (`rdns_error`); after the minute-long fail-open, lookups for the same address resolved in time (`rdns_pending`, then `rdns_unconfirmed` for a fake Googlebot). So a cold Vercel instance can spend about a minute labeling rDNS-checked claims `unknown_automation`. Watch whether that holds on other hosts, and whether a longer first timeout is worth it.
12. **Edge runtimes.** Where there is no DNS, operators that depend on reverse DNS stay `declared_unverifiable` outside their IP lists. Measure how much traffic that leaves unverified on edge deployments.

## Could mislabel people or ordinary tools

13. **Generic community tokens.** Some ai.robots.txt names are ordinary words (`Code`, `Dot`, `Spider`, `Cursor`, `Operator`, `Muse`, `Instinct`, `Trae`). Check that they never match real browser User-Agent strings; a match would turn a person into a `declared_unverifiable` claim.
14. **Human versus `unknown_automation`.** The label uses only the User-Agent and whether Accept and Accept-Language are present. Check privacy-focused browsers, in-app browsers and accessibility tools, which may omit headers, and make sure they are not labeled automation in volume. Two API fetchers tried on 28 October 2026 (Perplexity's and xAI's, below) send ordinary browser User-Agents with no product token and are labeled `human`.
15. **Proxy guard.** The guard trips when 80 percent of the last 200 requests come from internal addresses. Confirm it trips on real misconfigured installs and does not trip on apps that legitimately see private client addresses (intranets, VPN users). Load balancer and platform health checks count as internal requests: on a quiet site they alone can trip the guard (found on the canary sites, 27 October 2026), so the install guide now says to keep them out of Posterna; watch whether real installs still trip it that way. It does not notice a hop count one too small: on Railway that resolves to a CDN address, on Fly to the app's own address, on Render to a Cloudflare address. `posterna doctor` catches it; real traffic would show it as most requests sharing a handful of public addresses. Consider a guard rule for that.
16. **Host settings in `docs/install.md`.** Railway's `X-Real-IP` was confirmed on a live site on 27 October 2026 (directly and behind Cloudflare, over IPv4 and IPv6, forged values ignored), so the guide now recommends `clientIpHeader: "x-real-ip"` there. Vercel's `x-vercel-forwarded-for` was confirmed on a canary site on 27 October 2026 (IPv4 only, since `*.vercel.app` has no IPv6 address; a forged copy was ignored); the same run found that the Next.js proxy on Vercel cannot read `agents.yaml`, so installs there ran the built-in monitor policy; `withPosternaConfig` now builds the file into the proxy, and the same site passed doctor's Policy check with it, from a source build, the same day (see the Next.js 16 section of the guide). The hop count for Render (3) still rests on a staff demonstration and test requests, not documentation, and Fly's `Fly-Client-IP` is not documented as overwritten. Collect `doctor` results from real installs on each host, and the share of `no_client_address`, before treating the other rows as confirmed.
17. **X-Forwarded-Host.** Fly.io, AWS load balancers and a default nginx pass a client's `X-Forwarded-Host` through, so since 26 October 2026 the verifier reads it only when a site sets `trustForwardedHost` (docs/SPEC.md section 4.2). The cost is false `signature_invalid` results on installs whose proxy rewrites `Host` and that set neither `publicHost` nor `trustForwardedHost`. Watch the `signature_invalid` share per install, and the authority source the debug route reports, to see whether `doctor` and the install guide catch these.
18. **Hot path in production.** The benchmark measured p99 of 0.17 ms on a laptop and 1.4 ms on a 2-CPU CI runner for the signature path. Confirm the p99 holds with real header sizes, real directory refreshes and concurrent load.

## API fetcher observations

Since 28 October 2026, Posterna asks the official API of each of five AI providers, once a day, to open a fresh run-tagged URL on `https://posterna.com/lab` with that API's server-side fetch tool, and records what the verifier made of the request: verdict, reason, operator, agent, User-Agent and signature parameters, never the address. These are **API fetcher** results. A company's API can fetch with a different User-Agent, addresses or signing than its consumer product, so they say nothing on their own about ChatGPT, Claude, Gemini, Perplexity or Grok as people use them; those are checked by hand. The lab does no reverse DNS, so it checks operators by IP list and signature only.

28 October 2026, two runs (the second after OpenAI's account had credits; the other four gave the same verdicts both times):

| Provider and tool | User-Agent | Verdict (reason) | Signed | Items |
|---|---|---|---|---|
| Anthropic, Messages API web fetch (`web_fetch_20260309`, cache off) | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +claude-user@anthropic.com)` | `claimed_failed` (`outside_ip_list`) | no | 5 |
| Google, Gemini API URL context | `GoogleAgent-URLContext` | `verified_by_ip` | no | 5 |
| OpenAI, Responses API `web_search` (it opened the page with `open_page`) | A User-Agent with the `ChatGPT-User` token | `verified_by_ip` (agent `ChatGPT-User`) | no | 5 |
| Perplexity, Agent API `fetch_url` | A desktop Chrome User-Agent with no product token | `human` | no | 14 |
| xAI, Responses API `web_search` (it opened the page while browsing) | A desktop Safari User-Agent with no product token, a different version on each run | `human` | no | 14 |

What follows from them:

- **Item 5.** OpenAI's API web search opens a page as `ChatGPT-User` from an address in OpenAI's published `ChatGPT-User` list, so that list covers its API fetcher too. A request that honestly names `Claude-User` and comes from Anthropic's own API is `claimed_failed`, because its address is outside the list Anthropic publishes for its bots. Enforcing on `Claude-User` claims today would block it. Check claude.ai itself by hand before drawing a conclusion for `Claude-User` in general, and add addresses to the directory only from a public Anthropic source that ties them to that agent.
- **Item 7.** None of the API fetchers signed, including Google's, whose Google-Agent signs for a subset of requests.
- **Item 14.** Perplexity's and xAI's API fetchers cannot be told apart from people by their headers. They are not spoofing anything, so this is not a false `claimed_failed`, but counts of `human` include them.
- **Google.** URL-context fetches name themselves (`GoogleAgent-URLContext`, a community-listed name) and verify against Google's published addresses. On the first run, Google's API reported the retrieval as an error although the page was served normally; on the second it reported success.

## Manual lab observations

Each week the consumer products are asked by hand, in their own apps, to open a run-tagged URL on `https://posterna.com/lab`. The lab records what the verifier made of each request that arrives, never the address. Run-tagged lab pages carry no robots tag since 28 October 2026; before that they were marked `noindex, nofollow`.

28 October 2026 (ChatGPT on a free plan, so no agent mode):

| Product | User-Agent | Verdict (reason) | Signed |
|---|---|---|---|
| ChatGPT, with search and in plain chat | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot` | `verified_by_ip` (agent `ChatGPT-User`) | no |
| Gemini | `Google` | `unknown_automation` (`non_browser_user_agent`) | no |
| Claude (claude.ai, web search on) | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +claude-user@anthropic.com)` | `claimed_failed` (`outside_ip_list`) | no |
| Meta AI | `meta-webindexer/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)` | `declared_unverifiable` (`unsigned`), agent `Meta-WebIndexer` | no |
| Grok | A desktop Chrome User-Agent with no product token, nine requests | `human` | no |
| Duck.ai | `DuckAssistBot/1.2; (+http://duckduckgo.com/duckassistbot.html)` | `claimed_failed` (`validity_too_long`) under the old 300-second cap; the signature itself verified | yes |
| Perplexity | No request reached the lab (it reported "Failed to fetch content", twice) | | |
| Microsoft Copilot | No request reached the lab (it reported that no relevant content could be retrieved) | | |

Retest the same day, after the cap was raised to 3,600 seconds and run-tagged pages lost their robots tag: Duck.ai's DuckAssistBot request was `verified_by_signature` (the first verified signature from a real product), and Perplexity and Copilot again sent nothing that reached the lab.

Duck.ai's signature: `Signature-Agent: "https://assistbot.duckduckgo.com"` (string form), tag `web-bot-auth`, alg `ed25519`, keyid `Ov3HDsa8JQ39dPEYFvFFN-cUpnz9yNI8LDvr-5LeiBM` (the key in DuckDuckGo's key directory), a 600-second window, no nonce, covering `@authority` and `signature-agent`. Duck.ai then declined to read the page because it was marked `noindex`.

What follows from them:

- **Item 1.** The first real signer seen used a 600-second window, and the 300-second cap turned a valid signature into a false `claimed_failed`. The cap is now 3,600 seconds.
- **Item 5.** claude.ai fetches as `Claude-User` from outside Anthropic's published list, like Anthropic's API (above), so this is not specific to the API.
- **Item 7.** DuckAssistBot is the DuckDuckGo agent that signs.
- **Gemini.** The Gemini app sends a bare `Google` User-Agent, so real Gemini fetches count as `unknown_automation` and are never tied to Google. A bare `Google` is too generic to match safely (item 13); leave it unmatched unless Google documents it. Google's API fetcher, by contrast, names itself `GoogleAgent-URLContext` and verifies.
- **Meta AI** fetched as Meta-WebIndexer, not Meta-ExternalFetcher, and did not sign.
- **Grok** fetched with the same kind of browser User-Agent as xAI's API fetcher.
- **Perplexity and Copilot** sent nothing that reached the lab. Perplexity's API fetcher did reach it with a browser User-Agent, so the app's own fetcher may be stopped before the site (posterna.com is behind Cloudflare); Copilot's answer suggests it reads Bing's index rather than the page. The retest without the robots tag failed the same way, so the tag was not the cause; for Perplexity, check the CDN's security events for the minute of the attempt.

## Making these measurable

Most of these need the reason behind a verdict. **Reason codes are built (26 October 2026, with the counters client):** `VerdictResult.reason` is a closed list of codes (docs/SPEC.md section 4.6), counters aggregate by it (section 7), and the conformance vectors assert it. A reason code carries no per-request data, so it keeps to the rule that requests never leave the origin. The cloud's ingest schema must accept the `reason` field when it is built.

Codes that answer the items above: `expired`, `created_in_future`, `validity_too_long` (items 1 and 3), `nonce_rejected` (2), `signature_invalid` with method `signature` (4; a wrong authority cannot be told apart from other bad signatures), `outside_ip_list` (5), `rdns_mismatch` and `rdns_unconfirmed` (6), `unknown_kid` (8), `library_unsupported` and `library_error` (9), `rdns_error` and `rdns_pending` (11), `no_dns` (12), `community_token_on_browser` (13), `missing_accept`, `missing_accept_language`, `no_user_agent` (14), and `no_client_address` (16). Item 10 (Signature-Agent forms) and the no-`alg` count in item 9 still need their own counters.
