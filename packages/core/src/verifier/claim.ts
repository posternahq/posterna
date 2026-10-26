import { parseSignatureAgentHeader } from "web-bot-auth";
import type { AgentRef, DirectoryIndex } from "../directory/index-builder";
import type { OperatorRecord } from "../directory/types";
import { fieldValue, type NormalizedRequest } from "./request";

/** Who the request says it is (docs/SPEC.md section 4.3). Nothing here is verified yet. */
export interface Claim {
  /** Operators named by a directory-type Signature-Agent member that the directory lists. */
  signatureOperators: OperatorRecord[];
  /** A Signature-Agent header was present. */
  signatureAgentPresent: boolean;
  /** Signature-Agent was unreadable, or named no operator the directory lists. Never fetched. */
  signatureAgentUnknown: boolean;
  /** Both Signature and Signature-Input are present. */
  signed: boolean;
  /** The agent the User-Agent names, if any. */
  userAgent: AgentRef | null;
}

/**
 * The origin a Signature-Agent member names, when it is a valid directory
 * member: an https origin with no path other than "/" (draft-ietf-webbotauth-
 * httpsig-protocol section 5.5). Anything else is ignored.
 */
export function signatureAgentOrigin(uri: string): string | null {
  try {
    const url = new URL(uri);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    if (url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The directory operators a Signature-Agent header names, in header order. */
export function signatureAgentOperators(
  header: string,
  index: DirectoryIndex,
): { operators: OperatorRecord[]; readable: boolean } {
  let parsed: ReturnType<typeof parseSignatureAgentHeader>;
  try {
    parsed = parseSignatureAgentHeader(header);
  } catch {
    return { operators: [], readable: false };
  }
  const operators: OperatorRecord[] = [];
  for (const entry of parsed.entries) {
    // Only the directory type is supported; other types are ignored, as the draft requires.
    if (entry.type !== "directory") continue;
    const origin = signatureAgentOrigin(entry.uri);
    const operator = origin ? index.signingOrigins.get(origin) : undefined;
    if (operator && !operators.includes(operator)) operators.push(operator);
  }
  return { operators, readable: true };
}

/** The agent a User-Agent names: exact tokens first, then phrases; researched agents first. */
export function matchUserAgent(
  userAgent: string | undefined,
  index: DirectoryIndex,
): AgentRef | null {
  if (!userAgent) return null;
  let community: AgentRef | null = null;
  let best: { ref: AgentRef; length: number } | null = null;
  for (const word of userAgent.match(/[A-Za-z0-9][A-Za-z0-9._-]*/g) ?? []) {
    const ref =
      index.tokens.get(word.toLowerCase()) ??
      index.tokens.get(word.toLowerCase().replace(/[._-]+$/, ""));
    if (!ref) continue;
    if (ref.agent.coverage === "researched") {
      if (!best || word.length > best.length) best = { ref, length: word.length };
    } else community ??= ref;
  }
  if (best) return best.ref;
  for (const phrase of index.phrases) {
    if (!phrase.pattern.test(userAgent)) continue;
    if (phrase.ref.agent.coverage === "researched") return phrase.ref;
    community ??= phrase.ref;
  }
  return community;
}

export function identifyClaim(request: NormalizedRequest, index: DirectoryIndex): Claim {
  const header = fieldValue(request, "signature-agent");
  let signatureOperators: OperatorRecord[] = [];
  let signatureAgentUnknown = false;
  if (header !== undefined) {
    const named = signatureAgentOperators(header, index);
    signatureOperators = named.operators;
    signatureAgentUnknown = !named.readable || named.operators.length === 0;
  }
  return {
    signatureOperators,
    signatureAgentPresent: header !== undefined,
    signatureAgentUnknown,
    signed:
      fieldValue(request, "signature") !== undefined &&
      fieldValue(request, "signature-input") !== undefined,
    userAgent: matchUserAgent(fieldValue(request, "user-agent"), index),
  };
}
