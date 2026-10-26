import { describe, expect, it } from "vitest";
import { parseAddress } from "./address";
import { PrefixMatcher } from "./prefix-matcher";

const has = (matcher: PrefixMatcher, address: string) => {
  const parsed = parseAddress(address);
  if (!parsed) throw new Error(`bad test address ${address}`);
  return matcher.has(parsed.parsed);
};

describe("PrefixMatcher", () => {
  const matcher = PrefixMatcher.compile([
    "192.0.2.0/24",
    "192.0.2.128/25",
    "198.51.100.7/32",
    "203.0.113.0/25",
    "203.0.113.128/25",
    "2001:db8:10::/48",
    "2001:db8::1/128",
    "not a prefix",
  ]);

  it("matches inside and at the edges of each range, and nothing outside", () => {
    expect(has(matcher, "192.0.2.0")).toBe(true);
    expect(has(matcher, "192.0.2.255")).toBe(true);
    expect(has(matcher, "192.0.3.0")).toBe(false);
    expect(has(matcher, "198.51.100.7")).toBe(true);
    expect(has(matcher, "198.51.100.8")).toBe(false);
    expect(has(matcher, "203.0.113.255")).toBe(true);
    expect(has(matcher, "2001:db8:10:ffff:ffff:ffff:ffff:ffff")).toBe(true);
    expect(has(matcher, "2001:db8:11::")).toBe(false);
    expect(has(matcher, "2001:db8::1")).toBe(true);
    expect(has(matcher, "2001:db8::2")).toBe(false);
  });

  it("merges overlapping and adjacent ranges and counts invalid entries", () => {
    // 192.0.2.0/24 absorbs /25; the two 203.0.113 halves join.
    expect(matcher.size).toBe(5);
    expect(matcher.invalid).toBe(1);
  });

  it("does not match IPv4 against IPv6 ranges or the reverse", () => {
    const v4 = PrefixMatcher.compile(["0.0.0.0/0"]);
    expect(has(v4, "2001:db8::1")).toBe(false);
    expect(has(v4, "203.0.113.1")).toBe(true);
    expect(has(PrefixMatcher.EMPTY, "203.0.113.1")).toBe(false);
  });
});

describe("parseAddress", () => {
  it.each([
    ["192.0.2.1", "192.0.2.1"],
    ["192.0.2.1:8080", "192.0.2.1"],
    ["[2001:db8::1]:443", "2001:db8::1"],
    ["2001:DB8:0:0::1", "2001:db8::1"],
    ["::ffff:192.0.2.1", "192.0.2.1"],
  ])("reads %s as %s", (input, text) => {
    expect(parseAddress(input)?.text).toBe(text);
  });

  it.each(["", "unknown", "_hidden", "fe80::1%eth0", "0x7f.1", "300.1.1.1", "example.com"])(
    "rejects %j",
    (input) => {
      expect(parseAddress(input)).toBeNull();
    },
  );

  it("flags internal ranges", () => {
    for (const address of [
      "10.1.2.3",
      "172.16.0.1",
      "192.168.0.1",
      "127.0.0.1",
      "169.254.1.1",
      "100.64.0.1",
      "::1",
      "fd00::1",
      "fe80::1",
    ]) {
      expect(parseAddress(address)?.internal, address).toBe(true);
    }
    expect(parseAddress("203.0.113.1")?.internal).toBe(false);
  });
});
