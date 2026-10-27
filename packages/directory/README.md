# @posterna/directory

**An early release (0.1).** The API may change before 1.0, and every change is in the changelog.

The open directory of AI agent and crawler operators that [Posterna](https://posterna.com) verifies against: who runs each agent, its user-agent tokens and purpose, whether it honors robots.txt, and how to verify it (key directory, published IP lists, reverse DNS). Every fact carries its source and fetch date.

## Files

| File | Contents |
|---|---|
| `data/directory.json` | One record per operator. Rebuilt daily and reviewed by a person before merge. |
| `data/keys.json` | Current public keys from each signing operator's key directory, with RFC 7638 thumbprints |
| `data/agents.csv` | Flat export, one row per agent |
| `data/summary.json` | Counts |

The formats are in section 3 of the [specification](https://github.com/posternahq/posterna/blob/main/docs/SPEC.md) and in the JSON Schemas in `packages/core/src/schema/`. The latest build report is [docs/directory-build-report.md](https://github.com/posternahq/posterna/blob/main/docs/directory-build-report.md).

## Coverage

- **Researched** operators have a hand-curated file in `sources/` with every fact quoted from and linked to the operator's own documentation.
- **Community** records come from the [ai.robots.txt](https://github.com/ai-robots-txt/ai.robots.txt) project under MIT, and are labeled `community`. Their purposes are mapped from its free-text descriptions.

## Rebuilding

```bash
pnpm directory:fetch
pnpm directory:build
```

`directory:fetch` downloads every cited page, IP list and key directory into `raw/` and records each outcome in `raw/manifest.json`. It identifies itself as `PosternaDirectoryBuilder/0.1 (+https://posterna.com/directory)`, honors robots.txt, and records failures instead of retrying. `directory:build` writes `data/` and the build report, and fails on data that does not match the schemas. A scheduled workflow runs both every day and opens a pull request when facts change.

To add or correct an operator, edit its file in `sources/` (format in `sources/README.md`) and rebuild.

## License

The data is licensed under CC BY 4.0 and the code under MIT. See [LICENSE](LICENSE). Community records come from the ai.robots.txt project under MIT; see [NOTICE](NOTICE).
