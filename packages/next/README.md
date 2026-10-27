# @posterna/next

**An early release (0.1).** The API may change before 1.0, and every change is in the changelog.

Next.js integration for [Posterna](https://posterna.com). It verifies which AI agents and crawlers are calling your app, applies your `agents.yaml` policy, and passes the verdict to your pages and routes. It starts in monitor mode and fails open on every error.

```ts
// proxy.ts (Next.js 16), or middleware.ts with runtime: "nodejs" (Next.js 15.5 and later)
import { withPosterna } from "@posterna/next";

export const proxy = withPosterna({
  clientIpHeader: "x-real-ip", // the setting for your host: https://posterna.com/docs/install#trusted-proxies
  publicHost: "www.example.com",
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

- Wraps an existing proxy or middleware: `withPosterna(options, yourProxy)`. Your function runs after Posterna and reads the verdict with `getPosterna(request)`.
- Pages and route handlers read `X-Agent-Verdict`, `X-Agent-Operator`, `X-Agent-Purpose` and `X-Agent-Method` from `headers()`. Client-sent copies are removed.
- Route handlers that need a sign-up recommendation use `createPosterna()` to verify and decide.
- Next.js never gives middleware the socket address: set `clientIpHeader` or `trustedProxies` for your host, or IP checks stay off.
- Reading `agents.yaml` needs Node 20.16 or later. On the Edge runtime there is no reverse DNS and no file access; pass the policy text as `policy`.

See the [install guide](https://github.com/posternahq/posterna/blob/main/docs/install.md). Next.js 15 and 16 are supported. MIT licensed.
