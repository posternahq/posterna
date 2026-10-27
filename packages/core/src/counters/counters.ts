import { DEFAULT_BASE_URL } from "../directory/store";
import type { PolicyState } from "../policy/engine";
import type { Decision } from "../policy/types";
import type { ReasonCode, Verdict, VerdictResult } from "../verifier/types";

/** Settings from docs/SPEC.md section 12. */
export const COUNTERS_DEFAULTS = {
  flushIntervalMs: 60_000,
  maxPathGroups: 50,
  backlogMs: 10 * 60_000,
  requestTimeoutMs: 10_000,
  exitFlushTimeoutMs: 2_000,
  /** First retry after a failed flush; doubles each time up to `maxBackoffMs`. */
  minBackoffMs: 15_000,
  maxBackoffMs: 5 * 60_000,
} as const;

/** What the counters client needs from the policy engine. A `PolicyEngine` provides both. */
export interface CountersSource {
  state(): PolicyState;
  setRemoteOverride(mode: unknown): boolean;
}

export interface CountersOptions {
  /**
   * The site key from the dashboard. Defaults to `POSTERNA_SITE_KEY`. Without
   * one, the client runs local-only and sends nothing.
   */
  siteKey?: string | null;
  /** Where to send counters. Defaults to `POSTERNA_BASE_URL`, else https://posterna.com/v1/. */
  baseUrl?: string;
  /** The adapter reporting, for example `{ name: "@posterna/express", version: "0.1.0" }`. */
  sdk: { name: string; version: string };
  /** The policy engine: its state goes in each payload, and the response's `modeOverride` is applied to it. */
  source?: CountersSource;
  /** Defaults to 60 seconds; `POSTERNA_COUNTERS_INTERVAL_MS` overrides it (at least 1 second) for testing. */
  flushIntervalMs?: number;
  /** Install the timer and the exit hooks. Defaults to true; adapters for serverless runtimes pass false and use `flushIfDue()`. */
  autoFlush?: boolean;
  /** Environment variables, read once. Defaults to `process.env` where it exists. */
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  now?: () => number;
  /** Called with a short message when a flush fails. Never receives the site key or request data. */
  onError?: (message: string) => void;
}

/** One aggregated counter, as sent (docs/SPEC.md section 7). */
export interface CounterBucket {
  hour: string;
  verdict: Verdict;
  reason: ReasonCode | null;
  operator: string | null;
  agent: string | null;
  purpose: string | null;
  pathGroup: string;
  action: Decision["action"];
  enforced: boolean;
  count: number;
  bytes: number;
}

export interface CountersPayload {
  schema: 1;
  sdk: { name: string; version: string; runtime: string };
  instance: string;
  mode: "monitor" | "enforce";
  state: {
    proxySuspect: boolean;
    breakerTripped: string[];
    guarded: number;
    errors: number;
    directoryVersion: string | null;
    keysVersion: string | null;
    policyHash: string | null;
  };
  buckets: CounterBucket[];
}

export interface FlushResult {
  /**
   * `sent`; `local` (no site key, nothing sent); `empty`; `failed` (kept for
   * retry); `backoff` (kept, waiting after a failure); `rejected` (the cloud
   * refused it, dropped); `busy` (another flush was running).
   */
  status: "sent" | "local" | "empty" | "failed" | "backoff" | "rejected" | "busy";
  buckets: number;
  /** Buckets dropped because they were older than 10 minutes. */
  dropped: number;
  modeOverride?: "monitor" | null;
}

export interface CountersStatus {
  local: boolean;
  instance: string;
  pending: number;
  pathGroups: number;
  sent: number;
  dropped: number;
  failures: number;
  lastFlushAt: number | null;
  lastError: string | null;
}

export interface Counters {
  /**
   * Counts one request. Synchronous, constant time, never throws, never
   * touches the network. `bytes` is the response size when known.
   */
  record(
    result: VerdictResult,
    decision: Decision | null,
    request: { pathGroup: string; bytes?: number },
  ): void;
  /** Sends what has been counted now. Never throws. */
  flush(): Promise<FlushResult>;
  /**
   * For serverless and edge runtimes, where timers do not outlive a request:
   * returns a flush promise when one is due, for the platform's `waitUntil`,
   * else null.
   */
  flushIfDue(): Promise<FlushResult> | null;
  status(): CountersStatus;
  /** The buckets waiting to be sent, for tests and the debug route. */
  pending(): CounterBucket[];
  /** Stops the timer and removes the exit hooks. Does not flush. */
  close(): void;
}

