import {
  type ComponentDescriptor,
  type RequestDescriptor,
  SignatureError,
  SignatureErrorCode,
  type UntrustedSignatureCandidate,
  verifySignature,
} from "http-message-sig";
import { parseDictionary } from "structured-headers";
import {
  HTTP_MESSAGE_SIGNATURE_TAG,
  parseSignatureAgentHeader,
  type SignatureAgentEntry,
  type WebBotAlgorithm,
  type WebBotVerifier,
  verify as webBotAuthVerify,
} from "web-bot-auth";
import type { DirectoryIndex, KeyVerifier } from "../directory/index-builder";
import type { OperatorRecord } from "../directory/types";
import { signatureAgentOrigin } from "./claim";
import type { Lru } from "./lru";

/**
 * The Cloudflare functions the signature path calls. Tests replace them to
 * inject failures; production always uses the real ones.
 */
export interface SignatureLibrary {
  verify: typeof webBotAuthVerify;
  verifySignature: typeof verifySignature;
}

export const CLOUDFLARE_LIBRARY: SignatureLibrary = Object.freeze({
  verify: webBotAuthVerify,
  verifySignature,
});

export type SignatureOutcome =
  | { kind: "verified"; operator: OperatorRecord; keyid: string }
  | { kind: "invalid"; operator: OperatorRecord; reason: string }
  /** The kid matches no key this install holds: an early keys refresh is due. */
  | { kind: "unknown_key"; operator: OperatorRecord }
  /** The operator is listed but this install holds none of its keys. */
  | { kind: "no_keys"; operator: OperatorRecord }
  /** No Web Bot Auth signature names a listed operator. */
  | { kind: "unsigned" }
  /** The library failed or does not support what the signer used: fail open. */
  | { kind: "error"; operator: OperatorRecord; error: string };

export interface SignatureContext {
  index: DirectoryIndex;
  request: RequestDescriptor;
  /** Seconds since the epoch. */
  now: number;
  clockSkew: number;
  maxValidity: number;
  nonces: Lru<string, true>;
  library: SignatureLibrary;
  /** The first listed operator the Signature-Agent header names. */
  claimed: OperatorRecord;
  /** Every listed operator the Signature-Agent header names. */
  operators: OperatorRecord[];
}

const ALGORITHMS: readonly WebBotAlgorithm[] = ["ed25519", "rsa-pss-sha512"];

class UnknownKeyError extends Error {}
class NoKeysError extends Error {}
/** The signature's Signature-Agent member names no listed operator, or is not a directory member. */
class ForeignAgentError extends Error {}

function isSignatureError(error: unknown): error is SignatureError {
  return (
    error instanceof SignatureError ||
    (typeof error === "object" &&
      error !== null &&
      (error as Error).name === "SignatureError" &&
      typeof (error as SignatureError).code === "string")
  );
}

/** Errors from our resolver arrive wrapped as ResolverFailed; look at the cause. */
function unwrap(error: unknown): unknown {
  let current = error;
  for (let depth = 0; depth < 5; depth++) {
    if (
      isSignatureError(current) &&
      current.code === SignatureErrorCode.ResolverFailed &&
      current.cause !== undefined
    ) {
      current = current.cause;
    } else break;
  }
  return current;
}

/** Web Bot Auth labels in Signature-Input, with whether each carries an alg parameter. */
function webBotAuthLabels(signatureInput: string): { label: string; hasAlg: boolean }[] {
  const labels: { label: string; hasAlg: boolean }[] = [];
  for (const [label, member] of parseDictionary(signatureInput)) {
    if (!Array.isArray(member[0])) continue;
    const parameters = member[1];
    if (parameters.get("tag") === HTTP_MESSAGE_SIGNATURE_TAG) {
      labels.push({ label, hasAlg: parameters.has("alg") });
    }
  }
  return labels;
}

function headerOf(request: RequestDescriptor, name: string): string | undefined {
  const values = request.fields
    .filter((field) => field.name === name)
    .map((field) => field.value.trim());
  return values.length > 0 ? values.join(", ") : undefined;
}

function policy(message: string): never {
  throw new SignatureError(SignatureErrorCode.PolicyViolation, message);
}

