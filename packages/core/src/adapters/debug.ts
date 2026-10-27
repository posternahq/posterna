import type { Counters } from "../counters/counters";
import type { PolicyEngine } from "../policy/engine";
import type { RequestLike } from "../verifier/request";
import type { VerdictResult } from "../verifier/types";
import type { Verifier, VerifyCallOptions } from "../verifier/verifier";

/** The debug route `posterna doctor` calls (docs/SPEC.md section 6). */
export const DEBUG_PATH = "/.well-known/posterna/debug";
/** The request header carrying `POSTERNA_DEBUG_TOKEN`. */
export const DEBUG_TOKEN_HEADER = "x-posterna-debug-token";

const SIGNATURE_HEADERS = ["signature", "signature-input", "signature-agent"] as const;

/**
 * Where an adapter's policy came from: agents.yaml (`file`), the `policy`
 * option (`options`), or the built-in monitor policy used when neither could be
 * loaded (`fallback`, with the reason in `problem`).
 */
export interface PolicyLoad {
  source: "file" | "options" | "fallback";
  problem: string | null;
}

/** What the debug route returns. It is sent only to a caller holding the debug token. */
export interface DebugReport {
  posterna: { adapter: string; version: string };
  /** `header` is the configured `clientIpHeader` when it was consulted. */
  client: { address: string | null; source: string; header: string | null };
  authority: { host: string | null; source: string; scheme: "http" | "https" };
  viaTrustedProxy: boolean;
  /** Which of Signature, Signature-Input and Signature-Agent arrived (names only). */
  signatureHeaders: string[];
  verdict: VerdictResult;
  directory: {
    ready: boolean;
    directoryVersion: string | null;
    keysVersion: string | null;
    /** The lowest directory signing-key generation accepted; null when refresh is off. */
    keyGeneration: number | null;
    reverseDns: boolean;
  };
  /** `source` is `unknown` when the adapter did not say. `hash` is null until computed. */
  policy: {
    source: PolicyLoad["source"] | "unknown";
    hash: string | null;
    problem: string | null;
  };
  mode: "monitor" | "enforce";
  configuredMode: "monitor" | "enforce";
  suspensions: string[];
  breakerTripped: string[];
  proxySuspect: boolean;
  counters: { local: boolean } | null;
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

/** Compares a presented debug token with the configured one in constant time. */
export async function debugTokenMatches(
  presented: string | null | undefined,
  expected: string,
): Promise<boolean> {
  if (!presented || !expected) return false;
  const [a, b] = await Promise.all([sha256(presented), sha256(expected)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= (a[i] as number) ^ (b[i] as number);
  return difference === 0;
}

function headerNames(request: RequestLike): Set<string> {
  const names = new Set<string>();
  const headers = (request as Request).headers;
  if (typeof (headers as Headers | undefined)?.forEach === "function") {
    (headers as Headers).forEach((_value, name) => {
      names.add(name.toLowerCase());
    });
  } else {
    for (const name of Object.keys((request as { headers?: object }).headers ?? {}))
      names.add(name.toLowerCase());
  }
  return names;
}

/** Builds the debug route's answer for one request (docs/SPEC.md section 6). */
export function debugReport(input: {
  adapter: string;
  version: string;
  request: RequestLike;
  callOptions?: VerifyCallOptions;
  result: VerdictResult;
  verifier: Verifier;
  engine: PolicyEngine;
  counters: Counters | null;
  policy?: PolicyLoad;
}): DebugReport {
  const resolved = input.verifier.resolve(input.request, input.callOptions ?? {});
  const verifierState = input.verifier.state();
  const policyState = input.engine.state();
  const names = headerNames(input.request);
  return {
    posterna: { adapter: input.adapter, version: input.version },
    client: {
      address: resolved.address?.text ?? null,
      source: resolved.addressSource,
      header: resolved.clientIpHeader,
    },
    authority: { host: resolved.host, source: resolved.hostSource, scheme: resolved.scheme },
    viaTrustedProxy: resolved.viaTrustedProxy,
    signatureHeaders: SIGNATURE_HEADERS.filter((name) => names.has(name)),
    verdict: input.result,
    directory: {
      ready: verifierState.ready,
      directoryVersion: verifierState.directoryVersion,
      keysVersion: verifierState.keysVersion,
      keyGeneration: verifierState.directoryKeyGeneration,
      reverseDns: verifierState.reverseDnsAvailable,
    },
    policy: {
      source: input.policy?.source ?? "unknown",
      hash: policyState.policyHash,
      problem: input.policy?.problem ?? null,
    },
    mode: policyState.mode,
    configuredMode: policyState.configuredMode,
    suspensions: policyState.suspensions,
    breakerTripped: policyState.breakerTripped,
    proxySuspect: policyState.proxySuspect,
    counters: input.counters ? { local: input.counters.status().local } : null,
  };
}
