# Check with doctor

`posterna doctor` sends a signed request to your deployed site and reports what Posterna saw. It answers only to a request carrying your debug token.

1. Set a random `POSTERNA_DEBUG_TOKEN` on the server, for example from `openssl rand -hex 24`, and redeploy.
2. Run doctor from your own machine with the same token:

   ```bash
   POSTERNA_DEBUG_TOKEN=<token> npx posterna doctor --url https://www.example.com
   ```

3. Fix anything marked FAIL. Each failure comes with its fix.
4. Remove `POSTERNA_DEBUG_TOKEN` from the server. Without it, the debug route does not exist.

## The checks

| Check | Passes when |
|---|---|
| Debug route | `/.well-known/posterna/debug` answers with a Posterna report. With Next.js, the matcher must cover it. |
| Client IP | The site sees your machine's public address, as `https://posterna.com/v1/whoami` reports it, and ignores an `X-Forwarded-For` entry doctor forges. With `clientIpHeader`, doctor also forges that header, which fails if your host does not overwrite it. Doctor checks IPv4 and IPv6 separately, and says when one cannot be checked from your machine. |
| Signed host | Signatures are checked against your site's hostname, not an `X-Forwarded-Host` doctor forges. |
| Signature headers | `Signature`, `Signature-Input` and `Signature-Agent` reach your app. Some proxies, CDNs and firewalls strip them. |
| Policy | `agents.yaml` (or the `policy` option) was loaded. If it was not, Posterna runs a built-in monitor policy without your rules, and doctor shows why. |
| Directory | The operator directory is loaded and less than a week old. |
| Mode | The mode and anything suspending enforcement (the proxy guard, either kill switch, a tripped breaker). |

If doctor cannot reach `https://posterna.com/v1/whoami`, it names that step. A network whose DNS still has an old address for posterna.com is one cause: try another network, or pass `--base-url`.

## Testing by hand

- **A crawler's first request is labeled pending.** For operators checked by reverse DNS, the lookup runs in the background, so the first request from an address that claims to be, for example, Googlebot is `declared_unverifiable` with the reason `rdns_pending`. Later requests from that address get the result: `verified_by_ip`, or `claimed_failed` (`rdns_unconfirmed`) for a fake. The counts show some `rdns_pending` for this reason.
- **No client address locally.** With `clientIpHeader` set, a request to your local server has no client address (`no_client_address`) unless you send that header yourself, for example `curl -H "X-Real-IP: 203.0.113.7" http://localhost:3000/`.
- **curl looks like automation.** A plain curl request is `unknown_automation`: its User-Agent is not a browser's (`non_browser_user_agent`), and with a browser User-Agent it still sends no `Accept-Language` (`missing_accept_language`). To look like a browser, send both, for example `-A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36" -H "Accept: text/html" -H "Accept-Language: en"`.
