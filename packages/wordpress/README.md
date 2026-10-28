# Posterna for WordPress

The WordPress plugin, version 1.0: monitor mode only. It labels and counts AI
agent and crawler traffic with a PHP port of the verifier in `@posterna/core`
and shows the results in wp-admin. It never blocks anything. The user-facing
description is in `readme.txt`; review notes are in `docs/REVIEW-NOTES.md`;
releases are in `RELEASING.md`.

Licensed GPLv2 or later (`LICENSE`), unlike the rest of this repository (MIT).
The bundled directory data is CC BY 4.0 (`data/README.md`).

## Layout

| Path | What it is |
|---|---|
| `posterna.php` | Main plugin file and header |
| `uninstall.php` | Removes the table, options, transients and events |
| `includes/signature/` | Structured Fields, RFC 9421 and Web Bot Auth, ported from Cloudflare's `http-message-sig` and `web-bot-auth` |
| `includes/verifier/` | The verifier: client address, claims, IP lists, reverse DNS, verdicts |
| `includes/directory/` | Signed directory updates, generation ratchet, anti-rollback |
| `includes/policy/` | robots.txt suggestions from the monitor and allow-list templates |
| `includes/class-*.php` | WordPress wiring: hooks, counters table, admin page, storage |
| `data/` | Snapshot of `packages/directory/data` (must stay identical; a test checks) |
| `tests/unit/` | PHPUnit: every conformance vector, plus port checks |
| `tests/wp/` | End-to-end helpers for wp-env (never shipped) |
| `bin/` | Build, end-to-end and Plugin Check scripts |
| `.wordpress-org/` | Banner (1544x500, 772x250) and icon (256x256, 128x128) placeholders for the plugin page; replace them with final artwork. The deploy workflow uploads this folder to SVN `assets/`. |

## Development

PHP tools come from Composer. On a Mac where Homebrew cannot install PHP (it
no longer builds packages for macOS 14), run them in Docker:

```bash
docker run --rm -v "$PWD":/app -w /app composer:2 install
docker run --rm -v "$PWD":/app -w /app php:8.0-cli vendor/bin/phpunit
docker run --rm -v "$PWD":/app -w /app php:8.0-cli vendor/bin/phpcs
```

With PHP 8 and Composer installed locally: `composer install`, `composer test`,
`composer lint`.

End-to-end in a real WordPress (Docker and Node 22.13 or later):

```bash
pnpm --filter @posterna/wordpress-plugin test:wp
WP_ENV_PHP_VERSION=8.4 pnpm --filter @posterna/wordpress-plugin test:wp
pnpm --filter @posterna/wordpress-plugin plugin-check
```

Build the zip: `pnpm --filter @posterna/wordpress-plugin zip`, which writes
`dist/posterna-<version>.zip`.
