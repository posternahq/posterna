import { isMap, isPair, isScalar, LineCounter, parseDocument } from "yaml";
import type { Purpose } from "../directory/types";
import {
  type ActionSpec,
  type Emitter,
  type PathRule,
  type Policy,
  PURPOSES,
  type Rate,
  type SignupAction,
  type SignupScope,
  VERDICT_CLASSES,
  type VerdictClass,
} from "./types";

/** One problem found in agents.yaml. Lines and columns are 1-based; null when parsing an object. */
export interface PolicyIssue {
  severity: "error" | "warning";
  message: string;
  /** Dotted location, for example `operators.openai.agent`. */
  path: string;
  line: number | null;
  column: number | null;
}

/** Thrown by {@link parsePolicy} with every error found, not just the first. */
export class PolicyError extends Error {
  constructor(readonly issues: PolicyIssue[]) {
    super(issues.map(formatIssue).join("\n"));
    this.name = "PolicyError";
  }
}

export function formatIssue(issue: PolicyIssue): string {
  const where = issue.line === null ? "" : `line ${issue.line}, column ${issue.column}: `;
  return `${where}${issue.message}`;
}

type Key = string | number;
type Locate = (
  path: readonly Key[],
  at: "key" | "value",
) => { line: number; column: number } | null;

const TOP_LEVEL = [
  "version",
  "mode",
  "defaults",
  "guards",
  "purposes",
  "operators",
  "paths",
  "signup",
  "emit",
];
const PAGE_ACTIONS = ["allow", "block", "throttle"];
const SIGNUP_ACTIONS: readonly SignupAction[] = ["allow", "lift", "cap", "challenge"];
const EMITTERS: readonly Emitter[] = ["robots.txt", "content-signals"];
const RATE_UNITS = { sec: 1, min: 60, hour: 3600 } as const;
/** Highest count a rate may have, which keeps the token bucket arithmetic exact. */
export const MAX_RATE_COUNT = 1_000_000;

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0] as number;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j] as number;
      row[j] = Math.min(
        current + 1,
        (row[j - 1] as number) + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      previous = current;
    }
  }
  return row[b.length] as number;
}

function suggest(value: string, options: readonly string[]): string {
  const best = options
    .map((option) => ({ option, score: distance(value.toLowerCase(), option.toLowerCase()) }))
    .sort((a, b) => a.score - b.score)[0];
  return best && best.score <= 2 ? ` Did you mean "${best.option}"?` : "";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Parses a rate such as `60/min`. Returns null when it is not one. */
export function parseRate(text: string): Rate | null {
  const match = /^\s*(\d+)\s*\/\s*(sec|min|hour)\s*$/.exec(text);
  if (!match) return null;
  const count = Number(match[1]);
  const per = match[2] as Rate["per"];
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_RATE_COUNT) return null;
  return { count, per, seconds: RATE_UNITS[per], text: `${count}/${per}` };
}

class Validator {
  readonly issues: PolicyIssue[] = [];

  constructor(private readonly locate: Locate) {}

  private report(
    severity: PolicyIssue["severity"],
    path: readonly Key[],
    message: string,
    at: "key" | "value",
  ) {
    const position = this.locate(path, at);
    this.issues.push({
      severity,
      message,
      path: path.join("."),
      line: position?.line ?? null,
      column: position?.column ?? null,
    });
  }

  error(path: readonly Key[], message: string, at: "key" | "value" = "value") {
    this.report("error", path, message, at);
  }

  warning(path: readonly Key[], message: string, at: "key" | "value" = "value") {
    this.report("warning", path, message, at);
  }

  mapping(value: unknown, path: readonly Key[], what: string): Record<string, unknown> | null {
    if (value === undefined || value === null) return {};
    if (!isRecord(value)) {
      this.error(path, `${what} must be a mapping of keys to values.`);
      return null;
    }
    return value;
  }

  keys(
    map: Record<string, unknown>,
    path: readonly Key[],
    allowed: readonly string[],
    where: string,
  ) {
    for (const key of Object.keys(map)) {
      if (allowed.includes(key)) continue;
      if (key === "human") {
        this.error([...path, key], "human is always allowed and cannot be configured.", "key");
      } else {
        this.error(
          [...path, key],
          `Unknown key "${key}" in ${where}.${suggest(key, allowed)}`,
          "key",
        );
      }
    }
  }

