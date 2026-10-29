# Quickstart

Posterna runs inside your Express or Next.js app. Three steps, about five minutes. It starts in monitor mode: it labels and counts every request and blocks nothing. On WordPress, use the [WordPress plugin](wordpress.md) instead.

<!-- posterna:selectors -->

## 1. Create your policy

In your project:

```bash
npx posterna init
```

It writes `agents.yaml` in monitor mode and prints the code for step 2; it never edits your code. It can also save a site key from the dashboard, so counts show up there ([Counters](counters.md)).

## 2. Add Posterna to your app

<!-- posterna:framework express -->

### Express

```bash
npm install @posterna/express
```

<!-- posterna:host-snippet express-app -->
```js
import express from "express";
import { posterna } from "@posterna/express";

const app = express();

app.use(
  posterna({
    clientIpHeader: "x-real-ip", // Railway; other hosts in the table below
    publicHost: "www.example.com", // your site's hostname
  }),
);
```

Add it before your routes.

<!-- posterna:framework next -->

### Next.js

```bash
npm install @posterna/next
```

Create `proxy.ts` next to your `app` folder (inside `src/` if you use one):

<!-- posterna:host-snippet next-proxy -->
```ts
import { withPosterna } from "@posterna/next";

export const proxy = withPosterna({
  clientIpHeader: "x-real-ip", // Railway; other hosts in the table below
  publicHost: "www.example.com", // your site's hostname
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

Then wrap your Next.js config ([why](nextjs.md#nextjs-16-proxyts)):

```ts
// next.config.ts
import { withPosternaConfig } from "@posterna/next/config";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // your existing settings
};

export default withPosternaConfig(nextConfig);
```

On Next.js 15.5, use `middleware.ts` with `runtime: "nodejs"` instead ([Next.js details](nextjs.md#nextjs-15-middlewarets)).

<!-- posterna:end framework -->

<!-- posterna:hosts-quick -->
The setting for your host, from [Hosts and proxies](hosts.md#settings-by-host):

| Host | Setting | Also |
|---|---|---|
| [Railway](hosts.md#railway) | `clientIpHeader: "x-real-ip"` |  |
| [Vercel](hosts.md#vercel) | `clientIpHeader: "x-vercel-forwarded-for"` |  |
| [Fly.io](hosts.md#flyio) | `trustedProxies: 2` (3 with Cloudflare in front) |  |
| [Render](hosts.md#render) | `trustedProxies: 3` (check with posterna doctor; use 2 if it reports a forged address) | `3` comes from a Render employee's demonstration, not Render's documentation ([Render](hosts.md#render)). |
| [AWS load balancer](hosts.md#aws-application-load-balancer) | `trustedProxies: ["10.0.0.0/16"]` (replace with your load balancer subnets' CIDRs) | The load balancer checks each target every 30 seconds by default, on `/`: [give health checks their own path](hosts.md#health-checks). |
| [nginx](hosts.md#nginx-in-front-of-node-on-the-same-machine) | `clientIpHeader: "x-real-ip"` and `trustedProxies: ["127.0.0.1/32", "::1/128"]` | Bind Node to `127.0.0.1` and add [the `proxy_set_header` lines](hosts.md#nginx-in-front-of-node-on-the-same-machine) to nginx. |
| [Other](hosts.md#settings-by-host) | `clientIpHeader` or `trustedProxies` | Find your host's setting in [Hosts and proxies](hosts.md#settings-by-host). |
<!-- posterna:end hosts-quick -->

## 3. Deploy and check

1. Set a temporary `POSTERNA_DEBUG_TOKEN` on the server, for example from `openssl rand -hex 24`, and deploy.
2. From your own machine, run doctor with the same token:

   ```bash
   POSTERNA_DEBUG_TOKEN=<token> npx posterna doctor --url https://www.example.com
   ```

3. Fix anything marked FAIL. Each failure names its fix.
4. Remove the token from the server.

[Check with doctor](doctor.md) explains each check.

That's it. Posterna is labeling every request.

## Check these if they apply

- CloudFront in front of your app: [a required origin request setting](hosts.md#cloudfront).
- Load balancer or platform health checks (AWS, Render, Fly.io, Kubernetes, Docker): [give them their own path](hosts.md#health-checks).
- Next.js with webhooks, large uploads or rewrites to another site: [leave those routes out of the matcher](nextjs.md#routes-to-leave-out-of-the-matcher).
- Next.js on the Edge runtime: [works, with limits](nextjs.md#the-edge-runtime).

## Next

[Counters](counters.md), [Sign-up routes](signup.md), [Switch to enforce](enforce.md), [Policy file](policy.md), [Configuration](configuration.md).

## Moved

The rest of the old install guide now has its own pages.

- <a id="install"></a>The install guide: [Quickstart](#quickstart)
- <a id="1-create-agentsyaml"></a>1. Create agents.yaml: [1. Create your policy](#1-create-your-policy)
- <a id="nextjs-16-proxyts"></a>Next.js 16 (proxy.ts): [Next.js details](nextjs.md#nextjs-16-proxyts)
- <a id="nextjs-15-middlewarets"></a>Next.js 15 (middleware.ts): [Next.js details, Next.js 15](nextjs.md#nextjs-15-middlewarets)
- <a id="the-edge-runtime"></a>The Edge runtime: [Next.js details, the Edge runtime](nextjs.md#the-edge-runtime)
- <a id="health-checks"></a><a id="keep-health-checks-out-of-posterna"></a>Keep health checks out of Posterna: [Hosts and proxies, health checks](hosts.md#health-checks)
- <a id="trusted-proxies"></a><a id="3-tell-posterna-about-your-proxies"></a>3. Tell Posterna about your proxies: [Hosts and proxies](hosts.md)
- <a id="settings-by-host"></a>Settings by host: [Hosts and proxies, settings by host](hosts.md#settings-by-host)
- <a id="cloudfront"></a>Amazon CloudFront in front of any origin: [Hosts and proxies, CloudFront](hosts.md#cloudfront)
- <a id="4-check-the-setup-with-doctor"></a>4. Check the setup with doctor: [Check with doctor](doctor.md)
- <a id="testing-by-hand"></a>Testing by hand: [Check with doctor, testing by hand](doctor.md#testing-by-hand)
- <a id="5-optional-send-counters"></a>5. Optional: send counters: [Counters](counters.md)
- <a id="6-switch-to-enforce-safely"></a>6. Switch to enforce, safely: [Switch to enforce](enforce.md)
- <a id="configuration-reference"></a>Configuration reference: [Configuration](configuration.md)
- <a id="from-source"></a><a id="pre-release"></a><a id="install-from-a-source-build"></a>Install from a source build: [Install from a source build](source-build.md)
