# Releasing

Releases are cut by a maintainer. Contributors add a changeset to their pull request (`pnpm changeset`) and never publish.

Five packages are published: `posterna` (the CLI), `@posterna/core`, `@posterna/directory`, `@posterna/express` and `@posterna/next`. They share one version (a Changesets `fixed` group), and each release has one tag, `vX.Y.Z`.

The first release, 0.1.0, is published by hand, because npm lets you set up trusted publishing only for a package that already exists. Every later release is published by `.github/workflows/release.yml` when you push a version tag: no npm token, and a provenance statement on every package.

## Before the first publish

Check these once:

- Your npm account has two-factor authentication on, for authorization and writes (npmjs.com → your avatar → Account → Two-Factor Authentication).
- You are an owner of the npm organization `posterna` (https://www.npmjs.com/settings/posterna/members). The scoped packages publish into it.
- You maintain the unscoped `posterna` package. It exists already, holding the placeholder versions `0.0.0-stage` and `0.0.1`; 0.1.0 becomes its `latest`.
- Mail to security@posterna.com reaches you. SECURITY.md and the README give that address.

## 1. Publish 0.1.0 by hand

From a clean checkout of `main`:

```bash
cd ~/posterna/posterna
git switch main
git pull
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm typecheck
pnpm test
pnpm build
npm login
npm whoami
pnpm -r publish --dry-run --access public
pnpm -r publish --access public
```

What to expect:

- **`npm login`** prints a login URL and asks you to press Enter to open it. Sign in on npmjs.com with your password and second factor. The terminal then says you are logged in. `npm whoami` should print your npm user name.
- **The dry run** lists every file in each of the five packages and changes nothing. Check that each shows version 0.1.0 and only `dist`, the README, LICENSE, CHANGELOG, `package.json` and, where listed, `templates`, `src/schema`, `data` and NOTICE.
- **`pnpm -r publish --access public`** packs each package, turns `workspace:*` dependencies into `0.1.0`, and runs `npm publish` for each, dependencies first: `@posterna/directory`, then `@posterna/core`, then `@posterna/express`, `@posterna/next` and `posterna`. npm asks for your second factor once per package, five times in all:
  - with an authenticator app, it asks for a one-time password;
  - with a security key or passkey, it prints an "Authenticate your account" URL and asks you to press Enter to open it in the browser.
- If a prompt times out or a code is wrong, run `pnpm -r publish --access public` again. Versions already on npm are skipped.

Then check what was published:

```bash
npm view posterna version
npm view @posterna/core version
npm view @posterna/directory version
npm view @posterna/express version
npm view @posterna/next version
npx posterna@0.1.0 --version
```

Each should print `0.1.0`.

Optional: mark the placeholder versions as deprecated (one more second-factor prompt):

```bash
npm deprecate posterna@"<0.1.0" "Placeholder. Use 0.1.0 or later."
```

Tag the release:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The tag starts the release workflow. Everything in 0.1.0 is already on npm, so it runs the checks and publishes nothing. That is expected.

## 2. Make the repository public

Before you switch, decide whether the history needs rewriting. A rewrite changes every commit hash and needs a force push, so it is only cheap before anyone else has a copy. The release-preparation pass found:

- The first commit (`a1dc929`) has the author email `joewaltman@Joes-MacBook-Air.local`, which shows the Mac's name. Every later commit uses the GitHub noreply address.
- `f31eb92` added notes about the hosted service's sign-in problem and the Google Safe Browsing flag to `docs/notes/dogfood-first-install.md`. They were moved out in the 0.1.0 commit, but stay in the history.
- No secrets: the only private keys in the history are the ten throwaway conformance keys in `conformance/fixtures/keys/`, which are published on purpose.

Then switch, in the browser (Settings → General → Danger Zone → Change visibility → Public) or with:

```bash
gh repo edit posternahq/posterna --visibility public --accept-visibility-change-consequences
```

Afterwards:

- Settings → Code security: turn on private vulnerability reporting, if you want reports through GitHub as well as by email.
- Settings → Actions → General: turn on "Allow GitHub Actions to create and approve pull requests", so the daily directory rebuild can open its pull request.
- Open https://github.com/posternahq/posterna while signed out, and check the links in the README and the install guide.
- The hosted service's "Add a site" page and banners still point to the source-build steps. Switch them back to `npx posterna init` in `posternahq/cloud`.

## 3. Set up trusted publishing

Do this once, after 0.1.0 is on npm and the repository is public. npm adds provenance only for packages built in a public repository.

In GitHub, create the environment the workflow uses: Settings → Environments → New environment → `npm`. Optionally add yourself as a required reviewer, so that every release waits for your approval, and limit it to tags matching `v*`.

On npmjs.com, for each of the five packages (`posterna`, `@posterna/core`, `@posterna/directory`, `@posterna/express`, `@posterna/next`):

1. Open the package page, then **Settings**.
2. Under **Trusted Publisher**, choose **GitHub Actions** and fill in:
   - Organization or user: `posternahq`
   - Repository: `posterna`
   - Workflow filename: `release.yml`
   - Environment name: `npm`
3. Save. npm asks for your second factor.
4. Under **Publishing access**, choose **Require two-factor authentication and disallow tokens**, and save. Trusted publishing keeps working; tokens stop.

## 4. Later releases

1. Pull requests that change a published package include a changeset (`pnpm changeset`).
2. To release, on an up-to-date `main`:

   ```bash
   pnpm changeset version
   git diff
   pnpm install
   git add -A
   git commit -m "Release vX.Y.Z"
   git push
   ```

   `changeset version` moves all five packages to the same new version and writes their changelogs. Read the diff before committing.
3. Tag and push:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

4. In the Actions tab, approve the run if the `npm` environment requires it. The workflow checks that every package's version matches the tag, runs the checks and the tests, and publishes.
5. Check that https://www.npmjs.com/package/@posterna/core shows the new version with a provenance badge.

If the workflow fails partway, fix the cause and re-run it. Versions already on npm are skipped.
