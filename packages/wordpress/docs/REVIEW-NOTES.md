# Review notes: Posterna 1.0.0 for WordPress.org

Written 28 October 2026 while building the plugin. It covers what was checked
before writing code, what changed in the plan, the test results, how the port
differs from `@posterna/core`, and what a plugin reviewer is likely to ask.

## Sources checked before writing code (28 October 2026)

| Source | What it said that matters here |
|---|---|
| Detailed Plugin Guidelines (developer.wordpress.org, modified 11 March 2026) | Guideline 7: no outside contact without explicit opt-in. Guideline 8: no code from outside servers; data lists from a service only if its terms allow, over HTTPS. Guideline 11: dashboard widgets and notices must be dismissible or go away once resolved. Guideline 12: at most 5 tags. Guideline 17: no one else's trademark at the start of the slug. Nothing new on AI-written code. |
| "Common issues" page (modified 20 March 2026) | External services need a readme section that says what the service is, what is sent and when, and links to its terms and privacy policy. There is no official template. Use the WordPress HTTP API, `$wpdb->prepare()`, an ABSPATH guard in every PHP file, prefixes longer than 3 characters, and a text domain equal to the slug. |
| Plugin Check (PCP) 2.1.0, 16 August 2026 | Mandatory on upload since 1 October 2024; any error blocks the submission. Checks run: `plugin_repo` category (i18n, escaping, nonces, direct DB, prefixing, readme, offloading, write_file, file types, hidden files, minified files, trademarks and more). |
| WordPress releases | 7.1.4 shipped 28 October 2026. 7.2 is in beta, planned for 9 December 2026. WordPress 7.0 dropped PHP 7.2 and 7.3. |
| readme.txt standard (modified 11 March 2026) | "Tested up to" is major.minor only; short description at most 150 characters; 1 to 5 tags; Contributors are case-sensitive WordPress.org usernames; Requires at least and Requires PHP must match the plugin header. |
| Plugins Team post on licensing (6 November 2015) | CC BY 4.0 data "works with any GPL version"; attribution goes in the readme. |
| Plugins Team post (9 September 2026) | Every release now gets an automated security scan and a 6-hour hold before sites see it. |

### What changed in the plan

- **Tested up to: 7.1.** If the plugin is uploaded after WordPress 7.2 ships (planned 9 December 2026), test with 7.2 and change it to 7.2 first: Plugin Check reports an outdated value as an error for new submissions.
- **No translation calls before `init`.** WordPress 6.7 and later warn when translations load early, and the check runs on `plugins_loaded`. Verdict notes are fixed English text that never goes through `__()`; every admin string does. `load_plugin_textdomain()` is not called: WordPress.org loads translations itself.
- **Nothing is written into the plugin folder** (`write_file` check): downloaded directory data and all state live in options and transients.
- **No hidden files and no extra Markdown at the root of the zip.** The build copies an allow-list; `data/README.md` holds the data license notices.
- **No PHP library for RFC 9421.** The maintained candidates need PHP 8.1 or later and PSR-7 (`craftcms/http-message-signatures`, `bakame/http-structured-fields`) or PHP 8.5 (`socialweb/http-message-signatures`). The plugin implements only what the drafts require, in `includes/signature/`, as a port of the Cloudflare code core uses (see below).
- **Docker on this Mac.** Homebrew no longer ships packages for macOS 14 and its PHP build failed on a dependency (libvmaf), so PHP, Composer, PHPUnit and PHPCS ran in the official `php` and `composer` Docker images, and WordPress in wp-env. The CI jobs install PHP normally.

## Results

### Conformance vectors (`conformance/`, run by `tests/unit/ConformanceTest.php`)

All applicable vectors pass on PHP 8.0.30 and PHP 8.5.12:

