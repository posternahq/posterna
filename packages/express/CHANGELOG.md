# @posterna/express

## 0.1.0

### Patch Changes

- First public release. Express 4 and 5 middleware: labels every request, applies `agents.yaml`, sets `req.posterna` and the `X-Agent-*` request headers, sends enforced block and throttle responses, counts requests, and serves the debug route for `posterna doctor`. Fails open on every error.
- Updated dependencies
  - @posterna/core@0.1.0
