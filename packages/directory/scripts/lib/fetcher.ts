import { createHash } from "node:crypto";
import robotsParser from "robots-parser";
import {
  MAX_BODY_BYTES,
  MAX_CRAWL_DELAY_MS,
  MAX_REDIRECTS,
  MIN_HOST_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  ROBOTS_MAX_BYTES,
  ROBOTS_PRODUCT_TOKEN,
  USER_AGENT,
} from "./config";

export type FetchKind = "robots_json" | "ip_list" | "key_directory" | "doc";

/**
 * What happened to one request. Failures are recorded as they are; the
 * pipeline never retries around a robots.txt rule, an error or a timeout.
 */
export type FetchOutcome =
  | "ok"
  | "blocked_by_robots"
  | "robots_unreachable"
  | "http_error"
  | "timeout"
  | "network_error"
  | "too_large"
  | "invalid_url"
  | "too_many_redirects";

export interface FetchTarget {
  url: string;
  kind: FetchKind;
  operator: string | null;
  label: string;
}

export interface ManifestEntry extends FetchTarget {
  fetched_at: string;
  http_status: number | null;
  content_type: string | null;
  bytes: number | null;
  sha256: string | null;
  outcome: FetchOutcome;
  detail: string | null;
  final_url: string | null;
  /** Path of the saved body under raw/, when the fetch succeeded. */
  file: string | null;
}

/** How a host's robots.txt was obtained (RFC 9309 section 2.3.1). */
export interface RobotsRecord {
  origin: string;
  fetched_at: string;
  http_status: number | null;
  /** parsed: rules apply. unavailable (4xx): everything allowed. unreachable (5xx, network): everything disallowed. */
  outcome: "parsed" | "unavailable" | "unreachable";
  detail: string | null;
  sha256: string | null;
}

export interface FetchResult {
  entry: ManifestEntry;
  body: Uint8Array | null;
}

