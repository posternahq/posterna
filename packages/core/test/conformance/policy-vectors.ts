// Policy vectors for the conformance suite: decide, policy_check and robots.
// Expected decisions and robots.txt output are written here by hand from
// docs/SPEC.md section 5 and docs/policy.md; they are never computed by
// Posterna's policy engine.

const NOW_ISO = "2026-10-26T12:00:00Z";

interface Result {
  verdict: string;
  operator?: string;
  agent?: string;
  purpose?: string;
  method?: string;
}

/** Results as the verifier would label them, for operators in fixtures/directory.json. */
const R = {
  human: { verdict: "human", method: "none" },
  unknown: { verdict: "unknown_automation", method: "none" },
  claudebot: {
    verdict: "verified_by_ip",
    operator: "anthropic",
    agent: "ClaudeBot",
    purpose: "training",
    method: "ip",
  },
  claudebotFailed: {
    verdict: "claimed_failed",
    operator: "anthropic",
    agent: "ClaudeBot",
    purpose: "training",
    method: "ip",
  },
  googlebot: {
    verdict: "verified_by_ip",
    operator: "google",
    agent: "Googlebot",
    purpose: "search",
    method: "rdns",
  },
  googlebotFailed: {
    verdict: "claimed_failed",
    operator: "google",
    agent: "Googlebot",
    purpose: "search",
    method: "rdns",
  },
  googlebotUnverifiable: {
    verdict: "declared_unverifiable",
    operator: "google",
    agent: "Googlebot",
    purpose: "search",
    method: "none",
  },
  googleNews: {
    verdict: "verified_by_ip",
    operator: "google",
    agent: "Googlebot News",
    purpose: "search",
    method: "rdns",
  },
  googleSigned: { verdict: "verified_by_signature", operator: "google", method: "signature" },
  exampleBot: {
    verdict: "verified_by_ip",
    operator: "ip-crawler",
    agent: "ExampleBot",
    purpose: "search",
    method: "ip",
  },
  exampleBotFailed: {
    verdict: "claimed_failed",
    operator: "ip-crawler",
    agent: "ExampleBot",
    purpose: "search",
    method: "ip",
  },
  exampleBotUnverifiable: {
    verdict: "declared_unverifiable",
    operator: "ip-crawler",
    agent: "ExampleBot",
    purpose: "search",
    method: "none",
  },
  rdnsBot: {
    verdict: "verified_by_ip",
    operator: "rdns-crawler",
    agent: "ExampleRdnsBot",
    purpose: "training",
    method: "rdns",
  },
  signer: {
    verdict: "verified_by_signature",
    operator: "example-signer",
    agent: "ExampleAgent",
    purpose: "agent",
    method: "signature",
  },
  signerFailed: {
    verdict: "claimed_failed",
    operator: "example-signer",
    agent: "ExampleAgent",
    purpose: "agent",
    method: "signature",
  },
  signerOperatorOnly: {
    verdict: "declared_unverifiable",
    operator: "example-signer",
    method: "none",
  },
  labelSigner: {
    verdict: "verified_by_signature",
    operator: "label-signer",
    agent: "LabelAgent",
    purpose: "agent",
    method: "signature",
  },
  quiet: {
    verdict: "declared_unverifiable",
    operator: "quiet-operator",
    agent: "QuietBot",
    purpose: "other",
    method: "none",
  },
} satisfies Record<string, Result>;

interface Response {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface Expected {
  action: string;
  enforced: boolean;
  rule: string | null;
  retry_after: number | null;
  guarded: boolean;
  error: boolean;
  response?: Response | null;
}

interface Step {
  at?: number;
  repeat?: number;
  result?: Result | null;
  context?: { path: string; kind?: "page" | "signup" };
  expected?: Expected;
  set_remote_override?: unknown;
  expected_accepted?: boolean;
}

export interface PolicyVector {
  id: string;
  description: string;
  spec: string[];
  type: "decide" | "policy_check" | "robots";
  [key: string]: unknown;
}

const BLOCK_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Posterna-Action": "block",
};

const blocked = (operator: string, purpose: string): Response => ({
  status: 403,
  headers: BLOCK_HEADERS,
  body: `This site's policy does not allow this agent (${operator}, ${purpose}). Operators can get verified at https://posterna.com/operators`,
});

const throttled = (seconds: number): Response => ({
  status: 429,
  headers: {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Posterna-Action": "throttle",
    "Retry-After": String(seconds),
  },
  body: `Rate limited by this site's agent policy. Retry after ${seconds} seconds.`,
});

const allow = (rule: string | null, extra: Partial<Expected> = {}): Expected => ({
  action: "allow",
  enforced: false,
  rule,
  retry_after: null,
  guarded: false,
  error: false,
  ...extra,
});

const act = (
  action: string,
  enforced: boolean,
  rule: string,
  extra: Partial<Expected> = {},
): Expected => ({
  action,
  enforced,
  rule,
  retry_after: null,
  guarded: false,
  error: false,
  ...extra,
});

const guardedAllow = (): Expected =>
  allow("guards.search_engines", { guarded: true, response: null });

const page = (path: string) => ({ path });
const signup = (path: string) => ({ path, kind: "signup" as const });

const yaml = (...lines: string[]) => `${lines.join("\n")}\n`;

const vectors: PolicyVector[] = [];

function decideVector(
  id: string,
  description: string,
  spec: string[],
  policy: string,
  steps: Step[],
  extra: Record<string, unknown> = {},
): void {
  vectors.push({ id, description, spec, type: "decide", now: NOW_ISO, policy, ...extra, steps });
}

// ---------------------------------------------------------------- evaluation order (5.3)

