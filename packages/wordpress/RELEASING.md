# Releasing the WordPress plugin

The plugin in `packages/wordpress` is released to the WordPress.org plugin
directory, which hosts plugins in Subversion (SVN). It is not published to npm
and does not use Changesets.

## First submission (once)

1. Create the WordPress.org account `posterna` with the email hello@posterna.com
   (WordPress.org identifies an organization's official plugin mostly by the
   account's email address). `readme.txt` already lists `Contributors: posterna`;
   if the account ends up with another username, change that line to match
   (case-sensitive) and rebuild.
2. Make sure two-factor authentication is on for your WordPress.org account.
   It is required to submit.
3. Build the zip: `pnpm --filter @posterna/wordpress-plugin zip`. It writes
   `packages/wordpress/dist/posterna-<version>.zip` with one folder, `posterna`.
4. Go to https://wordpress.org/plugins/developers/add/, upload the zip, and
   confirm the slug shown is `posterna`. The slug comes from the
   `Plugin Name: Posterna` header. If it shows anything else, do not submit.
5. Wait for the review email (usually 1 to 10 days). Answer from the same
   address; reviews unanswered for 3 months are closed.

## After approval: automatic deploys (once)

WordPress.org gives you an SVN repository at
https://plugins.svn.wordpress.org/posterna/. The workflow
`.github/workflows/wordpress-deploy.yml` copies each release there.

1. Create an SVN password: on WordPress.org, open your profile, then
   Account & Security, then SVN credentials. It is separate from your account
   password.
2. In GitHub, `posternahq/posterna`, Settings, Environments: create an
   environment named `wordpress-org`. Add yourself as a required reviewer.
   Add two environment secrets: `SVN_USERNAME` (your WordPress.org username)
   and `SVN_PASSWORD` (the SVN password from step 1).
3. Settings, Secrets and variables, Actions, Variables: add the repository
   variable `WPORG_DEPLOY_ENABLED` with the value `true`. Until it exists the
   deploy job is skipped.
4. Replace the placeholder images in `packages/wordpress/.wordpress-org/`
   (banners and icons) if you want; the workflow uploads that folder as the
   plugin page's assets.

## Each release

1. Update the version in three places, which must match:
   `Version:` in `posterna.php`, `POSTERNA_VERSION` in `posterna.php`, and
   `Stable tag:` in `readme.txt`. Add a `== Changelog ==` entry.
2. If a new WordPress version is out, test with it and update `Tested up to:`
   in `readme.txt` (major.minor only, for example `7.2`).
3. If the operator directory changed, copy `packages/directory/data/directory.json`
   and `keys.json` into `packages/wordpress/data/`. A unit test fails until
   they match.
4. Run the checks (see `README.md` in this folder): unit tests, PHPCS,
   the wp-env end-to-end run on PHP 8.0 and the latest PHP, and Plugin Check.
5. Commit, then tag and push: `git tag wordpress-v1.0.1 && git push origin wordpress-v1.0.1`.
   Tags for the npm packages are `v*`; WordPress tags are `wordpress-v*`, so
   the two release workflows never pick up each other's tags.
6. Approve the `wordpress-org` environment in the Actions run. The workflow
   checks the tag against the version, builds the zip and commits to SVN
   trunk and a new SVN tag.
7. WordPress.org now scans each release automatically and holds it for a few
   hours before sites see the update.
