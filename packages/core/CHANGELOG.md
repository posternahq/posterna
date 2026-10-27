# @posterna/core

## 0.1.0

### Patch Changes

- First public release. The verifier behind `verify()` gives every request one of six verdicts from HTTP message signatures (RFC 9421, Web Bot Auth), published IP ranges and forward-confirmed reverse DNS. The policy engine behind `decide()` reads `agents.yaml`, starts in monitor mode, keeps verified search engines reachable, and suspends enforcement on its own when proxy settings look wrong or an operator's checks keep failing. Also included: the counters client, signed directory refresh trusting the production directory keys, the debug report for `posterna doctor`, and the policy templates and JSON schemas.
- Updated dependencies
  - @posterna/directory@0.1.0
