import ipaddr from "ipaddr.js";

/** An IP address as a number, ready for prefix matching. */
export type ParsedAddress = { kind: "ipv4"; value: number } | { kind: "ipv6"; value: bigint };

export interface Address {
  /** Normal form: dotted quad, or RFC 5952 for IPv6. IPv4-mapped IPv6 becomes IPv4. */
  text: string;
  parsed: ParsedAddress;
  /** Private, loopback, link-local, carrier-grade NAT, unique local or unspecified. */
  internal: boolean;
}

const INTERNAL_RANGES = new Set([
  "private",
  "loopback",
  "linkLocal",
  "carrierGradeNat",
  "uniqueLocal",
  "unspecified",
]);

function toAddress(ip: ipaddr.IPv4 | ipaddr.IPv6): Address {
  if (ip.kind() === "ipv6" && (ip as ipaddr.IPv6).isIPv4MappedAddress()) {
    return toAddress((ip as ipaddr.IPv6).toIPv4Address());
  }
  const bytes = ip.toByteArray();
  if (ip.kind() === "ipv4") {
    const value =
      (((bytes[0] ?? 0) << 24) >>> 0) +
      ((bytes[1] ?? 0) << 16) +
      ((bytes[2] ?? 0) << 8) +
      (bytes[3] ?? 0);
    return {
      text: ip.toString(),
      parsed: { kind: "ipv4", value },
      internal: INTERNAL_RANGES.has(ip.range()),
    };
  }
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return {
    text: (ip as ipaddr.IPv6).toRFC5952String(),
    parsed: { kind: "ipv6", value },
    internal: INTERNAL_RANGES.has(ip.range()),
  };
}

/**
 * Parses one address as it appears in a socket or a forwarding header:
 * strict dotted-quad IPv4, IPv6 with or without brackets, an optional port,
 * and no zone id. Returns null for anything else.
 */
export function parseAddress(input: string | null | undefined): Address | null {
  if (!input) return null;
  let value = input.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed?.[1]) value = bracketed[1];
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(value))
    value = value.slice(0, value.lastIndexOf(":"));
  if (value.includes("%")) return null;
  try {
    if (ipaddr.IPv4.isValidFourPartDecimal(value)) return toAddress(ipaddr.IPv4.parse(value));
    if (value.includes(":") && ipaddr.IPv6.isValid(value))
      return toAddress(ipaddr.IPv6.parse(value));
  } catch {
    return null;
  }
  return null;
}
