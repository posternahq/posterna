#!/usr/bin/env bash
# Runs the official Plugin Check (PCP) against the built plugin in wp-env,
# the same checks WordPress.org runs on upload. Writes the results to
# build/plugin-check.txt and build/plugin-check.json.
set -uo pipefail

cd "$(dirname "$0")/.."
WPENV="node_modules/.bin/wp-env"

bash bin/build-zip.sh
"$WPENV" start >/dev/null 2>&1 || "$WPENV" start
"$WPENV" run cli wp plugin activate plugin-check posterna >/dev/null 2>&1

run() {
  "$WPENV" run cli wp plugin check posterna --require=./wp-content/plugins/plugin-check/cli.php "$@" 2>/dev/null | tr -d '\r'
}

run --format=table --include-experimental | tee build/plugin-check.txt
run --format=json --include-experimental > build/plugin-check.json
"$WPENV" run cli wp plugin get plugin-check --field=version 2>/dev/null | tr -d '\r' > build/plugin-check-version.txt

errors=$(python3 -I -c "
import json, sys
text = open('build/plugin-check.json').read().strip()
count = 0
for line in text.splitlines():
    line = line.strip()
    if line.startswith('['):
        count += sum(1 for item in json.loads(line) if item.get('type') == 'ERROR')
print(count)
" 2>/dev/null || echo "unknown")
echo "Plugin Check $(cat build/plugin-check-version.txt): $errors errors"
[ "$errors" = "0" ]
