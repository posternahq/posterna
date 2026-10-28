---
"@posterna/core": patch
---

Signatures may now be valid for up to an hour: the default `maxSignatureValidity` is 3,600 seconds instead of 300. The first real signed traffic seen, DuckAssistBot from Duck.ai, signs with valid 600-second windows, which the old limit turned into `claimed_failed` with reason `validity_too_long`. A site that wants the stricter limit can still set `maxSignatureValidity: 300`.
