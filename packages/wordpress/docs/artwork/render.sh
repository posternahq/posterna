#!/bin/bash
# Renders the WordPress.org plugin page artwork (banners and icons) from
# banner.html and icon.html into ../../.wordpress-org, at the exact sizes
# WordPress.org asks for. Needs Google Chrome. The fonts are IBM Plex, the
# same files posterna.com uses (SIL Open Font License, fonts/OFL.txt).
#
# The deploy workflow uploads .wordpress-org with each release, so new
# artwork goes public with the next wordpress-v* tag.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../../.wordpress-org"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PROFILE="$(mktemp -d)"
trap 'rm -rf "$PROFILE"' EXIT

shot() { # html, css width, css height, scale, output file
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check \
    --disable-extensions --user-data-dir="$PROFILE" --virtual-time-budget=3000 \
    --force-device-scale-factor="$4" --window-size="$2,$3" --screenshot="$OUT/$5" "file://$HERE/$1" >/dev/null 2>&1
}

shot banner.html 772 250 1 banner-772x250.png
shot banner.html 772 250 2 banner-1544x500.png
shot icon.html 128 128 1 icon-128x128.png
shot icon.html 128 128 2 icon-256x256.png
echo "Wrote the banners and icons to $OUT"