/**
 * The Web Bot Auth profile checks for a signature without an alg parameter,
 * which the protocol draft allows but web-bot-auth 0.2.0 rejects. They mirror
 * that library's own checks; RFC 9421 parsing and the cryptography still run
 * in Cloudflare's http-message-sig. See docs/notes/upstream-gaps.md.
 */
function profileWithoutAlg(
  request: RequestDescriptor,
  candidate: UntrustedSignatureCandidate,
): { keyid: string; agent: SignatureAgentEntry | undefined } {
  const { parameters, components } = candidate;
  const keyid = parameters.keyid;
  if (typeof keyid !== "string" || keyid === "") policy("keyid must be a non-empty string");
  if (parameters.tag !== HTTP_MESSAGE_SIGNATURE_TAG)
    policy(`tag must be '${HTTP_MESSAGE_SIGNATURE_TAG}'`);
  const { created, expires } = parameters;
  if (typeof created !== "number" || typeof expires !== "number")
    policy("created and expires must be integers");
  if (created > expires) policy("created must not be after expires");
  const bareTarget = components.some(
    ({ name, parameters: componentParameters }) =>
      (name === "@authority" || name === "@target-uri") &&
      Object.keys(componentParameters).length === 0,
  );
  if (!bareTarget) policy("signature must cover bare @authority or bare @target-uri");
  const header = headerOf(request, "signature-agent");
  if (header === undefined) return { keyid, agent: undefined };
  const parsed = parseSignatureAgentHeader(header);
  if (parsed.kind === "legacy") {
    const covered = components.some(
      ({ name, parameters: p }: ComponentDescriptor) =>
        name === "signature-agent" && Object.keys(p).length === 0,
    );
    if (!covered) policy("signature must cover signature-agent");
    return { keyid, agent: parsed.entries[0] };
  }
  const keys = components.flatMap(({ name, parameters: p }) =>
    name === "signature-agent" && Object.keys(p).length === 1 && typeof p.key === "string"
      ? [p.key]
      : [],
  );
  if (keys.length !== 1) policy("signature must cover exactly one signature-agent member");
  const agent = parsed.entries.find((entry) => entry.label === keys[0]);
  if (!agent) policy(`Signature-Agent has no member ${keys[0]}`);
  return { keyid, agent };
}

/**
 * Verifies the Web Bot Auth signatures on a request whose Signature-Agent
 * names a listed operator (docs/SPEC.md section 4.4). Every label is checked
 * on its own; the first that verifies wins.
 */
export async function verifySignatures(context: SignatureContext): Promise<SignatureOutcome> {
  const signatureInput = headerOf(context.request, "signature-input");
  if (signatureInput === undefined || headerOf(context.request, "signature") === undefined) {
    return { kind: "unsigned" };
  }
  let labels: { label: string; hasAlg: boolean }[];
  try {
    labels = webBotAuthLabels(signatureInput);
  } catch {
    return {
      kind: "invalid",
      operator: context.claimed,
      reason: "Signature-Input could not be parsed",
    };
  }
  if (labels.length === 0) return { kind: "unsigned" };
  // Without keys for any named operator there is nothing to check; skip the library entirely.
  if (!context.operators.some((op) => (context.index.keys.get(op.slug)?.keys.length ?? 0) > 0)) {
    return { kind: "no_keys", operator: context.claimed };
  }

  const outcomes: SignatureOutcome[] = [];
  for (const { label, hasAlg } of labels) {
    const outcome = await verifyLabel(context, label, hasAlg);
    if (outcome.kind === "verified") return outcome;
    outcomes.push(outcome);
  }
  const first = (kind: SignatureOutcome["kind"]) =>
    outcomes.find((outcome) => outcome.kind === kind);
  return (
    first("invalid") ??
    first("unknown_key") ??
    first("no_keys") ??
    first("error") ?? { kind: "unsigned" }
  );
}

