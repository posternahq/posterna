=== Posterna ===
Contributors: WPORG_USERNAME
Tags: ai, crawlers, bots, web bot auth, robots.txt
Requires at least: 6.5
Tested up to: 7.1
Requires PHP: 8.0
Stable tag: 1.0.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

See which AI agents and crawlers visit your site and whether they are who they say they are. Monitor only: it labels and counts, never blocks.

== Description ==

Many requests to a WordPress site now come from AI agents and crawlers: training crawlers, search crawlers, assistants fetching a page for a user, and agents acting on someone's behalf. Some say who they are. Some of those are telling the truth.

Posterna labels every visitor request with one verdict:

* **Verified by signature**: the request carries a valid Web Bot Auth signature (HTTP Message Signatures, RFC 9421) from a key the operator publishes.
* **Verified by IP or DNS**: it comes from an address the operator publishes, or passes the forward-confirmed reverse DNS check the operator documents.
* **Claimed, failed the check**: it names a known agent, such as Googlebot or GPTBot, but comes from somewhere that agent does not use.
* **Claimed, cannot be checked**: it names an agent whose operator publishes nothing to check against, or a check is still running.
* **Unknown automation**: it looks automated and names no known agent.
* **Browsers**: it looks like an ordinary browser.

It then counts requests by hour, verdict, operator, agent, purpose and path, and shows them in wp-admin. Nothing is blocked, slowed or challenged. Version 1.0 only monitors.

What you get, with no account:

* A Posterna page with totals for the last 24 hours and 7 days, a table of agents by operator and purpose, a table of paths, and the operators seen for the first time this week.
* A dashboard widget with the last 24 hours.
* A "Check my setup" panel that shows how your own request was seen (client address and where it came from, the verdict, directory version, scheduled jobs) and warns about the two common problems: a proxy that makes every visitor look the same, and a full-page cache that serves pages without running PHP.
* Suggested robots.txt lines and Content Signals for two templates (monitor, and an allow-list that asks AI training crawlers to stay out), for you to copy. Posterna never changes robots.txt.
* Sign-ups by verdict: the verdict of each new WordPress registration and, when WooCommerce is active, each new WooCommerce customer. Sign-ups are never blocked.
* Developer hooks: `posterna_get_verdict()` and the `posterna_verdict` action.

How it works:

* The check runs early on each request, before the theme loads, inside your own site. Requests never go anywhere else.
* The operator directory (which agents exist, their user-agent tokens, published IP ranges, reverse DNS rules and signing keys) ships with the plugin. You can turn on signed updates from posterna.com; they are off by default.
* Reverse DNS lookups never run during a page load. A new address is queued, looked up by WP-Cron, and cached (24 hours when confirmed, 1 hour when not). Until then the request is labeled "claimed, cannot be checked".
* Every error path fails open: if anything goes wrong, the request goes ahead and is labeled as a browser or unknown automation.
* The plugin does not log or store IP addresses, full URLs, headers or request bodies. Its table holds hourly counts only, and rows older than 90 days are removed.

Posterna is open source. The verifier follows the same specification and passes the same conformance tests as the Posterna packages for Node.js: https://github.com/posternahq/posterna

== Installation ==

1. Install and activate Posterna from Plugins > Add New, or upload the `posterna` folder to `wp-content/plugins/`.
2. Open **Posterna** in the admin menu. Counting starts right away.
3. Open **Check my setup**. If your site is behind a proxy, a load balancer or Cloudflare, choose how Posterna should find each visitor's real address in **Settings**, then check again.
4. Optionally turn on directory updates or the connection to posterna.com in **Settings**. Both are off until you turn them on.

== Frequently Asked Questions ==

= Does Posterna block anything? =

No. Version 1.0 only labels and counts. It never blocks, throttles or challenges a request, a crawler or a sign-up. Enforcement may come in a later version, as a setting you turn on yourself.

= Why are some pages not counted? =

Pages served from a full-page cache (a caching plugin, your host's cache or a CDN) never run PHP, so no WordPress plugin sees those requests. Posterna counts only the requests that reach WordPress. "Check my setup" lists the caches it detects. Logged-in users, wp-admin, WP-Cron and WP-CLI are not counted either.

= Every visitor shows the same address. What is wrong? =

Your site is behind a proxy or load balancer, and WordPress sees the proxy's address instead of the visitor's. Real crawlers then fail their checks. In Settings, choose the header your host or proxy sets to the visitor's address (for example `cf-connecting-ip` behind Cloudflare, together with Cloudflare's published address ranges), or the number of proxies in front of the site. "Check my setup" shows the result.

= Which client address setting does my host need? =

Posterna recommends a header only where the host's own documentation confirms its proxy sets it:

* Cloudflare: header `cf-connecting-ip`, with Cloudflare's published address ranges (https://www.cloudflare.com/ips/) as the proxy ranges, so the header is read only from Cloudflare. Documentation: https://developers.cloudflare.com/support/troubleshooting/restoring-visitor-ips/restoring-original-visitor-ips/
* Pantheon: REMOTE_ADDR already holds the visitor's address, so keep the default. Behind Cloudflare as well, use the Cloudflare setting. Documentation: https://docs.pantheon.io/client-ip