function orderVectors(): void {
  decideVector(
    "policy/order/human-always-allowed",
    "A person is allowed even when every class, purpose, path and sign-up rule blocks or challenges.",
    ["5.3"],
    yaml(
      "version: 1",
      "mode: enforce",
      "defaults:",
      "  verified: block",
      "  declared_unverifiable: block",
      "  claimed_failed: block",
      "  unknown_automation: block",
      "purposes:",
      "  training: block",
      "  search: block",
      "  user_fetch: block",
      "  agent: block",
      "  preview: block",
      "  ads: block",
      "  other: block",
      "paths:",
      '  "/*":',
      "    verified: block",
      "    claimed_failed: block",
      "    unknown_automation: block",
      "signup:",
      '  "/*":',
      "    verified: challenge",
      "    declared_unverifiable: challenge",
      "    claimed_failed: challenge",
      "    unknown_automation: challenge",
    ),
    [
      { result: R.human, context: page("/"), expected: allow("human", { response: null }) },
      { result: R.human, context: signup("/signup"), expected: allow("human", { response: null }) },
      {
        result: R.unknown,
        context: page("/"),
        expected: act("block", true, "paths./*.unknown_automation", {
          response: blocked("unknown", "unknown"),
        }),
      },
    ],
  );

  decideVector(
    "policy/order/path-class-beats-path-purpose",
    "Within one path rule the verdict class key beats the purpose key, so a failed claim cannot borrow its claimed purpose's allow.",
    ["5.3"],
    yaml(
      "version: 1",
      "mode: enforce",
      "purposes:",
      "  training: block",
      "paths:",
      '  "/api/*":',
      "    claimed_failed: block",
      "    training: allow",
      '  "/feed/*":',
      "    verified: allow",
      "    training: block",
    ),
    [
      {
        result: R.claudebotFailed,
        context: page("/api/x"),
        expected: act("block", true, "paths./api/*.claimed_failed"),
      },
      { result: R.claudebot, context: page("/api/x"), expected: allow("paths./api/*.training") },
      {
        result: R.claudebot,
        context: page("/feed/rss"),
        expected: allow("paths./feed/*.verified"),
      },
      {
        result: R.claudebot,
        context: page("/"),
        expected: act("block", true, "purposes.training"),
      },
    ],
  );

  decideVector(
    "policy/order/path-beats-operator",
    "A matching path rule comes before the operator rule.",
    ["5.3"],
    yaml(
      "version: 1",
      "mode: enforce",
      "operators:",
      "  anthropic:",
      "    training: block",
      "paths:",
      '  "/docs/*":',
      "    training: allow",
    ),
    [
      { result: R.claudebot, context: page("/docs/a"), expected: allow("paths./docs/*.training") },
      {
        result: R.claudebot,
        context: page("/blog"),
        expected: act("block", true, "operators.anthropic.training", {
          response: blocked("anthropic", "training"),
        }),
      },
    ],
  );

  decideVector(
    "policy/order/operator-beats-purposes",
    "The operator rule for the purpose comes before the purposes rule.",
    ["5.3"],
    yaml(
      "version: 1",
      "mode: enforce",
      "purposes:",
      "  training: block",
      "operators:",
      "  anthropic:",
      "    training: allow",
    ),
    [
      { result: R.claudebot, context: page("/"), expected: allow("operators.anthropic.training") },
      {
        result: R.rdnsBot,
        context: page("/"),
        expected: act("block", true, "purposes.training", {
          response: blocked("rdns-crawler", "training"),
        }),
      },
    ],
  );

  decideVector(
    "policy/order/purposes-beats-defaults",
    "The purposes rule comes before defaults; a claim with no purpose falls through to defaults.",
    ["5.3"],
    yaml(
      "version: 1",
      "mode: enforce",
      "defaults:",
      "  verified: allow",
      "  declared_unverifiable: block",
      "purposes:",
      "  other: allow",
      "  training: block",
    ),
    [
      { result: R.rdnsBot, context: page("/"), expected: act("block", true, "purposes.training") },
      { result: R.signer, context: page("/"), expected: allow("defaults.verified") },
      { result: R.quiet, context: page("/"), expected: allow("purposes.other") },
      {
        result: R.signerOperatorOnly,
        context: page("/"),
        expected: act("block", true, "defaults.declared_unverifiable", {
          response: blocked("example-signer", "unknown"),
        }),
      },
    ],
  );

  decideVector(
    "policy/order/defaults-by-class",
    "Defaults apply by verdict class when nothing more specific matches.",
    ["5.3"],
    yaml(
      "version: 1",
      "mode: enforce",
      "defaults:",
      "  verified: allow",
      "  declared_unverifiable: { action: throttle, rate: 1/min }",
      "  claimed_failed: block",
      "  unknown_automation: allow",
    ),
    [
      { result: R.signer, context: page("/"), expected: allow("defaults.verified") },
      { result: R.quiet, context: page("/"), expected: allow("defaults.declared_unverifiable") },
      {
        result: R.quiet,
        context: page("/"),
        expected: act("throttle", true, "defaults.declared_unverifiable", {
          retry_after: 60,
          response: throttled(60),
        }),
      },
      {
        result: R.claudebotFailed,
        context: page("/"),
        expected: act("block", true, "defaults.claimed_failed"),
      },
      { result: R.unknown, context: page("/"), expected: allow("defaults.unknown_automation") },
    ],
  );

  decideVector(
    "policy/order/no-rule",
    "With no rule for the request, the decision is allow with no rule.",
    ["5.3"],
    yaml("version: 1", "mode: enforce"),
    [
      { result: R.claudebotFailed, context: page("/"), expected: allow(null, { response: null }) },
      { result: R.unknown, context: page("/"), expected: allow(null) },
      { result: R.signer, context: page("/"), expected: allow(null) },
    ],
  );
}

// ---------------------------------------------------------------- paths