async function verifyLabel(
  context: SignatureContext,
  label: string,
  hasAlg: boolean,
): Promise<SignatureOutcome> {
  const { index, request, now, clockSkew, maxValidity, nonces, library } = context;
  let operator: OperatorRecord | null = null;
  let rejection: string | null = null;
  let verifiedKeyid = "";

  const resolve = (keyid: string, agent: SignatureAgentEntry | undefined): WebBotVerifier => {
    if (agent?.type !== "directory")
      throw new ForeignAgentError("no directory Signature-Agent member");
    const origin = signatureAgentOrigin(agent.uri);
    const named = origin ? index.signingOrigins.get(origin) : undefined;
    if (!named) throw new ForeignAgentError("the Signature-Agent member names no listed operator");
    operator = named;
    const held = index.keys.get(named.slug);
    if (!held || held.keys.length === 0) throw new NoKeysError("no keys held for this operator");
    // Match by kid, then by RFC 7638 thumbprint, then every key when the operator uses no kid.
    let candidates: KeyVerifier[] = held.keys.filter((key) => key.kid === keyid);
    if (candidates.length === 0) candidates = held.keys.filter((key) => key.thumbprint === keyid);
    if (candidates.length === 0) {
      if (held.usesKid) throw new UnknownKeyError("unknown kid");
      candidates = held.keys;
    }
    const algorithm = (candidates[0] as KeyVerifier).algorithm;
    const usable = candidates.filter((key) => key.algorithm === algorithm);
    verifiedKeyid = keyid;
    return {
      algorithm,
      keyid,
      async verify(data: Uint8Array, signature: Uint8Array) {
        for (const key of usable) if (await key.verify(data, signature)) return true;
        return false;
      },
    };
  };

  const validate = (
    created: number,
    expires: number,
    keyid: string,
    nonce: string | undefined,
  ): boolean => {
    if (expires - created > maxValidity) {
      rejection = `validity window of ${expires - created} seconds is longer than ${maxValidity}`;
      return false;
    }
    if (nonce !== undefined) {
      const key = `${operator?.slug ?? ""}\u0000${keyid}\u0000${nonce}`;
      if (nonces.has(key)) {
        rejection = "nonce already used (replay)";
        return false;
      }
      nonces.set(key, true);
    }
    return true;
  };

  try {
    if (hasAlg) {
      await library.verify(request, {
        label,
        algorithms: ALGORITHMS,
        maxAge: maxValidity,
        clockSkew,
        now: new Date(now * 1000),
        resolver: (candidate) => resolve(candidate.keyid, candidate.signatureAgent),
        validate: (signature) =>
          validate(
            Math.floor(signature.created.getTime() / 1000),
            Math.floor(signature.expires.getTime() / 1000),
            signature.keyid,
            signature.nonce,
          ),
      });
    } else {
      await library.verifySignature(request, {
        label,
        policy: {
          algorithms: ALGORITHMS,
          requiredComponents: [],
          requiredParameters: ["created", "expires", "keyid", "tag"],
          maxAge: maxValidity,
          clockSkew,
          now,
          validate: (signature) =>
            validate(
              signature.parameters.created as number,
              signature.parameters.expires as number,
              signature.parameters.keyid as string,
              signature.parameters.nonce,
            ),
        },
        resolveVerifier: (candidate) => {
          const profile = profileWithoutAlg(request, candidate);
          return resolve(profile.keyid, profile.agent);
        },
      });
    }
    return { kind: "verified", operator: operator ?? context.claimed, keyid: verifiedKeyid };
  } catch (thrown) {
    const error = unwrap(thrown);
    const subject = operator ?? context.claimed;
    if (error instanceof UnknownKeyError) return { kind: "unknown_key", operator: subject };
    if (error instanceof NoKeysError) return { kind: "no_keys", operator: subject };
    if (error instanceof ForeignAgentError) return { kind: "unsigned" };
    if (isSignatureError(error)) {
      if (
        error.code === SignatureErrorCode.UnsupportedFeature ||
        error.code === SignatureErrorCode.ResolverFailed
      ) {
        return { kind: "error", operator: subject, error: `signature library: ${error.message}` };
      }
      return { kind: "invalid", operator: subject, reason: rejection ?? error.message };
    }
    return {
      kind: "error",
      operator: subject,
      error: `signature library: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
