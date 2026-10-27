import type { AgentRef, DirectoryIndex } from "../directory/index-builder";
import { type DirectoryOptions, DirectoryStore } from "../directory/store";
import type { OperatorRecord } from "../directory/types";
import { automationSignal } from "./automation";
import { identifyClaim } from "./claim";
import {
  compileTrust,
  ProxyGuard,
  type ProxyOptions,
  type ResolvedClient,
  resolveClient,
} from "./client";
import { Lru } from "./lru";
import {
  DEFAULT_REVERSE_DNS,
  type DnsResolver,
  matchesSuffix,
  nodeDnsResolver,
  ReverseDnsCache,
  type ReverseDnsOptions,
} from "./rdns";
import { type NormalizedRequest, normalizeRequest, type RequestLike } from "./request";
import { CLOUDFLARE_LIBRARY, type SignatureLibrary, verifySignatures } from "./signature-path";
import type { ReasonCode, VerdictResult } from "./types";

/** Configuration for {@link createVerifier}. Defaults follow docs/SPEC.md section 12. */
export interface VerifierOptions extends ProxyOptions {
  directory?: DirectoryOptions;
  /** Clock skew allowed on created and expires, in seconds. Default 60. */
  clockSkew?: number;
  /** Longest signature validity window accepted, in seconds. Default 300. */
  maxSignatureValidity?: number;
  /** Nonces remembered for replay detection. Default 10,000. */
  nonceCacheSize?: number;
  /**
   * DNS for reverse lookups. Defaults to node:dns where available. Pass null
   * to disable reverse DNS, as in edge runtimes.
   */
  dns?: DnsResolver | null;
  reverseDns?: Partial<ReverseDnsOptions>;
  /** Milliseconds since the epoch. Injectable for tests. */
  now?: () => number;
  /** @internal Replaces the Cloudflare functions, for failure-injection tests only. */
  signatureLibrary?: SignatureLibrary;
}

export interface VerifyCallOptions {
  /** The TCP peer address, for Fetch API requests that do not carry it. */
  remoteAddress?: string | null;
}

/** What the verifier knows about itself, for counters and the debug route. */
export interface VerifierState {
  ready: boolean;
  proxySuspect: boolean;
  /** Fail-open paths taken, plus directory and DNS failures. */
  errors: number;
  lastError: string | null;
  directoryVersion: string | null;
  keysVersion: string | null;
  reverseDnsAvailable: boolean;
}

export interface Verifier {
  /** Labels one request. Never throws and never blocks on the network. */
  verify(request: RequestLike, options?: VerifyCallOptions): Promise<VerdictResult>;
  /** Client address and host resolution for one request, for the debug route. */
  resolve(request: RequestLike, options?: VerifyCallOptions): ResolvedClient;
  state(): VerifierState;
  /** The current directory record for an operator slug, if the directory has loaded. */
  operator(slug: string): OperatorRecord | undefined;
  /** Every operator in the current directory. Empty until it has loaded. */
  operators(): OperatorRecord[];
  /**
   * Refreshes directory.json and keys.json now instead of waiting for the
   * schedule. A failure keeps the last good copy. Does nothing when refresh is off.
   */
  refresh(): Promise<{ directory: boolean; keys: boolean }>;
  /** Resolves when background lookups and refreshes started so far have finished. */
  settled(): Promise<void>;
  /** Stops background refreshes. */
  close(): void;
}

function ref(
  operator: OperatorRecord,
  agent: AgentRef["agent"] | undefined,
): Partial<VerdictResult> {
  return {
    operator: operator.slug,
    ...(agent ? { agent: agent.name, purpose: agent.purpose } : {}),
  };
}

/** The agent a verified signature speaks for: the one the User-Agent names, else the only covered one. */
function signingAgent(
  operator: OperatorRecord,
  userAgent: AgentRef | null,
): AgentRef["agent"] | undefined {
  if (userAgent && userAgent.operator.slug === operator.slug) return userAgent.agent;
  const covered = operator.agents.filter((agent) => agent.signs);
  if (covered.length === 1) return covered[0];
  const named = operator.verification.signing.covers;
  return operator.agents.find((agent) => named.includes(agent.name));
}