- 86 `verify` vectors, each run twice: once with header pairs (order and repeats kept) and once through a `$_SERVER` array as the plugin reads requests. 172 cases.
- 4 `rfc9421` vectors (RFC 9421 Appendix B.2.6 and the protocol draft's E.2), 3 `key_directory` vectors (Browserbase, Google and Meta key directories), 8 `robots` vectors including the three shipped templates.

Not run, because plugin 1.0 has no policy engine (monitor only, no agents.yaml, nothing is ever enforced): the 36 `decide` vectors and 3 `policy_check` vectors. They are reported as skipped:
`policy/breaker/retrips`, `policy/breaker/signature-not-counted`, `policy/breaker/signup-not-counted`, `policy/breaker/trip-and-recover`, `policy/check/invalid`, `policy/check/rates`, `policy/check/templates`, `policy/failure/fails-open`, `policy/guards/breaker-tripped`, `policy/guards/claimed-failed-after-verified`, `policy/guards/claimed-failed-unseen`, `policy/guards/declared-unverifiable`, `policy/guards/off`, `policy/guards/verified-search-engine`, `policy/monitor/global-mode`, `policy/monitor/per-rule`, `policy/order/defaults-by-class`, `policy/order/human-always-allowed`, `policy/order/no-rule`, `policy/order/operator-beats-purposes`, `policy/order/path-beats-operator`, `policy/order/path-class-beats-path-purpose`, `policy/order/purposes-beats-defaults`, `policy/paths/cascade`, `policy/paths/most-specific-wins`, `policy/signup/recommendations`, `policy/signup/template-monitor`, `policy/suspensions/all`, `policy/suspensions/env-cannot-enforce`, `policy/suspensions/env-kill-switch-case`, `policy/suspensions/env-kill-switch`, `policy/suspensions/proxy-guard`, `policy/suspensions/remote-cannot-enforce`, `policy/suspensions/remote-override`, `policy/throttle/buckets`, `policy/throttle/monitor-consumes`, `policy/throttle/timing`, `policy/unknown-automation/named`, `policy/unknown-automation/only-explicit`.

As a check that the vectors bite, replacing the Ed25519 verification with `return true` made the signature vectors fail as expected.

`tests/unit/PortTest.php` adds: the trusted directory keys equal core's `TRUSTED_DIRECTORY_KEYS`; a `keys.json` published by posterna.com verifies under the embedded primary key (and is refused when tampered, retired or malformed); the bundled snapshot is byte-identical to `packages/directory/data` and compiles with no skipped keys; path groups, addresses, prefixes, URLs and Structured Fields; the autoloader's class map is complete. Total: 235 tests, 5,110 assertions, 39 skipped (the policy vectors).

### WordPress end-to-end (`bin/test-wp.sh`, wp-env with WordPress 7.1, WooCommerce and Plugin Check)

68 of 68 checks pass on PHP 8.0 and on PHP 8.5: activation on a clean site; labels for a browser, curl, spoofed GPTBot and Googlebot (with the reverse DNS lookup run by WP-Cron), Googlebot from Google's published range, and forged `X-Agent-*`, `X-Posterna-*`, `X-Real-IP` and `CF-Connecting-IP` headers; counters and path-group masking; every admin tab, the dashboard widget, the settings form (and refusal without a nonce); WordPress and WooCommerce sign-ups counted by verdict; the counters connection against a mock ingest server, with the captured payload validated by the cloud's own `payloadSchema`; failing open when posterna.com is unreachable and when the bundled data is corrupt; a live, signature-checked download from posterna.com; deactivation and uninstall leaving nothing behind; no PHP notices from the plugin in `debug.log`.

Note for anyone reading the test: the official WordPress Docker image runs Apache's `mod_remoteip`, which trusts `X-Forwarded-For` from private addresses and rewrites `REMOTE_ADDR` before PHP runs. Requests from the Docker gateway can therefore set the address with `X-Forwarded-For`; the forging tests use headers Apache leaves alone.

### Plugin Check 2.1.0 (final)

Run against the built plugin with `--include-experimental`, and again with `--mode=new --slug=posterna`:

```
Success: Checks complete. No errors found.
```

No errors and no warnings. An earlier run reported two errors from the offloading check (`PluginCheck.CodeAnalysis.Offloading.OffloadedContent`), triggered by a Cloudflare documentation link in the settings help text; the link moved to the readme FAQ.

### PHPCS

`WordPress` ruleset (Core, Docs, Extra) from WPCS 3.4.1, plus `PHPCompatibilityWP` for PHP 8.0 and later, `minimum_wp_version` 6.5, prefix `posterna`, text domain `posterna`: 0 errors, 0 warnings on every shipped PHP file.

### Measured per-request overhead

Inside live requests (time from reading `$_SERVER` to the verdict, measured with `hrtime()` in the plugin, 30 requests each, PHP 8.5, Docker Desktop on an Apple M-series Mac):

| Request | Median | 90th percentile |
|---|---|---|
| Browser | 0.33 ms | 0.40 ms |
| curl | 0.33 ms | 0.36 ms |
| Googlebot from Google's range (`verified_by_ip`) | 0.45 ms | 0.48 ms |
| Spoofed GPTBot (`claimed_failed`, OpenAI's 2,340 prefixes loaded) | 0.46 ms | 0.49 ms |
| Spoofed Googlebot, cached reverse DNS | 0.57 ms | 0.77 ms |

On PHP 8.0 the same medians were 0.35, 0.35, 0.49, 0.49 and 0.61 ms. Most of that is loading the plugin's classes and options once per request on Docker Desktop's slower shared file system; the check itself, warm, takes 0.005 to 0.013 ms (`tests/wp/bench.php`). Counting adds one `INSERT ... ON DUPLICATE KEY UPDATE` at shutdown: 0.12 ms median. Reverse DNS and directory downloads never run during a page load. The compiled directory and keys are one autoloaded option of about 91 KB; IP ranges are separate options that are not autoloaded and are read only when a request claims that operator (the largest, Amazon's, is about 100 KB).

## How the PHP port differs from `@posterna/core`

- **Signatures.** `includes/signature/` ports the parts of Cloudflare's `http-message-sig` 0.3.0, `web-bot-auth` 0.2.0 and `structured-headers` 2.0.3 that core uses: the same checks in the same order with the same error codes, so reason codes map the same way, including the libraries' quirks (unpadded base64 in byte sequences, integral decimals treated as integers, a date must end the header). Ed25519 uses `sodium_crypto_sign_verify_detached` (PHP's sodium extension, or WordPress's bundled sodium_compat). RSA-PSS keys are kept in the index but fail open as `library_unsupported` if a signature uses one: PHP's OpenSSL functions have no PSS padding. No listed operator publishes RSA keys today.
- **URLs.** `@authority` and Signature-Agent origins need WHATWG URL parsing, which PHP does not have. `includes/verifier/class-url.php` implements the subset needed (special schemes, host lowercasing, default ports, IPv4 number forms, dot segments). Anything it does not understand is invalid, which can only make a signature fail or a Signature-Agent be ignored.
- **Reverse DNS** runs in WP-Cron with `dns_get_record()`, at most 20 addresses and 10 seconds per run. PHP cannot interrupt a lookup, so an answer that took longer than the 1 second timeout is recorded as an error (fail open for a minute), as core would have.
- **State that core keeps in memory** is kept in WordPress storage, because each request is its own process: nonces in transients (3,660 seconds), the directory signing-key generation ratchet in the directory option, reverse DNS results in transients keyed by a hash of the address.
- **Proxy guard.** Core keeps the last 200 addresses in memory. The plugin counts internal addresses in its hourly rows and reports `proxySuspect` when at least 80 percent of at least 200 requests in the last day were internal.
- **Counters.** Stored per site in one table, sent every five minutes (core: every minute), with `bytes` 0 (WordPress does not know the response size when it counts), `policyHash` null, `mode` monitor, one random `instance` per site instead of per process, at most 50 path groups per hour. Sign-up rows stay local. Path groups drop the site's own subdirectory if WordPress is installed in one.
- **Not labeled:** wp-admin (including admin-ajax), WP-Cron and WP-CLI. **Not counted:** logged-in users.
- **Exceptions** are built into a variable and then thrown. Every exception is caught inside the plugin; their messages reach the admin page only through `esc_html()`. Building them first keeps the WordPress escaping sniff from asking to HTML-escape messages that are never output directly.

## Client address presets

Only where the host's own documentation confirms the header:

- Cloudflare: `CF-Connecting-IP`, with Cloudflare's published ranges as the proxy list. https://developers.cloudflare.com/support/troubleshooting/restoring-visitor-ips/restoring-original-visitor-ips/ and https://www.cloudflare.com/ips/
- Pantheon: `REMOTE_ADDR` already holds the visitor's address. https://docs.pantheon.io/client-ip

Left out because their documentation does not confirm a header or behavior: WP Engine (its docs describe trusting Cloudflare's `X-Forwarded-For` at the nginx level, but not what reaches PHP), Kinsta, SiteGround, WordPress.com, Pressable, Flywheel, Cloudways, GoDaddy.

## Page cache detection

"Check my setup" names the full-page caches it can see from PHP: `WP_CACHE` with `wp-content/advanced-cache.php`, WP Rocket (`WP_ROCKET_VERSION`), W3 Total Cache (`W3TC`), WP Super Cache (`WPCACHEHOME`), LiteSpeed Cache (`LSCWP_V`), Cache Enabler (`CACHE_ENABLER_VERSION`), Breeze (`BREEZE_VERSION`), Hummingbird (`WPHB_VERSION`), Speed Optimizer (`SiteGround_Optimizer\VERSION`), WP Fastest Cache (class `WpFastestCache`), WP Engine (`is_wpe()`), Kinsta (`KINSTAMU_VERSION`), Pantheon (`PANTHEON_ENVIRONMENT`), WordPress.com and Pressable (`ATOMIC_SITE_ID`). It does not make a loopback request to read cache headers.

## What a reviewer is likely to ask

1. **Direct database queries.** The plugin has its own table of hourly counts. Every query uses `$wpdb->prepare()` with `%i` for the table name; caching is pointless for counters that change on every request. The table is created with `dbDelta()` and dropped in `uninstall.php`.
2. **Reading `$_SERVER` without sanitizing.** Signature verification needs the exact header bytes the agent signed. Values are only compared and verified; nothing from them is stored or printed, except on "Check my setup", where the administrator's own request headers are shown through `esc_html()`.
3. **Writing to `$_SERVER`.** The plugin removes inbound `X-Agent-*` and `X-Posterna-*` headers when its file loads, so no visitor can forge a verdict for other code, then sets `HTTP_X_AGENT_VERDICT` and related keys with its own verdict. Plugins that load before Posterna (alphabetically earlier, or must-use plugins) could read forged values before they are removed; the readme points developers to `posterna_get_verdict()`.
4. **DNS lookups of visitor addresses.** They go to the server's own resolver, never to posterna.com or any third party, and only for addresses that claim to be a crawler whose operator documents reverse DNS (Google, Microsoft, Apple, Common Crawl). The readme describes this under "How it works".
5. **`set_error_handler()`** wraps `dns_get_record()` only, to turn its warnings into a recorded error, and is restored in a `finally` block.
6. **`base64_encode()` and `base64_decode()`** encode and decode signature bytes, nonces and key thumbprints. Each use has a comment saying so.
7. **The 644 KB bundled JSON.** It is data, never executed: the operator directory, CC BY 4.0 (accepted by the Plugins Team, credited in the readme), with community records from ai.robots.txt under MIT. It is readable JSON, not minified code.
8. **Contacting posterna.com.** Two features, both off by default and described next to their settings and under "External services" with the data sent, the schedule and links to the terms and privacy policy. Downloads are JSON data verified with Ed25519 against keys in the plugin, never code. The plugin works fully without them (guidelines 5 and 6).
9. **Five-minute cron schedule.** Added only so counts can be sent; the event exists only while a site key is set.
10. **Top-level menu item and dashboard widget.** The menu holds reports, not just settings. The widget is a standard dashboard widget, which administrators can hide from Screen Options; it shows no notices or promotions. The plugin adds no admin notices outside its own page.
11. **The name and slug.** Posterna is the project's own name; Plugin Check's trademark list has no match and the slug is unused.

## Before submitting

- Replace `WPORG_USERNAME` in `readme.txt` with the WordPress.org username that submits, then rebuild the zip.
- If submitting after 9 December 2026, test with WordPress 7.2 and update "Tested up to".
