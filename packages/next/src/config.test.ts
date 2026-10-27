import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POLICY_TEXT_ENV, withPosternaConfig } from "./config";

const POLICY = "version: 1\nmode: monitor\n";

describe("withPosternaConfig", () => {
  let dir: string;
  let warnings: string[];
  const onError = (m: string) => warnings.push(m);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "posterna-config-"));
    warnings = [];
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    vi.stubEnv("POSTERNA_POLICY", undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("builds agents.yaml from the project folder in through env, keeping the rest", () => {
    writeFileSync(join(dir, "agents.yaml"), POLICY);
    const config = withPosternaConfig(
      { reactStrictMode: true, env: { OTHER: "kept" } },
      { onError },
    );
    expect(config).toEqual({
      reactStrictMode: true,
      env: { OTHER: "kept", POSTERNA_POLICY_TEXT: POLICY },
    });
    expect(POLICY_TEXT_ENV).toBe("POSTERNA_POLICY_TEXT");
    expect(withPosternaConfig().env).toEqual({ POSTERNA_POLICY_TEXT: POLICY });
    expect(warnings).toEqual([]);
  });

  it("reads the file that policyPath or POSTERNA_POLICY names", () => {
    mkdirSync(join(dir, "config"));
    writeFileSync(join(dir, "config", "agents.yaml"), "version: 1\nmode: enforce\n");
    writeFileSync(join(dir, "other.yaml"), "version: 1\n");
    expect(withPosternaConfig({}, { policyPath: "config/agents.yaml" }).env).toEqual({
      POSTERNA_POLICY_TEXT: "version: 1\nmode: enforce\n",
    });
    vi.stubEnv("POSTERNA_POLICY", join(dir, "other.yaml"));
    expect(withPosternaConfig({}).env).toEqual({ POSTERNA_POLICY_TEXT: "version: 1\n" });
  });

  it("wraps a config function", async () => {
    writeFileSync(join(dir, "agents.yaml"), POLICY);
    const wrapped = withPosternaConfig(async (phase: string) => ({ distDir: phase }));
    expect(await wrapped("phase-production-build")).toEqual({
      distDir: "phase-production-build",
      env: { POSTERNA_POLICY_TEXT: POLICY },
    });
  });

  it("reports a missing file and leaves the config as it was", () => {
    const config = { env: { OTHER: "kept" } };
    expect(withPosternaConfig(config, { onError })).toBe(config);
    expect(warnings).toEqual([
      `No policy file at ${join(dir, "agents.yaml")}, so withPosternaConfig built no policy into the proxy. Run \`npx posterna init\` to create agents.yaml, or set policyPath.`,
    ]);
  });

  it("stays quiet under next start, which serves a build that already has the policy", () => {
    const argv = process.argv;
    process.argv = [argv[0] ?? "node", "next", "start"];
    try {
      expect(withPosternaConfig({}, { onError })).toEqual({});
    } finally {
      process.argv = argv;
    }
    expect(warnings).toEqual([]);
  });

  it("never throws, even when the logger does", () => {
    expect(
      withPosternaConfig(
        {},
        {
          onError: () => {
            throw new Error("logger failed");
          },
        },
      ),
    ).toEqual({});
  });
});
