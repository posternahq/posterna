# Policy reference: agents.yaml

`agents.yaml` says what a site does with each kind of agent traffic. The verifier labels every request (docs/SPEC.md section 4); the policy engine in `@posterna/core` turns that label into a decision. This page is the full reference. The short version is docs/SPEC.md section 5, and the machine-readable one is the JSON Schema at `packages/core/src/schema/agents.schema.json`.

Every install starts in monitor mode. Nothing is blocked until the file says `mode: enforce`.

## Example

```yaml
version: 1
mode: monitor              # monitor | enforce
defaults:                  # by verdict class; people are always allowed and not configurable
  verified: allow
  declared_unverifiable: allow
  claimed_failed: allow
  unknown_automation: allow
guards:
  search_engines: protect  # protect | off
purposes:                  # applies to every operator
  training: block
operators:
  openai:
    agent: { action: throttle, rate: 60/min }
paths:
  "/api/*":
    claimed_failed: block
    monitor: true          # this rule records what it would do even when mode is enforce
signup:                    # recommendations returned by decide(); the application acts on them
  "/signup":
    verified: lift
    claimed_failed: challenge
    unknown_automation: challenge
emit: [robots.txt, content-signals]
```

## Keys

| Key | Required | Default | What it holds |
|---|---|---|---|
| `version` | yes | | Always `1`. |
| `mode` | no | `monitor` | `monitor` records decisions without acting on them; `enforce` acts on them. |
| `defaults` | no | everything allowed | An action per verdict class: `verified` (by signature or IP), `declared_unverifiable`, `claimed_failed`, `unknown_automation`. `human` is not a key: people are always allowed. |
| `guards.search_engines` | no | `protect` | `protect` or `off`. See [Search-engine guard](#search-engine-guard). `off` must be written out. |
| `purposes` | no | none | An action per purpose: `training`, `search`, `user_fetch`, `agent`, `preview`, `ads`, `other`. Applies to every operator. |
| `operators` | no | none | Directory slug, then an action per purpose, for that operator only. A slug not in the operator directory gets a warning from `posterna policy check`. |
| `paths` | no | none | Path pattern, then an action per verdict class or purpose, plus `monitor: true` to record the rule's actions without enforcing them. |
| `signup` | no | none | Path pattern, then a sign-up recommendation per verdict class. |
| `emit` | no | nothing | What `posterna robots` writes: `robots.txt` (groups for crawlers) and `content-signals`. |

An empty section (`paths:` with nothing under it) is the same as leaving it out.

## Actions

Page and API traffic, applied by the middleware:

- `allow`.
- `block`: a 403 response.
- `throttle`: allowed up to a rate, then a 429 response with `Retry-After`. Written as `{ action: throttle, rate: 60/min }`.

`allow` and `block` can be written as a bare word or as `{ action: block }`.

Sign-up scopes, returned to the application and never applied by the middleware:

- `lift`: skip a friction step (for example an email confirmation) for this request.
- `cap`: apply the application's own limits.
- `challenge`: hand the request to the application's existing CAPTCHA or similar. Posterna never builds a challenge of its own.
- `allow`: no recommendation.

### Rates

`N/sec`, `N/min` or `N/hour`, where N is a whole number from 1 to 1,000,000. Spaces around the slash are allowed.

Each throttle rule keeps a token bucket per operator, in memory, per instance (there is no shared store across instances in v1). A bucket holds N tokens and refills continuously at N per period, so `60/min` allows a burst of 60 and then one request a second. Requests without an operator (for example `unknown_automation`) share one bucket per rule. Two rules that throttle the same operator have separate buckets.

- Within the rate, the decision is `allow` with the throttle rule named, so the record shows which rule let it through.
- Over the rate, the decision is `throttle` with `retryAfter`: the whole seconds until the bucket has a token again, rounded up, at least 1.
- In monitor mode the bucket still counts, so the record shows what enforcement would do.

At most 10,000 buckets are kept; the least recently used is dropped first and starts full if it comes back.

## Path patterns

- A pattern starts with `/` and is matched against the request path without its query string. Matching is case-sensitive.
- `*` matches any run of characters, including `/` and nothing at all: `/api/*` covers `/api/`, `/api/users` and `/api/v1/users/7`, but not `/api`.
- A pattern without `*` matches that exact path only.
- Patterns cannot contain `?`, `#` or spaces.

When several patterns match, the most specific wins:

1. An exact pattern beats any pattern with a wildcard.
2. Otherwise, the pattern with more literal (non-`*`) characters wins: `/api/admin/*` beats `/api/*`, and `/api/*/users` beats `/api/v1/*`.
3. Then the pattern with fewer wildcards.
4. Then the pattern written first in the file.

The same rule picks the sign-up scope.

## How a decision is made

`decide(result, { path, kind })` follows docs/SPEC.md section 5.3:

1. **Suspensions.** If the local kill switch is on, the remote override is on, the proxy guard suspects a misconfigured proxy, or the breaker is tripped for the claimed operator, the decision is still worked out but recorded as not enforced.
2. **Humans** are allowed. Always.
3. **Guards.** A verified search engine is allowed (see below).
4. **Path rules**, most specific first. In each matching rule, the verdict class key is checked first, then the purpose key; the first rule with a key that applies decides. A more specific rule without an applicable key passes the request on to the next one.
5. **The operator rule** for the claimed purpose.
6. **The `purposes` rule.**
7. **`defaults`** for the verdict class.

If nothing applies, the request is allowed with no rule named.

The class key beats the purpose key within a path rule so that a failed claim cannot borrow the allowance its claimed purpose has. For example, with `"/api/*": { claimed_failed: block, training: allow }`, a real crawler that trains is allowed and a request that only claims to be one is blocked.

Operator and purpose rules come before `defaults`, so they apply to unverified and failed claims too. With `defaults: { claimed_failed: block }` and `purposes: { search: allow }`, a request that falsely claims to be a search crawler is allowed by the purpose rule. `posterna policy check` warns about this. To act on failed claims everywhere, put the class rule on a path: `"/*": { claimed_failed: block }`.

### unknown_automation

Automated requests that claim no known agent have no operator or purpose, so only rules that name `unknown_automation` act on them: `defaults.unknown_automation` or a path rule's `unknown_automation` key. No template sets it to anything but `allow`.

### Sign-up decisions

With `kind: "signup"`, only the `signup` section is used. The most specific matching scope's key for the verdict class gives the recommendation; people, classes with no key, and paths with no scope get `allow`. Purposes, operators and path rules are not consulted.

### What a decision contains

```ts
type Decision = {
  action: "allow" | "block" | "throttle" | "lift" | "cap" | "challenge";
  enforced: boolean;
  rule?: string;        // for example "paths./api/*.claimed_failed" or "operators.openai.agent"
  reason: string;       // plain English, for logs and the debug route
  retryAfter?: number;  // seconds, when action is throttle
  guarded?: boolean;    // true when the search-engine guard turned a block or throttle into allow
  error?: string;       // set when the engine failed open
};
```

`enforced` is true only when something should happen: the middleware sends a block or throttle response, or the application should act on a sign-up recommendation. It is false for every `allow`, and for any action recorded as "would have": in monitor mode, under a rule with `monitor: true`, or during a suspension.

Rule names: `human`, `guards.search_engines`, `paths.<pattern>.<key>`, `operators.<slug>.<purpose>`, `purposes.<purpose>`, `defaults.<class>`, `signup.<pattern>.<class>`.

`decide()` never throws. If anything goes wrong inside it, the decision is `allow`, not enforced, with `error` set, and the error count goes up.

## Responses

`enforcementResponse(decision, result)` returns the response for an enforced block or throttle, and null for everything else (including sign-up recommendations).

Block, status 403:

```text
Content-Type: text/plain; charset=utf-8
Cache-Control: no-store
X-Posterna-Action: block

This site's policy does not allow this agent ({operator}, {purpose}). Operators can get verified at https://posterna.com/operators
```

Throttle, status 429:

```text
Content-Type: text/plain; charset=utf-8
Cache-Control: no-store
X-Posterna-Action: throttle
Retry-After: {n}

Rate limited by this site's agent policy. Retry after {n} seconds.
```

`{operator}` is the directory slug and `{purpose}` the directory purpose; either is `unknown` when the request has none. Nothing from the request appears in a response. `Cache-Control: no-store` keeps a shared cache from serving one agent's refusal to anyone else.

## Safety rails

### Search-engine guard

With `guards.search_engines: protect` (the default), an agent the directory flags `search_engine` is never blocked or throttled when verified, whatever the rules say.

A `claimed_failed` or `declared_unverifiable` claim of a protected agent is blocked or throttled only if this instance has seen a verified request from the same operator within the past 7 days and the operator's breaker is not tripped. Otherwise the decision is downgraded to `allow`, named `guards.search_engines`, marked `guarded`, and counted. This keeps a site in search results when its proxy setup, a stale IP list or a missing DNS resolver makes a real search crawler fail verification.

A claim that names an operator but no agent is protected when any of that operator's agents is a search engine. An engine created without a verifier cannot look up the directory, so it protects every claim that names an operator.

`guards.search_engines: off` turns all of this off, and must be written explicitly.

### Breaker

For each operator, the engine counts conclusive IP and reverse DNS outcomes (`verified_by_ip` and `claimed_failed` with method `ip` or `rdns`) in one-minute slots over the last 10 minutes. With at least 20 such claims and half or more of them `claimed_failed`, the breaker trips: every decision about that operator's claims is recorded as not enforced for 60 minutes. Counting goes on while it is tripped, so if failures are still at half or more when the hour ends it trips again at once.

Only page decisions count, so a request decided as a page and again as a sign-up counts once. Failed signatures do not count: they are cryptographic failures, not stale lists.

### Kill switches

- **Local:** `POSTERNA_MODE=monitor` in the environment puts the install in monitor mode. It is read when the engine is created, ignores case and spaces, and no value of it can turn enforcement on.
- **Remote:** the ingest response's `modeOverride` (docs/SPEC.md section 7) is passed to `engine.setRemoteOverride()`. `"monitor"` turns monitor on and `null` turns it off; anything else, `"enforce"` included, is refused. If the cloud cannot be reached, nothing changes.

### Proxy guard

While the verifier's proxy guard suspects a misconfigured proxy (docs/SPEC.md section 4.2), nothing is enforced.

## State

`engine.state()` gives what the counters client reports:

| Field | Meaning |
|---|---|
| `mode` | `enforce` only when agents.yaml says so and neither kill switch is on. |
| `configuredMode` | The mode written in agents.yaml. |
| `suspensions` | Install-wide suspensions in effect: `env`, `remote`, `proxy`. |
| `remoteOverride` | `"monitor"` or null. |
| `proxySuspect` | From the verifier's proxy guard. |
| `breakerTripped` | Operators whose breaker is tripped now. |
| `guarded` | Decisions the search-engine guard downgraded since the engine started. |
| `errors` | Fail-open paths taken by the engine and its verifier. |
| `directoryVersion`, `keysVersion` | From the verifier. |
| `policyHash` | `sha256-` and 16 hex characters of the parsed policy, so formatting and comments do not change it. Null for a moment after start while it is computed. |

## API

```ts
import { createPolicyEngine, createVerifier, enforcementResponse } from "@posterna/core";

const verifier = createVerifier();
const engine = createPolicyEngine(readFileSync("agents.yaml", "utf8"), { verifier });

const result = await verifier.verify(request, { remoteAddress });
const decision = engine.decide(result, { path: url.pathname });
const response = enforcementResponse(decision, result); // null: let the request through
```

- `createPolicyEngine(policy, { verifier, env, now })` takes agents.yaml text or a parsed policy. It throws `PolicyError` for an invalid file; adapters catch it, report it, and allow everything.
- `checkPolicy(text, { knownOperators })` validates without throwing and returns `{ policy, errors, warnings }`. Each issue has a message, a dotted path, and a line and column. `posterna policy check` uses it.
- `parsePolicy(text)` returns the policy or throws `PolicyError` listing every error, each starting `line N, column M:`.
- `policyFromObject(value)` validates a policy that was already parsed, for runtimes that bundle agents.yaml as JSON.
- `emitRobots(policy, operators)` writes robots.txt (below).

## Templates

`@posterna/core/templates/<name>.yaml`, all starting with `mode: monitor`:

- `monitor`: everything allowed.
- `allow-list`: training blocked, everything else allowed.
- `saas-signup`: allow-list, plus a `/signup` scope that lifts friction for verified agents and challenges `claimed_failed` and `unknown_automation`.

## robots.txt and Content Signals

`posterna robots` prints what `emitRobots()` writes. With `emit: [robots.txt]`:

- One group per robots.txt token, for agents whose operator says they honor robots.txt, in sections by purpose. Tokens that get the same lines share a group.
- The lines are the rules that apply to the agent when it is verified: the operator, purpose and `defaults.verified` rules give `Disallow: /` or nothing, and path rules add `Allow` or `Disallow` lines where they differ from what already covers them. robots.txt picks the longest matching path, which matches the engine's specificity. An exact pattern ends in `$`; a trailing `*` is dropped.
- Agents the policy allows everywhere get no group. With the guard on, search engines get none either. Throttle cannot be said in robots.txt, so it counts as allow.
- The file states the policy's rules whatever the mode: it is the site's stated preference, which crawlers apply themselves.

With `emit: [content-signals]`, the `User-agent: *` group gets [Content Signals](https://contentsignals.org/): `purposes.training` sets `ai-train`, `purposes.search` sets `search`, and `purposes.user_fetch` sets `ai-input`. Block means `no`; allow and throttle mean `yes`; a purpose with no rule sends no signal, which means no preference. Path rules with those purpose keys add path-scoped lines such as `Content-Signal: /news/ ai-train=yes`. Posterna writes only the signal lines and a pointer to contentsignals.org, not a legal statement on the site's behalf.

Agents that do not honor robots.txt are left to the policy engine.