export class RequestError extends Error {
  constructor(
    readonly outcome: FetchOutcome,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

interface RawResponse {
  status: number;
  contentType: string | null;
  location: string | null;
  body: Uint8Array;
}

export type HttpGet = (url: string, accept: string, maxBytes: number) => Promise<RawResponse>;

/** One GET request: no redirects followed, a hard timeout and a size limit. */
export const httpGet: HttpGet = async (url, accept, maxBytes) => {
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "manual",
      // English, so quotes match the pages a person read (some sites pick a language by location).
      headers: { "user-agent": USER_AGENT, accept, "accept-language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw toRequestError(error);
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw new RequestError(
      "too_large",
      `content-length ${declared} exceeds ${maxBytes}`,
      response.status,
    );
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const reader = response.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RequestError("too_large", `body exceeds ${maxBytes} bytes`, response.status);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw toRequestError(error);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    location: response.headers.get("location"),
    body,
  };
};

function toRequestError(error: unknown): RequestError {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new RequestError("timeout", `no complete response within ${REQUEST_TIMEOUT_MS} ms`);
  }
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  const message = error instanceof Error ? error.message : String(error);
  return new RequestError("network_error", cause ? `${message}: ${cause}` : message);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const isRedirect = (status: number) => [301, 302, 303, 307, 308].includes(status);

interface RobotsRules {
  record: RobotsRecord;
  isAllowed(url: string): boolean;
  crawlDelayMs: number;
}

/**
 * Fetches URLs politely: identifies itself, honors robots.txt (RFC 9309) on
 * every host it touches including redirect targets, waits between requests
 * to the same host, and records every outcome.
 */
export class PoliteFetcher {
  private readonly robots = new Map<string, Promise<RobotsRules>>();
  private readonly lastRequest = new Map<string, number>();

  constructor(
    private readonly get: HttpGet = httpGet,
    private readonly now: () => Date = () => new Date(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /** Every robots.txt consulted so far. */
  async robotsRecords(): Promise<RobotsRecord[]> {
    const rules = await Promise.all(this.robots.values());
    return rules.map((rule) => rule.record).sort((a, b) => a.origin.localeCompare(b.origin));
  }

  async fetch(target: FetchTarget, accept: string): Promise<FetchResult> {
    const fetchedAt = this.now().toISOString();
    const result = (
      outcome: FetchOutcome,
      detail: string | null,
      extra: Partial<ManifestEntry> = {},
      body: Uint8Array | null = null,
    ): FetchResult => ({
      entry: {
        ...target,
        fetched_at: fetchedAt,
        http_status: null,
        content_type: null,
        bytes: body ? body.byteLength : null,
        sha256: body ? sha256Hex(body) : null,
        outcome,
        detail,
        final_url: null,
        file: null,
        ...extra,
      },
      body,
    });

    let current = target.url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let url: URL;
      try {
        url = new URL(current);
      } catch {
        return result("invalid_url", `not a valid URL: ${current}`);
      }
      if (url.protocol !== "https:") {
        return result("invalid_url", `only https URLs are fetched: ${current}`);
      }
      const rules = await this.rulesFor(url.origin);
      if (rules.record.outcome === "unreachable") {
        return result(
          "robots_unreachable",
          `robots.txt for ${url.origin} unreachable (${rules.record.detail}); treated as disallow all per RFC 9309`,
          { final_url: current },
        );
      }
      if (!rules.isAllowed(url.href)) {
        return result(
          "blocked_by_robots",
          `robots.txt for ${url.origin} disallows ${url.pathname} for ${ROBOTS_PRODUCT_TOKEN}`,
          { final_url: current },
        );
      }
      await this.waitForHost(url.host, rules.crawlDelayMs);

      let response: RawResponse;
      try {
        response = await this.get(url.href, accept, MAX_BODY_BYTES);
      } catch (error) {
        const failure =
          error instanceof RequestError ? error : new RequestError("network_error", String(error));
        return result(failure.outcome, failure.message, {
          http_status: failure.status,
          final_url: current,
        });
      }
      if (isRedirect(response.status) && response.location) {
        current = new URL(response.location, url).href;
        continue;
      }
      const extra = {
        http_status: response.status,
        content_type: response.contentType,
        final_url: current,
      };
      if (response.status < 200 || response.status > 299) {
        return result("http_error", `HTTP ${response.status}`, extra);
      }
      return result("ok", null, extra, response.body);
    }
    return result("too_many_redirects", `more than ${MAX_REDIRECTS} redirects`, {
      final_url: current,
    });
  }

  private rulesFor(origin: string): Promise<RobotsRules> {
    let rules = this.robots.get(origin);
    if (!rules) {
      rules = this.loadRobots(origin);
      this.robots.set(origin, rules);
    }
    return rules;
  }

  private async loadRobots(origin: string): Promise<RobotsRules> {
    const fetchedAt = this.now().toISOString();
    const robotsUrl = `${origin}/robots.txt`;
    const record = (
      outcome: RobotsRecord["outcome"],
      status: number | null,
      detail: string | null,
      body: Uint8Array | null = null,
    ): RobotsRecord => ({
      origin,
      fetched_at: fetchedAt,
      http_status: status,
      outcome,
      detail,
      sha256: body ? sha256Hex(body) : null,
    });
    const allowAll = (r: RobotsRecord): RobotsRules => ({
      record: r,
      isAllowed: () => true,
      crawlDelayMs: 0,
    });
    const denyAll = (r: RobotsRecord): RobotsRules => ({
      record: r,
      isAllowed: () => false,
      crawlDelayMs: 0,
    });

    // RFC 9309 section 2.3.1.2: follow at least five redirects for robots.txt.
    let current = robotsUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await this.waitForHost(new URL(current).host, 0);
      let response: RawResponse;
      try {
        response = await this.get(current, "text/plain", ROBOTS_MAX_BYTES);
      } catch (error) {
        const failure =
          error instanceof RequestError ? error : new RequestError("network_error", String(error));
        if (failure.outcome === "too_large") {
          return denyAll(
            record(
              "unreachable",
              failure.status,
              `robots.txt larger than ${ROBOTS_MAX_BYTES} bytes`,
            ),
          );
        }
        return denyAll(record("unreachable", failure.status, failure.message));
      }
      if (isRedirect(response.status) && response.location) {
        current = new URL(response.location, current).href;
        continue;
      }
      if (response.status >= 200 && response.status <= 299) {
        const text = new TextDecoder().decode(response.body);
        const parsed = robotsParser(current, text);
        const delay = parsed.getCrawlDelay(ROBOTS_PRODUCT_TOKEN);
        return {
          record: record("parsed", response.status, null, response.body),
          // robots-parser checks the URL's origin against the robots.txt URL;
          // after a robots.txt redirect, evaluate paths against the final URL.
          isAllowed: (href) => {
            const path = new URL(href);
            const checked = new URL(path.pathname + path.search, current).href;
            return parsed.isAllowed(checked, ROBOTS_PRODUCT_TOKEN) !== false;
          },
          crawlDelayMs: Math.min((delay ?? 0) * 1000, MAX_CRAWL_DELAY_MS),
        };
      }
      if (response.status >= 400 && response.status <= 499) {
        return allowAll(
          record("unavailable", response.status, `HTTP ${response.status}: no rules, all allowed`),
        );
      }
      return denyAll(record("unreachable", response.status, `HTTP ${response.status}`));
    }
    return denyAll(record("unreachable", null, `more than ${MAX_REDIRECTS} redirects`));
  }

  private async waitForHost(host: string, crawlDelayMs: number): Promise<void> {
    const gap = Math.max(MIN_HOST_INTERVAL_MS, crawlDelayMs);
    const last = this.lastRequest.get(host);
    const now = this.now().getTime();
    if (last !== undefined && now - last < gap) await this.sleep(gap - (now - last));
    this.lastRequest.set(host, this.now().getTime());
  }
}
