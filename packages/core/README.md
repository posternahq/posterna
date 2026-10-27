# @posterna/core

**Pre-release, not yet published.**

The core of [Posterna](https://posterna.com): the verifier behind `verify()` and the policy engine behind `decide()`. It checks which AI agents and crawlers are calling your site, using HTTP message signatures (RFC 9421, Web Bot Auth), published IP ranges and forward-confirmed reverse DNS, and gives every request one of six verdicts. It runs in your own process, never sends request data anywhere, and fails open on every error.

Most apps use an adapter instead: [`@posterna/express`](https://www.npmjs.com/package/@posterna/express) or [`@posterna/next`](https://www.npmjs.com/package/@posterna/next).

```ts
import { createVerifier, stripInboundHeaders, verdictHeaders } from "@posterna/core";

const verifier = createVerifier({ trustedProxies: ["10.0.0.0/8"], publicHost: "www.example.com" });

// Fetch API: pass the TCP peer, which a Request does not carry.
const result = await verifier.verify(request, { remoteAddress });
// { verdict: "verified_by_ip", operator: "google", agent: "Googlebot", purpose: "search", method: "ip" }
```

- `createVerifier(options)` returns a verifier with its own directory copy, refresh timers, nonce cache and reverse DNS cache. `verify(request, options)` uses a shared default one.
- `verify()` accepts a Fetch API `Request` or a Node `IncomingMessage`, never throws, and never waits on the network.
- `stripInboundHeaders(headers)` removes client-sent `X-Agent-*` and `X-Posterna-*` headers; adapters call it first. `verdictHeaders(result)` gives the headers to pass to the application.
- `verifier.state()` reports readiness, the proxy guard, error counts and directory versions, for counters and the debug route.

## Policy

The policy engine turns a verdict into a decision from the site's `agents.yaml` (allow, block or throttle for pages and APIs; lift, cap or challenge recommendations for sign-up pages), with safety rails that keep verified search engines reachable and stop enforcement when something looks misconfigured. Templates start in monitor mode, so nothing is blocked until the file says `mode: enforce`.

```ts
import { createPolicyEngine, enforcementResponse } from "@posterna/core";

const engine = createPolicyEngine(readFileSync("agents.yaml", "utf8"), { verifier });
const decision = engine.decide(result, { path: url.pathname });
// { action: "block", enforced: true, rule: "purposes.training", reason: "purposes.training: block." }
const response = enforcementResponse(decision, result); // null means let the request through
```

- `createPolicyEngine(policy, options)` takes agents.yaml text or a parsed policy and throws `PolicyError` (every error, with line numbers) when it is invalid. `checkPolicy(text)` validates without throwing.
- `engine.decide(result, { path, kind })` never throws. `engine.setRemoteOverride("monitor" | null)` applies the cloud's kill switch, which can never turn enforcement on. `engine.state()` reports mode, suspensions, tripped breakers, guarded and error counts and the policy hash.
- `emitRobots(policy, operators)` writes robots.txt and Content Signals from the policy.
- Templates: `@posterna/core/templates/monitor.yaml`, `allow-list.yaml`, `saas-signup.yaml`.

The full reference is [docs/policy.md](https://github.com/posternahq/posterna/blob/main/docs/policy.md).

## Counters

`createCounters({ sdk, source: engine })` aggregates requests by hour, verdict, reason code, operator, agent, purpose, path group, action and enforced. With a site key (`POSTERNA_SITE_KEY`) it sends them to the Posterna cloud every 60 seconds and on exit, and applies the cloud's monitor override to the engine. Without one it sends nothing. Recording never blocks or slows a request, and no address, URL or header value is ever kept or sent. The adapters set this up for you.

Signatures are verified with Cloudflare's [web-bot-auth](https://github.com/cloudflare/web-bot-auth) packages. The operator directory snapshot comes from [`@posterna/directory`](https://www.npmjs.com/package/@posterna/directory) and is refreshed in the background from posterna.com when signed directory files are available.

See the [specification](https://github.com/posternahq/posterna/blob/main/docs/SPEC.md), sections 4 and 5. MIT licensed.
