# @posterna/core

## 0.1.3

### Patch Changes

- ede5a4c: Signatures may now be valid for up to an hour: the default `maxSignatureValidity` is 3,600 seconds instead of 300. The first real signed traffic seen, DuckAssistBot from Duck.ai, signs with valid 600-second windows, which the old limit turned into `claimed_failed` with reason `validity_too_long`. A site that wants the stricter limit can still set `maxSignatureValidity: 300`.
- Updated dependencies [c047866]
  - @posterna/directory@0.1.3

## 0.1.2

### Patch Changes

- Updated dependencies [3a7999d]
  - @posterna/directory@0.1.2

## 0.1.1

### Patch Changes

- No code changes. The first release published from GitHub Actions with npm trusted publishing, so every package carries a provenance statement linking it to the commit and workflow that built it.
- Updated dependencies
  - @posterna/directory@0.1.1

## 0.1.0

### Patch Changes

- First public release. The verifier behind `verify()` gives every request one of six verdicts from HTTP message signatures (RFC 9421, Web Bot Auth), published IP ranges and forward-confirmed reverse DNS. The policy engine behind `decide()` reads `agents.yaml`, starts in monitor mode, keeps verified search engines reachable, and suspends enforcement on its own when proxy settings look wrong or an operator's checks keep failing. Also included: the counters client, signed directory refresh trusting the production directory keys, the debug report for `posterna doctor`, and the policy templates and JSON schemas.
- Updated dependencies
  - @posterna/directory@0.1.0
