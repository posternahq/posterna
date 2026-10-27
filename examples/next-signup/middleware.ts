import { withPosterna } from "@posterna/next";

// Next.js 15: Posterna runs as middleware on the Node.js runtime (15.5 or
// later), which can do reverse DNS. agents.yaml is built in by
// withPosternaConfig in next.config.ts.
export const middleware = withPosterna({
  // Use the setting for your host:
  // https://github.com/posternahq/posterna/blob/main/docs/install.md#trusted-proxies
  trustedProxies: 1,
  publicHost: process.env.PUBLIC_HOST || undefined,
});

export const config = {
  runtime: "nodejs",
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
