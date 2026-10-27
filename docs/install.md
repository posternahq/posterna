# Install

Posterna runs inside your app. In about five minutes you can have it labeling every request, without blocking anything. This guide covers Express and Next.js, the proxy settings for common hosts, how to check the setup with `posterna doctor`, and how to switch to enforcement safely.

> Posterna is pre-release. The packages are not on npm yet.

## 1. Create agents.yaml

In your project:

```bash
npx posterna init
```

`init` finds Express or Next.js in `package.json` and asks which template to start from (`monitor` unless you choose otherwise). It writes `agents.yaml` and prints the exact code to add; it never edits your code. It can also save a site key from the dashboard to your env file, after asking.

Every template starts in monitor mode: requests are labeled and counted, and nothing is blocked until you change `mode` to `enforce`. The policy format is in [policy.md](policy.md). Check the file at any time with:

```bash
npx posterna policy check
```

## 2. Add Posterna to your app

### Express

```bash
npm install @posterna/express
```

```js
import express from "express";
import { posterna } from "@posterna/express";

const app = express();

app.use(
  posterna({
    trustedProxies: 1, // the setting for your host, from the table below
    publicHost: "www.example.com", // the hostname agents sign
  }),
);
```

Add it before your routes. On each request it:

- removes any `X-Agent-*` and `X-Posterna-*` headers the client sent;
- labels the request and decides with agents.yaml;
- sets `req.posterna` (`result`, `decision`, and `decide()`) and the `X-Agent-Verdict`, `X-Agent-Operator`, `X-Agent-Purpose` and `X-Agent-Method` request headers;
- sends the block (403) or throttle (429) response when one is enforced;
- counts the request.

If anything inside fails, the request goes through. `agents.yaml` is read from the working directory; set `policyPath` or `POSTERNA_POLICY` to read it from elsewhere.

On a sign-up route, ask for a recommendation and act on it only when it is enforced:

```js
app.post("/signup", (req, res) => {
  const decision = req.posterna?.decide({ kind: "signup" });
  const action = decision?.enforced ? decision.action : "allow";
  // "lift": skip a friction step. "cap": apply your own limits.
  // "challenge": hand the request to your existing CAPTCHA.
});
```

See [examples/express-basic](../examples/express-basic) and [examples/express-signup](../examples/express-signup).

### Next.js 16 (proxy.ts)

```bash
npm install @posterna/next
```

Create `proxy.ts` next to your `app` folder (inside `src/` if you use one):

```ts
import { withPosterna } from "@posterna/next";

export const proxy = withPosterna({
  trustedProxies: 1, // the setting for your host, from the table below
  publicHost: "www.example.com",
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

If you already have a proxy function, pass it as the second argument: `withPosterna(options, yourProxy)`. Posterna runs first; your function runs after it and can read the verdict with `getPosterna(request)`. Next.js reads `config` at build time, so write it out in your own file; it cannot be imported. Make sure the matcher covers every page you want labeled, including your sign-up route.

In Next.js 16, the proxy always runs on the Node.js runtime, so it reads `agents.yaml` from the project folder and can do reverse DNS.

Pages and route handlers read the verdict from the request headers:

```ts
import { headers } from "next/headers";

const verdict = (await headers()).get("x-agent-verdict");
```

A route handler that needs a sign-up recommendation verifies and decides itself, because it runs in a different bundle from the proxy. Turn counting off there, since the proxy already counted the request:

```ts
import { createPosterna } from "@posterna/next";

const posterna = createPosterna({ trustedProxies: 1, publicHost: "www.example.com", counters: false });

export async function POST(request: Request) {
  const result = await posterna.verify(request);
  const decision = posterna.decide(result, { path: "/api/signup", kind: "signup" });
  // act on decision.action when decision.enforced is true
}
```

See [examples/next-basic](../examples/next-basic) and [examples/next-signup](../examples/next-signup).

### Next.js 15 (middleware.ts)

Use `middleware.ts` and the Node.js runtime, which is stable from Next.js 15.5:

```ts
import { withPosterna } from "@posterna/next";

export const middleware = withPosterna({ trustedProxies: 1, publicHost: "www.example.com" });

