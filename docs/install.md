# Install

> **Stub.** Posterna is pre-release and not yet published to npm. This page will become the full install guide.

The planned flow:

1. In your project, run `npx posterna init`. It detects Express or Next.js, writes `agents.yaml` from the `monitor` template, and prints the exact code to add. It does not edit your code.
2. Add the integration: `app.use(posterna(options))` for Express, or the wrapper for `proxy.ts` (Next.js 16) or `middleware.ts` (Next.js 15).
3. Deploy, then run `npx posterna doctor --url <your site>` to check client IP resolution, the signed host, and signature headers behind your proxies.
4. Optionally, add a site key from the dashboard to send aggregate counters. Without one, Posterna runs local-only and sends nothing.

Every install starts in monitor mode: requests are labeled and counted, and nothing is blocked until you switch the policy to `enforce`.

Until this guide is written, see sections 6 (adapters) and 8 (CLI) of the [specification](SPEC.md).