function pathVectors(): void {
  decideVector(
    "policy/paths/most-specific-wins",
    "Exact beats wildcard; then more literal characters; then fewer wildcards; then file order. Matching ignores the query and is case-sensitive.",
    ["5.3"],
    yaml(
      "version: 1",
      "mode: enforce",
      "paths:",
      '  "/api/*":',
      "    verified: block",
      '  "/api/public/*":',
      "    verified: allow",
      '  "/api/public/feed":',
      "    verified: block",
      '  "/a/b*":',
      "    verified: allow",
      '  "/a/*/c":',
      "    verified: block",
      '  "/x*":',
      "    verified: block",
      '  "/*y":',
      "    verified: allow",
      '  "/ab*":',
      "    verified: block",
      '  "/ab":',
      "    verified: allow",
    ),
    [
      {
        result: R.signer,
        context: page("/api/users"),
        expected: act("block", true, "paths./api/*.verified"),
      },
      {
        result: R.signer,
        context: page("/api/public/list"),
        expected: allow("paths./api/public/*.verified"),
      },
      {
        result: R.signer,
        context: page("/api/public/feed"),
        expected: act("block", true, "paths./api/public/feed.verified"),
      },
      {
        result: R.signer,
        context: page("/api/public/feed?page=2"),
        expected: act("block", true, "paths./api/public/feed.verified"),
      },
      {
        result: R.signer,
        context: page("/api/public/feed/extra"),
        expected: allow("paths./api/public/*.verified"),
      },
      { result: R.signer, context: page("/api"), expected: allow(null) },
      {
        result: R.signer,
        context: page("/a/b/c"),
        expected: act("block", true, "paths./a/*/c.verified"),
      },
      {
        result: R.signer,
        context: page("/xy"),
        expected: act("block", true, "paths./x*.verified"),
      },
      { result: R.signer, context: page("/ab"), expected: allow("paths./ab.verified") },
      {
        result: R.signer,
        context: page("/abc"),
        expected: act("block", true, "paths./ab*.verified"),
      },
      { result: R.signer, context: page("/API/users"), expected: allow(null) },
    ],
  );

  decideVector(
    "policy/paths/cascade",
    "When the most specific matching rule has no key for the request, the next most specific one is checked.",
    ["5.3"],
    yaml(
      "version: 1",
      "mode: enforce",
      "paths:",
      '  "/api/*":',
      "    claimed_failed: block",
      '  "/api/public/*":',
      "    verified: allow",
    ),
    [
      {
        result: R.claudebotFailed,
        context: page("/api/public/x"),
        expected: act("block", true, "paths./api/*.claimed_failed"),
      },
      {
        result: R.signer,
        context: page("/api/public/x"),
        expected: allow("paths./api/public/*.verified"),
      },
    ],
  );
}

// ---------------------------------------------------------------- unknown_automation and monitor

function ruleVectors(): void {
  decideVector(
    "policy/unknown-automation/only-explicit",
    "unknown_automation is not touched by purpose, operator or other class rules.",
    ["5.3"],
    yaml(
      "version: 1",
      "mode: enforce",
      "defaults:",
      "  verified: block",
      "  declared_unverifiable: block",
      "  claimed_failed: block",
      "purposes:",
      "  training: block",
      "  search: block",
      "  user_fetch: block",
      "  agent: block",
      "  preview: block",
      "  ads: block",
      "  other: block",
      "paths:",
      '  "/*":',
      "    verified: block",
      "    training: block",
    ),
    [
      { result: R.unknown, context: page("/"), expected: allow(null, { response: null }) },
      { result: { ...R.unknown, purpose: "training" }, context: page("/"), expected: allow(null) },
    ],
  );

  decideVector(
    "policy/unknown-automation/named",
    "Rules that name unknown_automation act on it. Claims without an operator share one throttle bucket per rule.",
    ["5.2", "5.3"],
    yaml(
      "version: 1",
      "mode: enforce",
      "defaults:",
      "  unknown_automation: allow",
      "paths:",
      '  "/admin/*":',
      "    unknown_automation: block",
      '  "/search":',
      "    unknown_automation: { action: throttle, rate: 2/sec }",
    ),
    [
      {
        result: R.unknown,
        context: page("/admin/x"),
        expected: act("block", true, "paths./admin/*.unknown_automation", {
          response: blocked("unknown", "unknown"),
        }),
      },
      { result: R.unknown, context: page("/"), expected: allow("defaults.unknown_automation") },
      {
        result: R.unknown,
        context: page("/search"),
        repeat: 2,
        expected: allow("paths./search.unknown_automation"),
      },
      {
        result: R.unknown,
        context: page("/search"),
        expected: act("throttle", true, "paths./search.unknown_automation", {
          retry_after: 1,
          response: throttled(1),
        }),
      },
    ],
  );

  decideVector(
    "policy/monitor/global-mode",
    "mode: monitor records the action as not enforced, and nothing is sent.",
    ["5.3"],
    yaml("version: 1", "mode: monitor", "purposes:", "  training: block"),
    [
      {
        result: R.claudebot,
        context: page("/"),
        expected: act("block", false, "purposes.training", { response: null }),
      },
    ],
    { expected_state: { mode: "monitor", suspensions: [] } },
  );

  decideVector(
    "policy/monitor/per-rule",
    "monitor: true on the deciding rule records the action as not enforced, even in enforce mode; other rules still enforce.",
    ["5.3"],
    yaml(
      "version: 1",
      "mode: enforce",
      "defaults:",
      "  claimed_failed: block",
      "paths:",
      '  "/api/*":',
      "    claimed_failed: block",
      "    monitor: true",
      '  "/api/v2/*":',
      "    claimed_failed: block",
    ),
    [
      {
        result: R.claudebotFailed,
        context: page("/api/x"),
        expected: act("block", false, "paths./api/*.claimed_failed", { response: null }),
      },
      {
        result: R.claudebotFailed,
        context: page("/api/v2/x"),
        expected: act("block", true, "paths./api/v2/*.claimed_failed"),
      },
      {
        result: R.claudebotFailed,
        context: page("/home"),
        expected: act("block", true, "defaults.claimed_failed", {
          response: blocked("anthropic", "training"),
        }),
      },
    ],
  );
}