For other hosts, ask which header carries the visitor's address and whether their proxy always overwrites it, then confirm with "Check my setup". Many hosts already put the visitor's address in REMOTE_ADDR, which is the default.

= What does "claimed, failed the check" mean? =

The request names an agent in the directory, for example Googlebot, but its address is not one the operator publishes and its reverse DNS does not match. That is how scrapers that pretend to be well-known crawlers usually look. Make sure the client address setting is right before you trust these numbers.

= Do I need a posterna.com account? =

No. Everything in the plugin works without an account and without contacting any server. The connection to posterna.com is optional and only adds this site to a dashboard there.

= What do posterna_get_verdict() and posterna_verdict do? =

`posterna_get_verdict()` returns the verdict for the current request as an array with `verdict` and, when set, `operator`, `agent`, `purpose`, `method`, `reason`, `note` and `error`. It returns null in WP-CLI and WP-Cron.

The `posterna_verdict` action fires once per labeled request, on `init`, with the same array:

`add_action( 'posterna_verdict', function ( $verdict ) {
    if ( 'claimed_failed' === $verdict['verdict'] ) {
        // For example, skip expensive work for a fake crawler.
    }
} );`

The verdict is also available to other code as the request headers `X-Agent-Verdict`, `X-Agent-Operator`, `X-Agent-Purpose` and `X-Agent-Method` (in `$_SERVER` as `HTTP_X_AGENT_VERDICT` and so on). Posterna removes any such headers a client sends before setting them.

= Does it slow my site down? =

In our tests the check took between 0.3 and 0.7 milliseconds per request (median), and it runs before the theme loads. Counting adds one small database write per counted request. Reverse DNS lookups and directory updates run in WP-Cron, never during a page load. "Check my setup" shows how long the check took on your own request.

= Where do the agent lists come from? =

From the Posterna operator directory, built from each operator's own documentation and published IP lists and keys, plus community records from the ai.robots.txt project. See "Data and credits" below.

== External services ==

Posterna works without contacting any outside server. It can connect to one service, posterna.com, run by the Posterna project, through two optional features. Both are off by default and do nothing until an administrator turns them on in Posterna > Settings.

**1. Directory updates** (setting: "Download updates to the operator directory from posterna.com")

* What it is for: keeping the list of AI operators, their published IP ranges and signing keys current between plugin updates.
* What is sent: a plain HTTPS download request for https://posterna.com/v1/directory.json, https://posterna.com/v1/keys.json and their `.sig` signature files, with the User-Agent `Posterna-WordPress/1.0.0`. No site address, visitor data or counts are sent. Like any web request, it shows posterna.com your server's IP address.
* When: once a day for directory.json, once an hour for keys.json, right after the setting is turned on, when an administrator clicks "Check for updates now", and at most once every 10 minutes when a signed request uses a key the site does not have yet.
* The downloaded files are used only if their Ed25519 signature checks out against keys built into the plugin.

**2. Connection to posterna.com** (setting: "Site key")

* What it is for: showing this site's counts on the posterna.com dashboard.
* What is sent: the site key you pasted (to identify the site), and the counts shown on the Posterna page: per hour, the number of requests with each verdict and reason code, by operator, agent, purpose and path group (such as `/blog/*`), plus the plugin and PHP version, a random ID for this installation, the directory version, whether a proxy problem was detected and a count of errors. Path groups never contain more than the first part of a path, and parts that look like numbers, IDs or e-mail addresses are replaced with `/:id/*`. It never sends IP addresses, full URLs, headers, request bodies, user names or e-mail addresses. Sign-up counts are not sent.
* When: every five minutes while a site key is set, and when an administrator clicks "Send counts now". Clear the site key to stop.
* Where: https://posterna.com/v1/ingest

posterna.com terms of service: https://posterna.com/terms
posterna.com privacy policy: https://posterna.com/privacy

== Privacy ==

Posterna does not store IP addresses, full URLs, headers, request bodies or anything else about a single request. Its database table holds hourly counts by verdict, reason, operator, agent, purpose and path group, kept for 90 days. Reverse DNS results are cached in transients keyed by a hash of the address, for up to 24 hours. Sign-ups are counted by verdict only; nothing about the person is recorded. Nothing leaves the site unless you turn on one of the two optional features described under "External services".

== Data and credits ==

The plugin includes a snapshot of the Posterna operator directory (`data/directory.json` and `data/keys.json`), licensed under CC BY 4.0: Posterna operator directory (https://github.com/posternahq/posterna), CC BY 4.0. Records marked as community records are derived from the ai.robots.txt project (https://github.com/ai-robots-txt/ai.robots.txt), used under the MIT License. Details and the license notices are in `data/README.md`.

The plugin code is licensed under the GPL, version 2 or later. It bundles no third-party code. Signatures are checked with the libsodium functions built into PHP, or the sodium_compat copy that ships with WordPress.

== Changelog ==

= 1.0.0 =
* First release. Monitor only: labels and counts AI agent and crawler traffic, with a setup check, robots.txt suggestions, sign-up counts by verdict, and two optional, off-by-default connections to posterna.com.

== Upgrade Notice ==

= 1.0.0 =
First release.
