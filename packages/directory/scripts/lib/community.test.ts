import { describe, expect, it } from "vitest";
import {
  agentKey,
  baseAgentName,
  communityPurpose,
  communityRobotsPolicy,
  parseOperatorField,
  slugify,
} from "./community";

describe("agent names", () => {
  it.each([
    ["MistralAI-User/1.0", "MistralAI-User"],
    ["iaskspider/2.0", "iaskspider"],
    ["Brightbot 1.0", "Brightbot"],
    ["ExampleBot/v2", "ExampleBot"],
    ["AI2Bot", "AI2Bot"],
    ["Kangaroo Bot", "Kangaroo Bot"],
    ["GPT-4o", "GPT-4o"],
  ])("base name of %s is %s", (name, base) => {
    expect(baseAgentName(name)).toBe(base);
  });

  it("treats case and version differences as the same agent", () => {
    expect(agentKey("Meta-ExternalAgent")).toBe(agentKey("meta-externalagent"));
    expect(agentKey("MistralAI-User/1.0")).toBe(agentKey("MistralAI-User"));
    expect(agentKey("ClaudeBot")).not.toBe(agentKey("Claude-User"));
  });
});

describe("parseOperatorField", () => {
  it.each([
    ["[OpenAI](https://openai.com)", { name: "OpenAI", url: "https://openai.com" }],
    ["Amazon", { name: "Amazon", url: null }],
    ["Amazon, used for fetching web content to answer user queries", { name: "Amazon", url: null }],
    ["Alibaba that fetches web content for the assistant", { name: "Alibaba", url: null }],
    ["Cohere to download training data", { name: "Cohere", url: null }],
    ["Naget Inc (founded in 2024)", { name: "Naget Inc", url: null }],
    ["https://example.com/bot", { name: "example.com", url: "https://example.com/bot" }],
    ["Unclear at this time.", { name: null, url: null }],
    ["Unknown", { name: null, url: null }],
    [undefined, { name: null, url: null }],
  ])("reads %j", (field, expected) => {
    expect(parseOperatorField(field)).toEqual(expected);
  });

  it("uses a curated display name when one is given", () => {
    const names = new Map([["the Chinese company Huawei", "Huawei"]]);
    expect(parseOperatorField("the Chinese company Huawei", names)).toEqual({
      name: "Huawei",
      url: null,
    });
  });
});

describe("slugify", () => {
  it("makes stable lowercase slugs", () => {
    expect(slugify("Common Crawl Foundation")).toBe("common-crawl-foundation");
    expect(slugify("Meta/Facebook")).toBe("meta-facebook");
    expect(slugify("  01.ai ")).toBe("01-ai");
  });
});

describe("communityPurpose", () => {
  it.each([
    ["AI Data Scrapers", "training"],
    ["AI Search Crawlers", "search"],
    ["AI Assistants", "user_fetch"],
    ["AI Agents", "agent"],
    ["Undocumented AI Agents", "agent"],
    ["AI Data Providers", "other"],
    ["Scrapes data to train Anthropic's AI products.", "training"],
    ["Validates and targets ads on ChatGPT.", "ads"],
    ["Collects data for AI search", "search"],
    ["Retrieves data to provide responses to user-initiated prompts.", "user_fetch"],
    ["Ostensibly only for sharing, but likely used as an AI crawler as well", "preview"],
    ["Data is sold.", "other"],
    [undefined, "other"],
  ])("maps %j to %s", (fn, purpose) => {
    expect(communityPurpose(fn)).toBe(purpose);
  });
});

describe("communityRobotsPolicy", () => {
  it.each([
    ["Yes", "honors"],
    ["[Yes](https://example.com/bot)", "honors"],
    ["No", "may_ignore"],
    ["[No](https://example.com/faq)", "may_ignore"],
    ["Unclear at this time.", "unstated"],
    ["At the discretion of users.", "unstated"],
  ])("maps %j to %s", (respect, policy) => {
    expect(communityRobotsPolicy(respect)).toBe(policy);
  });
});
