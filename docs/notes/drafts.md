# IETF webbotauth drafts: what we follow and where they are unclear

Read on 26 October 2026 from datatracker.ietf.org/wg/webbotauth/documents/. The documents that matter for the verifier:

- `draft-ietf-webbotauth-httpsig-protocol-00` (adopted by the working group, expires 5 March 2027): the Signature-Agent header, required components and parameters, key directories, and test vectors. It folded in the separate directory draft (`draft-meunier-webbotauth-httpsig-directory-00`).
- Expired and replaced: `draft-meunier-web-bot-auth-architecture-05`, `draft-meunier-http-message-signatures-directory-05`.

## What the verifier follows

| Draft requirement | Section | Posterna |
|---|---|---|
| Signatures cover bare `@authority` or `@target-uri` | 5.2 | Enforced (library) |
| `created`, `expires`, `keyid`, `tag="web-bot-auth"` are required | 5.2 | Enforced (library, plus our no-`alg` path) |
| Signature-Agent is a Dictionary; members are https URI strings; `type` defaults to `directory`; unsupported types are ignored | 5.2.1 | Followed. Only `directory` is supported. |
| The legacy bare-string form MAY be accepted | 5.2.1 | Accepted, via `web-bot-auth`'s parser |
| The member keyed to the signature's label MUST be covered | 5.2.1 | Enforced (library) |
| Each of several signatures is validated on its own | 5.2.2 | Followed |
| A `directory` member value is an origin; other values are ignored (`/` allowed) | 5.5 | Followed: members with a path, query, fragment or non-https scheme are ignored |
| Key lookup is keyed on the (URL, key) pair, never the key alone | 5.4 | Followed: keys are held per operator, found from the Signature-Agent origin |
| A failed resolution must not evict cached keys | 6.10 | Followed: a failed refresh keeps the last good copy |
| Verifiers SHOULD reject known test keys in directories | 6.8 | The RFC 9421 example key is skipped when loading keys.json (vector `keys/published-test-key-rejected`) |
| SSRF: bound fetches named by requests | 6.7 | Stronger: installs never fetch anything a request names |
| Three outcomes: verified, invalid, unverified | Appendix C.1 | `verified_by_signature`, `claimed_failed`, `declared_unverifiable` |

## Ambiguities and the reading we chose

1. **keyid versus kid.** Section 5.2 says `keyid` MUST be the JWK thumbprint, and section 5.5 says a kid at the well-known directory MUST equal it. Live directories disagree: Google publishes short kid labels, Meta publishes no kid. We select a key by kid first, then by computed thumbprint, then try every key when the operator publishes no kid at all; an unknown kid on an operator that does use kids is `declared_unverifiable` and triggers an early keys refresh. "Legacy kid derivation" in our tests means an operator-chosen label rather than a thumbprint.
2. **Signature-Agent without a signature.** The draft says a signed request MUST carry Signature-Agent, but not what a Signature-Agent without Signature and Signature-Input means. We treat it as unsigned (section 6.11: absence of a signal is not evidence): the User-Agent claim, if any, is checked, otherwise the request is `declared_unverifiable` for the named operator.
3. **Signature-Agent naming nothing we know.** docs/SPEC.md section 4.3 reads as "Signature-Agent first, otherwise User-Agent". Read literally, an attacker could add an invented Signature-Agent to a spoofed Googlebot request and get `declared_unverifiable` instead of `claimed_failed`. We still check the User-Agent claim in that case (vector `spoof/fake-signature-agent-with-googlebot`), and SPEC 4.3 now says so.
4. **Redistributed keys.** Section 5.5.3 says a verifier must not attribute a request to a URL using redistributed key material without a directory response signature, but also that "a control plane polling on behalf of the verifiers it serves" is resolution, not redistribution. Posterna's keys.json is produced by the Posterna cloud service polling each listed directory hourly for installs, which we read as the control-plane case. If the working group reads it otherwise, keys.json would need to carry each directory's response signature (Appendix B).
5. **Validity window.** The draft recommends expiry no more than 24 hours (section 5.2); docs/SPEC.md caps it at 300 seconds. The draft's own test vectors use windows of about a hundred years, and we do not know the windows live signers use. A signer with a longer window than 300 seconds would be `claimed_failed` here. This is the most likely source of false `claimed_failed` results once real signed traffic arrives, and is worth checking against live traffic before enforcement is used.
6. **Nonces.** The draft defines no nonce requirements (section 5.2.3) and leaves replay detection to deployments (Appendix C.6). Replay is checked only when a nonce is present; a signature without one cannot be checked for replay within its window.
7. **Scheme for `@target-uri`.** Behind a TLS-terminating proxy the app sees http. We use https when `publicHost` is set, the rightmost X-Forwarded-Proto from a trusted proxy, then the request's own scheme. The draft does not address this.
8. **Forwarded versus X-Forwarded-For.** docs/SPEC.md allows either. Reading both at once lets a client inject the one the proxy does not maintain, so the verifier reads exactly one, chosen by `forwardedHeader` (default `x-forwarded-for`). Vector `proxy/forwarded-ignored-by-default`.