  action(value: unknown, path: readonly Key[]): ActionSpec | null {
    const where = path.join(".");
    if (typeof value === "string") {
      if (value === "allow" || value === "block") return { action: value };
      if (value === "throttle") {
        this.error(
          path,
          `${where}: throttle needs a rate, for example { action: throttle, rate: 60/min }.`,
        );
        return null;
      }
      if ((SIGNUP_ACTIONS as readonly string[]).includes(value)) {
        this.error(path, `${where}: "${value}" is a sign-up action; use it under signup.`);
        return null;
      }
      this.error(
        path,
        `${where}: unknown action "${value}" (expected allow, block or throttle).${suggest(value, PAGE_ACTIONS)}`,
      );
      return null;
    }
    if (!isRecord(value)) {
      this.error(
        path,
        `${where}: expected an action such as block, or { action: throttle, rate: 60/min }.`,
      );
      return null;
    }
    this.keys(value, path, ["action", "rate"], where);
    const action = value.action;
    if (action !== "allow" && action !== "block" && action !== "throttle") {
      this.error(
        [...path, "action"],
        `${where}.action must be allow, block or throttle.`,
        value.action === undefined ? "key" : "value",
      );
      return null;
    }
    if (action === "throttle") {
      if (typeof value.rate !== "string") {
        this.error(path, `${where}: throttle needs a rate such as 60/min.`);
        return null;
      }
      const rate = parseRate(value.rate);
      if (!rate) {
        this.error(
          [...path, "rate"],
          `${where}.rate "${value.rate}" must look like 60/min: a whole number from 1 to 1,000,000 per sec, min or hour.`,
        );
        return null;
      }
      return { action, rate };
    }
    if (value.rate !== undefined) {
      this.error([...path, "rate"], `${where}.rate only applies to throttle.`, "key");
      return null;
    }
    return { action };
  }

  actionMap<K extends string>(
    value: unknown,
    path: readonly Key[],
    allowed: readonly K[],
    where: string,
  ): Partial<Record<K, ActionSpec>> {
    const map = this.mapping(value, path, where);
    const out: Partial<Record<K, ActionSpec>> = {};
    if (!map) return out;
    this.keys(map, path, allowed, where);
    for (const key of allowed) {
      if (map[key] === undefined) continue;
      const spec = this.action(map[key], [...path, key]);
      if (spec) out[key] = spec;
    }
    return out;
  }

