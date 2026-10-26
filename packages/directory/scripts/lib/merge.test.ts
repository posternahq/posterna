import { describe, expect, it } from "vitest";
import type { DirectoryFile, KeysFile } from "../../../core/src/directory/types";
import type { CommunityList } from "./community";
import type { FetchOutcome, ManifestEntry } from "./fetcher";
import { buildDirectory, type FetchedFile, findDuplicates } from "./merge";
import { schemaValidators } from "./outputs";
import { parseOperatorSource } from "./sources";

const ED25519 = { kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" };
const THUMBPRINT = "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k";
const NOW = new Date("2026-10-26T12:00:00.000Z");
const FETCHED_AT = "2026-10-26T11:59:00.000Z";

const exampleYaml = `
slug: example
name: Example AI
website: https://example.com/
docs_url: https://example.com/bots
checked_on: "2026-10-25"
community_agents: [Example-Legacy, Example-Agent]
sources:
  - id: bots
    url: https://example.com/bots
    title: Example bots
agents:
  - name: ExampleBot
    user_agent_tokens: [ExampleBot]
    robots_token: ExampleBot
    purpose: training
    purpose_quote: ExampleBot collects training data.
    purpose_source: bots
    search_engine: false
    robots_policy: honors
    robots_quote: ExampleBot follows robots.txt.
    robots_source: bots
    ip_list: examplebot
ip_lists:
  - id: examplebot
    url: https://example.com/examplebot.json
    source: bots
  - id: gone
    url: https://example.com/gone.json
    source: bots
signing:
  directory_url: https://sign.example.com/.well-known/http-message-signatures-directory
  basis: documented
  covers: [Example-Agent]
  sources: [bots]
`;

const sourceFor = (slug: string, signing: string) =>
  parseOperatorSource(
    `slug: ${slug}
name: ${slug}
checked_on: "2026-10-25"
sources:
  - id: docs
    url: https://${slug}.test/docs
    title: Docs
agents: []
signing:
${signing}`,
    `${slug}.yaml`,
  );

const community: CommunityList = {
  ExampleBot: {
    operator: "[Example AI](https://example.com)",
    respect: "No",
    function: "AI Search Crawlers",
  },
  "examplebot/2.0": { operator: "Unclear at this time.", function: "AI Data Scrapers" },
  "Example-Legacy": {
    operator: "Unclear at this time.",
    function: "AI Data Scrapers",
    respect: "Yes",
  },
  "Example-Agent": { operator: "Unclear at this time.", function: "AI Agents" },
  "Other-Fetcher": {
    operator: "Other Corp, a company that fetches pages",
    function: "AI Assistants",
  },
  "other-fetcher": { operator: "Unclear at this time.", function: "AI Assistants" },
  "Mystery/1.0": { operator: "Unclear at this time.", function: "Data is sold." },
};

function file(
  url: string,
  outcome: FetchOutcome,
  body: string | null,
  status = 200,
): [string, FetchedFile] {
  const entry: ManifestEntry = {
    url,
    kind: "doc",
    operator: null,
    label: "",
    fetched_at: FETCHED_AT,
    http_status: status,
    content_type: null,
    bytes: body?.length ?? null,
    sha256: body ? "a".repeat(64) : null,
    outcome,
    detail: outcome === "ok" ? null : "test",
    final_url: url,
    file: null,
  };
  return [url, { entry, body: body ? new TextEncoder().encode(body) : null }];
}

const baseFetched = [
  file("https://example.com/bots", "ok", "<p>ExampleBot collects training data.</p>"),
  file(
    "https://example.com/examplebot.json",
    "ok",
    JSON.stringify({ prefixes: [{ ipv4Prefix: "192.0.2.9/24" }, { ipv6Prefix: "2001:DB8::/32" }] }),
  ),
  file("https://example.com/gone.json", "timeout", null, 0),
  file(
    "https://sign.example.com/.well-known/http-message-signatures-directory",
    "ok",
    JSON.stringify({ keys: [ED25519] }),
  ),
];

async function build(
  overrides: Partial<Parameters<typeof buildDirectory>[0]> = {},
  extraFetched: [string, FetchedFile][] = [],
) {
  return buildDirectory({
    generatedAt: NOW,
    researched: [parseOperatorSource(exampleYaml, "example.yaml")],
    communityOperatorNames: new Map(),
    describedOperators: new Map(),
    community: {
      list: community,
      source: {
        url: "https://example.org/robots.json",
        title: "robots.json",
        fetched_at: FETCHED_AT,
      },
    },
    fetched: new Map([...baseFetched, ...extraFetched]),
    previousKeys: null,
    previousDirectory: null,
    ...overrides,
  });
}

describe("buildDirectory", () => {
  it("produces files that pass the published JSON Schemas", async () => {
    const { directory, keys, log } = await build();
    const validate = schemaValidators();
    expect(validate.directory(directory)).toEqual([]);
    expect(validate.keys(keys)).toEqual([]);
    expect(log.problems).toEqual([]);
  });

  it("lets researched facts win and folds case and version variants into the researched agent", async () => {
    const { directory, log } = await build();
    const example = directory.operators.find((op) => op.slug === "example");
    const bot = example?.agents.find((agent) => agent.name === "ExampleBot");
    expect(bot).toMatchObject({
      coverage: "researched",
      purpose: "training",
      robots_policy: "honors",
      purpose_quote: "ExampleBot collects training data.",
    });
    expect(log.merged.map((entry) => entry.community).sort()).toEqual([
      "ExampleBot",
      "examplebot/2.0",
    ]);
    // No separate community record survives for either spelling.
    const names = directory.operators.flatMap((op) =>
      op.agents.map((agent) => agent.name.toLowerCase()),
    );
    expect(names.filter((name) => name.startsWith("examplebot"))).toEqual(["examplebot"]);
  });

  it("keeps listed community agents under the researched operator, labeled community", async () => {
    const { directory } = await build();
    const legacy = directory.operators
      .find((op) => op.slug === "example")
      ?.agents.find((agent) => agent.name === "Example-Legacy");
    expect(legacy).toMatchObject({
      coverage: "community",
      purpose: "training",
      robots_policy: "honors",
      purpose_quote: null,
      signs: false,
    });
  });

  it("collapses community spellings and takes the operator from the spelling that names one", async () => {
    const { directory, log } = await build();
    const other = directory.operators.find((op) => op.slug === "other-corp");
    expect(other).toMatchObject({ name: "Other Corp", coverage: "community" });
    expect(other?.agents.map((agent) => [agent.name, agent.aliases])).toEqual([
      ["Other-Fetcher", ["other-fetcher"]],
    ]);
    expect(log.collapsed).toEqual([{ kept: "Other-Fetcher", dropped: "other-fetcher" }]);
  });

  it("names unattributed agents honestly and strips version suffixes", async () => {
    const { directory } = await build();
    const mystery = directory.operators.find((op) => op.slug === "unknown-mystery");
    expect(mystery?.name).toBe("Unknown operator (Mystery)");
    expect(mystery?.agents[0]).toMatchObject({
      name: "Mystery",
      aliases: ["Mystery/1.0"],
      purpose: "other",
    });
    expect(mystery?.verification.signing.status).toBe("not_probed");
  });

  it("normalizes IP prefixes and records lists that could not be fetched", async () => {
    const { directory, log } = await build();
    const lists = directory.operators.find((op) => op.slug === "example")?.verification.ip_lists;
    expect(lists?.[0]).toMatchObject({
      prefixes: ["192.0.2.0/24", "2001:db8::/32"],
      prefix_count: 2,
      format: "ipranges-json",
      fetched_at: FETCHED_AT,
    });
    expect(lists?.[1]).toMatchObject({ prefixes: [], prefix_count: null, fetched_at: null });
    expect(lists?.[1]?.note).toContain("timeout");
    expect(log.ipLists[0]).toMatchObject({ rewritten: 2, count: 2 });
  });

  it("keeps the last good copy of a list this build could not fetch, with its own date", async () => {
    const first = await build();
    const previous: DirectoryFile = structuredClone(first.directory);
    const gone = previous.operators[0]?.verification.ip_lists[1];
    if (!gone) throw new Error("fixture changed");
    Object.assign(gone, {
      prefixes: ["198.51.100.0/24"],
      prefix_count: 1,
      fetched_at: "2026-10-20T00:00:00.000Z",
      format: "ipranges-json",
    });
    const { directory } = await build({ previousDirectory: previous });
    const kept = directory.operators.find((op) => op.slug === "example")?.verification.ip_lists[1];
    expect(kept).toMatchObject({
      prefixes: ["198.51.100.0/24"],
      fetched_at: "2026-10-20T00:00:00.000Z",
    });
    expect(kept?.note).toContain("prefixes are from the fetch at 2026-10-20T00:00:00.000Z");
  });

  it("marks a fetched key directory live, computes thumbprints and sets signs on covered agents", async () => {
    const { directory, keys } = await build();
    const example = directory.operators.find((op) => op.slug === "example");
    expect(example?.verification.signing).toMatchObject({ status: "live", kid_convention: "none" });
    expect(example?.agents.find((agent) => agent.name === "Example-Agent")?.signs).toBe(true);
    expect(example?.agents.find((agent) => agent.name === "ExampleBot")?.signs).toBe(false);
    expect(keys.operators.example?.keys).toEqual([
      {
        jwk: ED25519,
        thumbprint: THUMBPRINT,
        kid: null,
        first_seen: FETCHED_AT,
        last_seen: FETCHED_AT,
      },
    ]);
  });

  it("keeps first_seen from the previous keys.json", async () => {
    const previousKeys: KeysFile = {
      version: "2026-10-01T00",
      generated_at: "2026-10-01T00:00:00Z",
      operators: {
        example: {
          directory_url: "https://sign.example.com/.well-known/http-message-signatures-directory",
          fetched_at: "2026-10-01T00:00:00Z",
          status: "live",
          keys: [
            {
              jwk: ED25519,
              thumbprint: THUMBPRINT,
              kid: null,
              first_seen: "2026-10-01T00:00:00Z",
              last_seen: "2026-10-01T00:00:00Z",
            },
          ],
        },
      },
    };
    const { keys } = await build({ previousKeys });
    expect(keys.operators.example?.keys[0]).toMatchObject({
      first_seen: "2026-10-01T00:00:00Z",
      last_seen: FETCHED_AT,
    });
  });

  it("decides signing status from what was fetched", async () => {
    const dir = (host: string) => `https://${host}/.well-known/http-message-signatures-directory`;
    const researched = [
      sourceFor(
        "missing",
        `  directory_url: ${dir("missing.test")}\n  basis: reported\n  sources: [docs]`,
      ),
      sourceFor(
        "blocked",
        `  directory_url: ${dir("blocked.test")}\n  basis: reported\n  sources: [docs]`,
      ),
      sourceFor(
        "empty",
        `  directory_url: ${dir("empty.test")}\n  basis: documented\n  sources: [docs]`,
      ),
      sourceFor("unknown-host", "  basis: reported\n  sources: [docs]"),
      sourceFor("nothing", "  basis: none"),
      sourceFor(
        "ours",
        `  directory_url: ${dir("ours.test")}\n  basis: documented\n  status: pending\n  sources: [docs]`,
      ),
    ];
    const { directory } = await buildDirectory({
      generatedAt: NOW,
      researched,
      communityOperatorNames: new Map(),
      describedOperators: new Map(),
      community: null,
      fetched: new Map([
        file(dir("missing.test"), "http_error", null, 404),
        file(dir("blocked.test"), "blocked_by_robots", null, 0),
        file(dir("empty.test"), "ok", JSON.stringify({ keys: [{ kty: "oct", k: "c2VjcmV0" }] })),
      ]),
      previousKeys: null,
      previousDirectory: null,
    });
    const status = Object.fromEntries(
      directory.operators.map((op) => [op.slug, op.verification.signing.status]),
    );
    expect(status).toEqual({
      blocked: "reported",
      empty: "none_found",
      missing: "none_found",
      nothing: "none_found",
      ours: "pending",
      "unknown-host": "reported",
    });
  });

  it("fails when two researched operators claim the same agent", async () => {
    const other = parseOperatorSource(
      exampleYaml
        .replace("slug: example", "slug: copycat")
        .replace("name: Example AI", "name: Copycat"),
      "copycat.yaml",
    );
    const { log } = await build({
      researched: [parseOperatorSource(exampleYaml, "example.yaml"), other],
    });
    expect(log.problems.join("\n")).toMatch(
      /claimed by researched agents of both example and copycat/,
    );
  });
});

describe("findDuplicates", () => {
  it("reports the same agent name or user-agent token twice", async () => {
    const { directory } = await build();
    expect(findDuplicates(directory.operators)).toEqual([]);
    const copy = structuredClone(directory.operators);
    const target = copy.find((op) => op.slug === "other-corp");
    const bot = directory.operators.find((op) => op.slug === "example")?.agents[0];
    if (!target || !bot) throw new Error("fixture changed");
    target.agents.push(structuredClone(bot));
    expect(findDuplicates(copy).join("\n")).toMatch(
      /duplicate agent name: example\/ExampleBot and other-corp\/ExampleBot/,
    );
  });
});

describe("description-based attributions", () => {
  const extra: CommunityList = {
    "Example-Helper": {
      operator: "Unclear at this time.",
      function: "AI Agents",
      description: "Example-Helper is an AI agent created by Example that books travel.",
    },
    Gadget: {
      operator: "Unclear at this time.",
      function: "AI Assistants",
      description: "Gadget is run by Widget Co for its assistant.",
    },
  };
  const withExtra = {
    list: { ...community, ...extra },
    source: {
      url: "https://example.org/robots.json",
      title: "robots.json",
      fetched_at: FETCHED_AT,
    },
  };

  it("attaches an entry to the operator its own description names, still labeled community", async () => {
    const { directory, log } = await build({
      community: withExtra,
      describedOperators: new Map([
        ["Example-Helper", { operator: "Example", evidence: "created by Example" }],
        ["Gadget", { operator: "Widget Co", evidence: "run by Widget Co" }],
      ]),
    });
    expect(log.problems).toEqual([]);
    const helper = directory.operators
      .find((op) => op.slug === "example")
      ?.agents.find((agent) => agent.name === "Example-Helper");
    expect(helper).toMatchObject({ coverage: "community", purpose: "agent" });
    expect(helper?.note).toContain("named in its ai.robots.txt description");
    expect(log.claimed).toContainEqual({
      community: "Example-Helper",
      operator: "example",
      how: "description",
    });
    const widget = directory.operators.find((op) => op.slug === "widget-co");
    expect(widget).toMatchObject({ name: "Widget Co", coverage: "community" });
    expect(widget?.note).toContain("named in the agent's own description");
    expect(log.described.map((entry) => entry.community).sort()).toEqual([
      "Example-Helper",
      "Gadget",
    ]);
  });

  it("fails when the quoted phrase is not in the description", async () => {
    const { log } = await build({
      community: withExtra,
      describedOperators: new Map([
        ["Gadget", { operator: "Widget Co", evidence: "built by Widget Co" }],
      ]),
    });
    expect(log.problems.join("\n")).toMatch(/does not contain "built by Widget Co"/);
  });

  it("reports attributions that no longer apply instead of using them", async () => {
    const { directory, log } = await build({
      community: withExtra,
      describedOperators: new Map([["Gone-Bot", { operator: "Widget Co", evidence: "anything" }]]),
    });
    expect(log.staleDescriptions).toEqual([
      { community: "Gone-Bot", reason: "no longer in robots.json" },
    ]);
    expect(directory.operators.find((op) => op.slug === "widget-co")).toBeUndefined();
  });
});
