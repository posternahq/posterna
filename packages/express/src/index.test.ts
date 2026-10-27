import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import type { CountersPayload, DirectoryFile, KeysFile } from "@posterna/core";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import pkg from "../package.json";
import {
  DEBUG_PATH,
  type PosternaMiddleware,
  type PosternaOptions,
  posterna,
  VERSION,
} from "./index";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const json = <T>(...parts: string[]) => JSON.parse(readFileSync(join(REPO, ...parts), "utf8")) as T;
const snapshot = () => ({
  directory: json<DirectoryFile>("conformance", "fixtures", "directory.json"),
  keys: json<KeysFile>("conformance", "fixtures", "keys.json"),
});

const BROWSER = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  accept: "text/html",
  "accept-language": "en-US",
};
const EXAMPLE_BOT = { "user-agent": "Mozilla/5.0 (compatible; ExampleBot/1.0)" };

const ENFORCE = `version: 1
mode: enforce
defaults:
  claimed_failed: block
paths:
  "/api/*":
    unknown_automation: { action: throttle, rate: 2/min }
signup:
  "/signup":
    verified: lift
    claimed_failed: challenge
    unknown_automation: challenge
`;

let servers: Server[] = [];
let middlewares: PosternaMiddleware[] = [];

afterEach(async () => {
  for (const mw of middlewares) mw.close();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  servers = [];
  middlewares = [];
});

async function start(options: PosternaOptions = {}, mount?: string) {
  const warnings: string[] = [];
  const mw = posterna({
    policy: ENFORCE,
    trustedProxies: ["127.0.0.0/8", "::1/128"],
    directory: { snapshot, refresh: false },
    dns: null,
    env: {},
    onError: (message) => warnings.push(message),
    ...options,
  });
  middlewares.push(mw);
  const app = express();
  if (mount) app.use(mount, mw);
  else app.use(mw);
  const seen: Record<string, unknown>[] = [];
  const handler = (req: express.Request, res: express.Response) => {
    seen.push({
      posterna: req.posterna && { result: req.posterna.result, decision: req.posterna.decision },
      verdict: req.get("x-agent-verdict"),
      operator: req.get("x-agent-operator"),
      forged: req.get("x-posterna-action") ?? null,
      raw: req.rawHeaders.filter((name) => /^x-(agent|posterna)-/i.test(name)),
      signup: req.posterna?.decide({ kind: "signup" }),
    });
    res.type("text/plain").send("hello from the app");
  };
  app.get(/.*/, handler);
  app.post(/.*/, handler);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string, headers: Record<string, string> = {}, client = "203.0.113.200") =>
    fetch(`${base}${path}`, { headers: { "x-forwarded-for": client, ...headers } });
  return { mw, seen, warnings, get, base };
}

