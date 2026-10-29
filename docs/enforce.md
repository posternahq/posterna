# Switch to enforce

Every install starts in monitor mode: requests are labeled and counted, and nothing is blocked until you change `mode` to `enforce` in `agents.yaml`.

Before you enforce, read [Checks to run against real traffic](notes/real-traffic-checks.md). It lists what the verifier has not yet seen in real traffic, starting with what could cause false `claimed_failed` results, the verdict policies block on, and what to look for in your own counts.

1. **Watch first.** Run in monitor mode for at least a week. Look at the counts for each operator.
   - A high `claimed_failed` share for an operator that should be legitimate usually means its IP list is stale, or your proxy settings are wrong. It rarely means spoofing.
   - Also look at `proxySuspect`, at decisions marked `guarded`, and at the items in [real-traffic-checks.md](notes/real-traffic-checks.md).
2. **Run doctor** against production and fix every failure ([Check with doctor](doctor.md)).
3. **Enforce one rule at a time.**
   - Set `mode: enforce`, and add `monitor: true` to every path rule you are not yet sure of. Those keep recording what they would do.
   - Remove the flags one by one.
   - Leave `unknown_automation` at `allow` unless you have a specific reason.
4. **Keep the guard on.** `guards.search_engines: protect` keeps verified search engines reachable whatever the rules say. It also stops failed search-engine claims from being blocked until this server has seen a verified request from that operator.
5. **Know the kill switches.**
   - Setting `POSTERNA_MODE=monitor` on the server stops all enforcement at the next start.
   - The dashboard can switch a site to monitor remotely. That switch can only turn enforcement off, never on.
   - Posterna also suspends enforcement on its own in two cases: when most requests look internal (a proxy setting is missing), and per operator when half of its IP-checked claims fail (the breaker).

The [policy file reference](policy.md#safety-rails) explains the guard, the breaker, the kill switches and the proxy guard in full.
