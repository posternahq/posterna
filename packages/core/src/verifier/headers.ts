import type { IncomingHttpHeaders } from "node:http";
import { isInboundVerdictHeader } from "./request";
import type { VerdictResult } from "./types";

/** Request header names the verdict is passed to the application under. */
export interface VerdictHeaderNames {
  verdict: string;
  operator: string;
  purpose: string;
  method: string;
}

export const DEFAULT_VERDICT_HEADERS: Readonly<VerdictHeaderNames> = Object.freeze({
  verdict: "X-Agent-Verdict",
  operator: "X-Agent-Operator",
  purpose: "X-Agent-Purpose",
  method: "X-Agent-Method",
});

/**
 * Removes every inbound X-Agent-* and X-Posterna-* header in place, so no
 * client can forge a verdict for the application or services behind it
 * (docs/SPEC.md section 4.7). Adapters call this before anything else.
 *
 * @returns The lowercase names that were removed.
 */
export function stripInboundHeaders(headers: Headers | IncomingHttpHeaders): string[] {
  const removed: string[] = [];
  if (
    typeof (headers as Headers).forEach === "function" &&
    typeof (headers as Headers).delete === "function"
  ) {
    const target = headers as Headers;
    const names: string[] = [];
    target.forEach((_value, name) => {
      names.push(name);
    });
    for (const name of names) {
      if (isInboundVerdictHeader(name)) {
        target.delete(name);
        removed.push(name.toLowerCase());
      }
    }
  } else {
    const target = headers as IncomingHttpHeaders;
    for (const name of Object.keys(target)) {
      if (isInboundVerdictHeader(name)) {
        delete target[name];
        removed.push(name.toLowerCase());
      }
    }
  }
  return [...new Set(removed)].sort();
}

/**
 * The headers that carry a verdict to the application. Fields without a value
 * are left out rather than sent empty.
 */
export function verdictHeaders(
  result: VerdictResult,
  names: Partial<VerdictHeaderNames> = {},
): Record<string, string> {
  const resolved = { ...DEFAULT_VERDICT_HEADERS, ...names };
  const headers: Record<string, string> = { [resolved.verdict]: result.verdict };
  if (result.operator) headers[resolved.operator] = result.operator;
  if (result.purpose) headers[resolved.purpose] = result.purpose;
  headers[resolved.method] = result.method ?? "none";
  return headers;
}
