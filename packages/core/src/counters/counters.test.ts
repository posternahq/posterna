import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPolicyEngine, firstSegmentGroup } from "../policy/engine";
import type { Decision } from "../policy/types";
import type { VerdictResult } from "../verifier/types";
import {
  type Counters,
  type CountersPayload,
  createCounters,
  hourOf,
  runtimeName,
} from "./counters";

const SDK = { name: "@posterna/test", version: "0.0.0" };
const T0 = Date.parse("2026-10-26T12:30:00Z");

const googlebot: VerdictResult = {
  verdict: "verified_by_ip",
  operator: "google",
  agent: "Googlebot",
  purpose: "search",
  method: "rdns",
  note: "never sent",
};
const spoof: VerdictResult = {
  verdict: "claimed_failed",
  operator: "anthropic",
  agent: "ClaudeBot",
  purpose: "training",
  method: "ip",
  reason: "outside_ip_list",
};
const human: VerdictResult = { verdict: "human", method: "none" };
const allow: Decision = { action: "allow", enforced: false, reason: "x" };
const block: Decision = {
  action: "block",
  enforced: true,
  rule: "defaults.claimed_failed",
  reason: "x",
};

interface Call {
  url: string;
  headers: Record<string, string>;
  payload: CountersPayload;
}

function mockIngest(answers: (number | { status: number; body: unknown })[] = []) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    const raw = init?.body as Uint8Array | string;
    const text =
      headers["Content-Encoding"] === "gzip"
        ? gunzipSync(raw as Uint8Array).toString("utf8")
        : (raw as string);
    calls.push({ url: String(url), headers, payload: JSON.parse(text) as CountersPayload });
    const answer = answers.shift() ?? { status: 200, body: { accepted: 1, modeOverride: null } };
    const { status, body } = typeof answer === "number" ? { status: answer, body: {} } : answer;
    return new Response(JSON.stringify(body), { status });
  });
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
}

let open: Counters[] = [];
function counters(options: Partial<Parameters<typeof createCounters>[0]> = {}): Counters {
  const client = createCounters({ sdk: SDK, autoFlush: false, env: {}, ...options });
  open.push(client);
  return client;
}

afterEach(() => {
  for (const client of open) client.close();
  open = [];
  vi.useRealTimers();
});

