import { describe, expect, it } from "vitest";
import { hasChanges, stripVolatile, substantiveEqual } from "./data-changed";

const base = {
  version: "2026-10-26",
  generated_at: "2026-10-26T06:00:00Z",
  operators: [
    {
      slug: "example",
      verification: {
        ip_lists: [
          {
            url: "https://example.com/list.json",
            fetched_at: "2026-10-26T06:00:00Z",
            sha256: "a".repeat(64),
            prefixes: ["192.0.2.0/24"],
            note: "Kept from the fetch at 2026-10-20T00:00:00Z.",
          },
        ],
      },
    },
  ],
};

describe("data-changed", () => {
  it("ignores fetch dates, build times and file hashes", () => {
    const rerun = structuredClone(base);
    rerun.version = "2026-10-27";
    rerun.generated_at = "2026-10-27T06:00:00Z";
    const list = rerun.operators[0]?.verification.ip_lists[0];
    if (!list) throw new Error("fixture changed");
    list.fetched_at = "2026-10-27T06:00:00Z";
    list.sha256 = "b".repeat(64);
    list.note = "Kept from the fetch at 2026-10-21T00:00:00Z.";
    expect(substantiveEqual(JSON.stringify(base), JSON.stringify(rerun))).toBe(true);
  });

  it("notices a changed fact", () => {
    const changed = structuredClone(base);
    const list = changed.operators[0]?.verification.ip_lists[0];
    if (!list) throw new Error("fixture changed");
    list.prefixes = ["192.0.2.0/24", "198.51.100.0/24"];
    expect(substantiveEqual(JSON.stringify(base), JSON.stringify(changed))).toBe(false);
  });

  it("strips volatile keys at any depth", () => {
    expect(stripVolatile({ a: { fetched_at: 1, b: [{ last_seen: 2, c: 3 }] } })).toEqual({
      a: { b: [{ c: 3 }] },
    });
  });
});

describe("hasChanges", () => {
  const findings = (values: string[]) =>
    JSON.stringify({
      findings: values.map((value) => ({
        operator: "a",
        kind: "user_agent_token",
        value,
        source: "s",
        detail: null,
      })),
    });
  const facts = JSON.stringify(base);

  it("is false when only timestamps moved and findings are the same", () => {
    const rerun = JSON.stringify({ ...base, generated_at: "2026-10-27T06:00:00Z" });
    expect(
      hasChanges(
        { directory: facts, findings: findings(["A"]) },
        { directory: rerun, findings: findings(["A"]) },
      ),
    ).toBe(false);
  });

  it("is true when findings change even if no facts did", () => {
    expect(
      hasChanges(
        { directory: facts, findings: findings(["A"]) },
        { directory: facts, findings: findings(["A", "B"]) },
      ),
    ).toBe(true);
  });

  it("is true when a file appears for the first time", () => {
    expect(
      hasChanges(
        { directory: facts, findings: null },
        { directory: facts, findings: findings([]) },
      ),
    ).toBe(true);
  });
});