// ---------------------------------------------------------------- throttle (5.2)

function throttleVectors(): void {
  const rule = "operators.example-signer.agent";
  decideVector(
    "policy/throttle/timing",
    "A bucket holds N tokens and refills N per period continuously; Retry-After is the whole seconds until the next token, rounded up.",
    ["5.2"],
    yaml(
      "version: 1",
      "mode: enforce",
      "operators:",
      "  example-signer:",
      "    agent: { action: throttle, rate: 3/min }",
    ),
    [
      {
        at: 0,
        repeat: 3,
        result: R.signer,
        context: page("/"),
        expected: allow(rule, { response: null }),
      },
      {
        at: 0,
        result: R.signer,
        context: page("/"),
        expected: act("throttle", true, rule, { retry_after: 20, response: throttled(20) }),
      },
      {
        at: 5,
        result: R.signer,
        context: page("/"),
        expected: act("throttle", true, rule, { retry_after: 15, response: throttled(15) }),
      },
      {
        at: 19.5,
        result: R.signer,
        context: page("/"),
        expected: act("throttle", true, rule, { retry_after: 1 }),
      },
      { at: 20, result: R.signer, context: page("/"), expected: allow(rule) },
      {
        at: 20,
        result: R.signer,
        context: page("/"),
        expected: act("throttle", true, rule, { retry_after: 20 }),
      },
      { at: 200, repeat: 3, result: R.signer, context: page("/"), expected: allow(rule) },
      {
        at: 200,
        result: R.signer,
        context: page("/"),
        expected: act("throttle", true, rule, { retry_after: 20 }),
      },
    ],
  );

  decideVector(
    "policy/throttle/buckets",
    "Buckets are per rule and per operator, so one operator never uses up another's rate.",
    ["5.2"],
    yaml(
      "version: 1",
      "mode: enforce",
      "purposes:",
      "  agent: { action: throttle, rate: 1/hour }",
      "paths:",
      '  "/api/*":',
      "    agent: { action: throttle, rate: 1/hour }",
    ),
    [
      { at: 0, result: R.signer, context: page("/"), expected: allow("purposes.agent") },
      { at: 0, result: R.labelSigner, context: page("/"), expected: allow("purposes.agent") },
      {
        at: 0,
        result: R.signer,
        context: page("/"),
        expected: act("throttle", true, "purposes.agent", { retry_after: 3600 }),
      },
      { at: 0, result: R.signer, context: page("/api/x"), expected: allow("paths./api/*.agent") },
      {
        at: 1800,
        result: R.signer,
        context: page("/"),
        expected: act("throttle", true, "purposes.agent", { retry_after: 1800 }),
      },
      {
        at: 1800,
        result: R.labelSigner,
        context: page("/"),
        expected: act("throttle", true, "purposes.agent", {
          retry_after: 1800,
          response: throttled(1800),
        }),
      },
    ],
  );

  decideVector(
    "policy/throttle/monitor-consumes",
    "In monitor mode the bucket still counts, so the record shows what enforcement would do.",
    ["5.2", "5.3"],
    yaml("version: 1", "mode: monitor", "purposes:", "  agent: { action: throttle, rate: 1/min }"),
    [
      { result: R.signer, context: page("/"), expected: allow("purposes.agent") },
      {
        result: R.signer,
        context: page("/"),
        expected: act("throttle", false, "purposes.agent", { retry_after: 60, response: null }),
      },
    ],
  );
}

// ---------------------------------------------------------------- sign-up scopes (5.2)

function signupVectors(templates: Record<string, string>): void {
  decideVector(
    "policy/signup/recommendations",
    "Sign-up scopes return lift, cap or challenge by verdict class for the application to act on; the middleware never sends a response for them.",
    ["5.2"],
    yaml(
      "version: 1",
      "mode: enforce",
      "purposes:",
      "  training: block",
      "signup:",
      '  "/signup":',
      "    verified: lift",
      "    claimed_failed: challenge",
      "    unknown_automation: challenge",
      '  "/invite/*":',
      "    declared_unverifiable: cap",
    ),
    [
      {
        result: R.signer,
        context: signup("/signup"),
        expected: act("lift", true, "signup./signup.verified", { response: null }),
      },
      {
        result: R.signerFailed,
        context: signup("/signup"),
        expected: act("challenge", true, "signup./signup.claimed_failed", { response: null }),
      },
      {
        result: R.unknown,
        context: signup("/signup"),
        expected: act("challenge", true, "signup./signup.unknown_automation", { response: null }),
      },
      { result: R.quiet, context: signup("/signup"), expected: allow(null) },
      { result: R.human, context: signup("/signup"), expected: allow("human") },
      {
        result: R.quiet,
        context: signup("/invite/abc"),
        expected: act("cap", true, "signup./invite/*.declared_unverifiable"),
      },
      { result: R.signer, context: signup("/pricing"), expected: allow(null) },
      {
        result: R.claudebot,
        context: signup("/signup"),
        expected: act("lift", true, "signup./signup.verified"),
      },
      {
        result: R.claudebot,
        context: page("/signup"),
        expected: act("block", true, "purposes.training", {
          response: blocked("anthropic", "training"),
        }),
      },
    ],
  );

  decideVector(
    "policy/signup/template-monitor",
    "The saas-signup template starts in monitor, so its recommendations are recorded but not enforced.",
    ["5.2", "5.5"],
    templates["saas-signup"] as string,
    [
      {
        result: R.signer,
        context: signup("/signup"),
        expected: act("lift", false, "signup./signup.verified"),
      },
      {
        result: R.unknown,
        context: signup("/signup"),
        expected: act("challenge", false, "signup./signup.unknown_automation"),
      },
      {
        result: R.claudebot,
        context: page("/"),
        expected: act("block", false, "purposes.training", { response: null }),
      },
    ],
    { template: "saas-signup" },
  );
}

