#!/usr/bin/env bash
# End-to-end tests of the plugin in a real WordPress site (wp-env, Docker).
#
# Covers activation on a clean site, labeling of browser, curl, spoofed
# crawler and forged-header requests, the counters and admin tables, the
# dashboard widget, settings, sign-ups (WordPress and WooCommerce), directory
# updates from posterna.com, the counters connection against a mock ingest
# server, failing open when posterna.com is unreachable or the bundled data
# is corrupt, deactivation and uninstall.
#
# Usage: bin/test-wp.sh            (PHP 8.0, the minimum)
#        WP_ENV_PHP_VERSION=8.4 bin/test-wp.sh
# Set POSTERNA_E2E_LIVE=0 to skip the one test that downloads from posterna.com.
set -uo pipefail

cd "$(dirname "$0")/.."
export WP_ENV_PHP_VERSION="${WP_ENV_PHP_VERSION:-8.0}"
WPENV="node_modules/.bin/wp-env"
URL="http://localhost:${WP_ENV_PORT:-8888}"
WORK="$(mktemp -d)"
INGEST_PORT=8791
BROWSER='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
GOOGLEBOT='Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
GPTBOT='Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.3; +https://openai.com/gptbot)'
passed=0
failed=0
failures=()

ok() { passed=$((passed + 1)); echo "  ok   $1"; }
bad() { failed=$((failed + 1)); failures+=("$1"); echo "  FAIL $1${2:+: $2}"; }
expect() { # name, actual, expected
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "got '$2', expected '$3'"; fi
}
expect_match() { # name, actual, regex
  if [[ "$2" =~ $3 ]]; then ok "$1"; else bad "$1" "got '$2', expected to match '$3'"; fi
}
wp() { "$WPENV" run cli wp "$@" 2>/dev/null | tr -d '\r'; }
sql() { wp db query "$1" --skip-column-names; }
json() { python3 -I -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1], {'d': d}))" "$1"; }
echo_req() { curl -s --max-time 20 "$@" "$URL/?posterna_echo=1"; }

echo "== PHP $WP_ENV_PHP_VERSION: build and start"
bash bin/build-zip.sh >/dev/null
"$WPENV" start >/dev/null 2>&1 || { "$WPENV" start; exit 1; }
"$WPENV" clean development >/dev/null 2>&1
wp plugin activate woocommerce plugin-check >/dev/null
"$WPENV" run cli sh -c ': > wp-content/debug.log' >/dev/null 2>&1
expect "PHP version in the container" "$(wp eval 'echo PHP_MAJOR_VERSION . "." . PHP_MINOR_VERSION;')" "$WP_ENV_PHP_VERSION"

echo "== Activation on a clean site"
expect "plugin activates" "$(wp plugin activate posterna >/dev/null && wp plugin is-active posterna && echo yes)" "yes"
expect "counter table exists" "$(sql "SHOW TABLES LIKE 'wp_posterna_counts'")" "wp_posterna_counts"
expect "version recorded" "$(wp option get posterna_version)" "1.0.0"
expect "directory compiled" "$(wp eval 'echo Posterna\Plugin::instance()->store()->index()->directory_version();')" "$(python3 -I -c 'import json;print(json.load(open("data/directory.json"))["version"])')"
expect "daily event scheduled" "$(wp cron event list --hook=posterna_daily --format=count)" "1"
expect "no hourly event while updates are off" "$(wp cron event list --hook=posterna_hourly --format=count)" "0"
expect "no send event without a site key" "$(wp cron event list --hook=posterna_send_counts --format=count)" "0"

