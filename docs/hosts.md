# Hosts and proxies

Proxy settings matter most. Posterna checks crawlers against their operators' published IP ranges, so it needs the real client address. It also needs the hostname agents sign. Behind a proxy, both arrive in headers, and those are safe to read only when you say which ones to trust.

The [quickstart](install.md) shows the setting for your host. This page explains each setting, gives the evidence for each host, and shows how to keep health checks out of Posterna.

## Proxy settings

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

## Settings by host

These settings come from each host's documentation, checked on 26 October 2026, and from test requests where the documentation is silent. `clientIpHeader` is recommended only where the host's own documentation says it overwrites the header, or where we have confirmed that on a live site (Railway and Vercel). Hosts change their proxies. Confirm yours with `posterna doctor` ([Check with doctor](doctor.md)), which sends forged copies of these headers to make sure they are ignored.

<!-- posterna:hosts-table -->
| Host | Client address | `publicHost` | Confidence |
|---|---|---|---|
| Railway, with or without Cloudflare in front | `clientIpHeader: "x-real-ip"` | recommended | high: confirmed on a live site |
| Vercel | `clientIpHeader: "x-vercel-forwarded-for"` | recommended | high: confirmed on a live site (IPv4) |
| Fly.io | `trustedProxies: 2` (`3` with Cloudflare in front) | recommended | high |
| Render | `trustedProxies: 3` | recommended | low: check with doctor |
| AWS Application Load Balancer | `trustedProxies:` your load balancer subnets' CIDRs | recommended; **required** with CloudFront | high |
| Amazon CloudFront, in front of any of these | the setting for the host behind it, plus CloudFront's ranges behind a load balancer; the origin request policy **AllViewerExceptHostHeader** is **required** | **required** | high: from AWS's documentation |
| nginx on the same machine | `clientIpHeader: "x-real-ip"` and `trustedProxies: ["127.0.0.1/32", "::1/128"]`, with the nginx config below | **required**, or pass `Host` as below | high |
<!-- posterna:end hosts-table -->

Leave `trustForwardedHost` off on all of them.

The same values work for Express and Next.js on each host.

### Railway

- Use `clientIpHeader: "x-real-ip"`. Railway's documentation names `X-Real-IP` for the client address and `X-Forwarded-Host` for the original host ([specs and limits](https://docs.railway.com/networking/public-networking/specs-and-limits)), and Railway staff state that the edge replaces `X-Forwarded-For`, `X-Real-IP`, `X-Forwarded-Proto` and `X-Forwarded-Host` on every request rather than appending to them ([Railway Station thread, October 2026](https://station.railway.com/questions/need-authoritative-client-ip-proxy-tru-090eac86)).
- Confirmed on 27 October 2026 on a live site, both on its `*.up.railway.app` address and with Cloudflare proxying a custom domain in front: `X-Real-IP` carried the real client address over IPv4 and IPv6, forged `X-Real-IP` and `X-Forwarded-For` values were ignored, and `posterna doctor` passed.
- Avoid a hop count here. A test request on 26 October 2026 arrived with `X-Forwarded-For: <client>, <edge address>` (two hops), but with Cloudflare in front the chain was not measured, and Railway publishes no proxy address ranges.
- Traffic over Railway's private network (`*.railway.internal`) skips the edge and its header cleaning.
- With Railway's CDN turned on, cached responses never reach your app ([CDN](https://docs.railway.com/networking/cdn)).

### Vercel

