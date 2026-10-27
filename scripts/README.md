# Scripts

Repository maintenance scripts. They are not published.

- `generate-directory-key.mjs --role primary|backup --generation <N>` makes a new directory signing key. It writes the private JWK to `~/posterna-keys/` (folder mode 700, file mode 600), never inside a git working tree and never over an existing file, and prints only the file path, the public JWK and the kid. Run `pnpm build` first: it checks the new key with `@posterna/core`'s own verification code before writing. What to do with the key is in `docs/KEYS.md`.

Package-specific scripts live with their package:

- `pnpm bench` runs `packages/core/bench/verify.bench.ts` (method in `docs/benchmark.md`).
- `pnpm conformance:generate` runs `packages/core/test/conformance/generate.ts`.
- The directory data pipeline is in `packages/directory/scripts/`.