echo "== Labeling"
out=$(echo_req -A "$BROWSER" -H 'Accept: text/html' -H 'Accept-Language: en-US')
expect "browser is human" "$(echo "$out" | json "d['verdict']['verdict']")" "human"
expect "posterna_verdict fired once" "$(echo "$out" | json "d['fired']")" "1"
expect "X-Agent-Verdict passed on" "$(echo "$out" | json "d['server'].get('HTTP_X_AGENT_VERDICT')")" "human"
out=$(echo_req)
expect "curl is unknown automation" "$(echo "$out" | json "d['verdict']['verdict'] + ' ' + d['verdict']['reason']")" "unknown_automation non_browser_user_agent"
out=$(echo_req -A "$BROWSER" -H 'Accept: text/html' -H 'Accept-Language: en' -H 'X-Agent-Verdict: verified_by_signature' -H 'X-Agent-Operator: google' -H 'X-Posterna-Action: allow')
expect "forged headers stripped" "$(echo "$out" | json "','.join(d['stripped'])")" "x-agent-operator,x-agent-verdict,x-posterna-action"
expect "forged verdict replaced" "$(echo "$out" | json "d['server'].get('HTTP_X_AGENT_VERDICT')")" "human"
expect "forged operator removed" "$(echo "$out" | json "d['server'].get('HTTP_X_AGENT_OPERATOR')")" "None"
# The official WordPress image runs Apache's mod_remoteip, which takes X-Forwarded-For from
# private addresses (the Docker gateway these requests come from) and rewrites REMOTE_ADDR.
# Address-forging tests therefore use headers Apache leaves alone.
out=$(echo_req -A "$GPTBOT" -H 'X-Real-IP: 20.171.207.10' -H 'CF-Connecting-IP: 20.171.207.10')
expect "spoofed GPTBot fails (forged address headers ignored)" "$(echo "$out" | json "d['verdict']['verdict'] + ' ' + d['verdict']['reason'] + ' ' + d['verdict']['operator']")" "claimed_failed outside_ip_list openai"
out=$(echo_req -A "$GOOGLEBOT" -H 'X-Real-IP: 66.249.66.1')
expect "spoofed Googlebot waits for reverse DNS" "$(echo "$out" | json "d['verdict']['verdict'] + ' ' + d['verdict']['reason']")" "declared_unverifiable rdns_pending"
expect "a lookup was queued" "$(wp option get posterna_rdns_queue --format=json | json 'len(d)')" "1"
wp cron event run posterna_rdns >/dev/null
out=$(echo_req -A "$GOOGLEBOT" -H 'X-Real-IP: 66.249.66.1')
expect_match "spoofed Googlebot fails after the lookup" "$(echo "$out" | json "d['verdict']['verdict'] + ' ' + d['verdict']['reason']")" "^claimed_failed rdns_(unconfirmed|mismatch)$"
out=$(echo_req -A "$GOOGLEBOT" -H 'X-Forwarded-For: 66.249.66.1')
expect "Googlebot from Google's published range is verified (address set by mod_remoteip)" "$(echo "$out" | json "d['verdict']['verdict'] + ' ' + d['verdict']['method']")" "verified_by_ip ip"
for i in 1 2 3 4 5; do echo_req -A "$BROWSER" -H 'Accept: text/html' -H 'Accept-Language: en' >/dev/null; done
curl -s -o /dev/null -A "$BROWSER" -H 'Accept: text/html' -H 'Accept-Language: en' "$URL/2026/10/a-post/"
curl -s -o /dev/null -A "$GPTBOT" "$URL/feed/"
timing() { # label, curl args...
  local label=$1; shift
  local ms
  ms=$(for i in $(seq 1 30); do echo_req "$@" | json "d['ms']"; done | sort -n | python3 -I -c "import sys; v=[float(x) for x in sys.stdin]; print('median %.3f ms, p90 %.3f ms, max %.3f ms' % (v[len(v)//2], v[int(len(v)*0.9)], v[-1]))")
  echo "  info $label: $ms" | tee -a "build/timing-php$WP_ENV_PHP_VERSION.txt"
}
rm -f "build/timing-php$WP_ENV_PHP_VERSION.txt"
echo "  info check time measured inside 30 live requests each:"
timing "browser" -A "$BROWSER" -H 'Accept: text/html' -H 'Accept-Language: en'
timing "curl" -A 'curl/8.7.1'
timing "Googlebot from Google (verified_by_ip)" -A "$GOOGLEBOT" -H 'X-Forwarded-For: 66.249.66.1'
timing "spoofed GPTBot (claimed_failed)" -A "$GPTBOT"
timing "spoofed Googlebot, cached reverse DNS (claimed_failed)" -A "$GOOGLEBOT"

echo "== Counters"
expect_match "human counted" "$(sql "SELECT SUM(hits) FROM wp_posterna_counts WHERE kind='page' AND verdict='human'")" "^([8-9]|[1-9][0-9]+)$"
expect_match "claimed_failed counted" "$(sql "SELECT SUM(hits) FROM wp_posterna_counts WHERE kind='page' AND verdict='claimed_failed'")" "^[0-9]+$"
expect "path groups masked" "$(sql "SELECT COUNT(*) FROM wp_posterna_counts WHERE path_group='/:id/*'")" "1"
expect "feed grouped" "$(sql "SELECT COUNT(*) FROM wp_posterna_counts WHERE path_group='/feed/*' AND operator='openai'")" "1"
expect "no addresses stored" "$(sql "SELECT COUNT(*) FROM wp_posterna_counts WHERE CONCAT(operator, agent, path_group, reason) REGEXP '[0-9]+\\\\.[0-9]+\\\\.[0-9]+\\\\.[0-9]+'")" "0"

