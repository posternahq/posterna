# posterna

**Pre-release, not yet published.**

The [Posterna](https://posterna.com) command line.

| Command | What it does |
|---|---|
| `posterna init` | Detect Express or Next.js, write `agents.yaml` from a template (monitor mode), print the code to add, and optionally save a site key |
| `posterna doctor --url <site>` | Check a deployed site: client IP resolution, the signed host, signature headers, directory freshness, mode. Needs `POSTERNA_DEBUG_TOKEN` |
| `posterna robots` | Print robots.txt and Content Signals from `agents.yaml` |
| `posterna policy check` | Validate `agents.yaml`, with line and column for every problem |

`init` never edits your code. `doctor` sends forged forwarding headers along with a signed request, to make sure your proxy settings ignore them. See the [install guide](https://github.com/posternahq/posterna/blob/main/docs/install.md). MIT licensed.
