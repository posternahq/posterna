# @posterna/express

## 0.1.3

### Patch Changes

- Updated dependencies [ede5a4c]
  - @posterna/core@0.1.3

## 0.1.2

### Patch Changes

- @posterna/core@0.1.2

## 0.1.1

### Patch Changes

- No code changes. The first release published from GitHub Actions with npm trusted publishing, so every package carries a provenance statement linking it to the commit and workflow that built it.
- Updated dependencies
  - @posterna/core@0.1.1

## 0.1.0

### Patch Changes

- First public release. Express 4 and 5 middleware: labels every request, applies `agents.yaml`, sets `req.posterna` and the `X-Agent-*` request headers, sends enforced block and throttle responses, counts requests, and serves the debug route for `posterna doctor`. Fails open on every error.
- Updated dependencies
  - @posterna/core@0.1.0
