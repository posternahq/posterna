import type { AgentRecord, OperatorRecord, Purpose } from "../directory/types";
import { compilePatterns } from "./paths";
import { type ActionSpec, type Policy, PURPOSES } from "./types";

/** Purposes that map to a Content Signal (https://contentsignals.org/), in the order the lines list them. */
const SIGNALS: readonly { signal: string; purpose: Purpose }[] = [
  { signal: "ai-train", purpose: "training" },
  { signal: "search", purpose: "search" },
  { signal: "ai-input", purpose: "user_fetch" },
];

const SECTION_TITLES: Record<Purpose, string> = {
  training: "Training",
  search: "Search",
  user_fetch: "User-initiated fetches",
  agent: "Agents",
  preview: "Link previews",
  ads: "Ads",
  other: "Other",
};

/** A policy path pattern as a robots.txt path (RFC 9309): exact patterns end in `$`, a trailing `*` is dropped. */
export function robotsPath(pattern: string): string {
  if (!pattern.includes("*")) return `${pattern}$`;
  return pattern.replace(/\*+$/, "") || "/";
}

function signalValue(spec: ActionSpec): "yes" | "no" {
  return spec.action === "block" ? "no" : "yes";
}

/**
 * Content-Signal values from the policy's `purposes` and path rules:
 * `training` sets ai-train, `search` sets search, `user_fetch` sets ai-input.
 * Block means `no`; allow and throttle mean `yes`; a purpose with no rule sends
 * no signal, which means no preference. Returns the lines without the
 * `User-agent` line they belong under.
 */
export function contentSignalLines(policy: Policy): string[] {
  const line = (rules: Partial<Record<Purpose, ActionSpec>>, prefix: string) => {
    const values = SIGNALS.flatMap(({ signal, purpose }) => {
      const spec = rules[purpose];
      return spec ? [`${signal}=${signalValue(spec)}`] : [];
    });
    return values.length > 0 ? [`Content-Signal: ${prefix}${values.join(", ")}`] : [];
  };
  return [
    ...line(policy.purposes, ""),
    ...policy.paths.flatMap((rule) => line(rule.rules, `${robotsPath(rule.pattern)} `)),
  ];
}

type Verb = "Allow" | "Disallow";

/** Plain code-unit order, so output does not depend on the machine's locale. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * What the policy does with this agent when it is verified, as robots.txt
 * lines. Path rules use the same precedence as the engine: within a rule the
 * `verified` key beats the purpose key; across rules robots.txt's own
 * longest-match picks the most specific.
 */
function agentLines(policy: Policy, operator: OperatorRecord, agent: AgentRecord): string[] {
  const purpose = agent.purpose;
  const base =
    policy.operators[operator.slug]?.[purpose] ??
    policy.purposes[purpose] ??
    policy.defaults.verified;
  let baseVerb: Verb = base?.action === "block" ? "Disallow" : "Allow";
  // Least specific first, so a nested rule is compared with what already covers it.
  const entries = compilePatterns(
    policy.paths.map((rule) => ({ pattern: rule.pattern, value: rule })),
  )
    .reverse()
    .flatMap((entry) => {
      const spec = entry.value.rules.verified ?? entry.value.rules[purpose];
      return spec
        ? [
            {
              path: robotsPath(entry.pattern),
              verb: (spec.action === "block" ? "Disallow" : "Allow") as Verb,
            },
          ]
        : [];
    });
  const lines: { path: string; verb: Verb }[] = [];
  for (const entry of entries) {
    if (entry.path === "/") {
      baseVerb = entry.verb;
      continue;
    }
    const covering = lines
      .filter(
        (line) => entry.path.startsWith(line.path.replace(/\$$/, "")) && !line.path.endsWith("$"),
      )
      .sort((a, b) => b.path.length - a.path.length)[0];
    const current = covering?.verb ?? baseVerb;
    // A rule that says what already covers it adds nothing.
    if (entry.verb !== current && !lines.some((line) => line.path === entry.path))
      lines.push(entry);
  }
  if (baseVerb === "Allow" && lines.length === 0) return [];
  const sorted = [...lines].sort((a, b) => compare(a.path, b.path));
  return [
    ...(baseVerb === "Disallow" ? ["Disallow: /"] : []),
    ...sorted.map((line) => `${line.verb}: ${line.path}`),
  ];
}

export interface RobotsOptions {
  /** Shown in the header comment when given, for example from `engine.hash()`. */
  policyHash?: string | null;
}

/**
 * Writes robots.txt from a policy and the operator directory (docs/SPEC.md
 * section 5.6). What it includes follows the policy's `emit` list:
 *
 * - `robots.txt`: one group per robots token for agents that honor
 *   robots.txt, grouped by purpose, from the rules that apply to the agent
 *   when verified. Agents the policy allows everywhere get no group. With
 *   `guards.search_engines: protect`, search engines get none either, because
 *   the guard never lets them be blocked. Throttle cannot be said in
 *   robots.txt, so it counts as allow. A token shared by several agents is
 *   written once, under the first.
 * - `content-signals`: Content-Signal lines in the `User-agent: *` group.
 *
 * The file reflects the rules whatever the mode: it states the site's
 * preferences, which crawlers apply themselves.
 */
export function emitRobots(
  policy: Policy,
  operators: readonly OperatorRecord[],
  options: RobotsOptions = {},
): string {
  const robots = policy.emit.includes("robots.txt");
  const signals = policy.emit.includes("content-signals") ? contentSignalLines(policy) : [];
  const out: string[] = [
    `# robots.txt written by Posterna from agents.yaml${options.policyHash ? ` (policy ${options.policyHash})` : ""}.`,
    "# Crawlers that honor robots.txt are asked to stay out of what the policy blocks.",
    "# The site's policy engine enforces against agents that do not.",
  ];
  if (signals.length > 0) {
    out.push("# Content-Signal lines state how content may be used: https://contentsignals.org/");
  }
  if (!robots && !policy.emit.includes("content-signals")) {
    out.push(
      "# agents.yaml emits nothing. Add emit: [robots.txt, content-signals] to write rules here.",
    );
  }
  out.push("", "User-agent: *", ...signals, "Allow: /");

  if (robots) {
    const seen = new Set<string>();
    for (const purpose of PURPOSES) {
      const groups = new Map<string, string[]>();
      for (const operator of operators) {
        for (const agent of operator.agents) {
          if (agent.purpose !== purpose || agent.robots_policy !== "honors" || !agent.robots_token)
            continue;
          if (policy.guards.search_engines === "protect" && agent.search_engine) continue;
          const token = agent.robots_token;
          if (seen.has(token.toLowerCase())) continue;
          const lines = agentLines(policy, operator, agent);
          if (lines.length === 0) continue;
          seen.add(token.toLowerCase());
          const key = lines.join("\n");
          groups.set(key, [...(groups.get(key) ?? []), token]);
        }
      }
      if (groups.size === 0) continue;
      out.push("", `# ${SECTION_TITLES[purpose]}`);
      const ordered = [...groups.entries()]
        .map(([lines, tokens]) => ({
          lines,
          tokens: tokens.sort((a, b) => compare(a.toLowerCase(), b.toLowerCase())),
        }))
        .sort((a, b) =>
          compare((a.tokens[0] as string).toLowerCase(), (b.tokens[0] as string).toLowerCase()),
        );
      ordered.forEach((group, index) => {
        if (index > 0) out.push("");
        for (const token of group.tokens) out.push(`User-agent: ${token}`);
        out.push(group.lines);
      });
    }
  }
  return `${out.join("\n")}\n`;
}
