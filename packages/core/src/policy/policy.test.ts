import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import pkg from "../../package.json";
import type { DirectoryFile, KeysFile, OperatorRecord } from "../directory/types";
import type { VerdictResult } from "../verifier/types";
import { createVerifier } from "../verifier/verifier";
import { emitRobots } from "./emit";
import { createPolicyEngine, type PolicyVerifier } from "./engine";
import { canonicalJson } from "./hash";
import {
  checkPolicy,
  formatIssue,
  PolicyError,
  parsePolicy,
  parseRate,
  policyFromObject,
} from "./parse";
import { compilePatterns, matchingPatterns } from "./paths";
import { enforcementResponse } from "./respond";
import { TEMPLATE_NAMES } from "./templates";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = join(HERE, "..", "..");
const REPO = join(PACKAGE, "..", "..");
const json = <T>(...parts: string[]) => JSON.parse(readFileSync(join(...parts), "utf8")) as T;
const fixtureDirectory = json<DirectoryFile>(REPO, "conformance", "fixtures", "directory.json");
const fixtureKeys = json<KeysFile>(REPO, "conformance", "fixtures", "keys.json");
const template = (name: string) => readFileSync(join(PACKAGE, "templates", `${name}.yaml`), "utf8");

const lookup = (operators: readonly OperatorRecord[]): PolicyVerifier => {
  const bySlug = new Map(operators.map((operator) => [operator.slug, operator]));
  return { state: () => ({ proxySuspect: false }), operator: (slug) => bySlug.get(slug) };
};
const fixtureVerifier = lookup(fixtureDirectory.operators);

const failedExampleBot: VerdictResult = {
  verdict: "claimed_failed",
  operator: "ip-crawler",
  agent: "ExampleBot",
  purpose: "search",
  method: "ip",
};
const verifiedExampleBot: VerdictResult = { ...failedExampleBot, verdict: "verified_by_ip" };

afterEach(() => {
  vi.useRealTimers();
});