echo "== Admin"
JAR="$WORK/cookies"
curl -s -o /dev/null -c "$JAR" -b 'wordpress_test_cookie=WP%20Cookie%20check' --data-urlencode 'log=admin' --data-urlencode 'pwd=password' --data-urlencode 'testcookie=1' "$URL/wp-login.php"
page() { curl -s -b "$JAR" "$URL/wp-admin/admin.php?page=posterna&tab=$1"; }
# The first admin visit after activating WooCommerce may redirect to its setup wizard.
curl -s -o /dev/null -b "$JAR" "$URL/wp-admin/"
page overview >/dev/null
expect_match "overview table" "$(page overview | grep -c 'Claimed, failed the check')" "^[1-9]"
expect_match "setup panel before settings are saved" "$(page overview | grep -c 'Set up Posterna')" "^[1-9]"
expect_match "agents table lists GPTBot" "$(page agents | grep -c 'GPTBot')" "^[1-9]"
expect_match "paths table" "$(page paths | grep -c '/feed/\*')" "^[1-9]"
expect_match "check my setup" "$(page check | grep -c 'How your own request was seen')" "^[1-9]"
expect_match "dashboard widget" "$(curl -s -b "$JAR" "$URL/wp-admin/index.php" | grep -c 'Posterna: last 24 hours')" "^[1-9]"
settings=$(page settings)
nonce=$(echo "$settings" | sed -n 's/.*name="_wpnonce" value="\([^"]*\)".*/\1/p' | head -1)
curl -s -o /dev/null -b "$JAR" --data-urlencode "_wpnonce=$nonce" --data-urlencode 'option_page=posterna' --data-urlencode 'action=update' \
  --data-urlencode '_wp_http_referer=/wp-admin/admin.php?page=posterna&tab=settings' \
  --data-urlencode 'posterna_settings[client_ip]=remote_addr' --data-urlencode 'posterna_settings[template]=allow-list' "$URL/wp-admin/options.php"
expect "settings saved through the form" "$(wp option get posterna_settings --format=json | json "d['template'] + ' ' + str(d['setup_done'])")" "allow-list True"
expect_match "robots.txt suggests blocking GPTBot" "$(page robots | grep -c 'User-agent: GPTBot')" "^[1-9]"
expect "form without a nonce is refused" "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" --data-urlencode 'option_page=posterna' --data-urlencode 'action=update' --data-urlencode 'posterna_settings[template]=monitor' "$URL/wp-admin/options.php")" "403"
expect "logged-in admin requests are not counted" "$(sql "SELECT COUNT(*) FROM wp_posterna_counts WHERE path_group='/wp-admin/*'")" "0"

echo "== Sign-ups"
wp option update users_can_register 1 >/dev/null
curl -s -o /dev/null -A 'python-requests/2.32' --data-urlencode 'user_login=signupbot' --data-urlencode 'user_email=signupbot@example.com' --data-urlencode 'wp-submit=Register' "$URL/wp-login.php?action=register"
expect "WordPress registration created" "$(wp user get signupbot --field=user_login)" "signupbot"
expect "WordPress sign-up counted by verdict" "$(sql "SELECT verdict FROM wp_posterna_counts WHERE kind='signup' AND path_group='/wp-login.php'")" "unknown_automation"
wp option update woocommerce_enable_myaccount_registration yes >/dev/null
wp option update woocommerce_registration_generate_password yes >/dev/null
wp option update woocommerce_registration_generate_username yes >/dev/null
account=$(wp eval 'echo get_permalink( wc_get_page_id( "myaccount" ) );' | sed "s#^http://localhost:8888#$URL#")
WCJAR="$WORK/wc"
form=$(curl -s -c "$WCJAR" -A "$BROWSER" -H 'Accept: text/html' -H 'Accept-Language: en' "$account")
wcnonce=$(echo "$form" | sed -n 's/.*name="woocommerce-register-nonce" value="\([^"]*\)".*/\1/p' | head -1)
curl -s -o /dev/null -b "$WCJAR" -c "$WCJAR" -A "$BROWSER" -H 'Accept: text/html' -H 'Accept-Language: en' \
  --data-urlencode 'email=customer@example.com' --data-urlencode "woocommerce-register-nonce=$wcnonce" --data-urlencode 'register=Register' "$account"
