# Install

Posterna runs inside your app. In about five minutes you can have it labeling every request, without blocking anything. This guide covers Express and Next.js, the proxy settings for common hosts, how to check the setup with `posterna doctor`, and how to switch to enforcement safely.

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

Then wrap your Next.js config, so that `agents.yaml` is built into the proxy. `posterna init` prints the exact change for your own `next.config`:

```ts
// next.config.ts
import { withPosternaConfig } from "@posterna/next/config";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // your existing settings
};

export default withPosternaConfig(nextConfig);
```

`withPosternaConfig` reads `agents.yaml` when Next.js loads the config and builds its text into the proxy, so the proxy never has to read the file at run time. Hosts such as Vercel deploy the proxy with only the code it imports, so without the wrapper the file is not there and Posterna runs a built-in monitor policy without your rules: on a live Vercel site, `posterna doctor` reported `FAIL Policy` with "No policy file at /var/task/agents.yaml", and with the wrapper (from a source build) the same site passed (27 October 2026). `agents.yaml` stays the one place your policy lives: every build copies it again, `posterna policy check` and `posterna robots` read it as before, and `next dev` picks up a change when you restart it. In `next.config.mjs` the import is the same; in CommonJS, use `require("@posterna/next/config")`. For a file somewhere else, pass its path: `withPosternaConfig(nextConfig, { policyPath: "config/agents.yaml" })`. The proxy uses the built-in copy unless you pass `policy` or `policyPath` in its own options.

If you already have a proxy function, pass it as the second argument: `withPosterna(options, yourProxy)`. Posterna runs first; your function runs after it and can read the verdict with `getPosterna(request)`. Next.js reads `config` at build time, so write it out in your own file; it cannot be imported. Make sure the matcher covers every page you want labeled, including your sign-up route.

Before you settle on the matcher, leave out these routes:

