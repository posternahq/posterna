# Configuration

Posterna reads its settings from adapter options and environment variables. The proxy settings for each host are on [Hosts and proxies](hosts.md); every key of `agents.yaml` is in the [policy file reference](policy.md).

## agents.yaml and posterna init

`init` finds Express or Next.js in `package.json` and asks which template to start from (`monitor` unless you choose otherwise). It writes `agents.yaml` and prints the exact code to add; it never edits your code. It can also save a site key from the dashboard to your env file, after asking.

Every template starts in monitor mode: requests are labeled and counted, and nothing is blocked until you change `mode` to `enforce`. The policy format is in [policy.md](policy.md). Check the file at any time with:

```bash
npx posterna policy check
```

## What the Express middleware does

Added before your routes, on each request it:

- removes any `X-Agent-*` and `X-Posterna-*` headers the client sent;
- labels the request and decides with agents.yaml;
- sets `req.posterna` (`result`, `decision`, and `decide()`) and the `X-Agent-Verdict`, `X-Agent-Operator`, `X-Agent-Purpose` and `X-Agent-Method` request headers;
- sends the block (403) or throttle (429) response when one is enforced;
- counts the request.

If anything inside fails, the request goes through. `agents.yaml` is read from the working directory; set `policyPath` or `POSTERNA_POLICY` to read it from elsewhere.

## Environment variables

| Environment variable | Meaning |
|---|---|
| `POSTERNA_POLICY` | Path to agents.yaml. Default: `agents.yaml` in the working directory. With Next.js, `withPosternaConfig` reads it at build time. |
| `POSTERNA_POLICY_TEXT` | Next.js only: the agents.yaml text, which `withPosternaConfig` builds in. Set it yourself only where neither the wrapper nor a file can be used. |
| `POSTERNA_MODE` | `monitor` turns enforcement off at start. No value turns it on. |
| `POSTERNA_SITE_KEY` | Site key for counters. Without it nothing is sent. |
| `POSTERNA_DEBUG_TOKEN` | Enables the debug route for `posterna doctor`. |
| `POSTERNA_BASE_URL` | The Posterna cloud's base URL, for tests. Default `https://posterna.com/v1/`. |
| `POSTERNA_COUNTERS_INTERVAL_MS` | Counter flush interval, for tests (at least 1000). Default 60 seconds. |

## Adapter options

Adapter options take precedence over the environment. Both adapters accept:
- `clientIpHeader`, `trustedProxies`, `forwardedHeader`, `publicHost` and `trustForwardedHost`;
- `policy` (agents.yaml text or a parsed policy) and `policyPath`;
- `headers`, to rename the verdict request headers;
- `siteKey`, `baseUrl` and `debugToken`;
- `counters` (`false` turns counting off);
- `onError`, where configuration problems are reported (default `console.warn`; never given request data).
