import { describe, expect, it } from "vitest";
import type { DirectoryFile } from "../../../core/src/directory/types";
import type { EvidenceCheck } from "./evidence";
import type { ManifestEntry } from "./fetcher";
import {
  extractLinks,
  extractTokens,
  findNewThings,
  looksLikeIpList,
  ownSourceIds,
} from "./findings";
import type { FetchedFile } from "./merge";
import { parseOperatorSource } from "./sources";

describe("extractLinks", () => {
  it("resolves relative links, keeps https only and drops fragments", () => {
    const html = `<a href="/static/ipranges/bots.json">list</a>
      <a href='https://example.com/docs#verify'>docs</a>
      <a href="http://insecure.example.com/x.json">old</a>
      See https://example.com/keys.json, or mailto:someone.`;
    expect(extractLinks(html, "https://example.com/docs/bots")).toEqual([
      "https://example.com/docs",
      "https://example.com/keys.json",
      "https://example.com/static/ipranges/bots.json",
    ]);
  });
});

describe("looksLikeIpList", () => {
  it.each([
    ["https://example.com/gptbot.json", true],
    ["https://example.com/static/crawling/ipranges/common-crawlers.json", true],
    ["https://example.com/amazonbot/ip-addresses/", true],
    ["https://example.com/mistralai-user-ips.json", true],
    ["https://example.com/manifest.json", false],
    ["https://example.com/openapi.json", false],
    ["https://example.com/robots.txt", false],
    ["https://example.com/logo.png", false],
  ])("%s is %s", (url, expected) => {
    expect(looksLikeIpList(url)).toBe(expected);
  });
});

describe("extractTokens", () => {
  it("finds bot tokens in user-agent strings and robots.txt examples, not browser tokens or prose", () => {
    const text =
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ExampleBot/1.4; +https://example.com) Chrome/W.X.Y.Z Safari/537.36. " +
      "User-agent: Example-User Disallow: / " +
      "Write the user agent token for the User-agent: line in robots.txt.";
    expect(extractTokens(text)).toEqual(["Example-User", "ExampleBot"]);
  });
});

const exampleYaml = `
slug: example
name: Example AI
checked_on: "2026-10-26"
ignore_findings:
  - value: https://example.com/all-ranges.json
    reason: Company-wide ranges, not a crawler list.
sources:
  - id: bots
    url: https://example.com/bots
    title: Example bots
  - id: survey
    url: https://survey.example.org/results
    title: A third-party survey
agents:
  - name: ExampleBot
    user_agent_tokens: [ExampleBot]
    purpose: training
    purpose_quote: ExampleBot collects training data.
    purpose_source: bots
    search_engine: false
    robots_policy: unstated
ip_lists:
  - id: examplebot
    url: https://example.com/examplebot.json
    source: bots
signing:
  directory_url: https://sign.example.com/.well-known/http-message-signatures-directory
  basis: reported
  sources: [survey]
`;

function page(url: string, body: string): [string, FetchedFile] {
  const entry = {
    url,
    kind: "doc",
    operator: "example",
    label: "",
    fetched_at: "2026-10-26T00:00:00.000Z",
    http_status: 200,
    content_type: "text/html",
    bytes: body.length,
    sha256: null,
    outcome: "ok",
    detail: null,
    final_url: url,
    file: null,
  } as ManifestEntry;
  return [url, { entry, body: new TextEncoder().encode(body) }];
}

const directory = {
  operators: [
    {
      slug: "example",
      agents: [
        { name: "ExampleBot", user_agent_tokens: ["ExampleBot"], aliases: [], robots_token: null },
      ],
      verification: {
        ip_lists: [{ url: "https://example.com/examplebot.json" }],
        signing: {
          directory_url: "https://sign.example.com/.well-known/http-message-signatures-directory",
        },
      },
    },
  ],
} as unknown as DirectoryFile;

describe("ownSourceIds", () => {
  it("leaves out pages cited only as a third-party report", () => {
    const op = parseOperatorSource(exampleYaml, "example.yaml");
    expect([...ownSourceIds(op)]).toEqual(["bots"]);
  });
});

describe("findNewThings", () => {
  const op = parseOperatorSource(exampleYaml, "example.yaml");
  const fetched = new Map([
    page(
      "https://example.com/bots",
      `<p>ExampleBot/1.0 crawls. New: ExampleSearch/2.0.</p>
       <a href="/examplebot.json">known list</a>
       <a href="/examplesearchbot.json">new list</a>
       <a href="/all-ranges.json">company ranges</a>
       <a href="https://agents.example.com/.well-known/http-message-signatures-directory">keys</a>`,
    ),
    page(
      "https://survey.example.org/results",
      `<a href="https://elsewhere.example.net/.well-known/http-message-signatures-directory">x</a> OtherBot/1.0`,
    ),
  ]);
  const evidence: EvidenceCheck[] = [
    {
      operator: "example",
      fact: "ExampleBot purpose_quote",
      value: "ExampleBot collects training data.",
      sourceUrl: "https://example.com/bots",
      result: "not_found",
      detail: null,
    },
  ];

  it("reports unknown lists, key directories and tokens on the operator's own pages only", () => {
    const { findings, ignored } = findNewThings([op], fetched, directory, evidence);
    expect(findings.map((finding) => [finding.kind, finding.value])).toEqual([
      ["evidence", "ExampleBot purpose_quote: ExampleBot collects training data."],
      ["ip_list_link", "https://example.com/examplesearchbot.json"],
      [
        "key_directory_link",
        "https://agents.example.com/.well-known/http-message-signatures-directory",
      ],
      ["user_agent_token", "ExampleSearch"],
    ]);
    expect(ignored).toBe(1);
    expect(findings.every((finding) => !finding.source.includes("survey"))).toBe(true);
  });
});