describe("parsing agents.yaml", () => {
  it("parses the SPEC 5.1 example", () => {
    const policy = parsePolicy(`version: 1
mode: monitor              # monitor | enforce
defaults:                  # by verdict class; human is always allowed and not configurable
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
    monitor: true          # this rule logs what it would do even when mode is enforce
signup:                    # recommendations returned by decide(); the application enforces them
  "/signup":
    verified: lift
    claimed_failed: challenge
    unknown_automation: challenge
emit: [robots.txt, content-signals]
`);
    expect(policy).toEqual({
      version: 1,
      mode: "monitor",
      defaults: {
        verified: { action: "allow" },
        declared_unverifiable: { action: "allow" },
        claimed_failed: { action: "allow" },
        unknown_automation: { action: "allow" },
      },
      guards: { search_engines: "protect" },
      purposes: { training: { action: "block" } },
      operators: {
        openai: {
          agent: {
            action: "throttle",
            rate: { count: 60, per: "min", seconds: 60, text: "60/min" },
          },
        },
      },
      paths: [{ pattern: "/api/*", rules: { claimed_failed: { action: "block" } }, monitor: true }],
      signup: [
        {
          pattern: "/signup",
          rules: { verified: "lift", claimed_failed: "challenge", unknown_automation: "challenge" },
        },
      ],
      emit: ["robots.txt", "content-signals"],
    });
  });

  it("defaults to monitor mode and the protect guard", () => {
    const policy = parsePolicy("version: 1\n");
    expect(policy.mode).toBe("monitor");
    expect(policy.guards.search_engines).toBe("protect");
    expect(policy.emit).toEqual([]);
  });

  it("reads rates", () => {
    expect(parseRate("60/min")).toEqual({ count: 60, per: "min", seconds: 60, text: "60/min" });
    expect(parseRate(" 5 / sec ")).toEqual({ count: 5, per: "sec", seconds: 1, text: "5/sec" });
    expect(parseRate("2/hour")?.seconds).toBe(3600);
    for (const bad of [
      "0/min",
      "1/day",
      "1.5/min",
      "-1/min",
      "1000001/sec",
      "ten/min",
      "60/m",
      "",
    ]) {
      expect(parseRate(bad), bad).toBeNull();
    }
  });

  it("reports every error at once, with line and column", () => {
    const text = `version: 1
mode: enforced
defaults:
  verifed: allow
purposes:
  trainng: block
  search: throttle
`;
    const result = checkPolicy(text);
    expect(result.policy).toBeNull();
    expect(result.errors.map(formatIssue)).toEqual([
      'line 2, column 7: mode must be monitor or enforce (got "enforced"). Did you mean "enforce"?',
      'line 4, column 3: Unknown key "verifed" in defaults. Did you mean "verified"?',
      'line 6, column 3: Unknown key "trainng" in purposes. Did you mean "training"?',
      "line 7, column 11: purposes.search: throttle needs a rate, for example { action: throttle, rate: 60/min }.",
    ]);
    expect(() => parsePolicy(text)).toThrow(PolicyError);
    try {
      parsePolicy(text);
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyError);
      expect((error as PolicyError).issues).toHaveLength(4);
      expect((error as PolicyError).message.split("\n")).toHaveLength(4);
    }
  });

  it("explains the rules people are likely to get wrong", () => {
    const messages = (text: string) => checkPolicy(text).errors.map((issue) => issue.message);
    expect(messages("version: 1\ndefaults:\n  human: block\n")).toEqual([
      "human is always allowed and cannot be configured.",
    ]);
    expect(messages('version: 1\nsignup:\n  "/signup":\n    claimed_failed: block\n')[0]).toContain(
      "Block and throttle belong under paths",
    );
    expect(messages("version: 1\npurposes:\n  training: challenge\n")[0]).toContain(
      "is a sign-up action",
    );
    expect(
      messages("version: 1\npurposes:\n  training: { action: block, rate: 1/min }\n")[0],
    ).toContain("only applies to throttle");
    expect(messages('version: 1\npaths:\n  "/api?x=1":\n    verified: block\n')[0]).toContain(
      "must not contain a query",
    );
    expect(messages("mode: monitor\n")[0]).toBe("version is required and must be 1.");
    expect(messages("")[0]).toContain("agents.yaml is empty");
    expect(messages("- just\n- a list\n")[0]).toContain("must be a mapping");
  });

  it("reports YAML syntax errors with their position", () => {
    const duplicate = checkPolicy("version: 1\nmode: monitor\nmode: enforce\n");
    expect(duplicate.policy).toBeNull();
    expect(duplicate.errors[0]).toMatchObject({ line: 3, column: 1 });
    expect(duplicate.errors[0]?.message).toMatch(/^YAML syntax: .*unique/);
    const broken = checkPolicy("version: 1\npaths: [\n");
    expect(broken.policy).toBeNull();
    expect(broken.errors[0]?.message).toMatch(/^YAML syntax:/);
    expect(broken.errors[0]?.line).toBeGreaterThanOrEqual(2);
  });

  it("warns about operators outside the directory and rules that loosen failed claims", () => {
    const result = checkPolicy(
      `version: 1
defaults:
  claimed_failed: block
purposes:
  search: allow
operators:
  open-ai:
    agent: block
paths:
  "/empty":
`,
      { knownOperators: ["openai", "google"] },
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings.map(formatIssue)).toEqual([
      'line 7, column 3: Operator "open-ai" is not in the operator directory, so this rule never matches. Did you mean "openai"?',
      'line 10, column 3: paths."/empty" has no rules, so it never changes a decision.',
      'line 5, column 3: purposes.search (allow) is checked before defaults.claimed_failed (block), so claimed_failed claims it covers get allow. To block them anyway, add a path rule such as "/*": { claimed_failed: block }.',
    ]);
    const fixed = checkPolicy(
      'version: 1\ndefaults:\n  claimed_failed: block\npurposes:\n  search: allow\npaths:\n  "/*":\n    claimed_failed: block\n',
    );
    expect(fixed.warnings).toEqual([]);
  });

  it("accepts an object already parsed, for runtimes that bundle the policy as JSON", () => {
    const fromText = parsePolicy(template("saas-signup"));
    expect(policyFromObject(parseYaml(template("saas-signup")))).toEqual(fromText);
    expect(() => policyFromObject({ version: 1, mode: "loud" })).toThrow(
      /mode must be monitor or enforce/,
    );
    try {
      policyFromObject({ version: 1, mode: "loud" });
    } catch (error) {
      expect((error as PolicyError).issues[0]).toMatchObject({ path: "mode", line: null });
    }
  });
});