  pattern(pattern: string, path: readonly Key[]): boolean {
    if (!pattern.startsWith("/")) {
      this.error(path, `Path pattern "${pattern}" must start with "/".`, "key");
      return false;
    }
    if (/[?#\s]/.test(pattern)) {
      this.error(
        path,
        `Path pattern "${pattern}" must not contain a query, fragment or spaces.`,
        "key",
      );
      return false;
    }
    return true;
  }
}

function validate(value: unknown, locate: Locate, knownOperators: Iterable<string> | undefined) {
  const known = knownOperators ? new Set(knownOperators) : null;
  const v = new Validator(locate);
  if (value === null || value === undefined) {
    v.error([], "agents.yaml is empty. Start from a template, for example `posterna init`.");
    return { policy: null, issues: v.issues };
  }
  const root = v.mapping(value, [], "agents.yaml");
  if (!root) return { policy: null, issues: v.issues };
  v.keys(root, [], TOP_LEVEL, "agents.yaml");

  if (root.version === undefined) v.error([], "version is required and must be 1.", "key");
  else if (root.version !== 1)
    v.error(["version"], `version must be 1 (got ${JSON.stringify(root.version)}).`);

  let mode: Policy["mode"] = "monitor";
  if (root.mode !== undefined) {
    if (root.mode === "monitor" || root.mode === "enforce") mode = root.mode;
    else
      v.error(
        ["mode"],
        `mode must be monitor or enforce (got ${JSON.stringify(root.mode)}).${suggest(String(root.mode), ["monitor", "enforce"])}`,
      );
  }

  const defaults = v.actionMap(root.defaults, ["defaults"], VERDICT_CLASSES, "defaults");

  const guards: Policy["guards"] = { search_engines: "protect" };
  const guardMap = v.mapping(root.guards, ["guards"], "guards");
  if (guardMap) {
    v.keys(guardMap, ["guards"], ["search_engines"], "guards");
    const value = guardMap.search_engines;
    if (value === "protect" || value === "off") guards.search_engines = value;
    else if (value !== undefined)
      v.error(["guards", "search_engines"], "guards.search_engines must be protect or off.");
  }

  const purposes = v.actionMap(root.purposes, ["purposes"], PURPOSES, "purposes");

  const operators: Policy["operators"] = {};
  const operatorMap = v.mapping(root.operators, ["operators"], "operators");
  for (const [slug, rules] of Object.entries(operatorMap ?? {})) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
      v.error(
        ["operators", slug],
        `Operator "${slug}" must be a directory slug: lowercase letters, digits and hyphens.`,
        "key",
      );
      continue;
    }
    if (known && !known.has(slug)) {
      v.warning(
        ["operators", slug],
        `Operator "${slug}" is not in the operator directory, so this rule never matches.${suggest(slug, [...known])}`,
        "key",
      );
    }
    operators[slug] = v.actionMap(rules, ["operators", slug], PURPOSES, `operators.${slug}`);
  }

  const paths: PathRule[] = [];
  const pathMap = v.mapping(root.paths, ["paths"], "paths");
  for (const [pattern, raw] of Object.entries(pathMap ?? {})) {
    if (!v.pattern(pattern, ["paths", pattern])) continue;
    const rule = v.mapping(raw, ["paths", pattern], `paths."${pattern}"`);
    if (!rule) continue;
    const allowed = [...VERDICT_CLASSES, ...PURPOSES, "monitor"] as const;
    v.keys(rule, ["paths", pattern], allowed, `paths."${pattern}"`);
    if (rule.monitor !== undefined && typeof rule.monitor !== "boolean") {
      v.error(["paths", pattern, "monitor"], `paths."${pattern}".monitor must be true or false.`);
    }
    const rules: PathRule["rules"] = {};
    for (const key of [...VERDICT_CLASSES, ...PURPOSES] as (VerdictClass | Purpose)[]) {
      if (rule[key] === undefined) continue;
      const spec = v.action(rule[key], ["paths", pattern, key]);
      if (spec) rules[key] = spec;
    }
    if (Object.keys(rule).filter((key) => key !== "monitor").length === 0) {
      v.warning(
        ["paths", pattern],
        `paths."${pattern}" has no rules, so it never changes a decision.`,
        "key",
      );
    }
    paths.push({ pattern, rules, monitor: rule.monitor === true });
  }

  const signup: SignupScope[] = [];
  const signupMap = v.mapping(root.signup, ["signup"], "signup");
  for (const [pattern, raw] of Object.entries(signupMap ?? {})) {
    if (!v.pattern(pattern, ["signup", pattern])) continue;
    const scope = v.mapping(raw, ["signup", pattern], `signup."${pattern}"`);
    if (!scope) continue;
    v.keys(scope, ["signup", pattern], VERDICT_CLASSES, `signup."${pattern}"`);
    const rules: SignupScope["rules"] = {};
    for (const key of VERDICT_CLASSES) {
      const value = scope[key];
      if (value === undefined) continue;
      if (typeof value === "string" && (SIGNUP_ACTIONS as readonly string[]).includes(value)) {
        rules[key] = value as SignupAction;
      } else {
        const hint =
          value === "block" || value === "throttle"
            ? " Block and throttle belong under paths; sign-up scopes recommend."
            : "";
        v.error(
          ["signup", pattern, key],
          `signup."${pattern}".${key} must be lift, cap, challenge or allow.${hint}${suggest(String(value), SIGNUP_ACTIONS)}`,
        );
      }
    }
    signup.push({ pattern, rules });
  }

  const emit: Emitter[] = [];
  if (root.emit !== undefined) {
    if (!Array.isArray(root.emit))
      v.error(["emit"], "emit must be a list, for example [robots.txt, content-signals].");
    else {
      root.emit.forEach((item, index) => {
        if ((EMITTERS as readonly unknown[]).includes(item)) {
          if (!emit.includes(item as Emitter)) emit.push(item as Emitter);
        } else
          v.error(
            ["emit", index],
            `emit entries must be robots.txt or content-signals (got ${JSON.stringify(item)}).`,
          );
      });
    }
  }

  // Operator and purpose rules come before defaults (docs/SPEC.md section 5.3), so a
  // looser one also applies to unverified and failed claims of that operator or
  // purpose. That is easy to miss, so point it out.
  const strictness = { allow: 0, throttle: 1, block: 2 } as const;
  for (const cls of ["declared_unverifiable", "claimed_failed"] as const) {
    const fallback = defaults[cls];
    if (!fallback || fallback.action === "allow") continue;
    if (paths.some((rule) => rule.pattern === "/*" && rule.rules[cls])) continue;
    const looser: [Key[], ActionSpec][] = [
      ...Object.entries(purposes).map(([purpose, spec]): [Key[], ActionSpec] => [
        ["purposes", purpose],
        spec,
      ]),
      ...Object.entries(operators).flatMap(([slug, rules]) =>
        Object.entries(rules).map(([purpose, spec]): [Key[], ActionSpec] => [
          ["operators", slug, purpose],
          spec,
        ]),
      ),
    ];
    for (const [path, spec] of looser) {
      if (strictness[spec.action] >= strictness[fallback.action]) continue;
      v.warning(
        path,
        `${path.join(".")} (${spec.action}) is checked before defaults.${cls} (${fallback.action}), so ${cls} claims it covers get ${spec.action}. To ${fallback.action} them anyway, add a path rule such as "/*": { ${cls}: ${fallback.action === "throttle" ? "{ action: throttle, rate: ... }" : "block"} }.`,
        "key",
      );
    }
  }

  const failed = v.issues.some((issue) => issue.severity === "error");
  const policy: Policy | null = failed
    ? null
    : { version: 1, mode, defaults, guards, purposes, operators, paths, signup, emit };
  return { policy, issues: v.issues };
}

