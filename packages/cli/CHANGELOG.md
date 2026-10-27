# posterna

## 0.1.2

### Patch Changes

- e997107: `posterna doctor` points at the two setups that most often break a working install. When the signature headers do not reach the app, its fix names the CloudFront origin request policy that passes them on (`AllViewerExceptHostHeader`), along with the real User-Agent and Accept-Language. When the proxy guard has suspended enforcement, its fix says that load balancer health checks can cause it on a quiet site, and links to the new install guide section on keeping them out of Posterna.
- e3a1d2b: `posterna doctor` no longer runs its IPv6 check over IPv4 on macOS. For a site with no IPv6 address, macOS answers an IPv6 lookup with IPv4-mapped addresses (`::ffff:a.b.c.d`), so the "Client IP (IPv6)" row compared an IPv4 address with an IPv6 one and printed a confusing WARN. Doctor now drops those addresses and reports `SKIP: not checked: the site has no IPv6 address.`, as it already did on Linux. Its whoami request over IPv6 goes through the same lookup, so it cannot report an IPv4 address as this machine's IPv6 one.
- 3799b87: `withPosternaConfig` from the new `@posterna/next/config` entry builds `agents.yaml` into the Next.js proxy, middleware and route handlers. Hosts such as Vercel deploy the proxy with only the code it imports, so it could not read the file there and ran the built-in monitor policy without the site's rules (`posterna doctor`: "No policy file at /var/task/agents.yaml"). Wrap your next.config: `export default withPosternaConfig(nextConfig)`. The wrapper reads `agents.yaml` (or `policyPath`, or `POSTERNA_POLICY`) when Next.js loads the config, so the file stays the one place your policy lives; the adapter uses that copy unless its own options set `policy` or `policyPath`. It also gives the Edge runtime your policy. `posterna init` now prints the exact change to the project's next.config as step 3 for Next.js, and `posterna doctor` suggests it when a Next.js site's policy did not load.
- Updated dependencies [3a7999d]
  - @posterna/directory@0.1.2
  - @posterna/core@0.1.2

## 0.1.1

### Patch Changes

- No code changes. The first release published from GitHub Actions with npm trusted publishing, so every package carries a provenance statement linking it to the commit and workflow that built it.
- Updated dependencies
  - @posterna/core@0.1.1
  - @posterna/directory@0.1.1

## 0.1.0

### Patch Changes

- First public release of the command line: `init` (writes `agents.yaml` in monitor mode and prints the code and host settings to add), `doctor` (checks a deployed site's client address over IPv4 and IPv6, signed host, signature headers, policy, directory and mode), `robots` and `policy check`.
- Updated dependencies
- Updated dependencies
  - @posterna/core@0.1.0
  - @posterna/directory@0.1.0
