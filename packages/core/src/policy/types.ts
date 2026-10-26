import type { Purpose } from "../directory/types";

/** The configurable verdict classes. `human` is always allowed and cannot be configured. */
export type VerdictClass =
  | "verified"
  | "declared_unverifiable"
  | "claimed_failed"
  | "unknown_automation";

export const VERDICT_CLASSES: readonly VerdictClass[] = [
  "verified",
  "declared_unverifiable",
  "claimed_failed",
  "unknown_automation",
];

export const PURPOSES: readonly Purpose[] = [
  "training",
  "search",
  "user_fetch",
  "agent",
  "preview",
  "ads",
  "other",
];

/** Actions the middleware enforces on page and API traffic. */
export type PageAction = "allow" | "block" | "throttle";

/** Recommendations returned for sign-up scopes. The application acts on them; the middleware never does. */
export type SignupAction = "allow" | "lift" | "cap" | "challenge";

export type Action = PageAction | SignupAction;

export interface Rate {
  /** Requests allowed per period. */
  count: number;
  per: "sec" | "min" | "hour";
  /** Period length in seconds. */
  seconds: number;
  /** As written in agents.yaml, for example `60/min`. */
  text: string;
}

export type ActionSpec = { action: "allow" | "block" } | { action: "throttle"; rate: Rate };

export interface PathRule {
  /** As written, for example `/api/*`. */
  pattern: string;
  rules: Partial<Record<VerdictClass | Purpose, ActionSpec>>;
  /** Records what the rule would do without enforcing it, even when mode is enforce. */
  monitor: boolean;
}

export interface SignupScope {
  pattern: string;
  rules: Partial<Record<VerdictClass, SignupAction>>;
}

export type Emitter = "robots.txt" | "content-signals";

/** A parsed and validated agents.yaml (docs/SPEC.md section 5.1). */
export interface Policy {
  version: 1;
  mode: "monitor" | "enforce";
  defaults: Partial<Record<VerdictClass, ActionSpec>>;
  guards: { search_engines: "protect" | "off" };
  purposes: Partial<Record<Purpose, ActionSpec>>;
  operators: Record<string, Partial<Record<Purpose, ActionSpec>>>;
  /** In file order. */
  paths: PathRule[];
  /** In file order. */
  signup: SignupScope[];
  emit: Emitter[];
}

/** What `decide()` returns (docs/SPEC.md section 4.6). */
export interface Decision {
  action: Action;
  /**
   * True only when the action is applied: block or throttle by the middleware,
   * or a sign-up recommendation the application should act on. False for
   * allow, and for anything recorded as "would have" (monitor mode, a
   * `monitor: true` rule, or a suspension).
   */
  enforced: boolean;
  /** Which rule decided, for example `paths./api/*.claimed_failed` or `purposes.training`. */
  rule?: string;
  reason: string;
  /** Seconds until the throttle bucket has a token again. Set when action is throttle. */
  retryAfter?: number;
  /** True when the search-engine guard downgraded the action to allow. */
  guarded?: boolean;
  /** Set when a fail-open path was taken inside the policy engine. */
  error?: string;
}

export interface DecideContext {
  /** The request path, without the query string. */
  path: string;
  /** `page` for page and API traffic (the default), `signup` for sign-up scopes. */
  kind?: "page" | "signup";
}