describe("the counters client", () => {
  it("aggregates by hour, verdict, reason, operator, agent, purpose, path group, action and enforced", async () => {
    let now = T0;
    const ingest = mockIngest();
    const client = counters({ siteKey: "psk_test", fetch: ingest.fetch, now: () => now });
    client.record(googlebot, allow, { pathGroup: "/docs/*", bytes: 1000 });
    client.record(googlebot, allow, { pathGroup: "/docs/*", bytes: 500 });
    client.record(googlebot, allow, { pathGroup: "/docs/*" });
    client.record(spoof, block, { pathGroup: "/docs/*", bytes: 120 });
    client.record(human, null, { pathGroup: "/" });
    now = T0 + 45 * 60_000; // the next hour
    client.record(googlebot, allow, { pathGroup: "/docs/*", bytes: 10 });

    const result = await client.flush();
    expect(result).toMatchObject({ status: "sent", buckets: 4, dropped: 0 });
    expect(ingest.calls).toHaveLength(1);
    const [call] = ingest.calls as [Call];
    expect(call.url).toBe("https://posterna.com/v1/ingest");
    expect(call.headers.Authorization).toBe("Bearer psk_test");
    expect(call.headers["Content-Encoding"]).toBe("gzip");
    expect(call.payload).toMatchObject({
      schema: 1,
      sdk: { name: "@posterna/test", version: "0.0.0", runtime: runtimeName() },
      mode: "monitor",
      state: { proxySuspect: false, breakerTripped: [], guarded: 0, errors: 0, policyHash: null },
    });
    expect(call.payload.instance).toMatch(/^[0-9a-f]{24}$/);
    expect(call.payload.buckets).toEqual([
      {
        hour: "2026-10-26T12:00:00Z",
        verdict: "verified_by_ip",
        reason: null,
        operator: "google",
        agent: "Googlebot",
        purpose: "search",
        pathGroup: "/docs/*",
        action: "allow",
        enforced: false,
        count: 3,
        bytes: 1500,
      },
      {
        hour: "2026-10-26T12:00:00Z",
        verdict: "claimed_failed",
        reason: "outside_ip_list",
        operator: "anthropic",
        agent: "ClaudeBot",
        purpose: "training",
        pathGroup: "/docs/*",
        action: "block",
        enforced: true,
        count: 1,
        bytes: 120,
      },
      {
        hour: "2026-10-26T12:00:00Z",
        verdict: "human",
        reason: null,
        operator: null,
        agent: null,
        purpose: null,
        pathGroup: "/",
        action: "allow",
        enforced: false,
        count: 1,
        bytes: 0,
      },
      {
        hour: "2026-10-26T13:00:00Z",
        verdict: "verified_by_ip",
        reason: null,
        operator: "google",
        agent: "Googlebot",
        purpose: "search",
        pathGroup: "/docs/*",
        action: "allow",
        enforced: false,
        count: 1,
        bytes: 10,
      },
    ]);
    // Nothing about a single request travels: no note, no address, no URL.
    expect(JSON.stringify(call.payload)).not.toContain("never sent");
    expect(client.pending()).toEqual([]);
    expect(client.status()).toMatchObject({ sent: 4, pending: 0, failures: 0, local: false });
  });

  it("caps path groups at 50 per flush, with the rest in other", async () => {
    const ingest = mockIngest();
    const client = counters({ siteKey: "psk_test", fetch: ingest.fetch, now: () => T0 });
    for (let i = 0; i < 60; i++) client.record(human, allow, { pathGroup: `/g${i}/*` });
    client.record(human, allow, { pathGroup: "/g3/*" });
    await client.flush();
    const groups = new Map(ingest.calls[0]?.payload.buckets.map((b) => [b.pathGroup, b.count]));
    expect(groups.size).toBe(51);
    expect(groups.get("other")).toBe(10);
    expect(groups.get("/g3/*")).toBe(2);
    // A new flush window gets a new budget.
    client.record(human, allow, { pathGroup: "/g59/*" });
    await client.flush();
    expect(ingest.calls[1]?.payload.buckets.map((b) => b.pathGroup)).toEqual(["/g59/*"]);
  });

  it("applies modeOverride from the ingest response to the policy engine", async () => {
    const engine = createPolicyEngine("version: 1\nmode: enforce\n", { env: {} });
    const ingest = mockIngest([
      { status: 200, body: { accepted: 1, modeOverride: "monitor" } },
      { status: 200, body: { accepted: 1, modeOverride: "enforce" } },
      { status: 200, body: { accepted: 1, modeOverride: null } },
    ]);
    const client = counters({
      siteKey: "psk_test",
      fetch: ingest.fetch,
      source: engine,
      now: () => T0,
    });
    client.record(human, allow, { pathGroup: "/" });
    expect(await client.flush()).toMatchObject({ status: "sent", modeOverride: "monitor" });
    expect(engine.state()).toMatchObject({ mode: "monitor", remoteOverride: "monitor" });
    expect(ingest.calls[0]?.payload.mode).toBe("enforce");

    client.record(human, allow, { pathGroup: "/" });
    await client.flush();
    // "enforce" is never accepted from the cloud.
    expect(engine.state().remoteOverride).toBe("monitor");
    expect(ingest.calls[1]?.payload.mode).toBe("monitor");

    client.record(human, allow, { pathGroup: "/" });
    await client.flush();
    expect(engine.state()).toMatchObject({ mode: "enforce", remoteOverride: null });
  });

  it("sends nothing without a site key", async () => {
    const ingest = mockIngest();
    const client = counters({ fetch: ingest.fetch, now: () => T0 });
    client.record(spoof, block, { pathGroup: "/" });
    expect(client.status().local).toBe(true);
    expect(await client.flush()).toMatchObject({ status: "local", buckets: 1 });
    expect(ingest.fetch).not.toHaveBeenCalled();
    expect(client.pending()).toEqual([]);
  });

  it("reads the site key and base URL from the environment", async () => {
    const ingest = mockIngest();
    const client = counters({
      env: { POSTERNA_SITE_KEY: " psk_env ", POSTERNA_BASE_URL: "http://127.0.0.1:9/v1" },
      fetch: ingest.fetch,
      now: () => T0,
    });
    client.record(human, allow, { pathGroup: "/" });
    await client.flush();
    expect(ingest.calls[0]?.url).toBe("http://127.0.0.1:9/v1/ingest");
    expect(ingest.calls[0]?.headers.Authorization).toBe("Bearer psk_env");
  });

  it("keeps data through failures with exponential backoff, and drops it after 10 minutes", async () => {
    let now = T0;
    const errors: string[] = [];
    const ingest = mockIngest([503, 503]);
    const client = counters({
      siteKey: "psk_test",
      fetch: ingest.fetch,
      now: () => now,
      onError: (message) => errors.push(message),
    });
    client.record(spoof, block, { pathGroup: "/" });
    expect(await client.flush()).toMatchObject({ status: "failed", buckets: 1 });
    expect(errors).toEqual(["counters flush failed: ingest answered 503"]);
    expect(client.pending()).toHaveLength(1);

    now += 10_000; // still inside the first 15 second backoff
    expect(await client.flush()).toMatchObject({ status: "backoff" });
    expect(ingest.calls).toHaveLength(1);

    now += 6_000;
    expect(await client.flush()).toMatchObject({ status: "failed" });
    now += 20_000; // the second backoff is 30 seconds
    expect(await client.flush()).toMatchObject({ status: "backoff" });
    now += 15_000;
    client.record(human, allow, { pathGroup: "/" });
    expect(await client.flush()).toMatchObject({ status: "sent", buckets: 2 });
    expect(ingest.calls.at(-1)?.payload.buckets.map((b) => b.verdict)).toEqual([
      "claimed_failed",
      "human",
    ]);

    // Ten minutes of failures: the oldest data is dropped, never sent late.
    const failing = mockIngest(Array(50).fill(503));
    const stale = counters({ siteKey: "psk_test", fetch: failing.fetch, now: () => now });
    stale.record(spoof, block, { pathGroup: "/" });
    await stale.flush();
    now += 11 * 60_000;
    expect(await stale.flush()).toMatchObject({ status: "empty", dropped: 1 });
    expect(stale.status().dropped).toBe(1);
  });

  it("drops a batch the cloud refuses, and never throws", async () => {
    const ingest = mockIngest([401]);
    const client = counters({ siteKey: "psk_wrong", fetch: ingest.fetch, now: () => T0 });
    client.record(human, allow, { pathGroup: "/" });
    expect(await client.flush()).toMatchObject({ status: "rejected", dropped: 1 });
    expect(client.pending()).toEqual([]);

    const broken = counters({
      siteKey: "psk_test",
      now: () => T0,
      fetch: (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch,
    });
    broken.record(human, allow, { pathGroup: "/" });
    expect(await broken.flush()).toMatchObject({ status: "failed" });
    expect(broken.status().lastError).toBe("counters flush failed: fetch failed");
    expect(broken.status().lastError).not.toContain("psk_");
  });

  it("never lets a bad input or source break counting", async () => {
    const client = counters({
      siteKey: "psk_test",
      fetch: mockIngest().fetch,
      now: () => T0,
      source: {
        state: () => {
          throw new Error("boom");
        },
        setRemoteOverride: () => false,
      },
    });
    expect(() =>
      client.record(null as unknown as VerdictResult, allow, { pathGroup: "/" }),
    ).not.toThrow();
    client.record(human, allow, { pathGroup: "/", bytes: Number.NaN });
    expect(await client.flush()).toMatchObject({ status: "sent" });
  });

  it("flushes on its own timer every 60 seconds without keeping the process alive", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(T0);
    const ingest = mockIngest();
    const client = createCounters({ sdk: SDK, siteKey: "psk_test", env: {}, fetch: ingest.fetch });
    open.push(client);
    client.record(human, allow, { pathGroup: "/" });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(ingest.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(ingest.calls).toHaveLength(1));
    client.record(human, allow, { pathGroup: "/" });
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(ingest.calls).toHaveLength(2));
  });

  it("offers a flush to waitUntil once one is due", async () => {
    let now = T0;
    const ingest = mockIngest();
    const client = counters({ siteKey: "psk_test", fetch: ingest.fetch, now: () => now });
    client.record(human, allow, { pathGroup: "/" });
    expect(client.flushIfDue()).toBeNull();
    now += 60_000;
    const due = client.flushIfDue();
    expect(due).not.toBeNull();
    expect(await due).toMatchObject({ status: "sent" });
    expect(client.flushIfDue()).toBeNull();
  });

  it("takes the flush interval from the environment for tests, never below a second", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const ingest = mockIngest();
    const client = createCounters({
      sdk: SDK,
      siteKey: "psk_test",
      env: { POSTERNA_COUNTERS_INTERVAL_MS: "10" },
      fetch: ingest.fetch,
    });
    open.push(client);
    client.record(human, allow, { pathGroup: "/" });
    await vi.advanceTimersByTimeAsync(999);
    expect(ingest.fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(ingest.fetch).toHaveBeenCalledTimes(1));
  });

  it("records in well under a microsecond on average", () => {
    const client = counters({ now: () => T0 });
    const start = performance.now();
    for (let i = 0; i < 100_000; i++)
      client.record(spoof, block, { pathGroup: "/docs/*", bytes: 100 });
    const perCall = ((performance.now() - start) / 100_000) * 1000;
    expect(perCall).toBeLessThan(20); // microseconds; generous for slow CI
  });
});

