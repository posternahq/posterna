import { describe, expect, it } from "vitest";
import { VERSION } from "./index";
import { run } from "./run";

function capture(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(args, { out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("posterna CLI", () => {
  it.each([[[]], [["--help"]], [["-h"]], [["help"]]])("prints help for %j", (args) => {
    const result = capture(args);
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    expect(result.out).toContain("Usage: posterna <command>");
    for (const command of ["init", "doctor", "robots", "policy check"]) {
      expect(result.out).toMatch(new RegExp(`^  ${command} .*\\(coming soon\\)$`, "m"));
    }
  });

  it("prints the version", () => {
    expect(capture(["--version"])).toEqual({ code: 0, out: VERSION, err: "" });
    expect(capture(["-v"]).out).toBe(VERSION);
  });

  it.each([
    [["init"], "init"],
    [["doctor", "--url", "https://example.com"], "doctor"],
    [["robots"], "robots"],
    [["policy", "check"], "policy check"],
  ])("says %j is coming soon and exits 1", (args, name) => {
    const result = capture(args);
    expect(result.code).toBe(1);
    expect(result.out).toBe("");
    expect(result.err).toBe(
      `posterna ${name} is coming soon. It is not available in this pre-release.`,
    );
  });

  it("rejects unknown commands", () => {
    const result = capture(["deploy"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("Unknown command: deploy");
    expect(result.err).toContain("Usage: posterna <command>");
  });
});
