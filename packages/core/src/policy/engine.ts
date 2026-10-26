import type { OperatorRecord, Purpose } from "../directory/types";
import type { Verdict, VerdictResult } from "../verifier/types";
import { policyHash } from "./hash";
import { parsePolicy } from "./parse";
import { type CompiledPattern, compilePatterns } from "./paths";
import { Breaker, TokenBuckets, VERIFIED_SEEN_MS } from "./rails";
import type {
  ActionSpec,
  DecideContext,
  Decision,
  PathRule,
  Policy,
  SignupScope,
  VerdictClass,
} from "./types";

/**
 * What the engine needs from the verifier: the proxy guard's state and
 * directory lookups. A {@link Verifier} from `createVerifier()` provides both.
 */
export interface PolicyVerifier {
  state(): {
    proxySuspect: boolean;
    errors?: number;
    directoryVersion?: string | null;
    keysVersion?: string | null;
  };
  operator(slug: string): OperatorRecord | undefined;
}

export interface PolicyEngineOptions {
  /**
   * The verifier whose results this engine decides on. Without one the engine
   * cannot tell which agents are search engines, so with `guards.search_engines:
   * protect` it treats every claimed agent as one, and the proxy guard is not
   * consulted.
   */
  verifier?: PolicyVerifier;
  /**
   * Environment variables, read once when the engine is created. Defaults to
   * `process.env` where it exists. `POSTERNA_MODE=monitor` is the local kill switch.
   */
  env?: Record<string, string | undefined>;
  /** Milliseconds since the epoch. Injectable for tests. */
  now?: () => number;
}

/** Why enforcement is suspended for the whole install. */
export type Suspension = "env" | "remote" | "proxy";

/** What the counters client reports about this install (docs/SPEC.md section 7). */
export interface PolicyState {
  /** `enforce` only when agents.yaml says so and neither kill switch is on. */
  mode: "monitor" | "enforce";
  /** The mode written in agents.yaml. */
  configuredMode: "monitor" | "enforce";
  /** Install-wide suspensions in effect: the local kill switch, the remote override, the proxy guard. */
  suspensions: Suspension[];
  remoteOverride: "monitor" | null;
  proxySuspect: boolean;
  /** Operators whose breaker is tripped right now. */
  breakerTripped: string[];
  /** Decisions the search-engine guard downgraded to allow since the engine started. */
  guarded: number;
  /** Fail-open paths taken by the policy engine and, when attached, the verifier. */
  errors: number;
  directoryVersion: string | null;
  keysVersion: string | null;
  /** `sha256-` and 16 hex characters of the canonical policy. Null until computed. */
  policyHash: string | null;
}

export interface PolicyEngine {
  readonly policy: Policy;
  /**
   * Decides what to do with one labeled request (docs/SPEC.md section 5.3).
   * Never throws: on any internal error it returns allow, not enforced, with
   * `error` set.
   */
  decide(result: VerdictResult, context: DecideContext): Decision;
  /**
   * Applies the remote override from the ingest response. Only `"monitor"`
   * turns it on and `null` turns it off; anything else, `"enforce"` included,
   * is ignored and returns false. It can never move an install to enforce.
   */
  setRemoteOverride(mode: unknown): boolean;
  state(): PolicyState;
  /** Resolves to the policy hash once computed. */
  hash(): Promise<string | null>;
}

const CLASS_OF: Record<Exclude<Verdict, "human">, VerdictClass> = {
  verified_by_signature: "verified",
  verified_by_ip: "verified",
  declared_unverifiable: "declared_unverifiable",
  claimed_failed: "claimed_failed",
  unknown_automation: "unknown_automation",
};

interface Match {
  spec: ActionSpec;
  rule: string;
  monitor: boolean;
}

