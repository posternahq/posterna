import {
  buildIndex,
  checkDirectoryShape,
  checkKeysShape,
  type DirectoryIndex,
} from "./index-builder";
import {
  checkDirectorySignature,
  type DirectorySignatureFailure,
  TRUSTED_DIRECTORY_KEYS,
  type TrustedDirectoryKey,
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

/**
 * Why a refreshed file was rejected (docs/SPEC.md section 3.1). Every
 * rejection keeps the last good copy and increments the error counter.
 */
export type DirectoryRefreshFailure =
  /** The file or its .sig could not be downloaded. */
  | "download_failed"
  | DirectorySignatureFailure
  /** Not JSON, not the expected shape, or a version in the wrong format. */
  | "invalid_file"
  /** Signed at the same generation as the loaded copy, but an older version. */
  | "version_rollback"
  /** keys.json arrived while no directory.json is loaded to attach it to. */
  | "directory_missing";

class RefreshRejected extends Error {
  constructor(
    readonly reason: DirectoryRefreshFailure,
    message: string,
  ) {
    super(message);
  }
}

const DIRECTORY_VERSION = /^\d{4}-\d{2}-\d{2}$/;
const KEYS_VERSION = /^\d{4}-\d{2}-\d{2}T\d{2}$/;

/**
 * The generation ratchet: the highest signing generation seen to verify, per
 * trusted-key list. Every store in the process that uses the same list (in
 * practice the embedded one) shares it. Kept in memory only, so a restart
 * starts again from the lowest generation in the list.
 */
const generationFloors = new WeakMap<readonly TrustedDirectoryKey[], number>();

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
  /** Rejected refreshes by reason. */
  readonly refreshFailures: Partial<Record<DirectoryRefreshFailure, number>> = {};
  readonly ready: Promise<void>;

  private directory: DirectoryFile | null = null;
  private keys: KeysFile | null = null;
  private readonly baseUrl: string;
  private readonly trustedKeys: readonly TrustedDirectoryKey[];
  /** The lowest generation in the trusted list. The bundled snapshot counts as signed at it. */
  private readonly baseGeneration: number;
  /** The signing generation of the loaded directory.json and keys.json. */
  private directoryGeneration: number;
  private keysGeneration: number;
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
    const generations = this.trustedKeys
      .map((key) => key.generation)
      .filter((generation) => Number.isSafeInteger(generation) && generation > 0);
    this.baseGeneration = generations.length > 0 ? Math.min(...generations) : 0;
    this.directoryGeneration = this.baseGeneration;
    this.keysGeneration = this.baseGeneration;
    this.fetcher = options.fetch ?? globalThis.fetch;
    // With no trusted keys, nothing downloaded could ever verify, so do not fetch.
    this.refreshing = (options.refresh ?? true) && this.trustedKeys.length > 0;
    this.ready = this.load(options.snapshot ?? bundledSnapshot);
  }

  private fail(context: string, error: unknown): void {
    this.errors++;
    this.lastError = `${context}: ${error instanceof Error ? error.message : String(error)}`;
  }

  private reject(file: string, error: unknown): void {
    const reason = error instanceof RefreshRejected ? error.reason : "invalid_file";
    this.refreshFailures[reason] = (this.refreshFailures[reason] ?? 0) + 1;
    this.fail(`refreshing ${file}: ${reason}`, error);
  }

  /**
   * The lowest signing generation this store still accepts: the lowest in the
   * trusted list until a file verifies under a higher one.
   */
  get minGeneration(): number {
    return Math.max(this.baseGeneration, generationFloors.get(this.trustedKeys) ?? 0);
  }

  private ratchet(generation: number): void {
    if (generation > (generationFloors.get(this.trustedKeys) ?? 0)) {
      generationFloors.set(this.trustedKeys, generation);
    }
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

  /**
   * Downloads a file and its .sig, and returns the parsed JSON with the
   * signing generation, only if the signature verifies under a trusted key at
   * or above the current minimum generation. Raises the minimum to that
   * generation (the ratchet).
   */
  private async signedFile(name: string): Promise<{ value: unknown; generation: number }> {
    let body: Uint8Array;
    let signature: Uint8Array;
    try {
      [body, signature] = await Promise.all([this.download(name), this.download(`${name}.sig`)]);
    } catch (error) {
      throw new RefreshRejected("download_failed", (error as Error).message);
    }
    const minimum = this.minGeneration;
    const check = await checkDirectorySignature(
      body,
      new TextDecoder().decode(signature),
      this.trustedKeys,
      minimum,
    );
    if (!check.ok) {
      throw new RefreshRejected(
        check.reason,
        check.reason === "signature_retired"
          ? `${name}: signed by a key below generation ${minimum}, which this install no longer trusts`
          : `${name}: signature does not verify against the trusted keys`,
      );
    }
    this.ratchet(check.generation);
    try {
      return { value: JSON.parse(new TextDecoder().decode(body)), generation: check.generation };
    } catch {
      throw new RefreshRejected("invalid_file", `${name}: not valid JSON`);
    }
  }

  /**
   * Anti-rollback: a file signed at the same generation as the loaded copy
   * must not have an older version. A file signed at a higher generation
   * replaces the loaded copy whatever its version, so a far-future version
   * signed with a leaked older key cannot block the switch to a newer key.
   */
  private checkVersion(
    name: string,
    pattern: RegExp,
    version: unknown,
    generation: number,
    loaded: { version: unknown; generation: number } | null,
  ): void {
    if (typeof version !== "string" || !pattern.test(version)) {
      throw new RefreshRejected("invalid_file", `${name}: version is missing or malformed`);
    }
    if (!loaded || generation > loaded.generation) return;
    if (typeof loaded.version === "string" && pattern.test(loaded.version)) {
      if (version < loaded.version) {
        throw new RefreshRejected(
          "version_rollback",
          `${name}: version ${version} is older than the loaded ${loaded.version}`,
        );
      }
    }
  }

  private async shape<T>(name: string, check: () => T | Promise<T>): Promise<T> {
    try {
      return await check();
    } catch (error) {
      throw new RefreshRejected("invalid_file", `${name}: ${(error as Error).message}`);
    }
  }

  /** Refreshes directory.json now. Returns false and keeps the last good copy on any failure. */
  async refreshDirectory(): Promise<boolean> {
    try {
      const { value, generation } = await this.signedFile("directory.json");
      const directory = await this.shape("directory.json", () => checkDirectoryShape(value));
      this.checkVersion(
        "directory.json",
        DIRECTORY_VERSION,
        directory.version,
        generation,
        this.directory
          ? { version: this.directory.version, generation: this.directoryGeneration }
          : null,
      );
      const index = await this.shape("directory.json", () => buildIndex(directory, this.keys));
      this.directory = directory;
      this.directoryGeneration = generation;
      this.index = index;
      return true;
    } catch (error) {
      this.reject("directory.json", error);
      return false;
    }
  }

  /** Refreshes keys.json now. Returns false and keeps the last good copy on any failure. */
  async refreshKeys(): Promise<boolean> {
    try {
      const { value, generation } = await this.signedFile("keys.json");
      const keys = await this.shape("keys.json", () => checkKeysShape(value));
      this.checkVersion(
        "keys.json",
        KEYS_VERSION,
        keys.version,
        generation,
        this.keys ? { version: this.keys.version, generation: this.keysGeneration } : null,
      );
      const directory = this.directory;
      if (!directory) {
        throw new RefreshRejected("directory_missing", "no directory loaded to attach keys to");
      }
      const index = await this.shape("keys.json", () => buildIndex(directory, keys));
      this.keys = keys;
      this.keysGeneration = generation;
      this.index = index;
      return true;
    } catch (error) {
      this.reject("keys.json", error);
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
