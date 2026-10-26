# @posterna/core

**Pre-release, not yet published.**

The core of [Posterna](https://posterna.com): the verifier behind `verify()`. It checks which AI agents and crawlers are calling your site, using HTTP message signatures (RFC 9421, Web Bot Auth), published IP ranges and forward-confirmed reverse DNS, and gives every request one of six verdicts. It runs in your own process, never sends request data anywhere, and fails open on every error.

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

Signatures are verified with Cloudflare's [web-bot-auth](https://github.com/cloudflare/web-bot-auth) packages. The operator directory snapshot comes from [`@posterna/directory`](https://www.npmjs.com/package/@posterna/directory) and is refreshed in the background from posterna.com when signed directory files are available.

See the [specification](https://github.com/posternahq/posterna/blob/main/docs/SPEC.md), section 4. MIT licensed.