// ---------------------------------------------------------------- search-engine guard (5.4)

function guardVectors(): void {
  decideVector(
    "policy/guards/verified-search-engine",
    "Verified search engines are never blocked or throttled; agents not flagged search_engine are.",
    ["5.4"],
    yaml(
      "version: 1",
      "mode: enforce",
      "purposes:",
      "  search: block",
      "paths:",
      '  "/*":',
      "    verified: block",
    ),
    [
      {
        result: R.googlebot,
        context: page("/"),
        expected: allow("guards.search_engines", { response: null }),
      },
      {
        result: R.googleSigned,
        context: page("/"),
        expected: allow("guards.search_engines"),
      },
      {
        result: R.googleNews,
        context: page("/"),
        expected: act("block", true, "paths./*.verified"),
      },
      {
        result: R.exampleBot,
        context: page("/"),
        expected: act("block", true, "paths./*.verified"),
      },
    ],
  );

  const failedBlock = yaml("version: 1", "mode: enforce", "defaults:", "  claimed_failed: block");

  decideVector(
    "policy/guards/claimed-failed-unseen",
    "A failed search-engine claim is downgraded to allow and recorded as guarded when no verified request from that operator was seen in 7 days.",
    ["5.4"],
    failedBlock,
    [
      { result: R.googlebotFailed, context: page("/"), repeat: 2, expected: guardedAllow() },
      {
        result: R.claudebotFailed,
        context: page("/"),
        expected: act("block", true, "defaults.claimed_failed"),
      },
    ],
    { expected_state: { guarded: 2 } },
  );

  decideVector(
    "policy/guards/claimed-failed-after-verified",
    "After a verified request from the operator, failed claims are enforced for 7 days, then guarded again.",
    ["5.4"],
    failedBlock,
    [
      { at: 0, result: R.googlebot, context: page("/"), expected: allow("guards.search_engines") },
      {
        at: 1,
        result: R.googlebotFailed,
        context: page("/"),
        expected: act("block", true, "defaults.claimed_failed", {
          response: blocked("google", "search"),
        }),
      },
      {
        at: 604800,
        result: R.googlebotFailed,
        context: page("/"),
        expected: act("block", true, "defaults.claimed_failed"),
      },
      { at: 604801, result: R.googlebotFailed, context: page("/"), expected: guardedAllow() },
      {
        at: 604802,
        result: R.googlebot,
        context: page("/"),
        expected: allow("guards.search_engines"),
      },
      {
        at: 604803,
        result: R.googlebotFailed,
        context: page("/"),
        expected: act("block", true, "defaults.claimed_failed"),
      },
    ],
    { expected_state: { guarded: 1 } },
  );

  decideVector(
    "policy/guards/declared-unverifiable",
    "An unverifiable search-engine claim gets the same protection as a failed one.",
    ["5.4"],
    yaml("version: 1", "mode: enforce", "defaults:", "  declared_unverifiable: block"),
    [
      { result: R.googlebotUnverifiable, context: page("/"), expected: guardedAllow() },
      { result: R.googlebot, context: page("/"), expected: allow("guards.search_engines") },
      {
        result: R.googlebotUnverifiable,
        context: page("/"),
        expected: act("block", true, "defaults.declared_unverifiable"),
      },
      {
        result: R.quiet,
        context: page("/"),
        expected: act("block", true, "defaults.declared_unverifiable"),
      },
    ],
  );

  decideVector(
    "policy/guards/breaker-tripped",
    "A failed search-engine claim is guarded while the breaker is tripped for the operator, even after a verified request.",
    ["5.4"],
    failedBlock,
    [
      {
        at: 0,
        repeat: 10,
        result: R.googlebot,
        context: page("/"),
        expected: allow("guards.search_engines"),
      },
      {
        at: 1,
        repeat: 9,
        result: R.googlebotFailed,
        context: page("/"),
        expected: act("block", true, "defaults.claimed_failed"),
      },
      { at: 2, result: R.googlebotFailed, context: page("/"), expected: guardedAllow() },
    ],
    { expected_state: { breaker_tripped: ["google"], guarded: 1 } },
  );

  decideVector(
    "policy/guards/off",
    "With guards.search_engines: off, search engines are treated like any other agent.",
    ["5.4"],
    yaml(
      "version: 1",
      "mode: enforce",
      "guards:",
      "  search_engines: off",
      "defaults:",
      "  claimed_failed: block",
      "purposes:",
      "  search: block",
    ),
    [
      { result: R.googlebot, context: page("/"), expected: act("block", true, "purposes.search") },
      {
        result: R.googlebotFailed,
        context: page("/"),
        expected: act("block", true, "purposes.search"),
      },
      {
        result: R.googlebotUnverifiable,
        context: page("/"),
        expected: act("block", true, "purposes.search"),
      },
    ],
  );
}

// ---------------------------------------------------------------- breaker (5.4)

