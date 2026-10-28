# @posterna/next

## 0.1.3

### Patch Changes

- Updated dependencies [ede5a4c]
  - @posterna/core@0.1.3

## 0.1.2

### Patch Changes

- 3799b87: `withPosternaConfig` from the new `@posterna/next/config` entry builds `agents.yaml` into the Next.js proxy, middleware and route handlers. Hosts such as Vercel deploy the proxy with only the code it imports, so it could not read the file there and ran the built-in monitor policy without the site's rules (`posterna doctor`: "No policy file at /var/task/agents.yaml"). Wrap your next.config: `export default withPosternaConfig(nextConfig)`. The wrapper reads `agents.yaml` (or `policyPath`, or `POSTERNA_POLICY`) when Next.js loads the config, so the file stays the one place your policy lives; the adapter uses that copy unless its own options set `policy` or `policyPath`. It also gives the Edge runtime your policy. `posterna init` now prints the exact change to the project's next.config as step 3 for Next.js, and `posterna doctor` suggests it when a Next.js site's policy did not load.
  - @posterna/core@0.1.2

## 0.1.1

### Patch Changes

- No code changes. The first release published from GitHub Actions with npm trusted publishing, so every package carries a provenance statement linking it to the commit and workflow that built it.
- Updated dependencies
  - @posterna/core@0.1.1

## 0.1.0

### Patch Changes

- First public release. Next.js 16 (`proxy.ts`) and 15.5 or later (`middleware.ts` on the Node.js runtime): `withPosterna`, `getPosterna` for composed proxy functions and Server Actions, and `createPosterna` and `decideRequest` for route handlers. Fails open on every error.
- Updated dependencies
  - @posterna/core@0.1.0