- **Large uploads.** With a proxy, Next.js holds each matched request's body in memory and keeps only the first 10 MB (`experimental.proxyClientMaxBodySize` in `next.config`; Next.js 15 calls it `middlewareClientMaxBodySize`). Anything past that is cut off, with only a warning in the server log. Exclude routes that take larger uploads, or raise the limit.
- **Webhooks** that check a signature over the raw request body. They are safest left out.
- **Paths rewritten to another site**, such as an analytics proxy set up in `next.config` rewrites. The proxy runs before rewrites, so the verdict request headers would be passed on to that site.
- **Health checks** from your load balancer or platform. See [Keep health checks out of Posterna](#health-checks).

For example, with webhooks under `/api/webhooks` and an analytics rewrite under `/ingest`:

```ts
matcher: ["/((?!_next/static|_next/image|favicon.ico|api/webhooks|ingest).*)"],
```

In Next.js 16, the proxy always runs on the Node.js runtime, so it can do reverse DNS. Without `withPosternaConfig`, it reads `agents.yaml` from the project folder at run time. That works with `next start` in the project folder, but needs Node 20.16 or later; on older Node, Posterna logs a `[posterna]` warning and runs a built-in monitor policy without your rules, and `posterna doctor` reports it.

Pages and route handlers read the verdict from the request headers:

```ts
import { headers } from "next/headers";

const verdict = (await headers()).get("x-agent-verdict");
```

A route handler that needs a sign-up recommendation verifies and decides itself, because it runs in a different bundle from the proxy. It gets the same built-in copy of `agents.yaml`. Turn counting off there, since the proxy already counted the request:

```ts
import { createPosterna } from "@posterna/next";

const posterna = createPosterna({ trustedProxies: 1, publicHost: "www.example.com", counters: false });

export async function POST(request: Request) {
  const result = await posterna.verify(request);
  const decision = posterna.decide(result, { path: "/api/signup", kind: "signup" });
  // act on decision.action when decision.enforced is true
}
```

A sign-up form built as a Server Action posts to the page's own path, not to a route handler. Ask for the recommendation in your proxy function and hand it to the action in a request header:

```ts
import { getPosterna, withPosterna } from "@posterna/next";
import { type NextRequest, NextResponse } from "next/server";

export const proxy = withPosterna(
  { clientIpHeader: "x-real-ip", publicHost: "www.example.com" },
  (request: NextRequest) => {
    if (request.method !== "POST" || request.nextUrl.pathname !== "/signup") return;
    const decision = getPosterna(request)?.decide({ kind: "signup" });
    const headers = new Headers(request.headers);
    // Always set it, so a value the client sent is never passed on.
    headers.set("x-signup-recommendation", decision?.enforced ? decision.action : "allow");
    return NextResponse.next({ request: { headers } });
  },
);
```

In the action, read it with `(await headers()).get("x-signup-recommendation")`. Your own header names cannot start with `x-agent-` or `x-posterna-`, because Posterna removes those. A matcher that excludes a page also skips its Server Actions.

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

Wrap your Next.js config in `withPosternaConfig`, and leave the same routes out of the matcher, as for Next.js 16 above.

### The Edge runtime

Next.js before 15.5 runs middleware only on the Edge runtime, and Next.js 16 still allows `middleware.ts` there. Posterna avoids Node.js built-ins so that it can run there, with these limits (the end-to-end tests cover the Node.js runtime only):

- **No reverse DNS.** There is no DNS resolver, so operators that are checked by reverse DNS (Googlebot outside its IP lists, for example) stay `declared_unverifiable`.
- **No files.** The Edge runtime cannot read files, so wrap your Next.js config in `withPosternaConfig` to build `agents.yaml` in (checked with Next.js 15.5 middleware on the Edge runtime), or pass the policy text as `policy`.
- **Bundle size.** The operator directory (about 650 KB of JSON) is bundled into the middleware.

Prefer the Node.js runtime wherever you can.

<a id="health-checks"></a>

### Keep health checks out of Posterna

Load balancer and platform health checks come from private addresses: the load balancer's own nodes, the platform's checker, or `localhost` for a container's own check. Posterna's proxy guard can count them. When 80 percent of the last 200 requests come from private addresses, it decides the proxy settings must be wrong and suspends enforcement, and `posterna doctor` reports `FAIL Mode`. On a site with little other traffic, health checks alone get there: an AWS load balancer checks each target every 30 seconds by default, and on `/` unless you set a path ([target group health checks](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html)). Our own canary sites hit this on 27 October 2026.

Give health checks their own path, and keep that path out of Posterna.

**Express:** register the health route before Posterna. Express runs handlers in order, so the request never reaches the middleware:

```js
app.get("/healthz", (_req, res) => res.send("ok"));

app.use(posterna({ trustedProxies: 1, publicHost: "www.example.com" }));
```

**Next.js:** leave the path out of the matcher, next to the other exclusions:

```ts
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|healthz).*)"],
};
```

`healthz` in that pattern also skips any path that starts with it, such as `/healthz/db`. Add it as a route handler, for example `app/healthz/route.ts` with `export function GET() { return new Response("ok"); }`.

Then point the checks at that path:

- **AWS Application Load Balancer:** the target group's **Health check path** (`HealthCheckPath`), which is `/` by default.
- **Render:** the service's **Health Check Path** (`healthCheckPath` in `render.yaml`). Render checks every few seconds, for as long as the service runs ([health checks](https://render.com/docs/health-checks)).
- **Fly.io:** the `path` of the HTTP check in `fly.toml`.
- **Kubernetes:** the `path` of the liveness and readiness probes.
- **Docker `HEALTHCHECK`** and other checks run inside the container: the same path, on `localhost`.
- **Railway** checks the healthcheck path only while a deployment starts, not after it is live ([healthchecks](https://docs.railway.com/reference/healthchecks)), so it cannot trip the guard. Using the same path costs nothing.
- **Vercel** sends no health checks.

The debug route that `posterna doctor` calls (`/.well-known/posterna/debug`) must stay covered: do not exclude it.

<a id="trusted-proxies"></a>

## 3. Tell Posterna about your proxies

This step matters most. Posterna checks crawlers against their operators' published IP ranges, so it needs the real client address. It also needs the hostname agents sign. Behind a proxy, both arrive in headers, and those are safe to read only when you say which ones to trust:

- **`clientIpHeader`**: the simplest setting, where your host supports it. Name one request header that your host documents overwriting with the client's address on every request, for example `x-vercel-forwarded-for` on Vercel. Posterna reads that header and nothing else for the address: no counting.
  - It is safe only for a header your host overwrites. Any other header can be set by the client.
  - If the header is missing, the address is unknown, and IP checks are off for that request.
  - With CIDRs in `trustedProxies`, the header is read only from those proxies. That protects you if your app can also be reached without going through the proxy.
- **`trustedProxies`**: a hop count or a list of CIDRs, for hosts with no such header.
  - A hop count `N` means the client is the address `N` hops to the left of the socket peer in `X-Forwarded-For`. So `1` is the last entry, appended by the one proxy in front of you.
  - A list of CIDRs skips trusted addresses from the right of `X-Forwarded-For`.
  - Without the setting, forwarding headers are ignored.
- **`publicHost`**: the hostname agents sign, or a list of them, for example `["www.example.com", "example.com"]`. Without it, Posterna uses the `Host` header your app receives, which is right only when your proxy passes the original one through. Setting it is the safest choice on every host, and required where the proxy changes `Host`.
- **`trustForwardedHost`**: off by default, and best left off. When on, the signed host comes from `X-Forwarded-Host` sent by a trusted proxy. Several hosts below pass a client's own `X-Forwarded-Host` through to your app, so a client could then choose the host signatures are checked against. Turn it on only behind a proxy that overwrites the header, and only if you cannot set `publicHost` (for example, an app serving many customer domains).
- **`forwardedHeader`**: keep the default, `x-forwarded-for`. None of the hosts below maintains the RFC 7239 `Forwarded` header, and some pass a client's copy through unchanged.

Next.js never gives middleware or a proxy the socket address. With `clientIpHeader` set, Posterna reads that header. With `trustedProxies` set, it reads `X-Forwarded-For` from its right end. With neither, there is no client address, and IP checks are off. When `next start` is reached directly, with no proxy in front, Next.js passes on an `X-Forwarded-For` the client sent itself. Always run Next.js behind your host's proxy or your own.

### Settings by host

These settings come from each host's documentation, checked on 26 October 2026, and from test requests where the documentation is silent. `clientIpHeader` is recommended only where the host's own documentation says it overwrites the header, or where we have confirmed that on a live site (Railway and Vercel). Hosts change their proxies. Confirm yours with `posterna doctor` (step 4), which sends forged copies of these headers to make sure they are ignored.

| Host | Client address | `publicHost` | Confidence |
|---|---|---|---|
| Railway, with or without Cloudflare in front | `clientIpHeader: "x-real-ip"` | recommended | high: confirmed on a live site |
| Vercel | `clientIpHeader: "x-vercel-forwarded-for"` | recommended | high: confirmed on a live site (IPv4) |
| Fly.io | `trustedProxies: 2` (`3` with Cloudflare in front) | recommended | high |
| Render | `trustedProxies: 3` | recommended | low: check with doctor |
| AWS Application Load Balancer | `trustedProxies:` your load balancer subnets' CIDRs | recommended; **required** with CloudFront | high |
| Amazon CloudFront, in front of any of these | the setting for the host behind it, plus CloudFront's ranges behind a load balancer; the origin request policy **AllViewerExceptHostHeader** is **required** | **required** | high: from AWS's documentation |
| nginx on the same machine | `clientIpHeader: "x-real-ip"` and `trustedProxies: ["127.0.0.1/32", "::1/128"]`, with the nginx config below | **required**, or pass `Host` as below | high |

Leave `trustForwardedHost` off on all of them.

The same values work for Express and Next.js on each host.

**Railway.**
- Use `clientIpHeader: "x-real-ip"`. Railway's documentation names `X-Real-IP` for the client address and `X-Forwarded-Host` for the original host ([specs and limits](https://docs.railway.com/networking/public-networking/specs-and-limits)), and Railway staff state that the edge replaces `X-Forwarded-For`, `X-Real-IP`, `X-Forwarded-Proto` and `X-Forwarded-Host` on every request rather than appending to them ([Railway Station thread, October 2026](https://station.railway.com/questions/need-authoritative-client-ip-proxy-tru-090eac86)).
- Confirmed on 27 October 2026 on a live site, both on its `*.up.railway.app` address and with Cloudflare proxying a custom domain in front: `X-Real-IP` carried the real client address over IPv4 and IPv6, forged `X-Real-IP` and `X-Forwarded-For` values were ignored, and `posterna doctor` passed.
- Avoid a hop count here. A test request on 26 October 2026 arrived with `X-Forwarded-For: <client>, <edge address>` (two hops), but with Cloudflare in front the chain was not measured, and Railway publishes no proxy address ranges.
- Traffic over Railway's private network (`*.railway.internal`) skips the edge and its header cleaning.
- With Railway's CDN turned on, cached responses never reach your app ([CDN](https://docs.railway.com/networking/cdn)).

**Vercel.**
- Vercel overwrites `X-Forwarded-For` with the client's address and does not forward external values, to prevent spoofing. `x-vercel-forwarded-for` is documented as identical to it, and unlike `X-Forwarded-For` it is not overwritten by a proxy you put in front of Vercel ([request headers](https://vercel.com/docs/headers/request-headers)). Use `clientIpHeader: "x-vercel-forwarded-for"`; `trustedProxies: 1` also works.
- Confirmed on 27 October 2026 on a live `*.vercel.app` site (Next.js 16, `@posterna/next` 0.1.1), from a home connection and from a GitHub Actions runner: `x-vercel-forwarded-for` carried the real client address, a forged copy was ignored, and the signed host and signature headers passed `posterna doctor`. `*.vercel.app` has no IPv6 address, so IPv6 was not checked.
- The proxy cannot read files on Vercel, so wrap your Next.js config in `withPosternaConfig`; see the Next.js 16 section above.
- `X-Forwarded-Host` matches `Host`, the custom domain.
- Vercel advises against putting your own reverse proxy in front of a project, because the real client address can then no longer be identified ([reverse proxy](https://vercel.com/docs/security/reverse-proxy)).
- For Express on Vercel, `express.static()` files are served by Vercel's CDN and never reach the middleware ([Express on Vercel](https://vercel.com/docs/frameworks/backend/express)).

**Fly.io.**
- Fly Proxy appends the client address to `X-Forwarded-For`, followed by your app's own shared or dedicated address ([request headers](https://docs.fly.io/networking/request-headers)). So the client is two hops from your app, and `1` would give your app's own address. Fly's documentation warns that the header must be treated with caution to avoid spoofing.
- Fly also adds `Fly-Client-IP`, the client's address as Fly Proxy sees it, but its documentation does not say that it replaces a client's own value, so use the hop count rather than `clientIpHeader`.
- Fly Proxy keeps the original `Host` header. It does not set `X-Forwarded-Host`: a test request's forged value passed through, which is why `trustForwardedHost` must stay off here.
- With Cloudflare in front, add one hop.
- Machines talking over Fly's private network (6PN) bypass Fly Proxy entirely ([private networking](https://docs.fly.io/networking/private-networking)).

**Render.**
- Render's web services are reached through Cloudflare and then Render's load balancer.
- Render says to read the client address from `X-Forwarded-For` ([how Render handles DDoS attacks](https://render.com/articles/how-render-handles-ddos-attacks)).
- A demonstration by a Render employee shows a client's own entry kept, with the real client, a Cloudflare address and an internal address appended after it ([header test](https://github.com/johnbeynon/header-test)). That makes the client three hops from the app. A separate public report shows a shorter chain.
- Run `posterna doctor` before relying on `3`. If it reports the forged address, the chain on your service is shorter: use `2`.
- Render does not document a single client-address header, so there is no `clientIpHeader` setting for it.

**AWS Application Load Balancer.**
- By default an ALB appends the client address to `X-Forwarded-For` (`append` mode). Never use `preserve`, which passes the header through unmodified ([X-Forwarded headers](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/x-forwarded-headers.html)).
- The ALB reaches your targets from private addresses in its subnets ([how Elastic Load Balancing works](https://docs.aws.amazon.com/elasticloadbalancing/latest/userguide/how-elastic-load-balancing-works.html)). List those subnets' CIDRs, or your VPC's, in `trustedProxies`.
- Restrict your targets' security group to the load balancer's.
- The ALB sets `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Port`, but not `X-Forwarded-Host`, so a client's own value passes through: keep `trustForwardedHost` off. The ALB keeps `Host`, lowercased, with the port added on non-default listener ports.
- With CloudFront in front, also trust CloudFront's origin-facing ranges (service `CLOUDFRONT_ORIGIN_FACING` in [ip-ranges.json](https://ip-ranges.amazonaws.com/ip-ranges.json)), and see the CloudFront section below.

<a id="cloudfront"></a>

**Amazon CloudFront in front of any origin.**
- Without an origin request policy, CloudFront sends your app only a few of the visitor's headers. It leaves out `Signature`, `Signature-Input` and `Signature-Agent`, removes `Accept` and `Accept-Language`, and replaces every `User-Agent` with `Amazon CloudFront` ([control origin requests](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/controlling-origin-requests.html), [request headers and CloudFront behavior](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RequestAndResponseBehaviorCustomOrigin.html#request-custom-headers-behavior)). Posterna would then see no signatures and label every visitor `unknown_automation`.
- The fix: in every cache behavior that reaches your app, set the origin request policy to the managed **AllViewerExceptHostHeader** policy (ID `b689b0a8-53d0-40ab-baf2-68738e2966ac`). It sends your app every visitor header except `Host`, with all cookies and query strings ([managed origin request policies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-origin-request-policies.html)).
  - Console: **CloudFront** → **Distributions** → your distribution → **Behaviors** → select the behavior → **Edit** → **Cache key and origin requests** → **Cache policy and origin request policy (recommended)** → **Origin request policy**: **AllViewerExceptHostHeader** → **Save changes**.
  - CloudFormation: `OriginRequestPolicyId: b689b0a8-53d0-40ab-baf2-68738e2966ac` on the cache behavior.
  - If you use a custom origin request policy instead, its headers must include at least `User-Agent`, `Accept`, `Accept-Language`, `Signature`, `Signature-Input` and `Signature-Agent`, as well as whatever your app needs.
- CloudFront then sends the origin's domain as `Host`, so set `publicHost` to the hostname visitors use. (The **AllViewer** policy forwards the visitor's `Host` too, but your origin must then accept that name, including its TLS certificate.)
- Responses CloudFront serves from its cache never reach your app, so they are not labeled or counted. For pages you want labeled, use the managed **CachingDisabled** cache policy (ID `4135ea2d-6df8-44a3-9df3-4b5a84be39ad`) or keep them out of the cache with `Cache-Control`.
- CloudFront appends the visitor's address to `X-Forwarded-For`, and a load balancer behind it appends CloudFront's address. Behind an Application Load Balancer, keep CloudFront's origin-facing ranges in `trustedProxies`, as above.
- CloudFront can add `CloudFront-Viewer-Address` through an origin request policy, but its documentation does not say what happens to a client's own copy ([CloudFront request headers](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/adding-cloudfront-headers.html)). Keep the CIDRs instead.
- `posterna doctor` catches a missing policy: its Signature headers check fails.

**nginx in front of Node on the same machine.**
- Bind Node to `127.0.0.1` and configure nginx like this:

  ```nginx
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
  ```

- `proxy_set_header` redefines the header, so `X-Real-IP` always carries the address nginx saw, whatever the client sent ([proxy module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)). That makes `clientIpHeader: "x-real-ip"` safe. Listing the loopback addresses in `trustedProxies` means the header is read only from nginx.
- If you use `X-Forwarded-For` instead (`trustedProxies` alone), `$proxy_add_x_forwarded_for` is the client's header with `$remote_addr` appended.
- By default nginx sends the upstream's name as `Host`, not the original one; `proxy_set_header Host $host` fixes that (or set `publicHost`). nginx passes a client's `X-Forwarded-Host` through unless you set it, so keep `trustForwardedHost` off.
- `proxy_set_header` lines are inherited from an outer block only when the inner block has none of its own.
- If a CDN sits in front of nginx, use nginx's [realip module](https://nginx.org/en/docs/http/ngx_http_realip_module.html) with the CDN's ranges, so that `$remote_addr`, and with it `X-Real-IP`, is the real client.

**Cloudflare in front of any host.** Prefer a hop count to listing Cloudflare's address ranges: Cloudflare Workers send requests from those same ranges, so a list would let a Worker write entries you then trust. On Railway, keep `clientIpHeader: "x-real-ip"`: it already carries the real client behind Cloudflare.

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
| Client IP | The site sees your machine's public address, as `https://posterna.com/v1/whoami` reports it, and ignores an `X-Forwarded-For` entry doctor forges. With `clientIpHeader`, doctor also forges that header, which fails if your host does not overwrite it. Doctor checks IPv4 and IPv6 separately, and says when one cannot be checked from your machine. |
| Signed host | Signatures are checked against your site's hostname, not an `X-Forwarded-Host` doctor forges. |
| Signature headers | `Signature`, `Signature-Input` and `Signature-Agent` reach your app. Some proxies, CDNs and firewalls strip them. |
| Policy | `agents.yaml` (or the `policy` option) was loaded. If it was not, Posterna runs a built-in monitor policy without your rules, and doctor shows why. |
| Directory | The operator directory is loaded and less than a week old. |
| Mode | The mode and anything suspending enforcement (the proxy guard, either kill switch, a tripped breaker). |

If doctor cannot reach `https://posterna.com/v1/whoami`, it names that step. A network whose DNS still has an old address for posterna.com is one cause: try another network, or pass `--base-url`.

### Testing by hand

- **A crawler's first request is labeled pending.** For operators checked by reverse DNS, the lookup runs in the background, so the first request from an address that claims to be, for example, Googlebot is `declared_unverifiable` with the reason `rdns_pending`. Later requests from that address get the result: `verified_by_ip`, or `claimed_failed` (`rdns_unconfirmed`) for a fake. The counts show some `rdns_pending` for this reason.
- **No client address locally.** With `clientIpHeader` set, a request to your local server has no client address (`no_client_address`) unless you send that header yourself, for example `curl -H "X-Real-IP: 203.0.113.7" http://localhost:3000/`.
- **curl looks like automation.** A plain curl request is `unknown_automation`: its User-Agent is not a browser's (`non_browser_user_agent`), and with a browser User-Agent it still sends no `Accept-Language` (`missing_accept_language`). To look like a browser, send both, for example `-A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36" -H "Accept: text/html" -H "Accept-Language: en"`.

## 5. Optional: send counters

With a site key from the dashboard in `POSTERNA_SITE_KEY`, Posterna sends aggregate counts every 60 seconds. They cover:

- verdict, reason code, operator, agent and purpose;
- a path group: the matched policy pattern, else the first path segment (`/docs/*`, or `/robots.txt` for a file at the root), with identifier-like segments masked;
- the action taken and whether it was enforced;
- bytes served, with Express only: the Next.js proxy runs before the page and cannot see response sizes, so the dashboard shows bytes as not available for Next.js sites.

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
| `POSTERNA_POLICY` | Path to agents.yaml. Default: `agents.yaml` in the working directory. With Next.js, `withPosternaConfig` reads it at build time. |
| `POSTERNA_POLICY_TEXT` | Next.js only: the agents.yaml text, which `withPosternaConfig` builds in. Set it yourself only where neither the wrapper nor a file can be used. |
| `POSTERNA_MODE` | `monitor` turns enforcement off at start. No value turns it on. |
| `POSTERNA_SITE_KEY` | Site key for counters. Without it nothing is sent. |
| `POSTERNA_DEBUG_TOKEN` | Enables the debug route for `posterna doctor`. |
| `POSTERNA_BASE_URL` | The Posterna cloud's base URL, for tests. Default `https://posterna.com/v1/`. |
| `POSTERNA_COUNTERS_INTERVAL_MS` | Counter flush interval, for tests (at least 1000). Default 60 seconds. |

Adapter options take precedence over the environment. Both adapters accept:
- `clientIpHeader`, `trustedProxies`, `forwardedHeader`, `publicHost` and `trustForwardedHost`;
- `policy` (agents.yaml text or a parsed policy) and `policyPath`;
- `headers`, to rename the verdict request headers;
- `siteKey`, `baseUrl` and `debugToken`;
- `counters` (`false` turns counting off);
- `onError`, where configuration problems are reported (default `console.warn`; never given request data).

<a id="from-source"></a>
<a id="pre-release"></a>

## Install from a source build

To try changes that are not on npm yet, install the packages from a local build of this repository. These steps were tested with npm 11 on 27 October 2026. Replace `<version>` with the version in each package's `package.json`.

1. Build the packages (Node 20 or later, pnpm 10):

   ```bash
   git clone https://github.com/posternahq/posterna.git
   cd posterna
   pnpm install
   pnpm build
   ```

2. Pack core, the directory and your adapter (`express` or `next`) into a `vendor` folder in your app:

   ```bash
   for p in core directory next; do
     pnpm --filter @posterna/$p pack --pack-destination /path/to/your-app/vendor
   done
   ```

3. In your app's `package.json`, depend on the adapter's tarball, and override core and the directory with theirs:

   ```json
   {
     "dependencies": {
       "@posterna/next": "file:vendor/posterna-next-<version>.tgz"
     },
     "overrides": {
       "@posterna/core": "file:vendor/posterna-core-<version>.tgz",
       "@posterna/directory": "file:vendor/posterna-directory-<version>.tgz"
     }
   }
   ```

   You need both overrides: packing turns the packages' dependencies on each other into plain version numbers, which npm would otherwise fetch from the registry. With pnpm, put the same two entries under `pnpm.overrides`; with Yarn, under `resolutions`. Commit the `vendor` folder, so your host's build can install from it. Vercel keeps `node_modules` between builds, so a new tarball with an unchanged version number is not installed there: redeploy with `vercel deploy --force`, which skips the build cache (seen on 27 October 2026).

4. Install, then check that a clean install works the way your host builds:

   ```bash
   npm install
   rm -rf node_modules && npm ci
   ```

   `npm install` can write a lockfile that `npm ci` rejects (for example `Missing: @emnapi/core from lock file`), and hosts such as Railway build with `npm ci`. If the check fails, restore your previous `package-lock.json` from git, run `npm install` again so that only the new entries are added, and repeat the check.

5. Wherever this guide says `npx posterna`, run the CLI from the same build instead, from your app's folder:

   ```bash
   node /path/to/posterna/packages/cli/dist/bin.js init
   ```

   Skip the `npm install` line that `init` prints: you have installed the packages already.
