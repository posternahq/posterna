import { describe, expect, it } from "vitest";
import { normalizePrefix, normalizePrefixes, parseIpList } from "./prefixes";

describe("normalizePrefix", () => {
  it.each([
    ["192.0.2.0/24", "192.0.2.0/24", false],
    [" 192.0.2.0/24 ", "192.0.2.0/24", true],
    ["192.0.2.77/24", "192.0.2.0/24", true],
    ["198.51.100.7", "198.51.100.7/32", true],
    ["2001:0DB8:0000:0000::/32", "2001:db8::/32", true],
    ["2001:db8::1/64", "2001:db8::/64", true],
    ["2001:db8:0:0:1:0:0:1/128", "2001:db8::1:0:0:1/128", true],
    ["2001:db8::", "2001:db8::/128", true],
  ])("normalizes %s to %s", (input, expected, changed) => {
    expect(normalizePrefix(input)).toEqual({ ok: true, prefix: expected, changed });
  });

  it.each([
    "0x7f.0.0.1/8",
    "127.1/16",
    "010.0.0.1/8",
    "300.1.1.1/8",
    "192.0.2.0/33",
    "2001:db8::/129",
    "fe80::1%eth0/64",
    "192.0.2.0/24/1",
    "192.0.2.0/abc",
    "example.com",
    "",
  ])("rejects %j", (input) => {
    expect(normalizePrefix(input).ok).toBe(false);
  });
});

describe("normalizePrefixes", () => {
  it("deduplicates, sorts IPv4 before IPv6 and numerically, and counts what it fixed", () => {
    const result = normalizePrefixes([
      "2001:db8::/32",
      "203.0.113.0/24",
      "198.51.100.9/24",
      "198.51.100.0/24",
      "192.0.2.0/25",
      "192.0.2.0/24",
      "not a prefix",
      "2001:DB8::/32",
    ]);
    expect(result.prefixes).toEqual([
      "192.0.2.0/24",
      "192.0.2.0/25",
      "198.51.100.0/24",
      "203.0.113.0/24",
      "2001:db8::/32",
    ]);
    expect(result.invalid).toEqual(["not a prefix"]);
    expect(result.rewritten).toBe(2);
    expect(result.duplicates).toBe(2);
  });
});

describe("parseIpList", () => {
  it("reads the ipranges JSON format", () => {
    const body = JSON.stringify({
      creationTime: "2026-10-26T00:00:00.000000",
      prefixes: [{ ipv4Prefix: "192.0.2.0/24" }, { ipv6Prefix: "2001:db8::/32" }],
    });
    expect(parseIpList(body)).toEqual({
      ok: true,
      format: "ipranges-json",
      entries: ["192.0.2.0/24", "2001:db8::/32"],
    });
  });

  it("reads a JSON array and plain text with comments", () => {
    expect(parseIpList('["192.0.2.0/24"]')).toEqual({
      ok: true,
      format: "json-array",
      entries: ["192.0.2.0/24"],
    });
    expect(parseIpList("# crawler ranges\n192.0.2.0/24\n\n2001:db8::/32 # v6\n")).toEqual({
      ok: true,
      format: "text-cidr",
      entries: ["192.0.2.0/24", "2001:db8::/32"],
    });
  });

  it("refuses HTML and unrecognized JSON", () => {
    expect(parseIpList("<!doctype html><title>Not found</title>").ok).toBe(false);
    expect(parseIpList("<html><pre>no json here</pre></html>").ok).toBe(false);
    expect(parseIpList('{"ranges": []}').ok).toBe(false);
    expect(parseIpList("{broken").ok).toBe(false);
  });
});

describe("parseIpList on HTML pages", () => {
  it("reads JSON published inside a <pre> block, including ip_prefix entries", () => {
    const html = `<html><body><h1>IP addresses</h1><pre>{&quot;prefixes&quot;: [
      {&quot;ip_prefix&quot;: &quot;192.0.2.1/32&quot;}, {&quot;ipv4Prefix&quot;: &quot;198.51.100.7&quot;}]}</pre></body></html>`;
    expect(parseIpList(html)).toEqual({
      ok: true,
      format: "html-pre+ipranges-json",
      entries: ["192.0.2.1/32", "198.51.100.7"],
    });
  });
});
