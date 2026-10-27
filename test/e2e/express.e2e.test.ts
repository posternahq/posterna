import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type App, appEnv, freePort, REPO, startApp, startIngest } from "./helpers";
import { basicAppChecks, signupChecks } from "./suites";

describe("examples/express-basic", () => {
  let app: App;
  let ingest: Awaited<ReturnType<typeof startIngest>>;
  beforeAll(async () => {
    ingest = await startIngest();
    app = await startApp({
      cwd: join(REPO, "examples", "express-basic"),
      command: process.execPath,
      args: ["server.js"],
      port: await freePort(),
      env: appEnv(ingest.baseUrl),
    });
  });
  afterAll(async () => {
    await app?.stop();
    await ingest?.close();
  });

  basicAppChecks({
    app: () => app,
    ingest: () => ingest,
    sdk: "@posterna/express",
    agentPath: "/agent",
    hasRequestState: true,
  });

  it("flushes counters on shutdown", async () => {
    await fetch(`${app.url}/`, {
      headers: { "user-agent": "Go-http-client/2.0", "x-forwarded-for": "198.51.100.99" },
    });
    const before = ingest.calls.length;
    expect(await app.stop()).toBe(0);
    expect(ingest.calls.length).toBeGreaterThan(before);
    expect(ingest.calls.at(-1)?.payload.buckets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          verdict: "unknown_automation",
          reason: "non_browser_user_agent",
        }),
      ]),
    );
  });
});

describe("examples/express-signup", () => {
  let app: App;
  let ingest: Awaited<ReturnType<typeof startIngest>>;
  beforeAll(async () => {
    ingest = await startIngest();
    app = await startApp({
      cwd: join(REPO, "examples", "express-signup"),
      command: process.execPath,
      args: ["server.js"],
      port: await freePort(),
      env: appEnv(ingest.baseUrl),
    });
  });
  afterAll(async () => {
    await app?.stop();
    await ingest?.close();
  });

  signupChecks({ app: () => app, path: "/signup" });
});
