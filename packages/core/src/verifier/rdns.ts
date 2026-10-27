import { parseAddress } from "../ip/address";
import { Lru } from "./lru";

/** The two lookups forward-confirmed reverse DNS needs. */
export interface DnsResolver {
  /** PTR names for an address. An empty list means none exist. */
  reverse(ip: string): Promise<string[]>;
  /** A and AAAA addresses for a name. An empty list means none exist. */
  forward(hostname: string): Promise<string[]>;
}

const NOT_FOUND = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN", "ENONAME"]);

/**
 * The resolver backed by node:dns, or null in runtimes that do not have it
 * (edge runtimes), where reverse DNS is skipped.
 */
export async function nodeDnsResolver(): Promise<DnsResolver | null> {
  try {
    const specifier = "node:dns";
    const dns = (await import(
      /* webpackIgnore: true */ /* turbopackIgnore: true */ specifier
    )) as typeof import("node:dns");
    const promises = dns.promises;
    if (!promises?.reverse) return null;
    const quiet = async (lookup: Promise<string[]>) => {
      try {
        return await lookup;
      } catch (error) {
        if (NOT_FOUND.has((error as NodeJS.ErrnoException).code ?? "")) return [];
        throw error;
      }
    };
    return {
      reverse: (ip) => quiet(promises.reverse(ip)),
      forward: async (hostname) => {
        const [v4, v6] = await Promise.all([
          quiet(promises.resolve4(hostname)),
          quiet(promises.resolve6(hostname)),
        ]);
        return [...v4, ...v6];
      },
    };
  } catch {
    return null;
  }
}

export type ReverseDnsEntry =
  | { status: "pending" }
  /** Forward-confirmed names, lowercase, without the trailing dot. */
  | { status: "confirmed"; hostnames: string[]; expiresAt: number }
  | { status: "unconfirmed"; expiresAt: number }
  | { status: "error"; message: string; expiresAt: number };

export interface ReverseDnsOptions {
  timeoutMs: number;
  positiveTtlMs: number;
  negativeTtlMs: number;
  /** How long a failed lookup is remembered before it is retried. */
  errorTtlMs: number;
  maxEntries: number;
}

export const DEFAULT_REVERSE_DNS: ReverseDnsOptions = {
  timeoutMs: 1_000,
  positiveTtlMs: 24 * 60 * 60 * 1000,
  negativeTtlMs: 60 * 60 * 1000,
  errorTtlMs: 60 * 1000,
  maxEntries: 10_000,
};

const MAX_NAMES = 3;

/**
 * Forward-confirmed reverse DNS that never runs on the request path: the first
 * request from an address schedules a lookup and later requests read the
 * cached result (docs/SPEC.md section 4.5).
 */
export class ReverseDnsCache {
  private readonly entries: Lru<string, ReverseDnsEntry>;
  private readonly inFlight = new Map<string, Promise<void>>();
  errors = 0;
  lastError: string | null = null;

  constructor(
    private readonly resolver: DnsResolver | null,
    private readonly options: ReverseDnsOptions,
    private readonly now: () => number,
  ) {
    this.entries = new Lru(options.maxEntries);
  }

  get available(): boolean {
    return this.resolver !== null;
  }

  /** The current entry for an address, or undefined when there is none or it expired. */
  get(ip: string): ReverseDnsEntry | undefined {
    const entry = this.entries.get(ip);
    if (!entry) return undefined;
    if (entry.status !== "pending" && entry.expiresAt <= this.now()) {
      this.entries.delete(ip);
      return undefined;
    }
    return entry;
  }

  /** Starts a background lookup for an address unless one is cached or running. */
  schedule(ip: string): void {
    if (!this.resolver || this.inFlight.has(ip) || this.get(ip)) return;
    this.entries.set(ip, { status: "pending" });
    const work = this.lookup(ip).finally(() => this.inFlight.delete(ip));
    this.inFlight.set(ip, work);
  }

  /** Resolves when every lookup started so far has finished. */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight.values()]);
  }

  private async lookup(ip: string): Promise<void> {
    const resolver = this.resolver;
    if (!resolver) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out after ${this.options.timeoutMs} ms`)),
        this.options.timeoutMs,
      );
      (timer as { unref?: () => void }).unref?.();
    });
    try {
      const confirmed = await Promise.race([this.confirm(resolver, ip), timeout]);
      const now = this.now();
      this.entries.set(
        ip,
        confirmed.length > 0
          ? {
              status: "confirmed",
              hostnames: confirmed,
              expiresAt: now + this.options.positiveTtlMs,
            }
          : { status: "unconfirmed", expiresAt: now + this.options.negativeTtlMs },
      );
    } catch (error) {
      this.errors++;
      this.lastError = `reverse DNS: ${(error as Error).message}`;
      this.entries.set(ip, {
        status: "error",
        message: (error as Error).message,
        expiresAt: this.now() + this.options.errorTtlMs,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async confirm(resolver: DnsResolver, ip: string): Promise<string[]> {
    const target = parseAddress(ip)?.text;
    const names = (await resolver.reverse(ip))
      .map((name) => name.toLowerCase().replace(/\.$/, ""))
      .filter((name) => name.length > 0)
      .slice(0, MAX_NAMES);
    const confirmed: string[] = [];
    for (const name of names) {
      const addresses = await resolver.forward(name);
      if (addresses.some((address) => parseAddress(address)?.text === target)) confirmed.push(name);
    }
    return confirmed;
  }
}

/** True when a hostname is one of the suffixes or inside one of them. */
export function matchesSuffix(hostname: string, suffixes: readonly string[]): boolean {
  return suffixes.some((suffix) => {
    const lower = suffix.toLowerCase().replace(/^\.+|\.+$/g, "");
    return hostname === lower || hostname.endsWith(`.${lower}`);
  });
}
