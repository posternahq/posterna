# Counters

Counters are optional. With a site key from the dashboard in `POSTERNA_SITE_KEY`, Posterna sends aggregate counts every 60 seconds. They cover:

- verdict, reason code, operator, agent and purpose;
- a path group: the matched policy pattern, else the first path segment (`/docs/*`, or `/robots.txt` for a file at the root), with identifier-like segments masked;
- the action taken and whether it was enforced;
- bytes served, with Express only: the Next.js proxy runs before the page and cannot see response sizes, so the dashboard shows bytes as not available for Next.js sites.

No address, URL, header value or body ever leaves your server. Without a site key nothing is sent. Counters are flushed on shutdown too. If your app handles `SIGTERM` itself, call `await middleware.flush()` (Express) in your handler.

`posterna init` can save the site key to your env file, after asking ([quickstart](install.md)).