function breakerVectors(): void {
  const policy = yaml(
    "version: 1",
    "mode: enforce",
    "defaults:",
    "  declared_unverifiable: block",
    "  claimed_failed: block",
  );
  decideVector(
    "policy/breaker/trip-and-recover",
    "20 IP-path claims with half failed in 10 minutes suspends enforcement for the operator for 60 minutes; it then recovers.",
    ["5.4"],
    policy,
    [
      { at: 0, repeat: 10, result: R.exampleBot, context: page("/"), expected: allow(null) },
      {
        at: 0,
        repeat: 9,
        result: R.exampleBotFailed,
        context: page("/"),
        expected: act("block", true, "defaults.claimed_failed"),
      },
      {
        at: 0,
        result: R.exampleBotFailed,
        context: page("/"),
        expected: act("block", false, "defaults.claimed_failed", { response: null }),
      },
      {
        at: 60,
        result: R.exampleBotUnverifiable,
        context: page("/"),
        expected: act("block", false, "defaults.declared_unverifiable"),
      },
      {
        at: 120,
        result: R.exampleBotFailed,
        context: page("/"),
        expected: act("block", false, "defaults.claimed_failed"),
      },
      {
        at: 3599,
        result: R.exampleBotFailed,
        context: page("/"),
        expected: act("block", false, "defaults.claimed_failed"),
      },
      {
        at: 3600,
        result: R.exampleBotFailed,
        context: page("/"),
        expected: act("block", true, "defaults.claimed_failed"),
      },
      {
        at: 3600,
        result: R.claudebotFailed,
        context: page("/"),
        expected: act("block", true, "defaults.claimed_failed"),
      },
    ],
    { expected_state: { breaker_tripped: [] } },
  );

  decideVector(
    "policy/breaker/retrips",
    "If failures are still at or above half when the hour ends, the breaker trips again at once.",
    ["5.4"],
    policy,
    [
      {
        at: 0,
        repeat: 19,
        result: R.exampleBotFailed,
        context: page("/"),
        expected: act("block", true, "defaults.claimed_failed"),
      },
      {
        at: 0,
        result: R.exampleBotFailed,
        context: page("/"),
        expected: act("block", false, "defaults.claimed_failed"),
      },
      {
        at: 3060,
        repeat: 20,
        result: R.exampleBotFailed,
        context: page("/"),
        expected: act("block", false, "defaults.claimed_failed"),
      },
      {
        at: 3600,
        result: R.exampleBotFailed,
        context: page("/"),
        expected: act("block", false, "defaults.claimed_failed"),
      },
    ],
    { expected_state: { breaker_tripped: ["ip-crawler"] } },
  );

  decideVector(
    "policy/breaker/signature-not-counted",
    "The breaker covers verification by IP and reverse DNS; failed signatures do not trip it.",
    ["5.4"],
    policy,
    [
      {
        repeat: 25,
        result: R.signerFailed,
        context: page("/"),
        expected: act("block", true, "defaults.claimed_failed"),
      },
    ],
    { expected_state: { breaker_tripped: [] } },
  );

  decideVector(
    "policy/breaker/signup-not-counted",
    "Sign-up decisions are not counted, so a request decided as a page and as a sign-up counts once.",
    ["5.4"],
    yaml(
      "version: 1",
      "mode: enforce",
      "defaults:",
      "  claimed_failed: block",
      "signup:",
      '  "/signup":',
      "    claimed_failed: challenge",
    ),
    [
      {
        repeat: 25,
        result: R.exampleBotFailed,
        context: signup("/signup"),
        expected: act("challenge", true, "signup./signup.claimed_failed"),
      },
      {
        result: R.exampleBotFailed,
        context: page("/"),
        expected: act("block", true, "defaults.claimed_failed"),
      },
    ],
    { expected_state: { breaker_tripped: [] } },
  );
}

// ---------------------------------------------------------------- kill switches and proxy guard (5.3, 5.4)

function suspensionVectors(): void {
  const enforce = yaml("version: 1", "mode: enforce", "purposes:", "  training: block");
  const monitor = yaml("version: 1", "mode: monitor", "purposes:", "  training: block");
  const block = (enforced: boolean) => act("block", enforced, "purposes.training");

  decideVector(
    "policy/suspensions/env-kill-switch",
    "POSTERNA_MODE=monitor stops enforcement in an enforce policy.",
    ["5.3", "5.4"],
    enforce,
    [{ result: R.claudebot, context: page("/"), expected: { ...block(false), response: null } }],
    {
      env: { POSTERNA_MODE: "monitor" },
      expected_state: { mode: "monitor", configured_mode: "enforce", suspensions: ["env"] },
    },
  );

  decideVector(
    "policy/suspensions/env-kill-switch-case",
    "The kill switch ignores case and surrounding spaces.",
    ["5.4"],
    enforce,
    [{ result: R.claudebot, context: page("/"), expected: block(false) }],
    {
      env: { POSTERNA_MODE: " Monitor " },
      expected_state: { mode: "monitor", suspensions: ["env"] },
    },
  );

  decideVector(
    "policy/suspensions/env-cannot-enforce",
    "POSTERNA_MODE=enforce does not enable enforcement in a monitor policy.",
    ["5.4"],
    monitor,
    [{ result: R.claudebot, context: page("/"), expected: block(false) }],
    { env: { POSTERNA_MODE: "enforce" }, expected_state: { mode: "monitor", suspensions: [] } },
  );

  decideVector(
    "policy/suspensions/remote-override",
    "The remote override can turn monitor on and off, and anything other than monitor or null is refused.",
    ["5.4"],
    enforce,
    [
      { result: R.claudebot, context: page("/"), expected: block(true) },
      { set_remote_override: "monitor", expected_accepted: true },
      { result: R.claudebot, context: page("/"), expected: block(false) },
      { set_remote_override: "enforce", expected_accepted: false },
      { result: R.claudebot, context: page("/"), expected: block(false) },
      { set_remote_override: null, expected_accepted: true },
      { result: R.claudebot, context: page("/"), expected: block(true) },
      { set_remote_override: "MONITOR", expected_accepted: false },
      { set_remote_override: 42, expected_accepted: false },
      { result: R.claudebot, context: page("/"), expected: block(true) },
    ],
    { expected_state: { mode: "enforce", remote_override: null, suspensions: [] } },
  );

  decideVector(
    "policy/suspensions/remote-cannot-enforce",
    "The remote override can never move an install to enforce.",
    ["5.4"],
    monitor,
    [
      { set_remote_override: "enforce", expected_accepted: false },
      { result: R.claudebot, context: page("/"), expected: block(false) },
    ],
    { expected_state: { mode: "monitor", remote_override: null } },
  );

  decideVector(
    "policy/suspensions/proxy-guard",
    "While the proxy guard suspects a misconfigured proxy, nothing is enforced.",
    ["5.4", "4.2"],
    enforce,
    [{ result: R.claudebot, context: page("/"), expected: { ...block(false), response: null } }],
    {
      proxy_suspect: true,
      expected_state: { mode: "enforce", proxy_suspect: true, suspensions: ["proxy"] },
    },
  );

  decideVector(
    "policy/suspensions/all",
    "Every suspension at once still yields a recorded, unenforced decision.",
    ["5.3", "5.4"],
    enforce,
    [
      { set_remote_override: "monitor", expected_accepted: true },
      { result: R.claudebot, context: page("/"), expected: block(false) },
    ],
    {
      env: { POSTERNA_MODE: "monitor" },
      proxy_suspect: true,
      expected_state: {
        mode: "monitor",
        remote_override: "monitor",
        suspensions: ["env", "remote", "proxy"],
      },
    },
  );
}

