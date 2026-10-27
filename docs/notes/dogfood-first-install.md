# Dogfood: first real install (Next.js 16 on Railway behind Cloudflare)

27 October 2026. The first install of Posterna on a live site, done by following docs/install.md as a new user would, in monitor mode only. Everything listed under "Recommended fixes" for the packages and the guide was fixed before 0.1.0 (commits `f31eb92` and `c5d25cc`).

- Packages: `@posterna/core`, `@posterna/directory` and `@posterna/next` 0.1.0-alpha.0, packed from commit `4e269a0`. CLI run from the same build (`node packages/cli/dist/bin.js`).
- App: Next.js 16.3 App Router, every route server-rendered with `next start`, npm with `package-lock.json`, `src/` folder, Auth.js v5. No existing proxy or middleware.
- Host: Railway (Nixpacks, service root directory set to a subfolder), with Cloudflare proxied in front. Canonical host is the apex; `www` is a different site.
- Result: `src/proxy.ts` with `withPosterna({ clientIpHeader: "x-real-ip", publicHost: "<apex>" }, fn)`, the monitor template plus two `signup` scopes, and sign-up recommendations logged from the composed proxy function.

## Time

- Hands-on: about 40 minutes from start to an install tested against a baseline build, plus about 10 minutes for the counters check, commit and pull request.
- Elapsed: about 12 hours, almost all of it waiting for a site key because of a hosted-service sign-in problem (since fixed).
- Merge to live: about 3 minutes on Railway; doctor passed on the first run.

## docs/install.md: unclear, wrong or slow steps

1. **No pre-release path.** Step 1 (`npx posterna init`) and step 2 (`npm install @posterna/next`) both fail before the packages are on npm. "The packages are not on npm yet" gives no alternative. A short section is needed covering:
   - `pnpm pack` of core, directory and the adapter;
   - `file:` dependencies on the tarballs;
   - overrides for **both** core and directory (`pnpm pack` turns core's `workspace:*` dependency on directory into a registry version that doesn't exist);
   - running the CLI from a local build.
