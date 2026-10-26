import { fieldValue, type NormalizedRequest } from "./request";

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
  const userAgent = fieldValue(request, "user-agent");
  if (!userAgent) return true;
  if (!/^Mozilla\/\d/.test(userAgent)) return true;
  if (AUTOMATION_WORDS.test(userAgent)) return true;
  if (!fieldValue(request, "accept") || !fieldValue(request, "accept-language")) return true;
  return false;
}
