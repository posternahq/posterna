import ipaddr from "ipaddr.js";
import type { ParsedAddress } from "./address";

const V6_BITS = 128n;

/**
 * IPv4 and IPv6 prefixes compiled into sorted, merged ranges, so a lookup is
 * a binary search. Built once when a directory loads.
 */
export class PrefixMatcher {
  private constructor(
    private readonly v4Starts: Float64Array,
    private readonly v4Ends: Float64Array,
    private readonly v6Starts: bigint[],
    private readonly v6Ends: bigint[],
    /** Prefixes that could not be parsed and were left out. */
    readonly invalid: number,
  ) {}

  static readonly EMPTY = PrefixMatcher.compile([]);

  /** Compiles CIDR strings. Invalid entries are counted and skipped, never thrown. */
  static compile(prefixes: readonly string[]): PrefixMatcher {
    const v4: [number, number][] = [];
    const v6: [bigint, bigint][] = [];
    let invalid = 0;
    for (const prefix of prefixes) {
      try {
        const [address, length] = ipaddr.parseCIDR(prefix.trim());
        if (address.kind() === "ipv4") {
          const bytes = address.toByteArray();
          const value =
            (((bytes[0] ?? 0) << 24) >>> 0) +
            ((bytes[1] ?? 0) << 16) +
            ((bytes[2] ?? 0) << 8) +
            (bytes[3] ?? 0);
          const size = 2 ** (32 - length);
          const start = Math.floor(value / size) * size;
          v4.push([start, start + size - 1]);
        } else {
          let value = 0n;
          for (const byte of address.toByteArray()) value = (value << 8n) | BigInt(byte);
          const hostBits = V6_BITS - BigInt(length);
          const start = (value >> hostBits) << hostBits;
          v6.push([start, start + (1n << hostBits) - 1n]);
        }
      } catch {
        invalid++;
      }
    }
    const mergedV4 = mergeRanges(
      v4,
      (a, b) => a - b,
      (end, start) => end + 1 >= start,
    );
    const mergedV6 = mergeRanges(
      v6,
      (a, b) => (a < b ? -1 : a > b ? 1 : 0),
      (end, start) => end + 1n >= start,
    );
    return new PrefixMatcher(
      Float64Array.from(mergedV4.map(([start]) => start)),
      Float64Array.from(mergedV4.map(([, end]) => end)),
      mergedV6.map(([start]) => start),
      mergedV6.map(([, end]) => end),
      invalid,
    );
  }

  /** Number of merged ranges. */
  get size(): number {
    return this.v4Starts.length + this.v6Starts.length;
  }

  has(address: ParsedAddress): boolean {
    if (address.kind === "ipv4") {
      const index = upperBound(this.v4Starts, address.value) - 1;
      return index >= 0 && address.value <= (this.v4Ends[index] ?? -1);
    }
    let low = 0;
    let high = this.v6Starts.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((this.v6Starts[middle] ?? 0n) <= address.value) low = middle + 1;
      else high = middle;
    }
    const index = low - 1;
    return index >= 0 && address.value <= (this.v6Ends[index] ?? -1n);
  }
}

function upperBound(starts: Float64Array, value: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((starts[middle] ?? 0) <= value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function mergeRanges<T>(
  ranges: [T, T][],
  compare: (a: T, b: T) => number,
  touches: (end: T, start: T) => boolean,
): [T, T][] {
  ranges.sort((a, b) => compare(a[0], b[0]));
  const merged: [T, T][] = [];
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1];
    if (last && touches(last[1], start)) {
      if (compare(end, last[1]) > 0) last[1] = end;
    } else merged.push([start, end]);
  }
  return merged;
}
