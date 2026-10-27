import { type Address, parseAddress } from "../ip/address";
import { PrefixMatcher } from "../ip/prefix-matcher";
import { fieldValue, type NormalizedRequest } from "./request";

/** How the app is reached (docs/SPEC.md section 4.2). */
export interface ProxyOptions {
  /**
   * The proxies in front of the app: a list of CIDRs, or a number of hops.
   * Without it, the socket address is the client and forwarding headers are ignored.
   */
  trustedProxies?: readonly string[] | number;
  /** The forwarding header the trusted proxies append to. Defaults to `x-forwarded-for`. */
  forwardedHeader?: "x-forwarded-for" | "forwarded";
  /**
   * The hostname agents sign as `@authority`. Overrides Host and
   * X-Forwarded-Host. A list is for sites served on several names (the apex
   * and www): the request's host is used when it is in the list, else the
   * first entry.
   */
  publicHost?: string | readonly string[];
}

export interface Trust {
  cidrs: PrefixMatcher | null;
  hops: number;
  header: "x-forwarded-for" | "forwarded";
  publicHosts: string[];
}

export function compileTrust(options: ProxyOptions): Trust {
  const proxies = options.trustedProxies;
  return {
    cidrs: Array.isArray(proxies) ? PrefixMatcher.compile(proxies) : null,
    hops: typeof proxies === "number" && Number.isInteger(proxies) && proxies > 0 ? proxies : 0,
    header: options.forwardedHeader ?? "x-forwarded-for",
    publicHosts: (typeof options.publicHost === "string"
      ? [options.publicHost]
      : (options.publicHost ?? [])
    )
      .map((host) => host.trim().toLowerCase())
      .filter((host) => host.length > 0),
  };
}

export interface ResolvedClient {
  address: Address | null;
  /** Which input produced the address: `socket`, or the header and hop. */
  addressSource: string;
  /** The authority agents sign, lowercase, with a port only when non-default. */
  host: string | null;
  hostSource: string;
  scheme: "http" | "https";
  /** True when the socket peer is a trusted proxy. */
  viaTrustedProxy: boolean;
}

/** Forwarding entries, oldest first, from X-Forwarded-For or the `for=` parameters of Forwarded. */
export function forwardingChain(request: NormalizedRequest, header: Trust["header"]): string[] {
  const raw = fieldValue(request, header);
  if (!raw) return [];
  if (header === "x-forwarded-for") {
    return raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  const chain: string[] = [];
  for (const element of splitOutsideQuotes(raw, ",")) {
    const forPair = splitOutsideQuotes(element, ";")
      .map((pair) => pair.trim())
      .find((pair) => pair.toLowerCase().startsWith("for="));
    // An element without for= is still a hop; record it as unknown so it cannot be skipped.
    chain.push(
      forPair
        ? forPair
            .slice(4)
            .trim()
            .replace(/^"(.*)"$/, "$1")
        : "unknown",
    );
  }
  return chain;
}

function splitOutsideQuotes(value: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i] as string;
    if (char === '"' && value[i - 1] !== "\\") quoted = !quoted;
    if (char === separator && !quoted) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  parts.push(current);
  return parts;
}

function lastValue(raw: string | undefined): string | undefined {
  const value = raw?.split(",").pop()?.trim();
  return value ? value : undefined;
}

/**
 * Works out the client address, the signed host and the scheme. Forwarding
 * headers are read only when the socket peer is a trusted proxy; the client
 * is the rightmost address that is not a trusted proxy.
 */