expect "WooCommerce customer created" "$(wp user get customer@example.com --field=user_email 2>/dev/null)" "customer@example.com"
expect "WooCommerce sign-up counted by verdict" "$(sql "SELECT verdict FROM wp_posterna_counts WHERE kind='signup' AND verdict='human'")" "human"
expect_match "sign-ups tab" "$(page signups | grep -c 'Sign-ups by verdict')" "^[1-9]"

echo "== Connection to posterna.com (mock ingest server)"
INGEST_LOG="$WORK/ingest.jsonl"
python3 -I tests/wp/mock-ingest.py "$INGEST_PORT" "$INGEST_LOG" &
INGEST_PID=$!
sleep 1
wp config set POSTERNA_BASE_URL "http://host.docker.internal:$INGEST_PORT/v1/" --type=constant >/dev/null
wp option patch update posterna_settings site_key "psk_$(python3 -I -c 'print("A" * 43)')" >/dev/null
wp eval 'Posterna\Plugin::sync_schedules();' >/dev/null
expect "send event scheduled with a site key" "$(wp cron event list --hook=posterna_send_counts --format=count)" "1"
wp cron event run posterna_send_counts >/dev/null
kill "$INGEST_PID" 2>/dev/null
if [ -s "$INGEST_LOG" ]; then
  first=$(head -1 "$INGEST_LOG")
  expect "payload schema and sdk" "$(echo "$first" | json "str(d['body']['schema']) + ' ' + d['body']['sdk']['name'] + ' ' + d['body']['mode']")" "1 posterna-wordpress monitor"
  expect "bearer site key" "$(echo "$first" | json "d['authorization'][:11]")" "Bearer psk_"
  expect "gzip body" "$(echo "$first" | json "d['content_encoding']")" "gzip"
  expect "no IPs, URLs or emails in the payload" "$(echo "$first" | python3 -I -c "import re,sys; t=sys.stdin.read(); print(bool(re.search(r'\d+\.\d+\.\d+\.\d+|https?://|@example', t)))")" "False"
  echo "$first" | python3 -I -c "import json,sys; print(json.dumps(json.load(sys.stdin)['body']))" > "$WORK/payload.json"
  if [ -d ../../../cloud/node_modules ]; then
    verdict=$(cd ../../../cloud && node_modules/.bin/tsx -e "import {readFileSync} from 'node:fs'; import {payloadSchema} from './src/server/ingest.ts'; const r = payloadSchema.safeParse(JSON.parse(readFileSync('$WORK/payload.json','utf8'))); console.log(r.success ? 'valid' : JSON.stringify(r.error.issues[0]));" 2>&1 | tail -1)
    expect "cloud ingest schema accepts the payload" "$verdict" "valid"
  else
    echo "  skip cloud schema check (../cloud has no node_modules)"
  fi
  expect "counts marked sent" "$(sql "SELECT COUNT(*) FROM wp_posterna_counts WHERE kind='page' AND hits > sent")" "0"
  expect "remote monitor override recorded" "$(wp option get posterna_state --format=json | json "d.get('remote_override')")" "monitor"
else
  bad "mock ingest received a payload"
fi

echo "== Fail open: posterna.com unreachable"
wp config set POSTERNA_BASE_URL "http://127.0.0.1:9/v1/" --type=constant >/dev/null
wp option patch update posterna_settings updates 1 >/dev/null
wp eval 'Posterna\Plugin::sync_schedules();' >/dev/null
wp cron event run posterna_refresh_now >/dev/null 2>&1 || wp eval 'Posterna\Plugin::instance()->refresh_now();' >/dev/null
echo_req -A "$BROWSER" -H 'Accept: text/html' -H 'Accept-Language: en' >/dev/null
wp cron event run posterna_send_counts >/dev/null
expect "refresh failure recorded, last copy kept" "$(wp option get posterna_state --format=json | json "str(d['refresh']['directory']['ok']) + ' ' + d['refresh']['directory']['error'].split(':')[0]")" "False refreshing directory.json"
expect "send failure recorded" "$(wp option get posterna_state --format=json | json "str(d['send']['ok'])")" "False"
expect "site still serves pages" "$(curl -s -o /dev/null -w '%{http_code}' "$URL/")" "200"
expect "verdicts unchanged" "$(echo_req -A "$GPTBOT" | json "d['verdict']['verdict']")" "claimed_failed"
wp config delete POSTERNA_BASE_URL --type=constant >/dev/null
wp option patch update posterna_settings site_key "" >/dev/null

