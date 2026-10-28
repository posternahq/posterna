#!/usr/bin/env bash
# Builds dist/posterna-<version>.zip with only the files the plugin needs,
# in a folder named posterna. Also leaves an unzipped copy in build/posterna,
# which wp-env mounts for testing and Plugin Check.
set -euo pipefail

cd "$(dirname "$0")/.."

version=$(sed -n 's/^ \* Version: *//p' posterna.php | tr -d '[:space:]')
stable=$(sed -n 's/^Stable tag: *//p' readme.txt | tr -d '[:space:]')
constant=$(sed -n "s/^define( 'POSTERNA_VERSION', '\(.*\)' );$/\1/p" posterna.php)

if [ -z "$version" ] || [ "$version" != "$stable" ] || [ "$version" != "$constant" ]; then
  echo "Version mismatch: header '$version', readme Stable tag '$stable', POSTERNA_VERSION '$constant'." >&2
  exit 1
fi

if grep -q '^Contributors: WPORG_USERNAME' readme.txt; then
  echo "Warning: readme.txt still says 'Contributors: WPORG_USERNAME'." >&2
  echo "Replace it with your WordPress.org username before you build the zip you submit." >&2
fi

# Empty build/posterna in place rather than recreating it: wp-env mounts this folder,
# and a new folder would leave the running containers looking at the deleted one.
mkdir -p build/posterna dist
find build/posterna -mindepth 1 -delete
cp posterna.php uninstall.php readme.txt LICENSE build/posterna/
cp -R includes assets data build/posterna/
if [ -d languages ] && [ -n "$(ls -A languages)" ]; then
  cp -R languages build/posterna/
fi
find build/posterna \( -name '.DS_Store' -o -name '*.orig' -o -name '*.swp' \) -delete

zip_path="dist/posterna-${version}.zip"
rm -f "$zip_path"
(cd build && zip -rqX "../$zip_path" posterna)

echo "Built $(pwd)/$zip_path ($(du -h "$zip_path" | cut -f1)), $(cd build && find posterna -type f | wc -l | tr -d ' ') files."