export function resolveClient(request: NormalizedRequest, trust: Trust): ResolvedClient {
  const socket = parseAddress(request.remoteAddress);
  let address: Address | null = socket;
  let addressSource = socket ? "socket" : "none";
  let viaTrustedProxy = false;

  if (socket && trust.cidrs?.has(socket.parsed)) {
    viaTrustedProxy = true;
    const chain = forwardingChain(request, trust.header);
    for (let i = chain.length - 1; i >= 0; i--) {
      const hop = parseAddress(chain[i]);
      if (!hop) {
        // An unreadable hop ends the walk: the last trusted address is all we know.
        addressSource = `${trust.header} (unreadable entry; using the nearest trusted hop)`;
        break;
      }
      address = hop;
      addressSource = `${trust.header} entry ${chain.length - i} from the right`;
      if (!trust.cidrs.has(hop.parsed)) break;
    }
  } else if (!socket && (trust.cidrs || trust.hops > 0)) {
    // No socket address (Next.js middleware and proxy never see it): the
    // configured proxies are trusted to have written the forwarding header,
    // so read it from its right end. Without trustedProxies it is ignored.
    viaTrustedProxy = true;
    const chain = forwardingChain(request, trust.header);
    if (trust.cidrs) {
      for (let i = chain.length - 1; i >= 0; i--) {
        const hop = parseAddress(chain[i]);
        if (!hop) {
          addressSource = `${trust.header} (unreadable entry)`;
          break;
        }
        address = hop;
        addressSource = `${trust.header} entry ${chain.length - i} from the right (no socket address)`;
        if (!trust.cidrs.has(hop.parsed)) break;
      }
    } else {
      // Fewer entries than hops: take the leftmost, as with a socket address.
      const index = Math.max(0, chain.length - trust.hops);
      const picked = chain.length > 0 ? parseAddress(chain[index]) : null;
      if (picked) {
        address = picked;
        addressSource = `${trust.header} with ${trust.hops} trusted hops (no socket address)`;
      } else addressSource = `${trust.header} (too few or unreadable entries)`;
    }
  } else if (socket && trust.hops > 0) {
    viaTrustedProxy = true;
    const chain = [...forwardingChain(request, trust.header), socket.text];
    const index = Math.max(0, chain.length - 1 - trust.hops);
    const picked = parseAddress(chain[index]);
    if (picked) {
      address = picked;
      addressSource =
        index === chain.length - 1 ? "socket" : `${trust.header} with ${trust.hops} trusted hops`;
    } else addressSource = `${trust.header} (unreadable entry; using the socket)`;
  }

  let host: string | null;
  let hostSource: string;
  const forwardedHost = viaTrustedProxy
    ? lastValue(fieldValue(request, "x-forwarded-host"))
    : undefined;
  if (forwardedHost) {
    host = forwardedHost.toLowerCase();
    hostSource = "x-forwarded-host";
  } else {
    host = (fieldValue(request, "host") ?? request.urlHost)?.toLowerCase() ?? null;
    hostSource = host ? "host" : "none";
  }
  if (trust.publicHosts.length > 0) {
    if (!host || !trust.publicHosts.includes(host)) host = trust.publicHosts[0] as string;
    hostSource = "publicHost";
  }

  let scheme: "http" | "https" = request.urlScheme ?? "https";
  if (trust.publicHosts.length > 0) scheme = "https";
  else if (viaTrustedProxy) {
    const proto = lastValue(fieldValue(request, "x-forwarded-proto"))?.toLowerCase();
    if (proto === "http" || proto === "https") scheme = proto;
  }

  return { address, addressSource, host, hostSource, scheme, viaTrustedProxy };
}

/**
 * Notices the misconfiguration that would make real crawlers look spoofed: if
 * 80 percent or more of the last 200 requests resolve to internal addresses,
 * the app is almost certainly behind a proxy it has not told us about.
 */
export class ProxyGuard {
  private readonly window: Uint8Array;
  private next = 0;
  private filled = 0;
  private internal = 0;

  constructor(
    private readonly size = 200,
    private readonly threshold = 0.8,
  ) {
    this.window = new Uint8Array(size);
  }

  /** Records one resolved client address. Requests with no address at all are not counted. */
  record(address: Address | null): void {
    if (address === null) return;
    const value = address.internal ? 1 : 0;
    if (this.filled === this.size) this.internal -= this.window[this.next] ?? 0;
    else this.filled++;
    this.window[this.next] = value;
    this.internal += value;
    this.next = (this.next + 1) % this.size;
  }

  get suspect(): boolean {
    return this.filled === this.size && this.internal >= this.size * this.threshold;
  }
}
