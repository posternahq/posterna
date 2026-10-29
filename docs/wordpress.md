# WordPress plugin

The Posterna plugin for WordPress labels and counts AI agent and crawler traffic inside your own site. Its verifier is a PHP port of the one in the Node.js packages: it follows the same specification and passes the same conformance tests. Version 1.0 is monitor only: it labels and counts, and never blocks, throttles or challenges a request, a crawler or a sign-up.

It needs WordPress 6.5 or later and PHP 8.0 or later. The plugin is licensed GPLv2 or later, unlike the rest of this repository (MIT). The source is in [packages/wordpress](../packages/wordpress), and its full description is [readme.txt](../packages/wordpress/readme.txt).

## Install

The plugin is not in the WordPress.org plugin directory yet. Until it is, build the zip from this repository (it needs only `bash` and `zip`):

```bash
git clone https://github.com/posternahq/posterna.git
bash posterna/packages/wordpress/bin/build-zip.sh
```

That writes `posterna/packages/wordpress/dist/posterna-1.0.0.zip`. Then:

1. In wp-admin, open **Plugins** > **Add New** > **Upload Plugin**, upload the zip and activate Posterna.
2. Open **Posterna** in the admin menu. Counting starts right away.
3. Open **Check my setup**. If your site is behind a proxy, a load balancer or Cloudflare, choose how Posterna should find each visitor's real address in **Settings**, then check again.
4. Optionally turn on directory updates or the connection to posterna.com in **Settings**. Both are off until you turn them on.

## What you get

With no account:

- A Posterna page with totals for the last 24 hours and 7 days, a table of agents by operator and purpose, a table of paths, and the operators seen for the first time this week.
- A dashboard widget with the last 24 hours.
- A "Check my setup" panel that shows how your own request was seen (client address and where it came from, the verdict, directory version, scheduled jobs) and warns about the two common problems: a proxy that makes every visitor look the same, and a full-page cache that serves pages without running PHP.
- Suggested robots.txt lines and Content Signals for two templates (monitor, and an allow-list that asks AI training crawlers to stay out), for you to copy. Posterna never changes robots.txt.
- Sign-ups by verdict: the verdict of each new WordPress registration and, when WooCommerce is active, each new WooCommerce customer. Sign-ups are never blocked.
- Developer hooks: `posterna_get_verdict()` and the `posterna_verdict` action.

## The visitor's address

If every visitor shows the same address, your site is behind a proxy or load balancer, and WordPress sees the proxy's address instead of the visitor's. Real crawlers then fail their checks. In **Settings**, choose the header your host or proxy sets to the visitor's address, or the number of proxies in front of the site. "Check my setup" shows the result.

Posterna recommends a header only where the host's own documentation confirms its proxy sets it:

- **Cloudflare:** header `cf-connecting-ip`, with Cloudflare's published address ranges (https://www.cloudflare.com/ips/) as the proxy ranges, so the header is read only from Cloudflare. Documentation: [restoring original visitor IPs](https://developers.cloudflare.com/support/troubleshooting/restoring-visitor-ips/restoring-original-visitor-ips/).
- **Pantheon:** `REMOTE_ADDR` already holds the visitor's address, so keep the default. Behind Cloudflare as well, use the Cloudflare setting. Documentation: [client IP](https://docs.pantheon.io/client-ip).

For other hosts, ask which header carries the visitor's address and whether their proxy always overwrites it, then confirm with "Check my setup". Many hosts already put the visitor's address in `REMOTE_ADDR`, which is the default.

## What is not counted

Pages served from a full-page cache (a caching plugin, your host's cache or a CDN) never run PHP, so no WordPress plugin sees those requests. Posterna counts only the requests that reach WordPress. "Check my setup" lists the caches it detects. Logged-in users, wp-admin, WP-Cron and WP-CLI are not counted either.

## Counts on posterna.com

Everything in the plugin works without an account and without contacting any server. To see the site's counts on the posterna.com dashboard as well, add a site there and paste its key into the **Site key** setting.

The plugin then sends counts every five minutes: per hour, the number of requests with each verdict and reason code, by operator, agent, purpose and path group (such as `/blog/*`), plus the plugin and PHP version, a random ID for this installation, the directory version, whether a proxy problem was detected and a count of errors. It never sends IP addresses, full URLs, headers, request bodies, user names or e-mail addresses. Sign-up counts are not sent. Clear the site key to stop.

Directory updates are the other optional feature: once turned on, the plugin downloads the operator directory once a day and the keys once an hour from posterna.com, and uses them only if their Ed25519 signature checks out against keys built into the plugin.

## For developers

`posterna_get_verdict()` returns the verdict for the current request as an array with `verdict` and, when set, `operator`, `agent`, `purpose`, `method`, `reason`, `note` and `error`. It returns null in WP-CLI and WP-Cron.

The `posterna_verdict` action fires once per labeled request, on `init`, with the same array:

```php
add_action( 'posterna_verdict', function ( $verdict ) {
    if ( 'claimed_failed' === $verdict['verdict'] ) {
        // For example, skip expensive work for a fake crawler.
    }
} );
```

The verdict is also available to other code as the request headers `X-Agent-Verdict`, `X-Agent-Operator`, `X-Agent-Purpose` and `X-Agent-Method` (in `$_SERVER` as `HTTP_X_AGENT_VERDICT` and so on). Posterna removes any such headers a client sends before setting them.

## How it differs from the Node.js packages

- **Monitor only.** There is no policy engine and no `agents.yaml`. The monitor and allow-list templates only drive the suggested robots.txt lines, which the plugin prints and never writes.
- **Check my setup** takes the place of `posterna doctor`, which works with the Express and Next.js packages.
- **Reverse DNS** runs in WP-Cron, never during a page load. A new address is queued, looked up and cached (24 hours when confirmed, 1 hour when not). Until then the request is labeled `declared_unverifiable`.
- **Counts** are sent every five minutes rather than every minute, and bytes served are not known, so the dashboard shows them as not available.
- **Not labeled:** wp-admin (including admin-ajax), WP-Cron and WP-CLI.

The details are in [docs/SPEC.md](SPEC.md), section 14.