function failureVectors(): void {
  decideVector(
    "policy/failure/fails-open",
    "Malformed input never blocks: the decision is allow, not enforced, with error set.",
    ["4.8", "5.3"],
    yaml("version: 1", "mode: enforce", "defaults:", "  unknown_automation: block"),
    [
      {
        result: { verdict: "not-a-verdict" },
        context: page("/"),
        expected: allow(null, { error: true, response: null }),
      },
      { result: null, context: page("/"), expected: allow(null, { error: true }) },
    ],
    { expected_state: { errors_at_least: 2 } },
  );
}

// ---------------------------------------------------------------- policy_check

function checkVectors(templates: Record<string, string>): void {
  vectors.push({
    id: "policy/check/templates",
    description: "Every shipped template is valid and starts in monitor mode.",
    spec: ["5.5"],
    type: "policy_check",
    cases: Object.entries(templates).map(([name, policy]) => ({
      template: name,
      policy,
      valid: true,
      mode: "monitor",
    })),
  });

  vectors.push({
    id: "policy/check/invalid",
    description:
      "Every error in a document is reported with the dotted path and line it belongs to.",
    spec: ["5.1"],
    type: "policy_check",
    cases: [
      {
        policy: yaml(
          "version: 1",
          "mode: enforced",
          "defaults:",
          "  verifed: allow",
          "  human: block",
          "purposes:",
          "  training: throttle",
          "  search: { action: throttle, rate: 60/minute }",
          "  ads: { action: block, rate: 1/min }",
          "operators:",
          "  OpenAI:",
          "    agent: block",
          "paths:",
          "  api/*:",
          "    claimed_failed: block",
          '  "/docs/*":',
          '    monitor: "true"',
          "signup:",
          "  /signup:",
          "    verified: block",
          "emit: [robots]",
        ),
        valid: false,
        errors: [
          { path: "mode", line: 2 },
          { path: "defaults.verifed", line: 4 },
          { path: "defaults.human", line: 5 },
          { path: "purposes.training", line: 7 },
          { path: "purposes.search.rate", line: 8 },
          { path: "purposes.ads.rate", line: 9 },
          { path: "operators.OpenAI", line: 11 },
          { path: "paths.api/*", line: 14 },
          { path: "paths./docs/*.monitor", line: 17 },
          { path: "signup./signup.verified", line: 20 },
          { path: "emit.0", line: 21 },
        ],
      },
      { policy: yaml("mode: monitor"), valid: false, errors: [{ path: "", line: 1 }] },
      { policy: yaml("version: 2"), valid: false, errors: [{ path: "version", line: 1 }] },
      {
        policy: yaml("version: 1", "colour: blue"),
        valid: false,
        errors: [{ path: "colour", line: 2 }],
      },
      { policy: "", valid: false },
      { policy: yaml("version: 1", "mode: monitor", "mode: enforce"), valid: false },
      { policy: yaml("version: 1", "paths:", "  bad: [", "    unclosed"), valid: false },
      {
        policy: yaml("version: 1", "defaults:", "paths:", "signup:", "operators:"),
        valid: true,
        mode: "monitor",
      },
    ],
  });

  const rate = (value: string) =>
    yaml("version: 1", "purposes:", `  agent: { action: throttle, rate: "${value}" }`);
  vectors.push({
    id: "policy/check/rates",
    description: "Rates are a whole number from 1 to 1,000,000 per sec, min or hour.",
    spec: ["5.2"],
    type: "policy_check",
    cases: [
      { policy: rate("60/min"), valid: true },
      { policy: rate("1/sec"), valid: true },
      { policy: rate("1/hour"), valid: true },
      { policy: rate(" 5 / sec "), valid: true },
      { policy: rate("1000000/hour"), valid: true },
      { policy: rate("0/min"), valid: false, errors: [{ path: "purposes.agent.rate", line: 3 }] },
      { policy: rate("1000001/min"), valid: false },
      { policy: rate("1.5/min"), valid: false },
      { policy: rate("10/day"), valid: false },
      { policy: rate("10 per min"), valid: false },
      { policy: rate("-1/min"), valid: false },
    ],
  });
}

// ---------------------------------------------------------------- robots.txt and Content Signals (5.6)

const HEADER = [
  "# robots.txt written by Posterna from agents.yaml.",
  "# Crawlers that honor robots.txt are asked to stay out of what the policy blocks.",
  "# The site's policy engine enforces against agents that do not.",
];
const SIGNALS_NOTE =
  "# Content-Signal lines state how content may be used: https://contentsignals.org/";
const text = (...lines: string[]) => `${lines.join("\n")}\n`;