describe("the agents.yaml JSON Schema", () => {
  const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
  const validate = ajv.compile(json(PACKAGE, "src", "schema", "agents.schema.json"));

  const listJson = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return listJson(path);
      return name.endsWith(".json") ? [path] : [];
    });

  /** Every policy document in the conformance vectors, plus the templates. */
  const corpus: string[] = [
    ...TEMPLATE_NAMES.map(template),
    ...listJson(join(REPO, "conformance", "vectors")).flatMap((path) => {
      const vector = JSON.parse(readFileSync(path, "utf8")) as {
        policy?: string;
        cases?: { policy: string }[];
      };
      return [
        ...(vector.policy ? [vector.policy] : []),
        ...(vector.cases ?? []).map((test) => test.policy),
      ];
    }),
  ];

  it("agrees with the parser on every policy in the conformance suite", () => {
    let checked = 0;
    for (const text of corpus) {
      const result = checkPolicy(text);
      if (result.errors.some((issue) => issue.message.startsWith("YAML syntax"))) continue;
      const value = parseYaml(text) ?? null;
      expect(validate(value), `${text}\n${JSON.stringify(validate.errors)}`).toBe(
        result.policy !== null,
      );
      checked++;
    }
    expect(checked).toBeGreaterThan(40);
  });
});

describe("path patterns", () => {
  it("orders matches from most to least specific", () => {
    const compiled = compilePatterns(
      ["/*", "/api/*", "/api/v1/*", "/api/v1/users", "/api/*/users", "/a*b*"].map((pattern) => ({
        pattern,
        value: pattern,
      })),
    );
    expect(matchingPatterns(compiled, "/api/v1/users").map((entry) => entry.pattern)).toEqual([
      "/api/v1/users",
      "/api/*/users",
      "/api/v1/*",
      "/api/*",
      "/*",
    ]);
    expect(matchingPatterns(compiled, "/abc").map((entry) => entry.pattern)).toEqual([
      "/a*b*",
      "/*",
    ]);
    expect(matchingPatterns(compiled, "/").map((entry) => entry.pattern)).toEqual(["/*"]);
  });

  it("treats regular expression characters literally", () => {
    const compiled = compilePatterns([{ pattern: "/a.b+(c)", value: 1 }]);
    expect(matchingPatterns(compiled, "/a.b+(c)")).toHaveLength(1);
    expect(matchingPatterns(compiled, "/aXbb(c)")).toHaveLength(0);
  });
});