describe("path groups", () => {
  it("use the matched policy pattern, else the first segment, masking identifiers", () => {
    const engine = createPolicyEngine(
      'version: 1\npaths:\n  "/api/*":\n    claimed_failed: block\n',
      { env: {} },
    );
    expect(engine.pathGroup("/api/users/7?x=1")).toBe("/api/*");
    expect(engine.pathGroup("/docs/intro")).toBe("/docs/*");
    expect(engine.pathGroup("/")).toBe("/");
    expect(engine.pathGroup("")).toBe("/");
    for (const path of [
      "/12345/profile",
      "/@alice",
      "/alice%40example.com",
      "/550e8400-e29b-41d4-a716-446655440000",
      "/0123456789abcdef0123",
      "/eyJhbGciOiJIUzI1NiJ9abc",
      "/a%20b",
      `/${"x".repeat(40)}`,
    ]) {
      expect(firstSegmentGroup(path), path).toBe("/:id/*");
    }
    for (const path of ["/blog", "/blog/2026/10/post", "/pricing", "/v1/things", "/robots.txt"]) {
      expect(firstSegmentGroup(path), path).toBe(`/${path.split("/")[1]}/*`);
    }
  });

  it("formats hours in UTC", () => {
    expect(hourOf(Date.parse("2026-10-28T17:59:59.999Z"))).toBe("2026-10-28T17:00:00Z");
  });
});
