import { withPosterna } from "@posterna/next";

// Posterna labels every request, applies agents.yaml (built in by
// withPosternaConfig in next.config.ts) and passes the verdict to your pages
// and routes as the X-Agent-* request headers. A fresh agents.yaml is in monitor mode: nothing
// is blocked until you change it to enforce.
export const proxy = withPosterna({
  // Next.js never gives a proxy the client's socket address, so Posterna reads
  // X-Forwarded-For only when trustedProxies is set. Use the setting for your
  // host: https://github.com/posternahq/posterna/blob/main/docs/install.md#trusted-proxies
  trustedProxies: 1,
  // The hostname agents sign. Set it in production, for example "www.example.com".
  publicHost: process.env.PUBLIC_HOST || undefined,
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
