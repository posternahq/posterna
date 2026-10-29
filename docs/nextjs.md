# Next.js details

What the [quickstart](install.md) leaves out for Next.js: why the config wrapper exists, which routes to leave out of the matcher, how pages read the verdict, Next.js 15 and the Edge runtime. Sign-up recommendations are on [Sign-up routes](signup.md).

## Next.js 16 (proxy.ts)

The quickstart has the code: `proxy.ts` next to your `app` folder (inside `src/` if you use one), and your Next.js config wrapped in `withPosternaConfig`, so that `agents.yaml` is built into the proxy. `posterna init` prints the exact change for your own `next.config`.

### Why withPosternaConfig

`withPosternaConfig` reads `agents.yaml` when Next.js loads the config and builds its text into the proxy, so the proxy never has to read the file at run time. Hosts such as Vercel deploy the proxy with only the code it imports, so without the wrapper the file is not there and Posterna runs a built-in monitor policy without your rules: on a live Vercel site, `posterna doctor` reported `FAIL Policy` with "No policy file at /var/task/agents.yaml", and with the wrapper (from a source build) the same site passed (27 October 2026). `agents.yaml` stays the one place your policy lives: every build copies it again, `posterna policy check` and `posterna robots` read it as before, and `next dev` picks up a change when you restart it. In `next.config.mjs` the import is the same; in CommonJS, use `require("@posterna/next/config")`. For a file somewhere else, pass its path: `withPosternaConfig(nextConfig, { policyPath: "config/agents.yaml" })`. The proxy uses the built-in copy unless you pass `policy` or `policyPath` in its own options.

### Your own proxy function

If you already have a proxy function, pass it as the second argument: `withPosterna(options, yourProxy)`. Posterna runs first; your function runs after it and can read the verdict with `getPosterna(request)`. Next.js reads `config` at build time, so write it out in your own file; it cannot be imported. Make sure the matcher covers every page you want labeled, including your sign-up route.

### The Node.js runtime

In Next.js 16, the proxy always runs on the Node.js runtime, so it can do reverse DNS. Without `withPosternaConfig`, it reads `agents.yaml` from the project folder at run time. That works with `next start` in the project folder, but needs Node 20.16 or later; on older Node, Posterna logs a `[posterna]` warning and runs a built-in monitor policy without your rules, and `posterna doctor` reports it.

## Routes to leave out of the matcher

Before you settle on the matcher, leave out these routes:

- **Large uploads.** With a proxy, Next.js holds each matched request's body in memory and keeps only the first 10 MB (`experimental.proxyClientMaxBodySize` in `next.config`; Next.js 15 calls it `middlewareClientMaxBodySize`). Anything past that is cut off, with only a warning in the server log. Exclude routes that take larger uploads, or raise the limit.
- **Webhooks** that check a signature over the raw request body. They are safest left out.
- **Paths rewritten to another site**, such as an analytics proxy set up in `next.config` rewrites. The proxy runs before rewrites, so the verdict request headers would be passed on to that site.
- **Health checks** from your load balancer or platform. See [Keep health checks out of Posterna](hosts.md#health-checks).

For example, with webhooks under `/api/webhooks` and an analytics rewrite under `/ingest`:

```ts
matcher: ["/((?!_next/static|_next/image|favicon.ico|api/webhooks|ingest).*)"],
```

## Reading the verdict

Pages and route handlers read the verdict from the request headers:

```ts
import { headers } from "next/headers";

const verdict = (await headers()).get("x-agent-verdict");
```

A route handler that needs a sign-up recommendation verifies and decides itself, because it runs in a different bundle from the proxy: see [Sign-up routes](signup.md#route-handlers).

## Server Actions

A Server Action posts to its page's own path, so a matcher that excludes a page also skips its Server Actions. To hand a sign-up recommendation to an action, ask for it in your proxy function and pass it in a request header: see [Sign-up routes](signup.md#server-actions).

See [examples/next-basic](../examples/next-basic) and [examples/next-signup](../examples/next-signup).

## Next.js 15 (middleware.ts)

Use `middleware.ts` and the Node.js runtime, which is stable from Next.js 15.5:

<!-- posterna:host-snippet next-middleware -->
```ts
import { withPosterna } from "@posterna/next";

export const middleware = withPosterna({
  clientIpHeader: "x-real-ip", // Railway; other hosts in Hosts and proxies
  publicHost: "www.example.com", // your site's hostname
});

export const config = {
  runtime: "nodejs",
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

Wrap your Next.js config in `withPosternaConfig`, and leave the same routes out of the matcher, as for Next.js 16 ([routes to leave out of the matcher](#routes-to-leave-out-of-the-matcher)).

## The Edge runtime

Next.js before 15.5 runs middleware only on the Edge runtime, and Next.js 16 still allows `middleware.ts` there. Posterna avoids Node.js built-ins so that it can run there, with these limits (the end-to-end tests cover the Node.js runtime only):

- **No reverse DNS.** There is no DNS resolver, so operators that are checked by reverse DNS (Googlebot outside its IP lists, for example) stay `declared_unverifiable`.
- **No files.** The Edge runtime cannot read files, so wrap your Next.js config in `withPosternaConfig` to build `agents.yaml` in (checked with Next.js 15.5 middleware on the Edge runtime), or pass the policy text as `policy`.
- **Bundle size.** The operator directory (about 650 KB of JSON) is bundled into the middleware.

Prefer the Node.js runtime wherever you can.
