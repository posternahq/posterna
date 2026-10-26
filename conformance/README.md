# Conformance vectors

Language-neutral test vectors for the Posterna verifier and policy engine.

Each vector is a JSON file that describes one request, the configuration and directory it runs against, and the exact result an implementation must produce. The TypeScript runner in `@posterna/core` executes every vector as part of `pnpm test`. Future ports (PHP and Python are planned) prove they behave the same by running the same files. Vectors are data only: nothing in them depends on a programming language.

## Status

No vectors yet. They arrive with the verifier. The format below is a draft and may change until the first vectors land.

## Layout

```text
conformance/
  vectors/<area>/<name>.json   one vector per file, for example vectors/signature/valid-ed25519.json
  fixtures/                    directory.json and keys.json fixtures, and throwaway test keys
```

## What a vector contains

| Field | Meaning |
|---|---|
| `id` | Stable identifier matching the file path, for example `signature/valid-ed25519` |
| `description` | One plain-English sentence on what is tested and why |
| `spec` | The `docs/SPEC.md` sections it covers, for example `["4.4"]` |
| `now` | The clock the implementation must use, as an RFC 3339 timestamp |
| `request` | Method, path, socket address, and headers as an ordered list of name and value pairs (order and repeats matter for signatures) |
| `dns` | Reverse and forward DNS answers, for vectors that exercise reverse DNS |
| `config` | Verifier options such as `trustedProxies` and `publicHost`, and the policy (`agents.yaml` as JSON) |
| `directory` | Which fixtures under `fixtures/` to load |
| `expected` | The `VerdictResult`, and the `Decision` when the vector includes a policy |

## Rules

- **No network, no wall clock.** DNS answers come from the vector, and time comes from `now`. A runner never makes a network call.
- **Fixtures, not live data.** Fixture operators use reserved names (`example.com`, `.example`, `.test`). Addresses come from the documentation ranges `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24` and `2001:db8::/32`, plus private and loopback addresses for proxy cases.
- **Throwaway keys only.** Signing keys are Ed25519 keys generated for the fixtures. Never use a real operator's key.
- **Every verifier or policy change adds or updates a vector.**