2. **No row for Railway with Cloudflare in front.** The Fly row says "add one hop with Cloudflare" and the Cloudflare paragraph says "prefer a hop count", so a reader would guess `trustedProxies: 3`. What I measured, through the same Cloudflare-to-Railway path (the cloud's `/v1/whoami` on posterna.com) and directly on `*.up.railway.app`:
   - Railway's `X-Real-IP` is the real client, over IPv4 and IPv6.
   - Forged `X-Real-IP` and `X-Forwarded-For` values are ignored.
   - The shape of `X-Forwarded-For` behind Cloudflare is still unknown, because nothing echoes it, so a hop count would have been a guess.

   I used `clientIpHeader: "x-real-ip"`; doctor forges that header after deploy, so it's checked. Recommendation: recommend `clientIpHeader: "x-real-ip"` for Railway with or without Cloudflare, or measure the chain and add a row.
3. **Server-action sign-ups aren't covered.** App Router sign-up forms are often Server Actions, which arrive as `POST` to the page's own path, not to a route handler. The guide only shows `createPosterna` + `verify` in a route handler. What worked: in the function passed to `withPosterna`, check `request.method === "POST"` and the page path, then `getPosterna(request)?.decide({ kind: "signup" })`. Worth an example, plus the Next.js rule that a matcher which excludes a path also skips its Server Actions.
4. **The recommended matcher has side effects in Next.js 16:**
   - With a proxy, Next.js buffers every matched request body in memory and **truncates bodies over 10 MB** (`experimental.proxyClientMaxBodySize`). Sites with large uploads need to exclude those routes or raise the limit.
   - Webhook routes that verify a signature over the raw body are safest excluded.
   - The proxy runs before `next.config` rewrites, so verdict request headers would go along with any rewrite to an external host (an analytics proxy, for example). I excluded such a path rather than test it.

   The guide should say all three next to the matcher.
5. **First request from a claimed crawler is `declared_unverifiable`** (`rdns_pending`). Reverse DNS runs in the background, so the first fake Googlebot request isn't `claimed_failed`; later ones are. Testers will be surprised, and counts show a `rdns_pending` bucket per instance.
6. **Local testing tips are missing:**
   - With `clientIpHeader`, a local request has no client address (`no_client_address`) unless you send the header yourself.
   - curl without `Accept-Language` is `unknown_automation` (`missing_accept_language`).
   - Two lines in the guide would save time.
7. **Node version:** the guide says Node 20+, but the Next.js adapter reads `agents.yaml` through `process.getBuiltinModule`, which needs **Node 20.16+**. On older 20.x it warns and falls back to a built-in monitor policy, losing the sign-up scopes. State 20.16+ for Next.js.
8. **`emit: [robots.txt, content-signals]`** in every template reads as if Posterna serves `robots.txt`. It doesn't; only `posterna robots` prints it. Say so in the template comment, especially for sites with their own `robots.txt`.
9. **Broken links:** the CLI and doctor link to `install.md#trusted-proxies`, but the heading is "3. Tell Posterna about your proxies". The repository is still private, so every printed GitHub link 404s for anyone else.

## CLI and packages: bugs and rough edges

1. **`init`:**
   - The help line `init [--template <name>] [--force] [--yes]` runs into its summary with no space (the usage column is wider than `COLUMN = 34`).
   - It prints `npm install @posterna/next` (fails before release) and `// trustedProxies: 1`, which is wrong for Railway (2), Fly (2) and Render (3). Point to the host table instead, or detect the host from `railway.json`, `fly.toml` or `vercel.json`.
   - Without a terminal (CI, `--yes`, an agent) it skips the site key step silently. Print a line saying to set `POSTERNA_SITE_KEY`, and mention `POSTERNA_DEBUG_TOKEN` for doctor.
2. **npm lockfile breakage when vendoring:** `npm install` (npm 11.6) of the tarballs with overrides dropped optional `@emnapi/*` entries and wrote a lockfile that `npm ci` rejects (`Missing: @emnapi/core@1.10.0 from lock file`). Not a Posterna bug, but anyone vendoring hits it, and Railway's build runs `npm ci`. The guide should say to check with `rm -rf node_modules && npm ci`. Fix used: the previous lockfile plus only the new entries.
3. **Counters:**
   - `bytes` is always 0 with the Next.js adapter, because the proxy never sees the response. The dashboard should show it as unavailable for Next.js sites rather than 0.
   - A file at the root gets the path group `/robots.txt/*`, which reads like a folder. Consider `/robots.txt` for single-segment paths that contain a dot.
4. **Privacy check of a real payload** (local mock ingest):
   - The test traffic included an IP address, an email in the path, a record ID, a query string, a cookie, `Accept-Language` and forged `X-Agent-*` headers.
   - None of it appeared in the payload; the email path became `/:id/*`.
   - Outbound request headers were Node's defaults plus `Authorization`.

## Hosted service

The hosted service's findings (dashboard sign-in, the add-site page, a stale-DNS network) are kept with that service. The one that affects the packages: on a network whose DNS still had an old address for posterna.com, doctor's `whoami` reached the wrong site, so doctor should say which step failed and suggest `--base-url`.

## Doctor results

Deployed 27 October 2026 at 16:51 UTC, about 3 minutes after the merge. `posterna doctor --url https://<apex>` from the tester's machine:

| Check | Result |
|---|---|
| Debug route | PASS: `@posterna/next 0.1.0-alpha.0` answered |
| Client IP | PASS: the site saw this machine's public address (IPv6), and ignored the forged `X-Real-IP` |
| Signed host | PASS: signatures checked against the apex, not the forged `X-Forwarded-Host` |
| Signature headers | PASS: `Signature`, `Signature-Input` and `Signature-Agent` reach the app through Cloudflare and Railway |
| Directory | PASS: version 2026-10-26, keys 2026-10-26T23 |
| Mode | PASS: monitor (agents.yaml says monitor) |

Checked by hand on production, since doctor ran over IPv6 only:

- **IPv4:** with forged `X-Real-IP` and `X-Forwarded-For`, the site saw the real IPv4 address.
- **Proxy guard:** `proxySuspect` false; reverse DNS available.
- **Fake Googlebot:** labeled `claimed_failed` (`rdns_unconfirmed`) from the second request on, and served normally.
- **Pages and sign-in:** pages return their usual status codes; the sign-in Server Action still redirects to the OAuth provider.

So `clientIpHeader: "x-real-ip"` works on Railway behind Cloudflare, for both address families.

The dashboard showed the site with a live instance and counts arriving within minutes of the deploy.

Rough edges:

- Doctor only checks whichever address family the machine uses. A second probe over the other family (or a note in the output) would cover both.
- Doctor doesn't show whether `agents.yaml` was actually loaded. The only sign is a `[posterna]` warning in the host's logs, and the report looks the same either way because the fallback policy is also monitor. Adding the policy hash or a "policy source" field to the debug report would close that gap.

## Recommended fixes, most useful first

1. Install guide: a pre-release install section (tarballs, overrides for core and directory, check with `npm ci`, CLI from a local build).
2. Install guide: Railway behind Cloudflare. Recommend `clientIpHeader: "x-real-ip"` for Railway, now verified both ways.
3. Install guide: a Server Actions sign-up example using `getPosterna(request).decide({ kind: "signup" })` in the composed proxy function.
4. Install guide: matcher caveats for Next.js 16 (10 MB body buffering, raw-body webhooks, rewrites to external hosts).
5. Hosted service: the sign-in and add-site fixes (kept with that service).
6. CLI: fix the `#trusted-proxies` links and the help column; stop printing `trustedProxies: 1`; print env var reminders when there is no terminal.
7. Install guide: `rdns_pending` on first requests, local testing tips, Node 20.16+ for Next.js, what `emit` does.
8. Counters and dashboard: `bytes` for Next.js, path groups for root files.
9. Doctor: probe both IPv4 and IPv6; show whether `agents.yaml` was loaded (policy source or hash) in the debug report.