describe("@posterna/express", () => {
  it("exports the version from package.json", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("labels a person, passes the verdict on, and removes forged headers", async () => {
    const { get, seen } = await start();
    const response = await get("/", {
      ...BROWSER,
      "x-agent-verdict": "verified_by_signature",
      "x-posterna-action": "allow",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello from the app");
    expect(seen[0]).toMatchObject({
      posterna: { result: { verdict: "human" }, decision: { action: "allow", rule: "human" } },
      verdict: "human",
      forged: null,
      raw: [],
    });
  });

  it("verifies by IP behind a trusted proxy and passes the operator on", async () => {
    const { get, seen } = await start();
    const response = await get("/docs", EXAMPLE_BOT, "192.0.2.77");
    expect(response.status).toBe(200);
    expect(seen[0]).toMatchObject({ verdict: "verified_by_ip", operator: "ip-crawler" });
  });

  it("blocks a spoofed claim with the exact response", async () => {
    const { get, seen } = await start();
    const response = await get("/docs", EXAMPLE_BOT, "203.0.113.9");
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-posterna-action")).toBe("block");
    expect(await response.text()).toBe(
      "This site's policy does not allow this agent (ip-crawler, search). Operators can get verified at https://posterna.com/operators",
    );
    expect(seen).toHaveLength(0);
  });

  it("throttles a burst with Retry-After", async () => {
    const { get } = await start();
    const curl = { "user-agent": "curl/8.4.0", accept: "*/*" };
    expect((await get("/api/a", curl)).status).toBe(200);
    expect((await get("/api/b", curl)).status).toBe(200);
    const limited = await get("/api/c", curl);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("30");
    expect(await limited.text()).toBe(
      "Rate limited by this site's agent policy. Retry after 30 seconds.",
    );
  });

  it("gives sign-up routes their recommendation", async () => {
    const { get, seen } = await start();
    await get("/signup", { "user-agent": "curl/8.4.0", accept: "*/*" });
    expect(seen[0]).toMatchObject({ signup: { action: "challenge", enforced: true } });
    await get("/signup", EXAMPLE_BOT, "192.0.2.77");
    expect(seen[1]).toMatchObject({ signup: { action: "lift", enforced: true } });
    await get("/signup", BROWSER);
    expect(seen[2]).toMatchObject({ signup: { action: "allow", rule: "human" } });
  });

  it("decides on the full path when mounted under a prefix", async () => {
    const policy = `version: 1
mode: enforce
paths:
  "/app/api/*":
    unknown_automation: block
  "/api/*":
    unknown_automation: allow
`;
    const { get } = await start({ policy }, "/app");
    // Policy paths are site paths: under app.use("/app", ...) the request is /app/api/x.
    const response = await get("/app/api/x", { "user-agent": "curl/8.4.0", accept: "*/*" });
    expect(response.status).toBe(403);
  });

  it("serves the debug route only with the token", async () => {
    const { get } = await start({ debugToken: "s3cret-token" });
    const denied = await get(DEBUG_PATH, { ...BROWSER, "x-posterna-debug-token": "wrong" });
    expect(denied.status).toBe(200);
    expect(await denied.text()).toBe("hello from the app");

    const response = await get(
      DEBUG_PATH,
      { ...EXAMPLE_BOT, "x-posterna-debug-token": "s3cret-token" },
      "192.0.2.77",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      client: { address: "192.0.2.77", source: "x-forwarded-for entry 1 from the right" },
      authority: { host: expect.stringMatching(/^127\.0\.0\.1:\d+$/), source: "host" },
      viaTrustedProxy: true,
      signatureHeaders: [],
      verdict: { verdict: "verified_by_ip", operator: "ip-crawler" },
      mode: "enforce",
      suspensions: [],
    });
  });

  it("takes the signed host from X-Forwarded-Host only when the site opts in", async () => {
    const report = async (options: PosternaOptions) => {
      const { get } = await start({ debugToken: "t0ken", ...options });
      const response = await get(DEBUG_PATH, {
        ...BROWSER,
        "x-forwarded-host": "www.site.example",
        "x-posterna-debug-token": "t0ken",
      });
      return ((await response.json()) as { authority: unknown }).authority;
    };
    expect(await report({})).toMatchObject({
      host: expect.stringMatching(/^127\.0\.0\.1:\d+$/),
      source: "host",
    });
    expect(await report({ trustForwardedHost: true })).toEqual({
      host: "www.site.example",
      source: "x-forwarded-host",
      scheme: "http",
    });
  });

  it("has no debug route without a token", async () => {
    const { get } = await start({ debugToken: null });
    const response = await get(DEBUG_PATH, { ...BROWSER, "x-posterna-debug-token": "" });
    expect(await response.text()).toBe("hello from the app");
  });

  it("counts requests with response bytes and sends them with the site key", async () => {
    const bodies: CountersPayload[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(
        JSON.parse(gunzipSync(init?.body as Uint8Array).toString("utf8")) as CountersPayload,
      );
      return Response.json({ accepted: 1, modeOverride: "monitor" });
    });
    const { mw, get } = await start({
      siteKey: "psk_test",
      counters: { fetch: fetchMock as unknown as typeof fetch, autoFlush: false },
    });
    await get("/docs", BROWSER);
    await get("/docs", EXAMPLE_BOT, "203.0.113.9");
    await vi.waitFor(() => expect(mw.counters?.pending().length).toBe(2));
    await mw.flush();
    expect(bodies[0]?.sdk.name).toBe("@posterna/express");
    expect(bodies[0]?.buckets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ verdict: "human", pathGroup: "/docs/*", count: 1, bytes: 18 }),
        expect.objectContaining({
          verdict: "claimed_failed",
          reason: "outside_ip_list",
          action: "block",
          enforced: true,
          bytes: 127,
        }),
      ]),
    );
    // The remote override from the response moved the app to monitor.
    expect(mw.engine.state().mode).toBe("monitor");
    expect((await get("/docs", EXAMPLE_BOT, "203.0.113.9")).status).toBe(200);
  });

  it("allows everything when agents.yaml is missing or invalid", async () => {
    const missing = await start({ policy: undefined, policyPath: "/nonexistent/agents.yaml" });
    expect(missing.warnings[0]).toContain("No policy file at /nonexistent/agents.yaml");
    expect((await missing.get("/docs", EXAMPLE_BOT, "203.0.113.9")).status).toBe(200);

    const invalid = await start({ policy: "version: 2\nmode: loud\n" });
    expect(invalid.warnings[0]).toContain("agents.yaml is invalid");
    expect(invalid.warnings[0]).toContain("line 1");
    expect((await invalid.get("/docs", EXAMPLE_BOT, "203.0.113.9")).status).toBe(200);
  });

  it("lets the request through when anything inside fails", async () => {
    const broken = {
      verify: () => Promise.reject(new Error("boom")),
      resolve: () => {
        throw new Error("boom");
      },
      state: () => ({
        ready: false,
        proxySuspect: false,
        errors: 0,
        lastError: null,
        directoryVersion: null,
        keysVersion: null,
        reverseDnsAvailable: false,
      }),
      operator: () => undefined,
      operators: () => [],
      refresh: async () => ({ directory: false, keys: false }),
      settled: async () => {},
      close: () => {},
    };
    const { get, warnings } = await start({ verifier: broken });
    const response = await get("/docs", EXAMPLE_BOT, "203.0.113.9");
    expect(response.status).toBe(200);
    expect(warnings).toEqual(["A request was let through after an internal error: boom"]);
  });
});
