import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type App,
  appEnv,
  BROWSER,
  DEBUG_TOKEN,
  freePort,
  POLICY,
  REPO,
  runToEnd,
  startApp,
  startIngest,
} from "./helpers";
import { basicAppChecks, signupChecks } from "./suites";

const nextBin = (example: string) =>
  join(REPO, "examples", example, "node_modules", ".bin", "next");

async function startNext(example: string, ingestBaseUrl: string): Promise<App> {
  const cwd = join(REPO, "examples", example);
  // The examples wrap next.config in withPosternaConfig, which builds the
  // policy that POSTERNA_POLICY names into the proxy and route handlers.
  await runToEnd(nextBin(example), ["build"], cwd, {
    NEXT_TELEMETRY_DISABLED: "1",
    POSTERNA_POLICY: POLICY,
  });
  const port = await freePort();
  return startApp({
    cwd,
    command: nextBin(example),
    args: ["start", "-p", String(port)],
    port,
    // No policy file at run time, as on Vercel: the enforcing policy can only
    // come from the build.
    env: { ...appEnv(ingestBaseUrl), POSTERNA_POLICY: join(cwd, "missing-agents.yaml") },
  });
}

/**
 * Fails when a production build left the policy out. The app starts with
 * POSTERNA_POLICY naming a missing file, as on Vercel, where the proxy has no
 * agents.yaml next to it: the enforcing policy can only come from the build,
 * and without it the debug report says "fallback" and the mode is monitor.
 */
function policyFromBuild(app: () => App) {
  it("loads the policy from the production build, with no policy file at run time", async () => {
    const response = await fetch(`${app().url}/.well-known/posterna/debug`, {
      headers: { ...BROWSER, "x-posterna-debug-token": DEBUG_TOKEN },
    });
    expect(response.status).toBe(200);
    const report = (await response.json()) as {
      policy: { source: string; problem: string | null };
      configuredMode: string;
    };
    expect(report.policy).toMatchObject({ source: "file", problem: null });
    expect(report.configuredMode).toBe("enforce");
  });
}

describe("examples/next-basic (Next.js 16, proxy.ts)", () => {
  let app: App;
  let ingest: Awaited<ReturnType<typeof startIngest>>;
  beforeAll(async () => {
    ingest = await startIngest();
    app = await startNext("next-basic", ingest.baseUrl);
  });
  afterAll(async () => {
    await app?.stop();
    await ingest?.close();
  });

  basicAppChecks({
    app: () => app,
    ingest: () => ingest,
    sdk: "@posterna/next",
    agentPath: "/api/agent",
    hasRequestState: false,
  });
  policyFromBuild(() => app);
});

describe("examples/next-signup (Next.js 15, middleware.ts on Node.js)", () => {
  let app: App;
  let ingest: Awaited<ReturnType<typeof startIngest>>;
  beforeAll(async () => {
    ingest = await startIngest();
    app = await startNext("next-signup", ingest.baseUrl);
  });
  afterAll(async () => {
    await app?.stop();
    await ingest?.close();
  });

  signupChecks({ app: () => app, path: "/api/signup" });
  policyFromBuild(() => app);
});
