import {
  buildIndex,
  checkDirectoryShape,
  checkKeysShape,
  type DirectoryIndex,
} from "./index-builder";
import {
  TRUSTED_DIRECTORY_KEYS,
  type TrustedDirectoryKey,
  verifyDirectorySignature,
} from "./signature";
import type { DirectoryFile, KeysFile } from "./types";

/** directory.json and keys.json as parsed JSON, not yet checked. */
export interface DirectorySnapshot {
  directory: unknown;
  keys: unknown;
}

export interface DirectoryOptions {
  /**
   * Where the starting copy comes from. Defaults to the snapshot bundled with
   * @posterna/directory. Tests pass fixtures here.
   */
  snapshot?: () => DirectorySnapshot | Promise<DirectorySnapshot>;
  /** Base URL for refreshes. Never taken from a request. Defaults to https://posterna.com/v1/. */
  baseUrl?: string;
  /** Background refresh. Defaults to true; off when no trusted keys are configured. */
  refresh?: boolean;
  /** Keys that may sign downloaded files. Defaults to the embedded list. */
  trustedKeys?: readonly TrustedDirectoryKey[];
  fetch?: typeof fetch;
}

export interface StoreHooks {
  now: () => number;
  random: () => number;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export const DEFAULT_BASE_URL = "https://posterna.com/v1/";
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const EARLY_KEYS_REFRESH_GAP = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

async function bundledSnapshot(): Promise<DirectorySnapshot> {
  const [directory, keys] = await Promise.all([
    import("@posterna/directory/data/directory.json", { with: { type: "json" } }),
    import("@posterna/directory/data/keys.json", { with: { type: "json" } }),
  ]);
  return { directory: directory.default, keys: keys.default };
}

/**
 * Holds the current directory and keys. Starts from a local snapshot, then
 * refreshes in the background: directory.json every 24 hours with jitter,
 * keys.json every hour and early when an unknown kid is seen (at most every
 * 10 minutes). A refresh never blocks a request, and a failed refresh keeps
 * the last good copy (docs/SPEC.md section 3.4).
 */
export class DirectoryStore {
  /** The index requests use. Null until a snapshot loaded. */
  index: DirectoryIndex | null = null;
  errors = 0;
  lastError: string | null = null;
  readonly ready: Promise<void>;

  private directory: DirectoryFile | null = null;
  private keys: KeysFile | null = null;
  private readonly baseUrl: string;
  private readonly trustedKeys: readonly TrustedDirectoryKey[];
  private readonly fetcher: typeof fetch | undefined;
  private readonly refreshing: boolean;
  private timers = new Set<unknown>();
  private lastEarlyKeysRefresh = Number.NEGATIVE_INFINITY;
  private pending = new Set<Promise<unknown>>();
  private closed = false;

  constructor(
    options: DirectoryOptions,
    private readonly hooks: StoreHooks,
  ) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/?$/, "/");
    this.trustedKeys = options.trustedKeys ?? TRUSTED_DIRECTORY_KEYS;
    this.fetcher = options.fetch ?? globalThis.fetch;
    // With no trusted keys, nothing downloaded could ever verify, so do not fetch.
    this.refreshing = (options.refresh ?? true) && this.trustedKeys.length > 0;
    this.ready = this.load(options.snapshot ?? bundledSnapshot);
  }

  private fail(context: string, error: unknown): void {
    this.errors++;
    this.lastError = `${context}: ${error instanceof Error ? error.message : String(error)}`;
  }

  private async load(snapshot: NonNullable<DirectoryOptions["snapshot"]>): Promise<void> {
    try {
      const files = await snapshot();
      this.directory = checkDirectoryShape(files.directory);
      this.keys =
        files.keys === null || files.keys === undefined ? null : checkKeysShape(files.keys);
      this.index = await buildIndex(this.directory, this.keys);
    } catch (error) {
      this.fail("loading the directory snapshot", error);
    }
    if (this.refreshing) {
      this.schedule("directory", this.jitter(DAY));
      this.schedule("keys", this.jitter(HOUR));
    }
  }

  private jitter(ms: number): number {
    return Math.round(ms * (0.9 + this.hooks.random() * 0.2));
  }

  private schedule(file: "directory" | "keys", delay: number): void {
    if (this.closed) return;
    const handle = this.hooks.setTimeout(() => {
      this.timers.delete(handle);
      this.track(file === "directory" ? this.refreshDirectory() : this.refreshKeys()).finally(() =>
        this.schedule(file, this.jitter(file === "directory" ? DAY : HOUR)),
      );
    }, delay);
    (handle as { unref?: () => void })?.unref?.();
    this.timers.add(handle);
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    work.finally(() => this.pending.delete(work)).catch(() => {});
    return work;
  }

  /** Resolves when every background refresh started so far has finished. */
  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  /**
   * Asks for an early keys.json refresh after an unknown kid. Returns true when
   * one was started; at most one per 10 minutes.
   */
  requestKeysRefresh(): boolean {
    if (!this.refreshing || this.closed) return false;
    const now = this.hooks.now();
    if (now - this.lastEarlyKeysRefresh < EARLY_KEYS_REFRESH_GAP) return false;
    this.lastEarlyKeysRefresh = now;
    this.track(this.refreshKeys());
    return true;
  }

  private async download(name: string): Promise<Uint8Array> {
    if (!this.fetcher) throw new Error("no fetch available");
    const response = await this.fetcher(`${this.baseUrl}${name}`, {
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > MAX_FILE_BYTES)
      throw new Error(`${name}: larger than ${MAX_FILE_BYTES} bytes`);
    return body;
  }

  /** Downloads a file and its .sig, and returns the parsed JSON only if the signature verifies. */
  private async signedFile(name: string): Promise<unknown> {
    const [body, signature] = await Promise.all([
      this.download(name),
      this.download(`${name}.sig`),
    ]);
    const valid = await verifyDirectorySignature(
      body,
      new TextDecoder().decode(signature),
      this.trustedKeys,
    );
    if (!valid) throw new Error(`${name}: signature does not verify against the trusted keys`);
    return JSON.parse(new TextDecoder().decode(body));
  }

  /** Refreshes directory.json now. Returns false and keeps the last good copy on any failure. */
  async refreshDirectory(): Promise<boolean> {
    try {
      const directory = checkDirectoryShape(await this.signedFile("directory.json"));
      const index = await buildIndex(directory, this.keys);
      this.directory = directory;
      this.index = index;
      return true;
    } catch (error) {
      this.fail("refreshing directory.json", error);
      return false;
    }
  }

  /** Refreshes keys.json now. Returns false and keeps the last good copy on any failure. */
  async refreshKeys(): Promise<boolean> {
    try {
      const keys = checkKeysShape(await this.signedFile("keys.json"));
      if (!this.directory) throw new Error("no directory loaded to attach keys to");
      const index = await buildIndex(this.directory, keys);
      this.keys = keys;
      this.index = index;
      return true;
    } catch (error) {
      this.fail("refreshing keys.json", error);
      return false;
    }
  }

  /** Stops background refreshes. */
  close(): void {
    this.closed = true;
    for (const handle of this.timers) this.hooks.clearTimeout(handle);
    this.timers.clear();
  }

  /** True when refresh is on and at least one trusted key is configured. */
  get refreshEnabled(): boolean {
    return this.refreshing;
  }
}