describe("the policy engine", () => {
  const enforce = (body: string) => `version: 1\nmode: enforce\n${body}`;

  it("trips and recovers the breaker on the wall clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
    const engine = createPolicyEngine(enforce("defaults:\n  claimed_failed: block\n"), {
      verifier: fixtureVerifier,
      env: {},
    });
    for (let i = 0; i < 10; i++) engine.decide(verifiedExampleBot, { path: "/" });
    for (let i = 0; i < 9; i++)
      expect(engine.decide(failedExampleBot, { path: "/" }).enforced).toBe(true);
    const tripping = engine.decide(failedExampleBot, { path: "/" });
    expect(tripping).toMatchObject({ action: "block", enforced: false });
    expect(tripping.reason).toContain("the breaker is tripped for ip-crawler");
    expect(engine.state().breakerTripped).toEqual(["ip-crawler"]);

    vi.advanceTimersByTime(59 * 60 * 1000);
    expect(engine.state().breakerTripped).toEqual(["ip-crawler"]);
    expect(engine.decide(failedExampleBot, { path: "/" }).enforced).toBe(false);

    vi.advanceTimersByTime(60 * 1000);
    expect(engine.state().breakerTripped).toEqual([]);
    expect(engine.decide(failedExampleBot, { path: "/" }).enforced).toBe(true);
  });

  it("forgets claims older than 10 minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
    const engine = createPolicyEngine(enforce("defaults:\n  claimed_failed: block\n"), {
      verifier: fixtureVerifier,
      env: {},
    });
    for (let i = 0; i < 19; i++) engine.decide(failedExampleBot, { path: "/" });
    vi.advanceTimersByTime(11 * 60 * 1000);
    expect(engine.decide(failedExampleBot, { path: "/" }).enforced).toBe(true);
    expect(engine.state().breakerTripped).toEqual([]);
  });

  it("refills throttle buckets on the wall clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
    const engine = createPolicyEngine(
      enforce("defaults:\n  unknown_automation: { action: throttle, rate: 1/sec }\n"),
      {
        env: {},
      },
    );
    const unknown: VerdictResult = { verdict: "unknown_automation", method: "none" };
    expect(engine.decide(unknown, { path: "/" }).action).toBe("allow");
    expect(engine.decide(unknown, { path: "/" })).toMatchObject({
      action: "throttle",
      retryAfter: 1,
    });
    vi.advanceTimersByTime(999);
    expect(engine.decide(unknown, { path: "/" }).action).toBe("throttle");
    vi.advanceTimersByTime(1);
    expect(engine.decide(unknown, { path: "/" }).action).toBe("allow");
  });

  it("reads the kill switch from process.env by default", () => {
    vi.stubEnv("POSTERNA_MODE", "monitor");
    try {
      const engine = createPolicyEngine(enforce("purposes:\n  training: block\n"));
      expect(engine.state()).toMatchObject({ mode: "monitor", suspensions: ["env"] });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("without a directory lookup, protects every claimed agent as a possible search engine", () => {
    const engine = createPolicyEngine(
      enforce("defaults:\n  claimed_failed: block\npurposes:\n  training: block\n"),
      {
        env: {},
      },
    );
    const claudebot: VerdictResult = {
      verdict: "verified_by_ip",
      operator: "anthropic",
      agent: "ClaudeBot",
      purpose: "training",
      method: "ip",
    };
    expect(engine.decide({ ...claudebot, verdict: "claimed_failed" }, { path: "/" }).guarded).toBe(
      true,
    );
    expect(engine.decide(claudebot, { path: "/" }).rule).toBe("guards.search_engines");
    expect(engine.decide({ verdict: "unknown_automation" }, { path: "/" }).action).toBe("allow");
  });

  it("fails open when the verifier it consults throws", () => {
    const engine = createPolicyEngine(enforce("purposes:\n  training: block\n"), {
      verifier: {
        state: () => {
          throw new Error("boom");
        },
        operator: () => undefined,
      },
      env: {},
    });
    const decision = engine.decide(
      { verdict: "verified_by_ip", operator: "x", agent: "X", purpose: "training", method: "ip" },
      { path: "/" },
    );
    expect(decision).toMatchObject({ action: "allow", enforced: false, error: "boom" });
    expect(engine.state().errors).toBe(1);
  });

  it("keeps the throttle state bounded", () => {
    const engine = createPolicyEngine(
      enforce("defaults:\n  claimed_failed: { action: throttle, rate: 1/hour }\n"),
      {
        verifier: fixtureVerifier,
        env: {},
      },
    );
    for (let i = 0; i < 20_000; i++) {
      engine.decide(
        { verdict: "claimed_failed", operator: `op-${i}`, method: "signature" },
        { path: "/" },
      );
    }
    // The first operator's bucket was evicted, so it starts full again.
    expect(
      engine.decide(
        { verdict: "claimed_failed", operator: "op-0", method: "signature" },
        { path: "/" },
      ).action,
    ).toBe("allow");
  });

  it("hashes the policy, not its formatting", async () => {
    const a = createPolicyEngine("version: 1\npurposes:\n  training: block\n", { env: {} });
    const b = createPolicyEngine(
      "# a comment\nversion: 1\npurposes: { training: block }\nmode: monitor\n",
      { env: {} },
    );
    const c = createPolicyEngine("version: 1\npurposes:\n  training: allow\n", { env: {} });
    expect(a.state().policyHash).toBeNull();
    const hash = await a.hash();
    expect(hash).toMatch(/^sha256-[0-9a-f]{16}$/);
    expect(a.state().policyHash).toBe(hash);
    expect(await b.hash()).toBe(hash);
    expect(await c.hash()).not.toBe(hash);
    expect(canonicalJson({ b: 1, a: [2, { d: undefined, c: 3 }] })).toBe('{"a":[2,{"c":3}],"b":1}');
  });

  it("works end to end with the verifier", async () => {
    const verifier = createVerifier({
      dns: null,
      now: () => Date.parse("2026-10-26T12:00:00Z"),
      directory: {
        snapshot: () => ({ directory: fixtureDirectory, keys: fixtureKeys }),
        refresh: false,
      },
    });
    try {
      await verifier.settled();
      expect(verifier.operator("ip-crawler")?.name).toBeDefined();
      expect(verifier.operators().map((operator) => operator.slug)).toContain("google");
      const engine = createPolicyEngine(
        template("allow-list").replace("mode: monitor", "mode: enforce"),
        {
          verifier,
          env: {},
        },
      );
      const result = await verifier.verify(
        new Request("https://www.site.example/", {
          headers: { "user-agent": "Mozilla/5.0 (compatible; ExampleRdnsBot/1.0)" },
        }),
        { remoteAddress: "198.51.100.7" },
      );
      expect(result.verdict).toBe("verified_by_ip");
      const decision = engine.decide(result, { path: "/" });
      expect(decision).toMatchObject({
        action: "block",
        enforced: true,
        rule: "purposes.training",
      });
      expect(enforcementResponse(decision, result)).toEqual({
        status: 403,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Posterna-Action": "block",
        },
        body: "This site's policy does not allow this agent (rdns-crawler, training). Operators can get verified at https://posterna.com/operators",
      });
      expect(engine.state()).toMatchObject({
        proxySuspect: false,
        directoryVersion: fixtureDirectory.version,
      });
    } finally {
      verifier.close();
    }
  });
});

