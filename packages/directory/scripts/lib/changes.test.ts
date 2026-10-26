import { describe, expect, it } from "vitest";
import type { DirectoryFile, KeysFile } from "../../../core/src/directory/types";
import { type Snapshot, summarizeChanges } from "./changes";
import type { Finding } from "./findings";
import type { Manifest } from "./manifest";

function agent(name: string, purpose = "training") {
  return {
    name,
    coverage: "community",
    user_agent_tokens: [name],
    aliases: [],
    purpose,
    robots_policy: "unstated",
    search_engine: false,
    signs: false,
  };
}

function operator(
  slug: string,
  agents: ReturnType<typeof agent>[],
  prefixes: string[] = [],
  status = "none_found",
) {
  return {
    slug,
    name: slug,
    coverage: "community",
    agents,
    verification: {
      signing: { status },
      ip_lists:
        prefixes.length > 0
          ? [{ agent: "bot", url: `https://${slug}.test/bot.json`, prefixes }]
          : [],
      reverse_dns: null,
    },
  };
}

const directory = (version: string, operators: ReturnType<typeof operator>[]) =>
  ({ version, operators }) as unknown as DirectoryFile;

const keys = (thumbprints: string[]) =>
  ({
    operators: { alpha: { keys: thumbprints.map((thumbprint) => ({ thumbprint })) } },
  }) as unknown as KeysFile;

const finding = (value: string): Finding => ({
  operator: "alpha",
  kind: "user_agent_token",
  value,
  source: "https://alpha.test/bots",
  detail: null,
});

const manifest = (failing: string[]) =>
  ({
    entries: failing.map((url) => ({
      url,
      kind: "doc",
      outcome: "http_error",
      detail: "HTTP 404",
    })),
  }) as unknown as Manifest;

describe("summarizeChanges", () => {
  const before: Snapshot = {
    directory: directory("2026-10-26", [
      operator(
        "alpha",
        [agent("AlphaBot"), agent("Wanderer")],
        ["192.0.2.0/24", "198.51.100.0/24"],
      ),
      operator("beta", [agent("BetaBot")]),
      operator("gone", [agent("OldBot")]),
    ]),
    keys: keys(["key-1"]),
    findings: [finding("KnownToken"), finding("FixedToken")],
    manifest: manifest(["https://alpha.test/old-failure"]),
  };
  const after: Snapshot = {
    directory: directory("2026-10-27", [
      operator(
        "alpha",
        [agent("AlphaBot", "search")],
        ["192.0.2.0/24", "203.0.113.0/24", "2001:db8::/32"],
        "live",
      ),
      operator("beta", [agent("BetaBot"), agent("Wanderer")]),
      operator("gamma", [agent("GammaBot", "agent")]),
    ]),
    keys: keys(["key-1", "key-2"]),
    findings: [finding("KnownToken"), finding("NewToken")],
    manifest: manifest(["https://alpha.test/old-failure", "https://alpha.test/new-failure"]),
  };
  const summary = summarizeChanges(before, after);

  it("lists new findings first, with what is still open and what went away", () => {
    expect(summary.indexOf("### Needs review")).toBeLessThan(summary.indexOf("### Operators"));
    expect(summary).toContain("1 new:");
    expect(summary).toContain("NewToken");
    expect(summary).toContain("1 still open from earlier runs");
    expect(summary).toContain("No longer found:\n\n- alpha: FixedToken");
  });

  it("covers operators, agents, signing, keys, IP lists and fetch failures", () => {
    expect(summary).toContain("Added `gamma`");
    expect(summary).toContain("Removed `gone`");
    expect(summary).toContain("Added `gamma/GammaBot` (community, agent)");
    expect(summary).toContain("Moved `Wanderer` from `alpha` to `beta`");
    expect(summary).toContain("`alpha/AlphaBot`: purpose training to search");
    expect(summary).toContain("Removed `gone/OldBot`");
    expect(summary).toContain("`alpha`: none_found to live");
    expect(summary).toContain("`alpha`: new keys `key-2`");
    expect(summary).toContain("| alpha | `bot` | 2 | 3 | +2 | -1 |");
    expect(summary).toContain("**New:** https://alpha.test/new-failure");
    expect(summary).not.toContain("**New:** https://alpha.test/old-failure");
  });

  it("says so when no facts changed", () => {
    const quiet = summarizeChanges(
      { ...before, manifest: null },
      {
        ...before,
        directory: directory("2026-10-27", before.directory?.operators as never),
        manifest: null,
      },
    );
    expect(quiet).toContain("No facts changed.");
  });
});
