# @posterna/directory

**Pre-release, not yet published.**

The open directory of AI agent and crawler operators that [Posterna](https://posterna.com) verifies against: who runs each agent, its user-agent tokens and purpose, whether it honors robots.txt, and how to verify it (key directory, published IP lists, reverse DNS). Every fact carries its source and fetch date.

Once built, the package ships these files in `data/`:

| File | Contents |
|---|---|
| `directory.json` | One record per operator. Rebuilt daily and reviewed by a person before merge. |
| `keys.json` | Current public keys from each signing operator's key directory |
| `agents.csv` | Flat export, one row per agent |
| `summary.json` | Counts |

## License

The data is licensed under CC BY 4.0 and the code under MIT. See [LICENSE](LICENSE). Community records come from the [ai.robots.txt](https://github.com/ai-robots-txt/ai.robots.txt) project under MIT; see [NOTICE](NOTICE).

See section 3 of the [specification](https://github.com/posternahq/posterna/blob/main/docs/SPEC.md).