describe("responses", () => {
  it("sends nothing for decisions that are not enforced or are sign-up recommendations", () => {
    const result: VerdictResult = { verdict: "unknown_automation" };
    expect(
      enforcementResponse({ action: "block", enforced: false, reason: "" }, result),
    ).toBeNull();
    expect(
      enforcementResponse({ action: "allow", enforced: false, reason: "" }, result),
    ).toBeNull();
    expect(
      enforcementResponse({ action: "challenge", enforced: true, reason: "" }, result),
    ).toBeNull();
    expect(
      enforcementResponse(
        { action: "throttle", enforced: true, reason: "", retryAfter: 7 },
        result,
      ),
    ).toMatchObject({
      status: 429,
      body: "Rate limited by this site's agent policy. Retry after 7 seconds.",
    });
  });
});

describe("templates", () => {
  it("ships every template, each starting in monitor mode", () => {
    expect(pkg.files).toContain("templates");
    for (const name of TEMPLATE_NAMES) {
      const policy = parsePolicy(template(name));
      expect(policy.mode, name).toBe("monitor");
      expect(policy.defaults.unknown_automation, name).toEqual({ action: "allow" });
    }
  });

  it("writes robots.txt from the real directory using only tokens of agents that honor robots.txt", async () => {
    const directory = json<DirectoryFile>(REPO, "packages", "directory", "data", "directory.json");
    const honoring = new Set(
      directory.operators.flatMap((operator) =>
        operator.agents
          .filter((agent) => agent.robots_policy === "honors")
          .map((agent) => agent.robots_token),
      ),
    );
    const text = emitRobots(parsePolicy(template("allow-list")), directory.operators);
    const tokens = [...text.matchAll(/^User-agent: (.+)$/gm)]
      .map((match) => match[1] as string)
      .filter((token) => token !== "*");
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) expect(honoring.has(token), token).toBe(true);
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});
