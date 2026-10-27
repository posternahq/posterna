---
"@posterna/next": patch
"posterna": patch
---

`withPosternaConfig` from the new `@posterna/next/config` entry builds `agents.yaml` into the Next.js proxy, middleware and route handlers. Hosts such as Vercel deploy the proxy with only the code it imports, so it could not read the file there and ran the built-in monitor policy without the site's rules (`posterna doctor`: "No policy file at /var/task/agents.yaml"). Wrap your next.config: `export default withPosternaConfig(nextConfig)`. The wrapper reads `agents.yaml` (or `policyPath`, or `POSTERNA_POLICY`) when Next.js loads the config, so the file stays the one place your policy lives; the adapter uses that copy unless its own options set `policy` or `policyPath`. It also gives the Edge runtime your policy. `posterna init` now prints the wrapper as step 3 for Next.js, and `posterna doctor` suggests it when a Next.js site's policy did not load.
