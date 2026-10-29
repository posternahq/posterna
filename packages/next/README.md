# @posterna/next

**An early release (0.1).** The API may change before 1.0, and every change is in the changelog.

Next.js integration for [Posterna](https://posterna.com). It verifies which AI agents and crawlers are calling your app, applies your `agents.yaml` policy, and passes the verdict to your pages and routes. It starts in monitor mode and fails open on every error.

```ts
// proxy.ts (Next.js 16), or middleware.ts with runtime: "nodejs" (Next.js 15.5 and later)
import { withPosterna } from "@posterna/next";

export const proxy = withPosterna({
  clientIpHeader: "x-real-ip", // the setting for your host: https://posterna.com/docs/hosts#settings-by-host
  publicHost: "www.example.com",
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

```ts
// next.config.ts: builds agents.yaml into the proxy, so it works where the
// proxy cannot read files at run time, such as on Vercel.
import { withPosternaConfig } from "@posterna/next/config";

export default withPosternaConfig({
  // your existing settings
});
```

- Wraps an existing proxy or middleware: `withPosterna(options, yourProxy)`. Your function runs after Posterna and reads the verdict with `getPosterna(request)`.
- Pages and route handlers read `X-Agent-Verdict`, `X-Agent-Operator`, `X-Agent-Purpose` and `X-Agent-Method` from `headers()`. Client-sent copies are removed.
- Route handlers that need a sign-up recommendation use `createPosterna()` to verify and decide.
- Next.js never gives middleware the socket address: set `clientIpHeader` or `trustedProxies` for your host, or IP checks stay off.
- `withPosternaConfig` copies `agents.yaml` into each build; without it, the proxy reads the file at run time, which needs Node 20.16 or later and does not work on Vercel. On the Edge runtime there is no reverse DNS.

See the [quickstart](https://posterna.com/docs/install) and [Next.js details](https://posterna.com/docs/nextjs). Next.js 15 and 16 are supported. MIT licensed.