- Vercel overwrites `X-Forwarded-For` with the client's address and does not forward external values, to prevent spoofing. `x-vercel-forwarded-for` is documented as identical to it, and unlike `X-Forwarded-For` it is not overwritten by a proxy you put in front of Vercel ([request headers](https://vercel.com/docs/headers/request-headers)). Use `clientIpHeader: "x-vercel-forwarded-for"`; `trustedProxies: 1` also works.
- Confirmed on 27 October 2026 on a live `*.vercel.app` site (Next.js 16, `@posterna/next` 0.1.1), from a home connection and from a GitHub Actions runner: `x-vercel-forwarded-for` carried the real client address, a forged copy was ignored, and the signed host and signature headers passed `posterna doctor`. `*.vercel.app` has no IPv6 address, so IPv6 was not checked.
- The proxy cannot read files on Vercel, so wrap your Next.js config in `withPosternaConfig`; see [Next.js details](nextjs.md#why-withposternaconfig).
- `X-Forwarded-Host` matches `Host`, the custom domain.
- Vercel advises against putting your own reverse proxy in front of a project, because the real client address can then no longer be identified ([reverse proxy](https://vercel.com/docs/security/reverse-proxy)).
- For Express on Vercel, `express.static()` files are served by Vercel's CDN and never reach the middleware ([Express on Vercel](https://vercel.com/docs/frameworks/backend/express)).

### Fly.io

- Fly Proxy appends the client address to `X-Forwarded-For`, followed by your app's own shared or dedicated address ([request headers](https://docs.fly.io/networking/request-headers)). So the client is two hops from your app, and `1` would give your app's own address. Fly's documentation warns that the header must be treated with caution to avoid spoofing.
- Fly also adds `Fly-Client-IP`, the client's address as Fly Proxy sees it, but its documentation does not say that it replaces a client's own value, so use the hop count rather than `clientIpHeader`.
- Fly Proxy keeps the original `Host` header. It does not set `X-Forwarded-Host`: a test request's forged value passed through, which is why `trustForwardedHost` must stay off here.
- With Cloudflare in front, add one hop.
- Machines talking over Fly's private network (6PN) bypass Fly Proxy entirely ([private networking](https://docs.fly.io/networking/private-networking)).

### Render

- Render's web services are reached through Cloudflare and then Render's load balancer.
- Render says to read the client address from `X-Forwarded-For` ([how Render handles DDoS attacks](https://render.com/articles/how-render-handles-ddos-attacks)).
- A demonstration by a Render employee shows a client's own entry kept, with the real client, a Cloudflare address and an internal address appended after it ([header test](https://github.com/johnbeynon/header-test)). That makes the client three hops from the app. A separate public report shows a shorter chain.
- Run `posterna doctor` before relying on `3`. If it reports the forged address, the chain on your service is shorter: use `2`.
- Render does not document a single client-address header, so there is no `clientIpHeader` setting for it.

### AWS Application Load Balancer

- By default an ALB appends the client address to `X-Forwarded-For` (`append` mode). Never use `preserve`, which passes the header through unmodified ([X-Forwarded headers](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/x-forwarded-headers.html)).
- The ALB reaches your targets from private addresses in its subnets ([how Elastic Load Balancing works](https://docs.aws.amazon.com/elasticloadbalancing/latest/userguide/how-elastic-load-balancing-works.html)). List those subnets' CIDRs, or your VPC's, in `trustedProxies`.
- Restrict your targets' security group to the load balancer's.
- The ALB sets `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Port`, but not `X-Forwarded-Host`, so a client's own value passes through: keep `trustForwardedHost` off. The ALB keeps `Host`, lowercased, with the port added on non-default listener ports.
- With CloudFront in front, also trust CloudFront's origin-facing ranges (service `CLOUDFRONT_ORIGIN_FACING` in [ip-ranges.json](https://ip-ranges.amazonaws.com/ip-ranges.json)), and see the CloudFront section below.
- An ALB checks each target every 30 seconds by default, on `/`: [keep health checks out of Posterna](#health-checks).

<a id="cloudfront"></a>

### Amazon CloudFront in front of any origin

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

### nginx in front of Node on the same machine

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

### Cloudflare in front of any host

Prefer a hop count to listing Cloudflare's address ranges: Cloudflare Workers send requests from those same ranges, so a list would let a Worker write entries you then trust. On Railway, keep `clientIpHeader: "x-real-ip"`: it already carries the real client behind Cloudflare.

<a id="health-checks"></a>

## Keep health checks out of Posterna

Load balancer and platform health checks come from private addresses: the load balancer's own nodes, the platform's checker, or `localhost` for a container's own check. Posterna's proxy guard can count them. When 80 percent of the last 200 requests come from private addresses, it decides the proxy settings must be wrong and suspends enforcement, and `posterna doctor` reports `FAIL Mode`. On a site with little other traffic, health checks alone get there: an AWS load balancer checks each target every 30 seconds by default, and on `/` unless you set a path ([target group health checks](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html)). Our own canary sites hit this on 27 October 2026.

Give health checks their own path, and keep that path out of Posterna.

<!-- posterna:selectors framework -->

<!-- posterna:framework express -->

### Express

Register the health route before Posterna. Express runs handlers in order, so the request never reaches the middleware:

```js
app.get("/healthz", (_req, res) => res.send("ok"));

app.use(posterna({ clientIpHeader: "x-real-ip", publicHost: "www.example.com" }));
```

<!-- posterna:framework next -->

### Next.js

Leave the path out of the matcher, next to the [other exclusions](nextjs.md#routes-to-leave-out-of-the-matcher):

```ts
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|healthz).*)"],
};
```

`healthz` in that pattern also skips any path that starts with it, such as `/healthz/db`. Add it as a route handler, for example `app/healthz/route.ts` with `export function GET() { return new Response("ok"); }`.

<!-- posterna:end framework -->

Then point the checks at that path:

- **AWS Application Load Balancer:** the target group's **Health check path** (`HealthCheckPath`), which is `/` by default.
- **Render:** the service's **Health Check Path** (`healthCheckPath` in `render.yaml`). Render checks every few seconds, for as long as the service runs ([health checks](https://render.com/docs/health-checks)).
- **Fly.io:** the `path` of the HTTP check in `fly.toml`.
- **Kubernetes:** the `path` of the liveness and readiness probes.
- **Docker `HEALTHCHECK`** and other checks run inside the container: the same path, on `localhost`.
- **Railway** checks the healthcheck path only while a deployment starts, not after it is live ([healthchecks](https://docs.railway.com/reference/healthchecks)), so it cannot trip the guard. Using the same path costs nothing.
- **Vercel** sends no health checks.

The debug route that `posterna doctor` calls (`/.well-known/posterna/debug`) must stay covered: do not exclude it.