export interface CheckOptions {
  /** Directory slugs; operators outside this list produce warnings. */
  knownOperators?: Iterable<string>;
}

export interface CheckResult {
  policy: Policy | null;
  errors: PolicyIssue[];
  warnings: PolicyIssue[];
}

/** Parses and validates agents.yaml text without throwing. Used by `posterna policy check`. */
export function checkPolicy(text: string, options: CheckOptions = {}): CheckResult {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter, prettyErrors: false, uniqueKeys: true });
  const position = (offset: number) => {
    const { line, col } = lineCounter.linePos(offset);
    return { line, column: col };
  };
  if (document.errors.length > 0) {
    return {
      policy: null,
      errors: document.errors.map((error) => {
        const at = position(error.pos[0]);
        return {
          severity: "error",
          message: `YAML syntax: ${error.message.split("\n")[0]}`,
          path: "",
          line: at.line,
          column: at.column,
        };
      }),
      warnings: [],
    };
  }
  const locate: Locate = (path, at) => {
    if (path.length === 0) return position(0);
    const parent = path.length > 1 ? document.getIn(path.slice(0, -1), true) : document.contents;
    const last = path[path.length - 1];
    if (isMap(parent)) {
      const pair = parent.items.find(
        (item) => isPair(item) && isScalar(item.key) && item.key.value === last,
      );
      const node = at === "key" ? pair?.key : (pair?.value ?? pair?.key);
      const range = (node as { range?: [number, number, number] } | null | undefined)?.range;
      if (range) return position(range[0]);
      const parentRange = (parent as { range?: [number, number, number] }).range;
      return parentRange ? position(parentRange[0]) : null;
    }
    const node = document.getIn(path, true) as { range?: [number, number, number] } | undefined;
    return node?.range ? position(node.range[0]) : null;
  };
  const { policy, issues } = validate(document.toJS(), locate, options.knownOperators);
  return {
    policy,
    errors: issues.filter((issue) => issue.severity === "error"),
    warnings: issues.filter((issue) => issue.severity === "warning"),
  };
}

/** Parses and validates agents.yaml text. Throws {@link PolicyError} listing every error, with line numbers. */
export function parsePolicy(text: string, options: CheckOptions = {}): Policy {
  const result = checkPolicy(text, options);
  if (!result.policy) throw new PolicyError(result.errors);
  return result.policy;
}

/** Validates a policy that is already a plain object (for example agents.yaml converted to JSON at build time). */
export function policyFromObject(value: unknown, options: CheckOptions = {}): Policy {
  const { policy, issues } = validate(value, () => null, options.knownOperators);
  if (!policy) throw new PolicyError(issues.filter((issue) => issue.severity === "error"));
  return policy;
}
