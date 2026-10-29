# Install from a source build

<a id="from-source"></a>
<a id="pre-release"></a>

To try changes that are not on npm yet, install the packages from a local build of this repository. These steps were tested with npm 11 on 27 October 2026. Replace `<version>` with the version in each package's `package.json`.

1. Build the packages (Node 20 or later, pnpm 10):

   ```bash
   git clone https://github.com/posternahq/posterna.git
   cd posterna
   pnpm install
   pnpm build
   ```

2. Pack core, the directory and your adapter (`express` or `next`) into a `vendor` folder in your app:

   ```bash
   for p in core directory next; do
     pnpm --filter @posterna/$p pack --pack-destination /path/to/your-app/vendor
   done
   ```

3. In your app's `package.json`, depend on the adapter's tarball, and override core and the directory with theirs:

   ```json
   {
     "dependencies": {
       "@posterna/next": "file:vendor/posterna-next-<version>.tgz"
     },
     "overrides": {
       "@posterna/core": "file:vendor/posterna-core-<version>.tgz",
       "@posterna/directory": "file:vendor/posterna-directory-<version>.tgz"
     }
   }
   ```

   You need both overrides: packing turns the packages' dependencies on each other into plain version numbers, which npm would otherwise fetch from the registry. With pnpm, put the same two entries under `pnpm.overrides`; with Yarn, under `resolutions`. Commit the `vendor` folder, so your host's build can install from it. Vercel keeps `node_modules` between builds, so a new tarball with an unchanged version number is not installed there: redeploy with `vercel deploy --force`, which skips the build cache (seen on 27 October 2026).

4. Install, then check that a clean install works the way your host builds:

   ```bash
   npm install
   rm -rf node_modules && npm ci
   ```

   `npm install` can write a lockfile that `npm ci` rejects (for example `Missing: @emnapi/core from lock file`), and hosts such as Railway build with `npm ci`. If the check fails, restore your previous `package-lock.json` from git, run `npm install` again so that only the new entries are added, and repeat the check.

5. Wherever these docs say `npx posterna`, run the CLI from the same build instead, from your app's folder:

   ```bash
   node /path/to/posterna/packages/cli/dist/bin.js init
   ```

   Skip the `npm install` line that `init` prints: you have installed the packages already.
