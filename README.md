# Posterna

Verify which AI agents and crawlers are calling your site, and decide what each may do.

**Status: pre-release, not yet published.** Nothing is on npm yet, and every API may change.

Posterna lets a website or API verify which AI agents and crawlers are calling it, decide what each may do, and see the result. It runs inside your app as a library: no proxy, no CDN, no DNS change. It checks each agent's claimed identity against an open directory of operators, using HTTP message signatures (RFC 9421), published IP ranges and reverse DNS.

A fresh install changes nothing: it labels every request and counts the results. When you are ready, a policy file (`agents.yaml`) can block or throttle by operator, purpose or path, with guards that keep verified search engines reachable. Every error path fails open, and requests never leave your server.

## Verdicts

Every request gets exactly one verdict.

| Verdict | Meaning |
|---|---|
| `verified_by_signature` | The request carries a valid HTTP message signature from a key the operator publishes. |
| `verified_by_ip` | The address is in the operator's published IP ranges, or passes forward-confirmed reverse DNS. |
| `declared_unverifiable` | The request claims an identity that cannot be checked right now, for example because the operator publishes no keys, ranges or reverse DNS rules. |
| `claimed_failed` | The request claims a known agent, and the check failed. It may be spoofed. |
| `unknown_automation` | The request looks automated but claims no agent in the directory. |
| `human` | The request looks like an ordinary browser. |

Posterna labels; it does not score. There is no behavioral detection and no fingerprinting.

## Install (preview)

Not published yet. Once it is, setup starts with:

```bash
npx posterna init
```

`init` detects Express or Next.js, writes an `agents.yaml` in monitor mode, and prints the code to add. See [docs/install.md](docs/install.md).

## Packages

| Package | What it is | License |
|---|---|---|
| [`@posterna/core`](packages/core) | Verifier, policy engine and counters client: `verify()` and `decide()` | MIT |
| [`@posterna/express`](packages/express) | Express middleware | MIT |
| [`@posterna/next`](packages/next) | Next.js integration | MIT |
| [`posterna`](packages/cli) | CLI: `init`, `doctor`, `robots`, `policy check` | MIT |
| [`@posterna/directory`](packages/directory) | The open operator directory and its build pipeline | CC BY 4.0 (data), MIT (code) |

[`conformance/`](conformance) holds language-neutral JSON test vectors, so ports to other languages can prove they behave the same.

## Development

You need Node 20 or later and pnpm (through corepack).

```bash
corepack enable
pnpm install
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

Read [docs/SPEC.md](docs/SPEC.md) before changing code, and [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Commits need a DCO sign-off.

## Security

Report vulnerabilities to security@posterna.com. See [SECURITY.md](SECURITY.md).

## License

Code is MIT ([LICENSE](LICENSE)). Directory data is CC BY 4.0, and community records come from the ai.robots.txt project under MIT ([packages/directory/LICENSE](packages/directory/LICENSE), [NOTICE](packages/directory/NOTICE)).