interface Entry {
  bucket: CounterBucket;
  /**
   * When this bucket was first queued to send. The 10 minute limit counts from
   * here, so a quiet site that flushes rarely loses nothing.
   */
  queuedAt: number;
}

function defaultEnv(): Record<string, string | undefined> {
  const process = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  return process?.env ?? {};
}

/** `node-22`, `edge`, `bun-1`, `deno-2` or `unknown`. */
export function runtimeName(): string {
  const g = globalThis as {
    EdgeRuntime?: unknown;
    Bun?: { version?: string };
    Deno?: { version?: { deno?: string } };
    process?: { versions?: { node?: string } };
  };
  if (g.EdgeRuntime !== undefined) return "edge";
  if (g.Bun?.version) return `bun-${g.Bun.version.split(".")[0]}`;
  if (g.Deno?.version?.deno) return `deno-${g.Deno.version.deno.split(".")[0]}`;
  const node = g.process?.versions?.node;
  return node ? `node-${node.split(".")[0]}` : "unknown";
}

function randomId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The start of the UTC hour, as `2026-10-28T17:00:00Z`. */
export function hourOf(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 13)}:00:00Z`;
}

async function gzip(text: string): Promise<Uint8Array | null> {
  if (typeof globalThis.CompressionStream !== "function") return null;
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const EMPTY_STATE: CountersPayload["state"] = {
  proxySuspect: false,
  breakerTripped: [],
  guarded: 0,
  errors: 0,
  directoryVersion: null,
  keysVersion: null,
  policyHash: null,
};

/**
 * The counters client (docs/SPEC.md section 7). Aggregates requests in memory
 * by hour, verdict, reason, operator, agent, purpose, path group, action and
 * enforced, and sends them every 60 seconds with the site key. Nothing about
 * a single request (address, URL, header value, body) is ever kept or sent.
 */
export function createCounters(options: CountersOptions): Counters {
  const env = options.env ?? defaultEnv();
  const clock = options.now ?? (() => Date.now());
  const siteKey =
    (options.siteKey === undefined ? env.POSTERNA_SITE_KEY : options.siteKey)?.trim() || null;
  const baseUrl = (options.baseUrl ?? (env.POSTERNA_BASE_URL?.trim() || DEFAULT_BASE_URL)).replace(
    /\/?$/,
    "/",
  );
  const envInterval = Number(env.POSTERNA_COUNTERS_INTERVAL_MS);
  const interval = Math.max(
    1000,
    options.flushIntervalMs ??
      (Number.isFinite(envInterval) && envInterval > 0
        ? envInterval
        : COUNTERS_DEFAULTS.flushIntervalMs),
  );
  const fetcher = options.fetch ?? globalThis.fetch;
  const instance = randomId();
  const sdk = { ...options.sdk, runtime: runtimeName() };

  let entries = new Map<string, Entry>();
  let groups = new Set<string>();
  let backlog: Entry[] = [];
  let sending: Promise<FlushResult> | null = null;
  let failures = 0;
  let nextAttempt = 0;
  let lastFlushAt: number | null = null;
  const startedAt = clock();
  let lastError: string | null = null;
  let sent = 0;
  let dropped = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  const cleanups: (() => void)[] = [];

  const report = (message: string) => {
    lastError = message;
    try {
      options.onError?.(message);
    } catch {
      // A broken error handler must not break counting.
    }
  };

  const record: Counters["record"] = (result, decision, request) => {
    try {
      const now = clock();
      let pathGroup = request.pathGroup || "other";
      if (!groups.has(pathGroup)) {
        if (groups.size >= COUNTERS_DEFAULTS.maxPathGroups) pathGroup = "other";
        else groups.add(pathGroup);
      }
      const bucket: CounterBucket = {
        hour: hourOf(now),
        verdict: result.verdict,
        reason: result.reason ?? null,
        operator: result.operator ?? null,
        agent: result.agent ?? null,
        purpose: result.purpose ?? null,
        pathGroup,
        action: decision?.action ?? "allow",
        enforced: decision?.enforced ?? false,
        count: 0,
        bytes: 0,
      };
      const key = [
        bucket.hour,
        bucket.verdict,
        bucket.reason,
        bucket.operator,
        bucket.agent,
        bucket.purpose,
        bucket.pathGroup,
        bucket.action,
        bucket.enforced,
      ].join("\u0000");
      let entry = entries.get(key);
      if (!entry) {
        entry = { bucket, queuedAt: 0 };
        entries.set(key, entry);
      }
      entry.bucket.count++;
      const bytes = request.bytes;
      if (typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0)
        entry.bucket.bytes += Math.floor(bytes);
    } catch {
      // Counting is best effort and never affects the request.
    }
  };

  const state = (): Pick<CountersPayload, "mode" | "state"> => {
    try {
      const s = options.source?.state();
      if (!s) return { mode: "monitor", state: EMPTY_STATE };
      return {
        mode: s.mode,
        state: {
          proxySuspect: s.proxySuspect,
          breakerTripped: s.breakerTripped,
          guarded: s.guarded,
          errors: s.errors,
          directoryVersion: s.directoryVersion,
          keysVersion: s.keysVersion,
          policyHash: s.policyHash,
        },
      };
    } catch {
      return { mode: "monitor", state: EMPTY_STATE };
    }
  };

  /** Moves this window's buckets into the backlog and starts a new window (and a new path group budget). */
  const rotate = (now: number) => {
    for (const entry of entries.values()) {
      entry.queuedAt = now;
      backlog.push(entry);
    }
    entries = new Map();
    groups = new Set();
  };

  const send = async (batch: Entry[]): Promise<FlushResult> => {
    const payload: CountersPayload = {
      schema: 1,
      sdk,
      instance,
      ...state(),
      buckets: batch.map((entry) => entry.bucket),
    };
    const json = JSON.stringify(payload);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${siteKey}`,
      "Content-Type": "application/json",
    };
    let body: string | Uint8Array = json;
    try {
      const compressed = await gzip(json);
      if (compressed) {
        body = compressed;
        headers["Content-Encoding"] = "gzip";
      }
    } catch {
      body = json;
    }
    const response = await fetcher(`${baseUrl}ingest`, {
      method: "POST",
      headers,
      body: body as RequestInit["body"],
      signal: AbortSignal.timeout(COUNTERS_DEFAULTS.requestTimeoutMs),
    });
    if (response.ok) {
      let modeOverride: "monitor" | null | undefined;
      try {
        const answer = (await response.json()) as { modeOverride?: unknown };
        if (answer && (answer.modeOverride === "monitor" || answer.modeOverride === null)) {
          modeOverride = answer.modeOverride;
          options.source?.setRemoteOverride(answer.modeOverride);
        }
      } catch {
        // An unreadable answer changes nothing.
      }
      return { status: "sent", buckets: batch.length, dropped: 0, modeOverride };
    }
    // Retry what might succeed later; drop what never will.
    const retry = response.status === 429 || response.status >= 500 || response.status === 408;
    throw Object.assign(new Error(`ingest answered ${response.status}`), { retry });
  };

  const doFlush = async (): Promise<FlushResult> => {
    const now = clock();
    rotate(now);
    const fresh = backlog.filter((entry) => now - entry.queuedAt <= COUNTERS_DEFAULTS.backlogMs);
    const stale = backlog.length - fresh.length;
    dropped += stale;
    backlog = fresh;
    lastFlushAt = now;
    if (!siteKey) {
      // Local-only: nothing leaves the process.
      const count = backlog.length;
      backlog = [];
      return { status: "local", buckets: count, dropped: stale };
    }
    if (backlog.length === 0) return { status: "empty", buckets: 0, dropped: stale };
    if (now < nextAttempt) return { status: "backoff", buckets: backlog.length, dropped: stale };
    const batch = backlog;
    backlog = [];
    try {
      const result = await send(batch);
      failures = 0;
      nextAttempt = 0;
      sent += batch.length;
      return { ...result, dropped: stale };
    } catch (error) {
      const retry = (error as { retry?: boolean }).retry !== false;
      failures++;
      nextAttempt =
        clock() +
        Math.min(
          COUNTERS_DEFAULTS.minBackoffMs * 2 ** (failures - 1),
          COUNTERS_DEFAULTS.maxBackoffMs,
        );
      report(`counters flush failed: ${error instanceof Error ? error.message : String(error)}`);
      if (retry) {
        backlog = [...batch, ...backlog];
        return { status: "failed", buckets: batch.length, dropped: stale };
      }
      dropped += batch.length;
      return { status: "rejected", buckets: batch.length, dropped: stale + batch.length };
    }
  };

  const flush = (): Promise<FlushResult> => {
    if (sending) return sending.then(() => ({ status: "busy", buckets: 0, dropped: 0 }));
    sending = doFlush()
      .catch((error): FlushResult => {
        report(`counters flush failed: ${error instanceof Error ? error.message : String(error)}`);
        return { status: "failed", buckets: 0, dropped: 0 };
      })
      .finally(() => {
        sending = null;
      });
    return sending;
  };

  const schedule = () => {
    if (closed) return;
    timer = setTimeout(() => {
      void flush().finally(schedule);
    }, interval);
    (timer as { unref?: () => void }).unref?.();
  };

  if (options.autoFlush !== false) {
    schedule();
    installExitHooks();
  }

  function installExitHooks(): void {
    const entry = {
      pending: () => entries.size > 0 || backlog.length > 0,
      flush,
    };
    registerForExit(entry);
    cleanups.push(() => unregisterForExit(entry));
  }

  return {
    record,
    flush,
    flushIfDue() {
      const now = clock();
      if (sending || closed) return null;
      if (now - (lastFlushAt ?? startedAt) < interval) return null;
      return flush();
    },
    status() {
      return {
        local: siteKey === null,
        instance,
        pending: entries.size + backlog.length,
        pathGroups: groups.size,
        sent,
        dropped,
        failures,
        lastFlushAt,
        lastError,
      };
    },
    pending() {
      return [...backlog, ...entries.values()].map((entry) => ({ ...entry.bucket }));
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
}

// One set of exit hooks for every counters client in the process, so several
// clients never stop a signal from ending the process.
interface ExitEntry {
  pending: () => boolean;
  flush: () => Promise<FlushResult>;
}
const exitEntries = new Set<ExitEntry>();
let removeExitHooks: (() => void) | null = null;

function flushAll(): Promise<unknown> {
  return Promise.allSettled(
    [...exitEntries].filter((entry) => entry.pending()).map((entry) => entry.flush()),
  );
}

function registerForExit(entry: ExitEntry): void {
  exitEntries.add(entry);
  if (removeExitHooks) return;
  const process = (globalThis as { process?: NodeJS.Process }).process;
  if (!process || typeof process.on !== "function" || typeof process.listenerCount !== "function")
    return;
  let flushedBeforeExit = false;
  const onBeforeExit = () => {
    if (flushedBeforeExit) return;
    flushedBeforeExit = true;
    void flushAll();
  };
  const onSignal = (signal: "SIGTERM" | "SIGINT") => {
    // If the application handles this signal itself, only start a flush and
    // leave shutdown to it. Otherwise flush briefly, then let the signal do
    // what it would have done without us.
    if (process.listenerCount(signal) > 1) {
      void flushAll();
      return;
    }
    removeExitHooks?.();
    const deadline = new Promise((resolve) => {
      const timer = setTimeout(resolve, COUNTERS_DEFAULTS.exitFlushTimeoutMs);
      (timer as { unref?: () => void }).unref?.();
    });
    void Promise.race([flushAll(), deadline]).finally(() => process.kill(process.pid, signal));
  };
  process.on("beforeExit", onBeforeExit);
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  removeExitHooks = () => {
    process.off("beforeExit", onBeforeExit);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    removeExitHooks = null;
  };
}

function unregisterForExit(entry: ExitEntry): void {
  exitEntries.delete(entry);
  if (exitEntries.size === 0) removeExitHooks?.();
}
