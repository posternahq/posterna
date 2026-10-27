# Releasing

Releases are cut by a maintainer. Contributors add a changeset to their pull request (`pnpm changeset`) and never publish.

Five packages are published: `posterna` (the CLI), `@posterna/core`, `@posterna/directory`, `@posterna/express` and `@posterna/next`. They share one version (a Changesets `fixed` group), and each release has one tag, `vX.Y.Z`.

The first release, 0.1.0, is published by hand, because npm lets you set up trusted publishing only for a package that already exists. Every later release is published by `.github/workflows/release.yml` when you push a version tag: no npm token, and a provenance statement on every package.

## Before the first publish

Check these once:

- Your npm account has two-factor authentication on, for authorization and writes (npmjs.com → your avatar → Account → Two-Factor Authentication).
- You are an owner of the npm organization `posterna` (https://www.npmjs.com/settings/posterna/members). The scoped packages publish into it.
- You maintain the unscoped `posterna` package. It exists already, holding the placeholder versions `0.0.0-stage` and `0.0.1`; 0.1.0 becomes its `latest`.
- Mail to hello@posterna.com reaches you. It is the one contact address: SECURITY.md, the README, CONTRIBUTING.md, the code of conduct and posterna.com all give it.

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

Two settings on each package. Lock down publishing access right after 0.1.0 is on npm. Add the trusted publisher on the day you push the next release tag: npm expires a new trusted publisher that has not completed a publish within 2 days, and a workflow run that publishes nothing does not count. npm adds provenance only for packages built in a public repository.

The five packages' settings pages:

- https://www.npmjs.com/package/posterna/access
- https://www.npmjs.com/package/@posterna/core/access
- https://www.npmjs.com/package/@posterna/directory/access
- https://www.npmjs.com/package/@posterna/express/access
- https://www.npmjs.com/package/@posterna/next/access

### Publishing access (right after 0.1.0)

On each settings page:

1. Under **Publishing access**, select **Require two-factor authentication and disallow tokens**.
2. Click **Update Package Settings**, and confirm with your second factor.

Access tokens can then no longer publish. Your own `npm publish` with your second factor still works, and so does trusted publishing, which does not use tokens.

### The GitHub environment (once)

The workflow publishes from the GitHub environment `npm`.

1. Open https://github.com/posternahq/posterna/settings/environments and click **New environment**. Name it `npm` and click **Configure environment**.
2. Optional: under **Required reviewers**, add yourself and click **Save protection rules**. Every release then waits for your approval in the Actions tab.
3. Under **Deployment branches and tags**, choose **Selected branches and tags**, click **Add deployment branch or tag rule**, set the type to **Tag** and the pattern to `v*`, and click **Add rule**.

### The trusted publisher (just before the next release)

On each settings page:

1. Under **Trusted Publisher**, in **Select your publisher**, click **GitHub Actions**.
2. Fill in the form exactly; every field is case-sensitive:
   - **Organization or user**: `posternahq`
   - **Repository**: `posterna`
   - **Workflow filename**: `release.yml` (the file name only, without `.github/workflows/`)
   - **Environment name**: `npm`
3. Under **Allowed actions**, turn on publishing directly with `npm publish`. The workflow publishes directly; staged publishing (`npm stage publish`) is always allowed but is not what it runs. Leave dist-tag changes off.
4. Click **Add trusted publisher**, and confirm with your second factor.

npm does not check the form when you save it; a mistake shows up as a failed publish. If a trusted publisher expires before its first publish, delete it and add it again. An existing one cannot be edited, only deleted and added again.

## 4. Later releases

For the first release from the workflow, add the trusted publishers (section 3) on the same day, before you push the tag.

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

4. In the Actions tab, approve the run if the `npm` environment requires it. The workflow checks that every package's version matches the tag, runs the checks and the tests, and publishes. The Publish step's log shows a provenance statement being signed and a `+ name@version` line for each package.
5. Check that https://www.npmjs.com/package/@posterna/core shows the new version with a provenance badge.

If the workflow fails partway, fix the cause and re-run it. Versions already on npm are skipped. A failure in the Publish step that mentions authentication or OIDC usually means a trusted publisher field does not match (check each one, and the environment name) or the trusted publisher expired.
