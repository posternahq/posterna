import { fieldValue, type NormalizedRequest } from "./request";
import type { ReasonCode } from "./types";

const AUTOMATION_WORDS =
  /bot|crawl|spider|slurp|scrape|fetch|headless|python|curl|wget|httpclient|okhttp|go-http|java\/|axios|node-fetch|undici|libwww|scrapy|playwright|puppeteer|selenium/i;

/**
 * Labels a request that claims no known agent as automated or not, using only
 * signals already in the request: a User-Agent that no mainstream browser
 * sends, or a missing header that every mainstream browser sends.
 *
 * This is labeling, not scoring (docs/SPEC.md section 4.6). It must never grow
 * into fingerprinting: no timing, no ordering, no client hints, no history.
 */
export function looksAutomated(request: NormalizedRequest): boolean {
  return automationSignal(request) !== null;
}

/** Which of those signals fired, as a reason code, or null for a browser. */
export function automationSignal(request: NormalizedRequest): ReasonCode | null {
  const userAgent = fieldValue(request, "user-agent");
  if (!userAgent) return "no_user_agent";
  if (!/^Mozilla\/\d/.test(userAgent)) return "non_browser_user_agent";
  if (AUTOMATION_WORDS.test(userAgent)) return "automation_token";
  if (!fieldValue(request, "accept")) return "missing_accept";
  if (!fieldValue(request, "accept-language")) return "missing_accept_language";
  return null;
}
