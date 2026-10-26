import type { VerdictResult } from "../verifier/types";
import type { Decision } from "./types";

/** An HTTP response for an enforced block or throttle. Adapters send it as is. */
export interface EnforcementResponse {
  status: 403 | 429;
  headers: Record<string, string>;
  body: string;
}

export const OPERATORS_URL = "https://posterna.com/operators";

/**
 * The response for an enforced decision (docs/SPEC.md section 5.2), or null
 * when the request should proceed: anything not enforced, and sign-up
 * recommendations, which the application handles. The body names only the
 * directory slug and purpose, never anything taken from the request.
 */
export function enforcementResponse(
  decision: Decision,
  result: VerdictResult,
): EnforcementResponse | null {
  if (!decision.enforced) return null;
  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
    // Never let a shared cache serve an agent's refusal to someone else.
    "Cache-Control": "no-store",
    "X-Posterna-Action": decision.action,
  };
  if (decision.action === "block") {
    return {
      status: 403,
      headers,
      body: `This site's policy does not allow this agent (${result.operator ?? "unknown"}, ${result.purpose ?? "unknown"}). Operators can get verified at ${OPERATORS_URL}`,
    };
  }
  if (decision.action === "throttle") {
    const seconds = Math.max(1, Math.ceil(decision.retryAfter ?? 1));
    return {
      status: 429,
      headers: { ...headers, "Retry-After": String(seconds) },
      body: `Rate limited by this site's agent policy. Retry after ${seconds} seconds.`,
    };
  }
  return null;
}
