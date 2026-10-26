# CLAUDE.md: posternahq/posterna

Posterna's open-source packages: an in-process verifier, policy engine, counters client, Express and Next.js adapters, CLI, and the open operator directory. The full spec is `docs/SPEC.md`. Read it before any change and keep it in step with the code.

## Stack

- pnpm workspaces, TypeScript strict, Node 20 or later (CI runs 20, 22, 24)
- tsup builds (ESM and CJS with type declarations), Vitest, Biome, Changesets
- Cloudflare's web-bot-auth packages for RFC 9421 and Ed25519. Never hand-roll canonicalization or cryptography.

## Commands

- `pnpm install`, `pnpm check` (Biome), `pnpm typecheck`, `pnpm test`, `pnpm bench`, `pnpm build`
- Directory: `pnpm directory:fetch`, `pnpm directory:build`

## Non-negotiables

1. Fail open on every error path. A bug must never block a request or produce `claimed_failed`.
2. Monitor mode by default. Templates start in monitor.
3. Label, never score. No behavioral detection, no fingerprinting, no challenge of our own.
4. No proxy mode, no CDN features.
5. Requests never leave the origin. Never log or transmit IPs, full URLs, header values or bodies.
6. Never fetch a URL taken from an incoming request.
7. Strip inbound `X-Agent-*` and `X-Posterna-*` headers before anything reads them.
8. The hot path stays under 5 ms p99; the benchmark in CI enforces it.
9. Directory data: never invent a URL, key, prefix, token or quote. Every fact has a source and a fetch date.

## Conventions

- Every verifier or policy change adds or updates a conformance vector in `conformance/`.
- Public APIs are documented with TSDoc and in `docs/`.
- Code is MIT; directory data is CC BY 4.0; credit ai.robots.txt (MIT) in NOTICE.
- No customer, prospect or partner names anywhere in this repository. It will be public.
- Write docs and comments in plain English. Do not use em dashes.
- Small commits with clear messages. Do not publish to npm; Joe publishes releases himself.

## When to stop and ask

Only for: credentials or secrets, anything that publishes or deletes, a change that contradicts docs/SPEC.md, or a security trade-off. Otherwise make the reasonable call and list your decisions in the final summary.
