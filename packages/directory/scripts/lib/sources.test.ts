import { describe, expect, it } from "vitest";
import { loadCommunityOperatorNames, loadOperatorSources, parseOperatorSource } from "./sources";

const valid = `
slug: example
name: Example AI
checked_on: "2026-10-26"
sources:
  - id: bots
    url: https://example.com/bots
    title: Example bots
agents:
  - name: ExampleBot
    user_agent_tokens: [ExampleBot]
    purpose: training
    purpose_quote: ExampleBot collects training data.
    purpose_source: bots
    search_engine: false
    robots_policy: honors
    robots_quote: ExampleBot follows robots.txt.
    robots_source: bots
signing:
  basis: none
`;

describe("committed researched sources", () => {
  const sources = loadOperatorSources();

  it("all load, and every researched fact points at a listed source", () => {
    // loadOperatorSources throws on any fact without a source.
    expect(sources.length).toBeGreaterThanOrEqual(14);
    for (const op of sources) {
      const ids = new Set(op.sources.map((source) => source.id));
      for (const agent of op.agents) {
        expect(ids.has(agent.purpose_source), `${op.slug}/${agent.name} purpose`).toBe(true);
        expect(agent.purpose_quote.length, `${op.slug}/${agent.name} quote`).toBeGreaterThan(0);
        if (agent.robots_policy !== "unstated") {
          expect(ids.has(agent.robots_source ?? ""), `${op.slug}/${agent.name} robots`).toBe(true);
          expect(agent.robots_quote, `${op.slug}/${agent.name} robots quote`).toBeTruthy();
        }
      }
      for (const list of op.ip_lists)
        expect(ids.has(list.source), `${op.slug}/${list.id}`).toBe(true);
      if (op.reverse_dns) expect(ids.has(op.reverse_dns.source)).toBe(true);
      if (op.signing.basis !== "none") expect(op.signing.sources.length).toBeGreaterThan(0);
    }
  });

  it("covers every operator the build brief asks for", () => {
    expect(sources.map((op) => op.slug)).toEqual(
      expect.arrayContaining([
        "openai",
        "anthropic",
        "google",
        "perplexity",
        "meta",
        "apple",
        "amazon",
        "microsoft",
        "common-crawl",
        "duckduckgo",
        "mistral",
        "browserbase",
        "xai",
        "posterna",
      ]),
    );
  });

  it("flags search engines only for Google's search crawlers, Bingbot and Applebot", () => {
    const flagged = sources.flatMap((op) =>
      op.agents.filter((agent) => agent.search_engine).map((agent) => `${op.slug}/${agent.name}`),
    );
    for (const name of flagged)
      expect(name).toMatch(/^(google\/Googlebot|microsoft\/Bingbot|apple\/Applebot$)/);
    expect(flagged).toEqual(
      expect.arrayContaining(["google/Googlebot", "microsoft/Bingbot", "apple/Applebot"]),
    );
  });

  it("lists Posterna itself with a pending key directory", () => {
    const posterna = sources.find((op) => op.slug === "posterna");
    expect(posterna?.agents.map((agent) => [agent.name, agent.purpose])).toEqual([
      ["PosternaProbe", "other"],
    ]);
    expect(posterna?.signing).toMatchObject({
      status: "pending",
      directory_url: "https://posterna.com/.well-known/http-message-signatures-directory",
    });
  });

  it("loads the community operator names", () => {
    expect(loadCommunityOperatorNames().get("the Chinese company Huawei")).toBe("Huawei");
  });
});

describe("parseOperatorSource", () => {
  it("accepts a complete file and fills defaults", () => {
    const source = parseOperatorSource(valid, "example.yaml");
    expect(source.agents[0]).toMatchObject({ aliases: [], ip_list: null, note: null });
    expect(source.signing).toMatchObject({ directory_url: null, covers: [], sources: [] });
  });

  it.each([
    [
      "a purpose without a source",
      valid.replace("    purpose_source: bots\n", ""),
      /purpose_source/,
    ],
    [
      "a source id that does not exist",
      valid.replace("purpose_source: bots", "purpose_source: blog"),
      /unknown source id "blog"/,
    ],
    [
      "a robots policy without a quote",
      valid.replace("    robots_quote: ExampleBot follows robots.txt.\n", ""),
      /robots_quote/,
    ],
    [
      "an unknown field",
      valid.replace("signing:", "rumor: yes\nsigning:"),
      /must NOT have additional properties/,
    ],
    [
      "a reported directory without a source",
      valid.replace("  basis: none", "  basis: reported"),
      /needs at least one source/,
    ],
    ["an http URL", valid.replace("https://example.com/bots", "http://example.com/bots"), /url/],
    ["a slug that differs from the file name", valid, /must match the file name/],
  ])("rejects %s", (_label, text, error) => {
    const fileName = _label.startsWith("a slug") ? "other.yaml" : "example.yaml";
    expect(() => parseOperatorSource(text, fileName)).toThrow(error);
  });

  it("rejects a key directory URL that is not the well-known path", () => {
    const text = valid.replace(
      "  basis: none",
      "  basis: documented\n  directory_url: https://example.com/keys.json\n  sources: [bots]",
    );
    expect(() => parseOperatorSource(text, "example.yaml")).toThrow(
      /http-message-signatures-directory/,
    );
  });
});
