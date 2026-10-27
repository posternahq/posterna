import { expect, it } from "vitest";
import {
  type App,
  BROWSER,
  CURL,
  DEBUG_TOKEN,
  GOOGLEBOT,
  GOOGLEBOT_ADDRESS,
  type IngestCall,
  SITE_KEY,
  SPOOFED_CLAUDEBOT,
  type startIngest,
  UNVERIFIABLE_AGENT,
  waitFor,
} from "./helpers";

type Ingest = Awaited<ReturnType<typeof startIngest>>;

const BLOCK_BODY =
  "This site's policy does not allow this agent (anthropic, training). Operators can get verified at https://posterna.com/operators";

/**
 * The checks every "basic" example passes: verdict headers, forged headers,
 * enforced block and throttle responses, counters and the remote override.
 */
export function basicAppChecks(context: {
  app: () => App;
  ingest: () => Ingest;
  sdk: string;
  /** The route that echoes what Posterna told the app. */
  agentPath: string;
  /** Express also exposes req.posterna. */
  hasRequestState: boolean;
}): void {
  const get = (path: string, headers: Record<string, string>) =>
    fetch(`${context.app().url}${path}`, { headers, redirect: "manual" });
  const agent = async (headers: Record<string, string>) => {
    const response = await get(context.agentPath, headers);
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  };

  it("labels a person and passes the verdict on", async () => {
    const seen = await agent({ ...BROWSER, "x-forwarded-for": "203.0.113.50" });
    expect(seen).toMatchObject({ verdict: "human", method: "none" });
    if (context.hasRequestState) {
      expect(seen.posterna).toMatchObject({
        result: { verdict: "human" },
        decision: { action: "allow", enforced: false, rule: "human" },
      });
    }
  });

  it("removes forged verdict headers before the app sees them", async () => {
    const seen = await agent({
      ...BROWSER,
      "x-forwarded-for": "203.0.113.50",
      "x-agent-verdict": "verified_by_signature",
      "x-agent-operator": "google",
      "x-posterna-action": "allow",
    });
    expect(seen.verdict).toBe("human");
    expect(seen.operator ?? null).toBeNull();
    if ("forged" in seen) expect(seen.forged).toBeNull();
  });

  it("verifies a crawler by its published IP list", async () => {
    const seen = await agent(GOOGLEBOT);
    expect(seen).toMatchObject({
      verdict: "verified_by_ip",
      operator: "google",
      purpose: "search",
      method: "ip",
    });
    if (context.hasRequestState) {
      expect(seen.posterna).toMatchObject({
        decision: { action: "allow", rule: "guards.search_engines" },
      });
    }
  });

  it("labels unknown automation", async () => {
    expect(await agent(CURL)).toMatchObject({ verdict: "unknown_automation" });
    expect(
      await agent({
        ...BROWSER,
        "user-agent": UNVERIFIABLE_AGENT.userAgent,
        "x-forwarded-for": "203.0.113.51",
      }),
    ).toMatchObject({
      verdict: "declared_unverifiable",
      operator: UNVERIFIABLE_AGENT.operator,
    });
  });

  it("blocks a spoofed crawler with the exact response", async () => {
    const response = await get("/", SPOOFED_CLAUDEBOT);
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-posterna-action")).toBe("block");
    expect(await response.text()).toBe(BLOCK_BODY);
  });

  it("throttles a burst with Retry-After", async () => {
    const statuses: number[] = [];
    let limited: Response | null = null;
    for (let i = 0; i < 4; i++) {
      const response = await get("/api/items", CURL);
      statuses.push(response.status);
      if (response.status === 429) limited = response;
      else await response.arrayBuffer();
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(limited?.headers.get("retry-after")).toBe("20");
    expect(limited?.headers.get("x-posterna-action")).toBe("throttle");
    expect(await limited?.text()).toBe(
      "Rate limited by this site's agent policy. Retry after 20 seconds.",
    );
  });

  it("serves the debug route to the token holder only", async () => {
    const report = (await (
      await get("/.well-known/posterna/debug", {
        ...GOOGLEBOT,
        "x-posterna-debug-token": DEBUG_TOKEN,
      })
    ).json()) as Record<string, unknown>;
    expect(report).toMatchObject({
      posterna: { adapter: context.sdk },
      client: { address: GOOGLEBOT_ADDRESS },
      verdict: { verdict: "verified_by_ip" },
      mode: "enforce",
    });
    const denied = await get("/.well-known/posterna/debug", {
      ...BROWSER,
      "x-posterna-debug-token": "wrong",
    });
    expect(denied.headers.get("content-type") ?? "").not.toContain("application/json");
  });

  it("sends counters to the ingest endpoint with the site key", async () => {
    const ingest = context.ingest();
    await waitFor(
      () =>
        ingest.calls.some((call) =>
          call.payload.buckets.some((bucket) => bucket.verdict === "claimed_failed"),
        ),
      20_000,
      "counters with the spoofed request",
    );
    const call = ingest.calls.find((c) =>
      c.payload.buckets.some((b) => b.verdict === "claimed_failed"),
    ) as IngestCall;
    expect(call.headers.authorization).toBe(`Bearer ${SITE_KEY}`);
    expect(call.headers["content-encoding"]).toBe("gzip");
    expect(call.payload).toMatchObject({ schema: 1, sdk: { name: context.sdk }, mode: "enforce" });
    expect(call.payload.state).toMatchObject({ proxySuspect: false, breakerTripped: [] });
    expect(call.payload.state.policyHash).toMatch(/^sha256-[0-9a-f]{16}$/);
    const all = ingest.calls.flatMap((c) => c.payload.buckets);
    expect(all).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          verdict: "claimed_failed",
          reason: "outside_ip_list",
          operator: "anthropic",
          action: "block",
          enforced: true,
          pathGroup: "/",
        }),
        expect.objectContaining({ verdict: "verified_by_ip", operator: "google", action: "allow" }),
        expect.objectContaining({
          verdict: "unknown_automation",
          action: "throttle",
          enforced: true,
        }),
      ]),
    );
    // Nothing about a single request travels.
    const text = JSON.stringify(ingest.calls.map((c) => c.payload));
    for (const secret of [
      GOOGLEBOT_ADDRESS,
      "216.244.7.10",
      "203.0.113.50",
      "curl/8.4.0",
      "ClaudeBot/1.0",
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("switches to monitor when the ingest response says so", async () => {
    const ingest = context.ingest();
    ingest.state.modeOverride = "monitor";
    // The next flush carries this request; its answer turns on the override.
    await get("/", BROWSER);
    await ingest.next();
    const response = await get("/", SPOOFED_CLAUDEBOT);
    expect(response.status).toBe(200);
    const report = (await (
      await get("/.well-known/posterna/debug", {
        ...BROWSER,
        "x-posterna-debug-token": DEBUG_TOKEN,
      })
    ).json()) as Record<string, unknown>;
    expect(report).toMatchObject({
      mode: "monitor",
      configuredMode: "enforce",
      suspensions: ["remote"],
    });
    await waitFor(
      () =>
        ingest.calls.some(
          (c) =>
            c.payload.mode === "monitor" &&
            c.payload.buckets.some((b) => b.verdict === "claimed_failed" && !b.enforced),
        ),
      20_000,
      "a monitor-mode payload with the unenforced block",
    );
    ingest.state.modeOverride = null;
  });
}

/** The sign-up examples: lift, cap, challenge and the normal flow. */
export function signupChecks(context: { app: () => App; path: string }): void {
  const post = (headers: Record<string, string>) =>
    fetch(`${context.app().url}${context.path}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
      body: "email=someone%40example.com",
    });

  it("lifts friction for a verified agent", async () => {
    const response = await post(GOOGLEBOT);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      created: true,
      emailConfirmation: "skipped",
      recommendation: "lift",
    });
  });

  it("caps an agent that cannot be verified", async () => {
    const response = await post({
      "user-agent": UNVERIFIABLE_AGENT.userAgent,
      "x-forwarded-for": "203.0.113.52",
    });
    expect(await response.json()).toMatchObject({ created: true, recommendation: "cap" });
  });

  it("hands unknown automation to the app's challenge", async () => {
    const response = await post(CURL);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      created: false,
      challenge: "required",
      recommendation: "challenge",
    });
  });

  it("leaves people on the normal flow", async () => {
    const response = await post({ ...BROWSER, "x-forwarded-for": "203.0.113.53" });
    expect(await response.json()).toEqual({
      created: true,
      emailConfirmation: "sent",
      recommendation: "allow",
    });
  });

  it("never lets a failed claim reach sign-up", async () => {
    const response = await post(SPOOFED_CLAUDEBOT);
    expect(response.status).toBe(403);
    expect(response.headers.get("x-posterna-action")).toBe("block");
  });
}