if [ "${POSTERNA_E2E_LIVE:-1}" = "1" ]; then
  echo "== Directory updates from posterna.com (live, signed)"
  wp eval 'Posterna\Plugin::instance()->refresh_now();' >/dev/null
  state=$(wp option get posterna_state --format=json)
  # directory.json is either newer (updated) or older than the bundled copy (refused as a
  # rollback, which happens only after its signature verified). keys.json changes hourly.
  expect_match "directory.json downloaded and signature-checked" "$(echo "$state" | json "'updated' if d['refresh']['directory']['ok'] else d['refresh']['directory']['error']")" "^(updated|.*version_rollback.*)$"
  expect "keys.json downloaded, verified and used" "$(echo "$state" | json "str(d['refresh']['keys']['ok'])")" "True"
  expect "loaded keys version is the live one" "$(wp eval 'echo Posterna\Plugin::instance()->store()->index()->keys_version();')" "$(curl -s https://posterna.com/v1/keys.json | json "d['version']")"
fi
wp option patch update posterna_settings updates 0 >/dev/null
wp eval 'Posterna\Plugin::sync_schedules();' >/dev/null
expect "hourly event removed when updates are off" "$(wp cron event list --hook=posterna_hourly --format=count)" "0"

echo "== Fail open: corrupt bundled data"
cp build/posterna/data/directory.json "$WORK/directory.json"
printf '{"broken": tru' > build/posterna/data/directory.json
wp option delete posterna_directory >/dev/null
out=$(echo_req -A "$BROWSER" -H 'Accept: text/html' -H 'Accept-Language: en')
expect "browser still human, error set" "$(echo "$out" | json "d['verdict']['verdict'] + ' ' + d['verdict']['reason'] + ' ' + str(bool(d['verdict'].get('error')))")" "human directory_unavailable True"
expect "claimed crawler is never claimed_failed" "$(echo_req -A "$GPTBOT" | json "d['verdict']['verdict']")" "unknown_automation"
expect "site still serves pages" "$(curl -s -o /dev/null -w '%{http_code}' "$URL/")" "200"
expect_match "check my setup warns" "$(page check | grep -c 'could not be loaded')" "^[1-9]"
cp "$WORK/directory.json" build/posterna/data/directory.json
wp eval 'Posterna\Plugin::upgrade();' >/dev/null
expect "directory restored" "$(echo_req -A "$GPTBOT" | json "d['verdict']['verdict']")" "claimed_failed"

echo "== Overhead (warm, in-process, real directory)"
wp eval-file wp-content/posterna-tests/bench.php | tee "$WORK/bench.json" | sed 's/^/  /'
cp "$WORK/bench.json" "build/bench-php$WP_ENV_PHP_VERSION.json"

echo "== Deactivation and uninstall"
wp plugin deactivate posterna >/dev/null
expect "events cleared on deactivation" "$(wp cron event list --format=csv --fields=hook | grep -c '^posterna_')" "0"
expect "data kept on deactivation" "$(sql "SHOW TABLES LIKE 'wp_posterna_counts'")" "wp_posterna_counts"
wp plugin activate posterna >/dev/null
expect "events back on activation" "$(wp cron event list --hook=posterna_daily --format=count)" "1"
wp plugin deactivate posterna >/dev/null
wp plugin uninstall posterna --skip-delete >/dev/null
expect "table removed" "$(sql "SHOW TABLES LIKE 'wp_posterna_counts'")" ""
expect "options and transients removed" "$(sql "SELECT COUNT(*) FROM wp_options WHERE option_name LIKE '%posterna%'")" "0"
expect "no events left" "$(wp cron event list --format=csv --fields=hook | grep -c '^posterna_')" "0"
wp plugin activate posterna >/dev/null

if [ -n "${POSTERNA_E2E_DEBUG_LOG:-}" ]; then
  "$WPENV" run cli cat wp-content/debug.log 2>/dev/null | grep -i posterna | head -20
fi
php_notices=$("$WPENV" run cli sh -c 'cat wp-content/debug.log 2>/dev/null' 2>/dev/null | grep -ci 'posterna' || true)
expect "no PHP notices or warnings from Posterna in debug.log" "$php_notices" "0"

rm -rf "$WORK"
echo
echo "PHP $WP_ENV_PHP_VERSION: $passed passed, $failed failed"
for f in "${failures[@]+"${failures[@]}"}"; do echo "  failed: $f"; done
[ "$failed" -eq 0 ]
