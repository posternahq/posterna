# Security policy

Posterna runs inside other people's request paths, so security reports matter to us.

## Reporting a vulnerability

Email **hello@posterna.com** and put "Security" in the subject. Please do not open a public issue, pull request or discussion for a suspected vulnerability.

Include what you can of:

- the affected package and version, or the commit
- what the problem is and what an attacker could do with it
- steps to reproduce, or a proof of concept
- a suggested fix, if you have one
- whether and how you would like to be credited

## What to expect

Posterna is a small project, so response times are best effort.

- We aim to acknowledge your report within 3 business days.
- We will confirm whether we can reproduce it, tell you what we plan to do, and keep you updated until it is resolved.
- We prefer coordinated disclosure: we release a fix first, then publish an advisory on GitHub. We credit reporters who want credit.

## Signing keys

The keys that sign the published directory, who holds them, and the runbook for a leaked or lost key are in [docs/KEYS.md](docs/KEYS.md). If you think one of them has leaked, report it as above.

## Supported versions

Before 1.0, only the latest release of each package gets security fixes. Fixes land on the `main` branch first.

## Scope

In scope:

- The packages in this repository: `@posterna/core`, `@posterna/express`, `@posterna/next`, `@posterna/directory` and the `posterna` CLI.
- Getting a verified verdict (`verified_by_signature` or `verified_by_ip`) without controlling the operator's keys or addresses, including through forwarding headers or inbound `X-Agent-*` and `X-Posterna-*` headers that survive stripping.
- A crafted request that makes Posterna block, crash, throw into the application, or add significant latency, when it should fail open.
- Posterna fetching a URL taken from an incoming request, or logging or sending client IPs, full URLs, header values or bodies.
- Accepting a `directory.json` or `keys.json` whose signature does not verify against the embedded keys, that a retired key generation signed, or that is older than the loaded copy.
- Directory data errors that would let someone pass verification, such as a wrong key directory URL or IP list.
- The build and release process in this repository: CI workflows, package contents and install-time behavior.

Reports about the posterna.com endpoints these packages talk to are welcome at the same address.

Out of scope:

- Agents that claim no identity and are labeled `unknown_automation` or `human`. Posterna labels claims; detecting undeclared bots is not a goal.
- Results of a misconfiguration the documentation warns about, such as listing a proxy you do not control in `trustedProxies`, unless Posterna should have caught it.
- Vulnerabilities in dependencies that cannot be exploited through Posterna. Please report those upstream, and tell us if Posterna is affected.
- Volumetric denial of service, spam, social engineering and physical attacks.
- Automated scanner output without a demonstrated impact.