function defaultEnv(): Record<string, string | undefined> {
  const process = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  return process?.env ?? {};
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Creates a policy engine from agents.yaml text or a parsed {@link Policy}.
 * Throws {@link PolicyError} when the text is invalid; adapters catch it and
 * fall back to allowing everything.
 */
export function createPolicyEngine(
  input: Policy | string,
  options: PolicyEngineOptions = {},
): PolicyEngine {
  const policy = typeof input === "string" ? parsePolicy(input) : input;
  const clock = options.now ?? (() => Date.now());
  const verifier = options.verifier;
  const env = options.env ?? defaultEnv();
  const killSwitch = (env.POSTERNA_MODE ?? "").trim().toLowerCase() === "monitor";

  const paths: CompiledPattern<PathRule>[] = compilePatterns(
    policy.paths.map((rule) => ({ pattern: rule.pattern, value: rule })),
  );
  const signup: CompiledPattern<SignupScope>[] = compilePatterns(
    policy.signup.map((scope) => ({ pattern: scope.pattern, value: scope })),
  );
  const operators = new Map(Object.entries(policy.operators));
  const protect = policy.guards.search_engines === "protect";

  const breaker = new Breaker();
  const buckets = new TokenBuckets();
  const lastVerified = new Map<string, number>();
  let remoteOverride: "monitor" | null = null;
  let guarded = 0;
  let errors = 0;
  let hash: string | null = null;
  const hashing = policyHash(policy)
    .then((value) => {
      hash = value;
      return value;
    })
    .catch(() => null);

  const isSearchEngine = (operator: string, agent: string | undefined): boolean => {
    if (!verifier) return true;
    const record = verifier.operator(operator);
    if (!record) return false;
    return agent
      ? record.agents.some((entry) => entry.name === agent && entry.search_engine)
      : record.agents.some((entry) => entry.search_engine);
  };

  /** Steps 4 to 7 of docs/SPEC.md section 5.3. */
  const lookup = (
    cls: VerdictClass,
    purpose: Purpose | undefined,
    operator: string | undefined,
    path: string,
  ): Match | null => {
    // unknown_automation is acted on only by rules that name it, never by operator or purpose rules.
    const byPurpose = cls === "unknown_automation" ? undefined : purpose;
    for (const entry of paths) {
      if (!entry.regex.test(path)) continue;
      const { rules, monitor } = entry.value;
      const byClass = rules[cls];
      if (byClass) return { spec: byClass, rule: `paths.${entry.pattern}.${cls}`, monitor };
      const forPurpose = byPurpose ? rules[byPurpose] : undefined;
      if (forPurpose)
        return { spec: forPurpose, rule: `paths.${entry.pattern}.${byPurpose}`, monitor };
    }
    if (byPurpose && operator) {
      const spec = operators.get(operator)?.[byPurpose];
      if (spec) return { spec, rule: `operators.${operator}.${byPurpose}`, monitor: false };
    }
    if (byPurpose) {
      const spec = policy.purposes[byPurpose];
      if (spec) return { spec, rule: `purposes.${byPurpose}`, monitor: false };
    }
    const spec = policy.defaults[cls];
    return spec ? { spec, rule: `defaults.${cls}`, monitor: false } : null;
  };

  /** Step 1: why a decision about this operator would not be enforced, if anything stops it. */
  const suspension = (operator: string | undefined, now: number): string | null => {
    if (killSwitch) return "POSTERNA_MODE=monitor is set";
    if (remoteOverride) return "the remote monitor override is on";
    if (verifier?.state().proxySuspect) return "the proxy guard suspects a proxy misconfiguration";
    if (operator && breaker.tripped(operator, now)) return `the breaker is tripped for ${operator}`;
    return null;
  };

  const notEnforced = (stopped: string | null, ruleMonitor: boolean): string | null => {
    if (stopped) return stopped;
    if (ruleMonitor) return "the rule has monitor: true";
    if (policy.mode === "monitor") return "mode is monitor";
    return null;
  };

  const evaluate = (result: VerdictResult, context: DecideContext): Decision => {
    const now = Math.floor(clock());
    const kind = context.kind ?? "page";
    const path = context.path.replace(/[?#].*$/s, "") || "/";
    const { verdict, operator } = result;

    if (operator && (verdict === "verified_by_signature" || verdict === "verified_by_ip")) {
      lastVerified.set(operator, now);
    }
    // The breaker counts conclusive IP and reverse DNS outcomes, once per request (page decisions only).
    if (kind === "page" && operator && (result.method === "ip" || result.method === "rdns")) {
      if (verdict === "verified_by_ip" || verdict === "claimed_failed") {
        breaker.record(operator, verdict === "claimed_failed", now);
      }
    }

    if (verdict === "human") {
      return {
        action: "allow",
        enforced: false,
        rule: "human",
        reason: "Humans are always allowed.",
      };
    }
    const cls = CLASS_OF[verdict];
    if (!cls) throw new Error(`unknown verdict ${JSON.stringify(verdict)}`);
    const stopped = suspension(operator, now);

    if (kind === "signup") {
      const scope = signup.find((entry) => entry.regex.test(path));
      if (!scope)
        return { action: "allow", enforced: false, reason: "No sign-up scope matches this path." };
      const action = scope.value.rules[cls];
      if (!action) {
        return {
          action: "allow",
          enforced: false,
          reason: `signup.${scope.pattern} has no rule for ${cls}.`,
        };
      }
      const rule = `signup.${scope.pattern}.${cls}`;
      if (action === "allow")
        return { action, enforced: false, rule, reason: `Allowed by ${rule}.` };
      const why = notEnforced(stopped, false);
      return {
        action,
        enforced: why === null,
        rule,
        reason:
          why === null
            ? `Recommend ${action} (${rule}).`
            : `Would recommend ${action} (${rule}), but ${why}.`,
      };
    }

    const protectedAgent =
      protect && operator !== undefined && isSearchEngine(operator, result.agent);
    if (protectedAgent && cls === "verified") {
      return {
        action: "allow",
        enforced: false,
        rule: "guards.search_engines",
        reason: "Verified search engines are never blocked or throttled.",
      };
    }

    const match = lookup(cls, result.purpose, operator, path);
    if (!match) return { action: "allow", enforced: false, reason: "No rule matches; allowed." };
    const { spec, rule } = match;
    if (spec.action === "allow")
      return { action: "allow", enforced: false, rule, reason: `Allowed by ${rule}.` };

    if (
      protectedAgent &&
      operator &&
      (cls === "claimed_failed" || cls === "declared_unverifiable")
    ) {
      const seen = lastVerified.get(operator);
      const recent = seen !== undefined && now - seen <= VERIFIED_SEEN_MS;
      const tripped = breaker.tripped(operator, now);
      if (!recent || tripped) {
        guarded++;
        const why = !recent
          ? `no verified request from ${operator} was seen here in the past 7 days`
          : `the breaker is tripped for ${operator}`;
        return {
          action: "allow",
          enforced: false,
          rule: "guards.search_engines",
          guarded: true,
          reason: `Search-engine guard: ${rule} would ${spec.action} this claim, but ${why}.`,
        };
      }
    }

    let retryAfter: number | undefined;
    if (spec.action === "throttle") {
      // One bucket per rule and operator; claims without an operator share one per verdict class.
      const wait = buckets.take(`${rule}\n${operator ?? cls}`, spec.rate, now);
      if (wait === 0) {
        return {
          action: "allow",
          enforced: false,
          rule,
          reason: `Within the rate ${spec.rate.text} set by ${rule}.`,
        };
      }
      retryAfter = wait;
    }

    const why = notEnforced(stopped, match.monitor);
    const verb = spec.action === "throttle" ? `throttle (${spec.rate.text})` : "block";
    return {
      action: spec.action,
      enforced: why === null,
      rule,
      reason: why === null ? `${rule}: ${verb}.` : `${rule}: would ${verb}, but ${why}.`,
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    };
  };

  return {
    policy,
    decide(result, context) {
      try {
        return evaluate(result, context);
      } catch (error) {
        errors++;
        return {
          action: "allow",
          enforced: false,
          reason: "The policy engine hit an error and failed open.",
          error: message(error),
        };
      }
    },
    setRemoteOverride(mode) {
      if (mode === "monitor") remoteOverride = "monitor";
      else if (mode === null) remoteOverride = null;
      else return false;
      return true;
    },
    state() {
      const now = Math.floor(clock());
      let verifierState: ReturnType<PolicyVerifier["state"]> | null = null;
      try {
        verifierState = verifier?.state() ?? null;
      } catch {
        verifierState = null;
      }
      const suspensions: Suspension[] = [];
      if (killSwitch) suspensions.push("env");
      if (remoteOverride) suspensions.push("remote");
      if (verifierState?.proxySuspect) suspensions.push("proxy");
      return {
        mode: policy.mode === "enforce" && !killSwitch && !remoteOverride ? "enforce" : "monitor",
        configuredMode: policy.mode,
        suspensions,
        remoteOverride,
        proxySuspect: verifierState?.proxySuspect ?? false,
        breakerTripped: breaker.trippedOperators(now),
        guarded,
        errors: errors + (verifierState?.errors ?? 0),
        directoryVersion: verifierState?.directoryVersion ?? null,
        keysVersion: verifierState?.keysVersion ?? null,
        policyHash: hash,
      };
    },
    hash() {
      return hashing;
    },
  };
}
