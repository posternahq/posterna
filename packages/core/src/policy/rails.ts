import { Lru } from "../verifier/lru";
import type { Rate } from "./types";

/** Breaker settings from docs/SPEC.md section 12. */
export const BREAKER = {
  windowMs: 10 * 60 * 1000,
  slotMs: 60 * 1000,
  minClaims: 20,
  failedShare: 0.5,
  tripMs: 60 * 60 * 1000,
} as const;

/** How long a verified request from an operator keeps its claims enforceable under the search-engine guard. */
export const VERIFIED_SEEN_MS = 7 * 24 * 60 * 60 * 1000;

interface BreakerSlot {
  slot: number;
  total: number;
  failed: number;
}

interface BreakerOperator {
  slots: BreakerSlot[];
  trippedUntil: number;
}

/**
 * The breaker (docs/SPEC.md section 5.4). Counts conclusive IP and reverse DNS
 * outcomes per operator in one-minute slots over the last 10 minutes. With at
 * least 20 claims and half or more of them `claimed_failed`, it trips for 60
 * minutes. Counting continues while tripped, so if the failure rate is still
 * that high when the hour ends it trips again at once.
 */
export class Breaker {
  private readonly operators = new Map<string, BreakerOperator>();

  record(operator: string, failed: boolean, now: number): void {
    let entry = this.operators.get(operator);
    if (!entry) {
      entry = { slots: [], trippedUntil: 0 };
      this.operators.set(operator, entry);
    }
    const slot = Math.floor(now / BREAKER.slotMs);
    let current = entry.slots[entry.slots.length - 1];
    if (!current || current.slot !== slot) {
      current = { slot, total: 0, failed: 0 };
      entry.slots.push(current);
      const oldest = slot - BREAKER.windowMs / BREAKER.slotMs;
      while (entry.slots.length > 0 && (entry.slots[0] as BreakerSlot).slot <= oldest)
        entry.slots.shift();
    }
    current.total++;
    if (failed) current.failed++;
  }

  /** Claims and failures in the window ending now. */
  window(operator: string, now: number): { total: number; failed: number } {
    const entry = this.operators.get(operator);
    const oldest = Math.floor(now / BREAKER.slotMs) - BREAKER.windowMs / BREAKER.slotMs;
    let total = 0;
    let failed = 0;
    for (const slot of entry?.slots ?? []) {
      if (slot.slot <= oldest) continue;
      total += slot.total;
      failed += slot.failed;
    }
    return { total, failed };
  }

  tripped(operator: string, now: number): boolean {
    const entry = this.operators.get(operator);
    if (!entry) return false;
    if (entry.trippedUntil > now) return true;
    const { total, failed } = this.window(operator, now);
    if (total >= BREAKER.minClaims && failed / total >= BREAKER.failedShare) {
      entry.trippedUntil = now + BREAKER.tripMs;
      return true;
    }
    return false;
  }

  /** Operators tripped right now, sorted. */
  trippedOperators(now: number): string[] {
    return [...this.operators.keys()].filter((operator) => this.tripped(operator, now)).sort();
  }
}

interface Bucket {
  /** Scaled so one token is `periodMs` units; refills by `count` units per millisecond. */
  units: number;
  updated: number;
}

/**
 * Token buckets for throttle (docs/SPEC.md section 5.2), one per rule and
 * operator, in memory per instance. A bucket holds up to `count` tokens and
 * refills continuously at `count` per period. Integer arithmetic keeps the
 * timing exact.
 */
export class TokenBuckets {
  private readonly buckets: Lru<string, Bucket>;

  constructor(capacity = 10_000) {
    this.buckets = new Lru(capacity);
  }

  /** Takes a token. Returns 0 when one was available, else the whole seconds until one will be (at least 1). */
  take(key: string, rate: Rate, now: number): number {
    const periodMs = rate.seconds * 1000;
    const full = rate.count * periodMs;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { units: full, updated: now };
      this.buckets.set(key, bucket);
    } else {
      const elapsed = Math.max(0, now - bucket.updated);
      bucket.units = Math.min(full, bucket.units + elapsed * rate.count);
      bucket.updated = now;
    }
    if (bucket.units >= periodMs) {
      bucket.units -= periodMs;
      return 0;
    }
    const waitMs = Math.ceil((periodMs - bucket.units) / rate.count);
    return Math.max(1, Math.ceil(waitMs / 1000));
  }

  get size(): number {
    return this.buckets.size;
  }
}