function robotsVector(
  id: string,
  description: string,
  policy: string,
  expected: string,
  extra: Record<string, unknown> = {},
) {
  vectors.push({
    id,
    description,
    spec: ["5.6"],
    type: "robots",
    directory: "fixtures/directory.json",
    policy,
    ...extra,
    expected,
  });
}

function robotsVectors(templates: Record<string, string>): void {
  robotsVector(
    "robots/templates/monitor",
    "The monitor template blocks nothing and sets no signals.",
    templates.monitor as string,
    text(...HEADER, "", "User-agent: *", "Allow: /"),
    { template: "monitor" },
  );
  const allowList = text(
    ...HEADER,
    SIGNALS_NOTE,
    "",
    "User-agent: *",
    "Content-Signal: ai-train=no",
    "Allow: /",
    "",
    "# Training",
    "User-agent: ClaudeBot",
    "User-agent: Google-Extended",
    "Disallow: /",
  );
  robotsVector(
    "robots/templates/allow-list",
    "Training agents that honor robots.txt are disallowed and ai-train=no is signaled; agents that do not honor it are left to the engine.",
    templates["allow-list"] as string,
    allowList,
    { template: "allow-list" },
  );
  robotsVector(
    "robots/templates/saas-signup",
    "Sign-up scopes do not change robots.txt, so the output matches allow-list.",
    templates["saas-signup"] as string,
    allowList,
    { template: "saas-signup" },
  );

  robotsVector(
    "robots/paths",
    "Path rules become Allow and Disallow lines under robots.txt longest-match rules; exact patterns end in $; the guard keeps search engines out.",
    yaml(
      "version: 1",
      "mode: enforce",
      "purposes:",
      "  training: block",
      "  user_fetch: allow",
      "paths:",
      '  "/blog/*":',
      "    training: allow",
      '  "/blog/drafts/*":',
      "    verified: block",
      '  "/private":',
      "    user_fetch: block",
      "emit: [robots.txt]",
    ),
    text(
      ...HEADER,
      "",
      "User-agent: *",
      "Allow: /",
      "",
      "# Training",
      "User-agent: ClaudeBot",
      "User-agent: Google-Extended",
      "Disallow: /",
      "Allow: /blog/",
      "Disallow: /blog/drafts/",
      "",
      "# Search",
      "User-agent: Claude-SearchBot",
      "User-agent: Googlebot-News",
      "User-agent: Storebot-Google",
      "Disallow: /blog/drafts/",
      "",
      "# User-initiated fetches",
      "User-agent: Claude-User",
      "Disallow: /blog/drafts/",
      "Disallow: /private$",
      "",
      "# Other",
      "User-agent: Google-CloudVertexBot",
      "User-agent: Google-InspectionTool",
      "User-agent: GoogleOther",
      "User-agent: GoogleOther-Image",
      "User-agent: GoogleOther-Video",
      "Disallow: /blog/drafts/",
    ),
  );

  robotsVector(
    "robots/operator-rules",
    "Operator rules override purposes for that operator's agents.",
    yaml(
      "version: 1",
      "purposes:",
      "  training: block",
      "operators:",
      "  google:",
      "    training: allow",
      "  anthropic:",
      "    user_fetch: block",
      "emit: [robots.txt]",
    ),
    text(
      ...HEADER,
      "",
      "User-agent: *",
      "Allow: /",
      "",
      "# Training",
      "User-agent: ClaudeBot",
      "Disallow: /",
      "",
      "# User-initiated fetches",
      "User-agent: Claude-User",
      "Disallow: /",
    ),
  );

  robotsVector(
    "robots/guard-off",
    "With the guard off, search engines are disallowed like any other agent when search is blocked.",
    yaml(
      "version: 1",
      "guards:",
      "  search_engines: off",
      "purposes:",
      "  search: block",
      "emit: [robots.txt, content-signals]",
    ),
    text(
      ...HEADER,
      SIGNALS_NOTE,
      "",
      "User-agent: *",
      "Content-Signal: search=no",
      "Allow: /",
      "",
      "# Search",
      "User-agent: Claude-SearchBot",
      "User-agent: Googlebot",
      "User-agent: Googlebot-Image",
      "User-agent: Googlebot-News",
      "User-agent: Googlebot-Video",
      "User-agent: Storebot-Google",
      "Disallow: /",
    ),
  );

  robotsVector(
    "robots/content-signals",
    "training, search and user_fetch rules become ai-train, search and ai-input signals; path rules add path-scoped lines.",
    yaml(
      "version: 1",
      "purposes:",
      "  training: block",
      "  search: allow",
      "  user_fetch: { action: throttle, rate: 10/min }",
      "paths:",
      '  "/news/*":',
      "    training: allow",
      '  "/members":',
      "    search: block",
      "emit: [content-signals]",
    ),
    text(
      ...HEADER,
      SIGNALS_NOTE,
      "",
      "User-agent: *",
      "Content-Signal: ai-train=no, search=yes, ai-input=yes",
      "Content-Signal: /news/ ai-train=yes",
      "Content-Signal: /members$ search=no",
      "Allow: /",
    ),
  );

  robotsVector(
    "robots/emit-nothing",
    "Without an emit list, nothing but the open default group is written.",
    yaml("version: 1", "purposes:", "  training: block"),
    text(
      ...HEADER,
      "# agents.yaml emits nothing. Add emit: [robots.txt, content-signals] to write rules here.",
      "",
      "User-agent: *",
      "Allow: /",
    ),
  );
}

/** Every policy vector. `templates` maps template names to the YAML shipped in packages/core/templates. */
export function policyVectors(templates: Record<string, string>): PolicyVector[] {
  vectors.length = 0;
  orderVectors();
  pathVectors();
  ruleVectors();
  throttleVectors();
  signupVectors(templates);
  guardVectors();
  breakerVectors();
  suspensionVectors();
  failureVectors();
  checkVectors(templates);
  robotsVectors(templates);
  return [...vectors];
}
