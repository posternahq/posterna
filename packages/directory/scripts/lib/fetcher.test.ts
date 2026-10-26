import { describe, expect, it } from "vitest";
import { type FetchTarget, type HttpGet, PoliteFetcher, RequestError } from "./fetcher";

type Reply = { status: number; body?: string; location?: string } | RequestError;

/** A fake network: a map from URL to reply, recording every request. */
function fakeNetwork(replies: Record<string, Reply>) {
  const calls: string[] = [];
  const get: HttpGet = async (url) => {
    calls.push(url);
    const reply = replies[url];
    if (!reply)
      return { status: 404, contentType: "text/plain", location: null, body: new Uint8Array() };
    if (reply instanceof RequestError) throw reply;
    return {
      status: reply.status,
      contentType: "text/plain",
      location: reply.location ?? null,
      body: new TextEncoder().encode(reply.body ?? ""),
    };
  };
  const fetcher = new PoliteFetcher(
    get,
    () => new Date("2026-10-26T00:00:00Z"),
    async () => {},
  );
  return { fetcher, calls };
}

const target = (url: string): FetchTarget => ({
  url,
  kind: "ip_list",
  operator: "example",
  label: "list",
});

describe("PoliteFetcher", () => {
  it("fetches when robots.txt allows it, and hashes the body", async () => {
    const { fetcher, calls } = fakeNetwork({
      "https://a.test/robots.txt": { status: 200, body: "User-agent: *\nDisallow: /private/\n" },
      "https://a.test/list.json": { status: 200, body: "192.0.2.0/24" },
    });
    const { entry, body } = await fetcher.fetch(target("https://a.test/list.json"), "*/*");
    expect(entry).toMatchObject({ outcome: "ok", http_status: 200, bytes: 12 });
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(new TextDecoder().decode(body ?? undefined)).toBe("192.0.2.0/24");
    expect(calls).toEqual(["https://a.test/robots.txt", "https://a.test/list.json"]);
  });

  it("records a robots.txt block for its own token and never requests the file", async () => {
    const { fetcher, calls } = fakeNetwork({
      "https://a.test/robots.txt": {
        status: 200,
        body: "User-agent: *\nAllow: /\n\nUser-agent: PosternaDirectoryBuilder\nDisallow: /.well-known/\n",
      },
    });
    const url = "https://a.test/.well-known/http-message-signatures-directory";
    const { entry } = await fetcher.fetch(target(url), "*/*");
    expect(entry.outcome).toBe("blocked_by_robots");
    expect(calls).toEqual(["https://a.test/robots.txt"]);
  });

  it("treats a missing robots.txt as allow all and an unreachable one as disallow all", async () => {
    const { fetcher } = fakeNetwork({
      "https://open.test/robots.txt": { status: 404 },
      "https://open.test/x": { status: 200, body: "ok" },
      "https://down.test/robots.txt": { status: 503 },
    });
    expect((await fetcher.fetch(target("https://open.test/x"), "*/*")).entry.outcome).toBe("ok");
    expect((await fetcher.fetch(target("https://down.test/x"), "*/*")).entry.outcome).toBe(
      "robots_unreachable",
    );
    const records = await fetcher.robotsRecords();
    expect(records.map((record) => [record.origin, record.outcome])).toEqual([
      ["https://down.test", "unreachable"],
      ["https://open.test", "unavailable"],
    ]);
  });

  it("checks robots.txt on the host a redirect points to", async () => {
    const { fetcher, calls } = fakeNetwork({
      "https://a.test/robots.txt": { status: 404 },
      "https://a.test/list": { status: 301, location: "https://b.test/list" },
      "https://b.test/robots.txt": { status: 200, body: "User-agent: *\nDisallow: /\n" },
    });
    const { entry } = await fetcher.fetch(target("https://a.test/list"), "*/*");
    expect(entry).toMatchObject({ outcome: "blocked_by_robots", final_url: "https://b.test/list" });
    expect(calls).not.toContain("https://b.test/list");
  });

  it("records errors and timeouts once, without retrying", async () => {
    const { fetcher, calls } = fakeNetwork({
      "https://a.test/robots.txt": { status: 404 },
      "https://a.test/slow": new RequestError("timeout", "no complete response within 15000 ms"),
      "https://a.test/broken": { status: 500 },
    });
    expect((await fetcher.fetch(target("https://a.test/slow"), "*/*")).entry.outcome).toBe(
      "timeout",
    );
    expect((await fetcher.fetch(target("https://a.test/broken"), "*/*")).entry).toMatchObject({
      outcome: "http_error",
      http_status: 500,
    });
    expect(calls.filter((url) => url === "https://a.test/slow")).toHaveLength(1);
    expect(calls.filter((url) => url === "https://a.test/broken")).toHaveLength(1);
  });

  it("refuses anything but https", async () => {
    const { fetcher, calls } = fakeNetwork({});
    expect((await fetcher.fetch(target("http://a.test/list"), "*/*")).entry.outcome).toBe(
      "invalid_url",
    );
    expect(calls).toEqual([]);
  });
});
