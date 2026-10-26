# Contributing to Posterna

Thank you for helping. This guide covers what a pull request needs before it can be merged.

## Sign off every commit (DCO)

Posterna uses the [Developer Certificate of Origin 1.1](https://developercertificate.org/) (DCO). Signing off a commit certifies that you wrote the change, or otherwise have the right to submit it under this project's licenses.

Every commit in a pull request must carry a sign-off line:

```text
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds it for you, using the name and email from your git config. The sign-off must match the commit author. Pull requests with commits that are not signed off cannot be merged.

To sign off commits you already made:

```bash
git rebase --signoff main
```

## Licensing of contributions

Code you contribute is licensed under the MIT License. Contributions to the directory data in `packages/directory/data/` are licensed under CC BY 4.0. See [LICENSE](LICENSE) and [packages/directory/LICENSE](packages/directory/LICENSE).

## Before you start

- Read [docs/SPEC.md](docs/SPEC.md). It is the source of truth. When code and spec disagree, fix one of them in the same change.
- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- Report security problems privately as described in [SECURITY.md](SECURITY.md), not in an issue.

## Setup

You need Node 20 or later and pnpm, which corepack provides:

```bash
corepack enable
pnpm install
```

| Command | What it does |
|---|---|
| `pnpm check` | Lint and format check (Biome). `pnpm format` fixes what it can. |
| `pnpm typecheck` | TypeScript, strict |
| `pnpm test` | Unit and conformance tests (Vitest) |
| `pnpm bench` | Hot path benchmark; fails at 5 ms p99 (see `docs/benchmark.md`) |
| `pnpm conformance:generate` | Rewrites the conformance fixtures and vectors in `conformance/` |
| `pnpm build` | Build every package (tsup, ESM and CJS with type declarations) |
| `pnpm changeset` | Describe a change for the next release |
| `pnpm directory:fetch`, `pnpm directory:build` | Directory data pipeline |

All of `check`, `typecheck`, `test` and `build` must pass. CI runs them on Node 20, 22 and 24.

## Ground rules

These come from the spec and are not up for trade-offs in a pull request:

1. Fail open on every error path. A bug must never block a request or produce `claimed_failed`.
2. Monitor mode by default. Templates start in monitor.
3. Label, never score. No behavioral detection, no fingerprinting, no challenge of our own.
4. No proxy mode and no CDN features.
5. Requests never leave the origin. Never log or transmit IPs, full URLs, header values or bodies.
6. Never fetch a URL taken from an incoming request.
7. Strip inbound `X-Agent-*` and `X-Posterna-*` headers before anything reads them.
8. Keep the hot path under 5 ms at p99.
9. Use Cloudflare's web-bot-auth packages for RFC 9421 and Ed25519. Never hand-roll canonicalization or cryptography.

## Making a change

- Every verifier or policy change adds or updates a vector in [`conformance/`](conformance).
- Document public APIs with TSDoc and in `docs/`.
- Add a changeset (`pnpm changeset`) for any change that affects a published package.
- Pin exact dependency versions. Packages must not have install scripts.
- Keep commits small, with clear messages.
- Write docs and comments in plain English, and do not use em dashes.
- Do not name customers, prospects or partners anywhere in the repository.

## Directory data

- Never invent a URL, key, IP prefix, user-agent token or quote. Every fact needs a source URL and a fetch date.
- An agent's purpose comes from the operator's own documentation, with a short quote. Otherwise it comes from ai.robots.txt and the record is labeled `community`.
- Mark an agent as signing (`signs: true`, signing status `live`) only when its key directory was fetched and parsed. Third-party sightings are `reported`.

Researched facts live in `packages/directory/sources/<operator>.yaml` (format in `packages/directory/sources/README.md`). Change them there, then run `pnpm directory:fetch` and `pnpm directory:build`, and check the evidence section of `docs/directory-build-report.md`: every quote and token should be found verbatim on the page it cites.

If you run an agent or crawler and your entry is wrong or missing, open an issue or pull request with a link to your own documentation.

## Code of conduct

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md). Report problems to hello@posterna.com.
