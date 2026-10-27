import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DirectoryFile, KeysFile } from "@posterna/core";
import { type NextFetchEvent, NextRequest, NextResponse } from "next/server";
import { describe, expect, it, vi } from "vitest";
import pkg from "../package.json";
import {
  DEBUG_PATH,
  decideRequest,
  getPosterna,
  type PosternaNextOptions,
  type ProxyFunction,
  VERSION,
  withPosterna,
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
const POLICY = `version: 1
mode: enforce
defaults:
  claimed_failed: block
signup:
  "/signup":
    verified: lift
    unknown_automation: challenge
`;

function options(extra: PosternaNextOptions = {}): PosternaNextOptions {
  return {
    policy: POLICY,
    trustedProxies: 1,
    publicHost: "www.site.example",
    directory: { snapshot, refresh: false },
    counters: false,
    env: {},
    onError: () => {},
    ...extra,
  };
}

const event = () =>
  ({ waitUntil: vi.fn() }) as unknown as NextFetchEvent & { waitUntil: ReturnType<typeof vi.fn> };

function request(path: string, headers: Record<string, string>) {
  return new NextRequest(`https://www.site.example${path}`, { headers });
}

/** The request headers Next.js would hand the application. */
function forwarded(response: Response): Record<string, string> {
  const names = (response.headers.get("x-middleware-override-headers") ?? "")
    .split(",")
    .filter(Boolean);
  return Object.fromEntries(
    names.map((name) => [name, response.headers.get(`x-middleware-request-${name}`) ?? ""]),
  );
}

describe("@posterna/next", () => {
  it("exports the version from package.json", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("passes the verdict to the app and removes forged headers", async () => {
    const proxy = withPosterna(options());
    const response = (await proxy(
      request("/", {
        ...BROWSER,
        "x-forwarded-for": "203.0.113.5",
        "x-agent-verdict": "verified_by_signature",
      }),
      event(),
    )) as Response;
    expect(response.headers.get("x-middleware-next")).toBe("1");
    const app = forwarded(response);
    expect(app["x-agent-verdict"]).toBe("human");
    expect(app["x-agent-method"]).toBe("none");
    expect(app["user-agent"]).toBe(BROWSER["user-agent"]);
    expect(Object.keys(app).filter((name) => name.startsWith("x-posterna"))).toEqual([]);
  });

  it("reads the client address from X-Forwarded-For only when trustedProxies is set", async () => {
    const trusting = withPosterna(options());
    const blocked = (await trusting(
      request("/docs", { ...EXAMPLE_BOT, "x-forwarded-for": "192.0.2.77, 203.0.113.9" }),
      event(),
    )) as Response;
    expect(blocked.status).toBe(403);
    expect(blocked.headers.get("x-posterna-action")).toBe("block");
    expect(await blocked.text()).toContain("(ip-crawler, search)");

    const verified = (await trusting(
      request("/docs", { ...EXAMPLE_BOT, "x-forwarded-for": "192.0.2.77" }),
      event(),
    )) as Response;
    expect(forwarded(verified)["x-agent-verdict"]).toBe("verified_by_ip");

    const untrusting = withPosterna(options({ trustedProxies: undefined }));
    const unknown = (await untrusting(
      request("/docs", { ...EXAMPLE_BOT, "x-forwarded-for": "203.0.113.9" }),
      event(),
    )) as Response;
    expect(forwarded(unknown)["x-agent-verdict"]).toBe("declared_unverifiable");
  });

  it("composes with an existing proxy function", async () => {
    let seen: unknown;
    const user: ProxyFunction = (req) => {
      seen = getPosterna(req)?.result.verdict;
      if (req.nextUrl.pathname === "/old") return NextResponse.redirect(new URL("/new", req.url));
      const headers = new Headers(req.headers);
      headers.set("x-user", "kept");
      headers.delete("accept-language");
      return NextResponse.next({ request: { headers } });
    };
    const proxy = withPosterna(options(), user);
    const response = (await proxy(
      request("/", { ...BROWSER, "x-forwarded-for": "203.0.113.5", "x-agent-operator": "google" }),
      event(),
    )) as Response;
    expect(seen).toBe("human");
    const app = forwarded(response);
    expect(app["x-user"]).toBe("kept");
    expect(app["x-agent-verdict"]).toBe("human");
    expect(app["x-agent-operator"]).toBeUndefined();
    expect(app["accept-language"]).toBeUndefined();

    const redirect = (await proxy(request("/old", BROWSER), event())) as Response;
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("location")).toBe("https://www.site.example/new");
  });

  it("gives sign-up recommendations through getPosterna and decideRequest", async () => {
    let signup: unknown;
    const proxy = withPosterna(options(), (req) => {
      signup = getPosterna(req)?.decide({ kind: "signup" });
    });
    await proxy(
      request("/signup", { "user-agent": "curl/8.4.0", "x-forwarded-for": "203.0.113.5" }),
      event(),
    );
    expect(signup).toMatchObject({
      action: "challenge",
      enforced: true,
      rule: "signup./signup.unknown_automation",
    });

    const { result, decision } = await decideRequest(
      request("/signup", { ...EXAMPLE_BOT, "x-forwarded-for": "192.0.2.77" }),
      { kind: "signup" },
      options(),
    );
    expect(result.verdict).toBe("verified_by_ip");
    expect(decision).toMatchObject({ action: "lift", enforced: true });
  });

  it("serves the debug route only with the token", async () => {
    const proxy = withPosterna(options({ debugToken: "s3cret" }));
    const denied = (await proxy(
      request(DEBUG_PATH, { ...BROWSER, "x-posterna-debug-token": "nope" }),
      event(),
    )) as Response;
    expect(denied.headers.get("x-middleware-next")).toBe("1");
    const response = (await proxy(
      request(DEBUG_PATH, {
        ...EXAMPLE_BOT,
        "x-forwarded-for": "192.0.2.77",
        "x-posterna-debug-token": "s3cret",
      }),
      event(),
    )) as Response;
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      posterna: { adapter: "@posterna/next" },
      client: {
        address: "192.0.2.77",
        source: "x-forwarded-for with 1 trusted hops (no socket address)",
      },
      authority: { host: "www.site.example", source: "publicHost" },
      verdict: { verdict: "verified_by_ip" },
      mode: "enforce",
    });
  });

  it("counts requests and hands a due flush to waitUntil", async () => {
    let now = Date.parse("2026-10-26T12:00:00Z");
    const fetchMock = vi.fn(async () => Response.json({ accepted: 1, modeOverride: null }));
    const proxy = withPosterna(
      options({
        siteKey: "psk_test",
        counters: { fetch: fetchMock as unknown as typeof fetch, autoFlush: false, now: () => now },
      }),
    );
    const first = event();
    await proxy(request("/docs", { ...BROWSER, "x-forwarded-for": "203.0.113.5" }), first);
    expect(first.waitUntil).not.toHaveBeenCalled();
    now += 61_000;
    const second = event();
    await proxy(request("/docs", { ...BROWSER, "x-forwarded-for": "203.0.113.5" }), second);
    expect(second.waitUntil).toHaveBeenCalledTimes(1);
    await second.waitUntil.mock.calls[0]?.[0];
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lets the request through when anything inside fails", async () => {
    const warnings: string[] = [];
    const proxy = withPosterna(
      options({ policy: "version: 7\n", onError: (m) => warnings.push(m) }),
      () => {
        throw new Error("the user's own proxy failed");
      },
    );
    await expect(proxy(request("/", BROWSER), event())).rejects.toThrow(
      "the user's own proxy failed",
    );
    expect(warnings[0]).toContain("agents.yaml is invalid");

    const quiet = withPosterna(options({ policy: POLICY, onError: (m) => warnings.push(m) }));
    const response = (await quiet(
      { headers: null } as unknown as NextRequest,
      event(),
    )) as Response;
    expect(response.headers.get("x-middleware-next")).toBe("1");
    // No override: Next.js keeps the request headers as they were.
    expect(response.headers.get("x-middleware-override-headers")).toBeNull();
    expect(warnings.at(-1)).toContain("A request was let through after an internal error");
  });
});