export function createVerifier(options: VerifierOptions = {}): Verifier {
  const now = options.now ?? (() => Date.now());
  const trust = compileTrust(options);
  const guard = new ProxyGuard();
  const nonces = new Lru<string, true>(options.nonceCacheSize ?? 10_000);
  const clockSkew = options.clockSkew ?? 60;
  const maxValidity = options.maxSignatureValidity ?? 300;
  const library = options.signatureLibrary ?? CLOUDFLARE_LIBRARY;
  const store = new DirectoryStore(options.directory ?? {}, {
    now,
    random: Math.random,
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
  const rdnsOptions = { ...DEFAULT_REVERSE_DNS, ...options.reverseDns };
  let rdns = new ReverseDnsCache(options.dns ?? null, rdnsOptions, now);
  const rdnsReady =
    options.dns === undefined
      ? nodeDnsResolver().then((resolver) => {
          rdns = new ReverseDnsCache(resolver, rdnsOptions, now);
        })
      : Promise.resolve();
  let errors = 0;
  let lastError: string | null = null;

  const failOpen = (
    request: NormalizedRequest | null,
    message: string,
    reason: ReasonCode,
  ): VerdictResult => {
    errors++;
    lastError = message;
    let automated = true;
    try {
      automated = request ? automationSignal(request) !== null : true;
    } catch {
      automated = true;
    }
    return {
      verdict: automated ? "unknown_automation" : "human",
      method: "none",
      reason,
      note: "A fail-open path was taken; the request proceeds unlabeled.",
      error: message,
    };
  };

  /** IP list and reverse DNS checks for a User-Agent claim (docs/SPEC.md section 4.5). */
  const ipPath = (
    claim: AgentRef,
    client: ResolvedClient,
    request: NormalizedRequest,
    index: DirectoryIndex,
  ) => {
    const { operator, agent } = claim;
    const base = ref(operator, agent);
    const lists = index.ipLists.get(operator.slug);
    const matcher = lists
      ? (agent.ip_list_agent && lists.byList.get(agent.ip_list_agent)) || lists.all
      : null;
    const rule = operator.verification.reverse_dns;
    const address = client.address;
    if (!address) {
      return {
        verdict: "declared_unverifiable",
        ...base,
        method: "none",
        reason: "no_client_address",
        note: "The client address is unknown.",
      } as VerdictResult;
    }
    if (matcher?.has(address.parsed)) {
      return {
        verdict: "verified_by_ip",
        ...base,
        method: "ip",
        note: "The address is in the operator's published IP list.",
      } as VerdictResult;
    }
    if (rule && rule.suffixes.length > 0) {
      if (!rdns.available) {
        return {
          verdict: "declared_unverifiable",
          ...base,
          method: "none",
          reason: "no_dns",
          note: "Reverse DNS would decide, and this runtime has no DNS.",
        } as VerdictResult;
      }
      const entry = rdns.get(address.text);
      if (entry?.status === "confirmed") {
        if (entry.hostnames.some((hostname) => matchesSuffix(hostname, rule.suffixes))) {
          return {
            verdict: "verified_by_ip",
            ...base,
            method: "rdns",
            note: "Forward-confirmed reverse DNS matches the operator's documented domain.",
          } as VerdictResult;
        }
        return {
          verdict: "claimed_failed",
          ...base,
          method: "rdns",
          reason: "rdns_mismatch",
          note: "The address is outside the operator's IP lists and its reverse DNS is not the operator's domain.",
        } as VerdictResult;
      }
      if (entry?.status === "unconfirmed") {
        return {
          verdict: "claimed_failed",
          ...base,
          method: "rdns",
          reason: "rdns_unconfirmed",
          note: "The address is outside the operator's IP lists and has no forward-confirmed reverse DNS.",
        } as VerdictResult;
      }
      if (entry?.status === "error")
        return failOpen(request, `reverse DNS lookup failed: ${entry.message}`, "rdns_error");
      rdns.schedule(address.text);
      return {
        verdict: "declared_unverifiable",
        ...base,
        method: "none",
        reason: "rdns_pending",
        note: "A reverse DNS lookup for this address is running; later requests get its result.",
      } as VerdictResult;
    }
    if (matcher) {
      return {
        verdict: "claimed_failed",
        ...base,
        method: "ip",
        reason: "outside_ip_list",
        note: "The address is outside the operator's published IP lists.",
      } as VerdictResult;
    }
    const signs = (index.keys.get(operator.slug)?.keys.length ?? 0) > 0;
    // A community token on a request that otherwise looks like a browser: the
    // token may be an ordinary word (docs/notes/real-traffic-checks.md, item 13).
    const reason: ReasonCode = signs
      ? "unsigned"
      : agent.coverage === "community" && automationSignal(request) === null
        ? "community_token_on_browser"
        : "nothing_published";
    return {
      verdict: "declared_unverifiable",
      ...base,
      method: "none",
      reason,
      note: signs
        ? "The operator signs requests, and this one is not signed."
        : "The operator publishes no keys, IP lists or reverse DNS rules.",
    } as VerdictResult;
  };

  const label = async (request: NormalizedRequest): Promise<VerdictResult> => {
    await rdnsReady;
    await store.ready;
    const index = store.index;
    if (!index)
      return failOpen(
        request,
        `directory not loaded (${store.lastError ?? "unknown reason"})`,
        "directory_unavailable",
      );
    const nowMs = now();
    if (!Number.isFinite(nowMs) || nowMs <= 0)
      return failOpen(request, "the system clock returned an invalid time", "clock_invalid");

    const client = resolveClient(request, trust);
    guard.record(client.address);
    const claim = identifyClaim(request, index);

    const claimed = claim.signatureOperators[0];
    if (claimed && claim.signed) {
      const outcome = await verifySignatures({
        index,
        request: {
          kind: "request",
          method: request.method,
          targetUri: `${client.scheme}://${client.host ?? "invalid.invalid"}${request.target}`,
          fields: request.fields,
        },
        now: Math.floor(nowMs / 1000),
        clockSkew,
        maxValidity,
        nonces,
        library,
        claimed,
        operators: claim.signatureOperators,
      });
      switch (outcome.kind) {
        case "verified":
          return {
            verdict: "verified_by_signature",
            ...ref(outcome.operator, signingAgent(outcome.operator, claim.userAgent)),
            method: "signature",
            note: "A Web Bot Auth signature verified against the operator's published key.",
          };
        case "invalid":
          return {
            verdict: "claimed_failed",
            ...ref(outcome.operator, signingAgent(outcome.operator, claim.userAgent)),
            method: "signature",
            reason: outcome.code,
            note: `The signature did not verify: ${outcome.reason}.`,
          };
        case "unknown_key":
          store.requestKeysRefresh();
          return {
            verdict: "declared_unverifiable",
            ...ref(outcome.operator, signingAgent(outcome.operator, claim.userAgent)),
            method: "signature",
            reason: "unknown_kid",
            note: "The signing key is not one this install holds yet; a keys refresh was requested.",
          };
        case "error":
          return failOpen(request, outcome.error, outcome.code);
        case "no_keys":
        case "unsigned":
          break;
      }
    }

    // A User-Agent claim is checked even when Signature-Agent named nothing usable,
    // so an invented Signature-Agent cannot soften a failed check.
    if (claim.userAgent) return ipPath(claim.userAgent, client, request, index);

    if (claimed) {
      return {
        verdict: "declared_unverifiable",
        operator: claimed.slug,
        method: "none",
        reason: claim.signed ? "no_keys" : "unsigned",
        note: claim.signed
          ? "This install holds no keys for the operator the Signature-Agent names."
          : "Signature-Agent names a listed operator, and the request is not signed.",
      };
    }
    if (claim.signatureAgentPresent) {
      return {
        verdict: "declared_unverifiable",
        method: "none",
        reason: "unlisted_signature_agent",
        note: "Signature-Agent names a key directory that is not in the operator directory; nothing was fetched.",
      };
    }
    const signal = automationSignal(request);
    return signal
      ? {
          verdict: "unknown_automation",
          method: "none",
          reason: signal,
          note: "Automated, and claims no agent in the directory.",
        }
      : { verdict: "human", method: "none" };
  };

  return {
    async verify(input, callOptions = {}) {
      let request: NormalizedRequest | null = null;
      try {
        request = normalizeRequest(input, callOptions.remoteAddress);
        return await label(request);
      } catch (error) {
        return failOpen(
          request,
          `unexpected error: ${error instanceof Error ? error.message : String(error)}`,
          "unexpected_error",
        );
      }
    },
    resolve(input, callOptions = {}) {
      return resolveClient(normalizeRequest(input, callOptions.remoteAddress), trust);
    },
    state() {
      const index = store.index;
      return {
        ready: index !== null,
        proxySuspect: guard.suspect,
        errors: errors + store.errors + rdns.errors,
        lastError: lastError ?? store.lastError ?? rdns.lastError,
        directoryVersion: index?.directoryVersion ?? null,
        keysVersion: index?.keysVersion ?? null,
        reverseDnsAvailable: rdns.available,
      };
    },
    operator(slug) {
      return store.index?.operators.get(slug);
    },
    operators() {
      return [...(store.index?.operators.values() ?? [])];
    },
    async refresh() {
      await store.ready;
      if (!store.refreshEnabled) return { directory: false, keys: false };
      const directory = await store.refreshDirectory();
      const keys = await store.refreshKeys();
      return { directory, keys };
    },
    async settled() {
      await rdnsReady;
      await store.ready;
      await Promise.all([store.settled(), rdns.settled()]);
    },
    close() {
      store.close();
    },
  };
}

const defaultVerifiers = new Map<string, Verifier>();

/**
 * Labels one request with the shared default verifier for these options
 * (docs/SPEC.md section 4.6). Never throws. Create your own with
 * {@link createVerifier} to control its lifetime.
 */
export async function verify(
  request: RequestLike,
  options: ProxyOptions & VerifyCallOptions = {},
): Promise<VerdictResult> {
  const { remoteAddress, ...proxy } = options;
  const key = JSON.stringify([
    proxy.trustedProxies ?? null,
    proxy.forwardedHeader ?? null,
    proxy.publicHost ?? null,
    proxy.trustForwardedHost === true,
    proxy.clientIpHeader ?? null,
  ]);
  let verifier = defaultVerifiers.get(key);
  if (!verifier) {
    verifier = createVerifier(proxy);
    defaultVerifiers.set(key, verifier);
  }
  return verifier.verify(request, { remoteAddress: remoteAddress ?? null });
}