export const config = {
  runtime: "nodejs",
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

### The Edge runtime

Next.js before 15.5 runs middleware only on the Edge runtime, and Next.js 16 still allows `middleware.ts` there. Posterna avoids Node.js built-ins so that it can run there, with these limits (the end-to-end tests cover the Node.js runtime only):

- **No reverse DNS.** There is no DNS resolver, so operators that are checked by reverse DNS (Googlebot outside its IP lists, for example) stay `declared_unverifiable`.
- **No files.** The Edge runtime cannot read `agents.yaml`. Pass the policy text as `policy` instead.
- **Bundle size.** The operator directory (about 650 KB of JSON) is bundled into the middleware.

Prefer the Node.js runtime wherever you can.

## 3. Tell Posterna about your proxies

This step matters most. Posterna checks crawlers against their operators' published IP ranges, so it needs the real client address. It also needs the hostname agents sign. Behind a proxy, both arrive in forwarding headers, and those are safe to read only when you say which proxies to trust:

- **`trustedProxies`**: a hop count or a list of CIDRs.
  - A hop count `N` means the client is the address `N` hops to the left of the socket peer in `X-Forwarded-For`. So `1` is the last entry, appended by the one proxy in front of you.
  - A list of CIDRs skips trusted addresses from the right of `X-Forwarded-For`.
  - Without the setting, forwarding headers are ignored.
- **`publicHost`**: the hostname agents sign, or a list of them, for example `["www.example.com", "example.com"]`. Without it, Posterna uses the `Host` header your app receives, which is right only when your proxy passes the original one through. Setting it is the safest choice on every host, and required where the proxy changes `Host`.
- **`trustForwardedHost`**: off by default, and best left off. When on, the signed host comes from `X-Forwarded-Host` sent by a trusted proxy. Several hosts below pass a client's own `X-Forwarded-Host` through to your app, so a client could then choose the host signatures are checked against. Turn it on only behind a proxy that overwrites the header, and only if you cannot set `publicHost` (for example, an app serving many customer domains).
- **`forwardedHeader`**: keep the default, `x-forwarded-for`. None of the hosts below maintains the RFC 7239 `Forwarded` header, and some pass a client's copy through unchanged.

Next.js never gives middleware or a proxy the socket address. With `trustedProxies` set, Posterna reads `X-Forwarded-For` from its right end; without it, there is no client address, and IP checks are off. When `next start` is reached directly, with no proxy in front, Next.js passes on an `X-Forwarded-For` the client sent itself. Always run Next.js behind your host's proxy or your own.

### Settings by host

These settings come from each host's documentation, checked on 26 October 2026, and from test requests where the documentation is silent. Hosts change their proxies. Confirm yours with `posterna doctor` (step 4), which also sends forged forwarding headers to make sure they are ignored.

| Host | `trustedProxies` | `publicHost` | Confidence |
|---|---|---|---|
| Railway | `2` | recommended | medium |
| Vercel | `1` | recommended | medium |
| Fly.io | `2` (`3` with Cloudflare in front) | recommended | high |
| Render | `3` | recommended | low: check with doctor |
| AWS Application Load Balancer | your load balancer subnets' CIDRs | recommended; **required** with CloudFront | high |
| nginx on the same machine | `["127.0.0.1/32", "::1/128"]` | **required**, or pass `Host` as below | high |

Leave `trustForwardedHost` off on all of them.

The same values work for Express and Next.js on each host.

**Railway.**
- Railway's documentation names `X-Real-IP` for the client address and `X-Forwarded-Host` for the original host; it does not document `X-Forwarded-For` ([specs and limits](https://docs.railway.com/networking/public-networking/specs-and-limits)).
- Railway staff state that the edge replaces `X-Forwarded-For`, `X-Real-IP`, `X-Forwarded-Proto` and `X-Forwarded-Host` on every request, rather than appending to them ([Railway Station thread, October 2026](https://station.railway.com/questions/need-authoritative-client-ip-proxy-tru-090eac86)).
- A test request on 26 October 2026 arrived with `X-Forwarded-For: <client>, <edge address>`, so the client is two hops from your app. Railway publishes no proxy address ranges, so use the hop count.
- Traffic over Railway's private network (`*.railway.internal`) skips the edge and its header cleaning.
- With Railway's CDN turned on, cached responses never reach your app ([CDN](https://docs.railway.com/networking/cdn)).

**Vercel.**
- Vercel overwrites `X-Forwarded-For` with the client's address and does not forward external values, to prevent spoofing ([request headers](https://vercel.com/docs/headers/request-headers)). Use `1`.
- `X-Forwarded-Host` matches `Host`, the custom domain.
- Vercel advises against putting your own reverse proxy in front of a project, because the real client address can then no longer be identified ([reverse proxy](https://vercel.com/docs/security/reverse-proxy)).
- For Express on Vercel, `express.static()` files are served by Vercel's CDN and never reach the middleware ([Express on Vercel](https://vercel.com/docs/frameworks/backend/express)).

**Fly.io.**
- Fly Proxy appends the client address to `X-Forwarded-For`, followed by your app's own shared or dedicated address ([request headers](https://docs.fly.io/networking/request-headers)). So the client is two hops from your app, and `1` would give your app's own address. Fly's documentation warns that the header must be treated with caution to avoid spoofing.
- Fly Proxy keeps the original `Host` header. It does not set `X-Forwarded-Host`: a test request's forged value passed through, which is why `trustForwardedHost` must stay off here.
- With Cloudflare in front, add one hop.
- Machines talking over Fly's private network (6PN) bypass Fly Proxy entirely ([private networking](https://docs.fly.io/networking/private-networking)).

**Render.**
- Render's web services are reached through Cloudflare and then Render's load balancer.
- Render says to read the client address from `X-Forwarded-For` ([how Render handles DDoS attacks](https://render.com/articles/how-render-handles-ddos-attacks)).
- A demonstration by a Render employee shows a client's own entry kept, with the real client, a Cloudflare address and an internal address appended after it ([header test](https://github.com/johnbeynon/header-test)). That makes the client three hops from the app. A separate public report shows a shorter chain.
- Run `posterna doctor` before relying on `3`. If it reports the forged address, the chain on your service is shorter: use `2`.

**AWS Application Load Balancer.**
- By default an ALB appends the client address to `X-Forwarded-For` (`append` mode). Never use `preserve`, which passes the header through unmodified ([X-Forwarded headers](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/x-forwarded-headers.html)).
- The ALB reaches your targets from private addresses in its subnets ([how Elastic Load Balancing works](https://docs.aws.amazon.com/elasticloadbalancing/latest/userguide/how-elastic-load-balancing-works.html)). List those subnets' CIDRs, or your VPC's, in `trustedProxies`.
- Restrict your targets' security group to the load balancer's.
- The ALB sets `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Port`, but not `X-Forwarded-Host`, so a client's own value passes through: keep `trustForwardedHost` off. The ALB keeps `Host`, lowercased, with the port added on non-default listener ports.
- With CloudFront in front, also trust CloudFront's origin-facing ranges (service `CLOUDFRONT_ORIGIN_FACING` in [ip-ranges.json](https://ip-ranges.amazonaws.com/ip-ranges.json)). CloudFront replaces `Host` with the origin's domain ([request and response behavior](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RequestAndResponseBehaviorCustomOrigin.html)).

**nginx in front of Node on the same machine.**
- Bind Node to `127.0.0.1` and configure nginx like this:

  ```nginx
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
  ```

- `$proxy_add_x_forwarded_for` is the client's header with `$remote_addr` appended ([proxy module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)).
- By default nginx sends the upstream's name as `Host`, not the original one; `proxy_set_header Host $host` fixes that (or set `publicHost`). nginx passes a client's `X-Forwarded-Host` through unless you set it, so keep `trustForwardedHost` off.
- `proxy_set_header` lines are inherited from an outer block only when the inner block has none of its own.
- If a CDN sits in front of nginx, either use nginx's [realip module](https://nginx.org/en/docs/http/ngx_http_realip_module.html) with the CDN's ranges, or add those ranges to `trustedProxies`.

**Cloudflare in front of any host.** Prefer a hop count to listing Cloudflare's address ranges: Cloudflare Workers send requests from those same ranges, so a list would let a Worker write entries you then trust.

## 4. Check the setup with doctor

`posterna doctor` sends a signed request to your deployed site and reports what Posterna saw. It answers only to a request carrying your debug token.

1. Set a random `POSTERNA_DEBUG_TOKEN` on the server, for example from `openssl rand -hex 24`, and redeploy.
2. Run doctor from your own machine with the same token:

   ```bash
   POSTERNA_DEBUG_TOKEN=<token> npx posterna doctor --url https://www.example.com
   ```

3. Fix anything marked FAIL. Each failure comes with its fix.
4. Remove `POSTERNA_DEBUG_TOKEN` from the server. Without it, the debug route does not exist.

The checks:

| Check | Passes when |
|---|---|
| Debug route | `/.well-known/posterna/debug` answers with a Posterna report. With Next.js, the matcher must cover it. |
| Client IP | The site sees your machine's public address, as `https://posterna.com/v1/whoami` reports it, and ignores an `X-Forwarded-For` entry doctor forges. |
| Signed host | Signatures are checked against your site's hostname, not an `X-Forwarded-Host` doctor forges. |
| Signature headers | `Signature`, `Signature-Input` and `Signature-Agent` reach your app. Some proxies, CDNs and firewalls strip them. |
| Directory | The operator directory is loaded and less than a week old. |
| Mode | The mode and anything suspending enforcement (the proxy guard, either kill switch, a tripped breaker). |

## 5. Optional: send counters

With a site key from the dashboard in `POSTERNA_SITE_KEY`, Posterna sends aggregate counts every 60 seconds. They cover:

- verdict, reason code, operator, agent and purpose;
- a path group: the matched policy pattern, or the first path segment with identifier-like segments masked;
- the action taken and whether it was enforced.

No address, URL, header value or body ever leaves your server. Without a site key nothing is sent. Counters are flushed on shutdown too. If your app handles `SIGTERM` itself, call `await middleware.flush()` (Express) in your handler.

## 6. Switch to enforce, safely

1. **Watch first.** Run in monitor mode for at least a week. Look at the counts for each operator.
   - A high `claimed_failed` share for an operator that should be legitimate usually means its IP list is stale, or your proxy settings are wrong. It rarely means spoofing.
   - Also look at `proxySuspect`, at decisions marked `guarded`, and at the items in [real-traffic-checks.md](notes/real-traffic-checks.md).
2. **Run doctor** against production and fix every failure.
3. **Enforce one rule at a time.**
   - Set `mode: enforce`, and add `monitor: true` to every path rule you are not yet sure of. Those keep recording what they would do.
   - Remove the flags one by one.
   - Leave `unknown_automation` at `allow` unless you have a specific reason.
4. **Keep the guard on.** `guards.search_engines: protect` keeps verified search engines reachable whatever the rules say. It also stops failed search-engine claims from being blocked until this server has seen a verified request from that operator.
5. **Know the kill switches.**
   - Setting `POSTERNA_MODE=monitor` on the server stops all enforcement at the next start.
   - The dashboard can switch a site to monitor remotely. That switch can only turn enforcement off, never on.
   - Posterna also suspends enforcement on its own in two cases: when most requests look internal (a proxy setting is missing), and per operator when half of its IP-checked claims fail (the breaker).

## Configuration reference

| Environment variable | Meaning |
|---|---|
| `POSTERNA_POLICY` | Path to agents.yaml. Default: `agents.yaml` in the working directory. |
| `POSTERNA_MODE` | `monitor` turns enforcement off at start. No value turns it on. |
| `POSTERNA_SITE_KEY` | Site key for counters. Without it nothing is sent. |
| `POSTERNA_DEBUG_TOKEN` | Enables the debug route for `posterna doctor`. |
| `POSTERNA_BASE_URL` | The Posterna cloud's base URL, for tests. Default `https://posterna.com/v1/`. |
| `POSTERNA_COUNTERS_INTERVAL_MS` | Counter flush interval, for tests (at least 1000). Default 60 seconds. |

Adapter options take precedence over the environment. Both adapters accept:
- `trustedProxies`, `forwardedHeader`, `publicHost` and `trustForwardedHost`;
- `policy` (agents.yaml text or a parsed policy) and `policyPath`;
- `headers`, to rename the verdict request headers;
- `siteKey`, `baseUrl` and `debugToken`;
- `counters` (`false` turns counting off);
- `onError`, where configuration problems are reported (default `console.warn`; never given request data).
