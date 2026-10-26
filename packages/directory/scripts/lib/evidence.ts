import type { FetchedFile } from "./merge";
import type { OperatorSource } from "./sources";
import { findText, htmlToText, type MatchResult } from "./text";

export type EvidenceResult = MatchResult | "page_unavailable";

export interface EvidenceCheck {
  operator: string;
  /** What is being checked, for example `GPTBot purpose_quote`. */
  fact: string;
  value: string;
  sourceUrl: string;
  result: EvidenceResult;
  /** Why the page was unavailable, when it was. */
  detail: string | null;
}

interface Page {
  html: string;
  text: string;
}

/** Every string in a JSON document, for help centers that serve article HTML inside JSON. */
function jsonStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(jsonStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(jsonStrings);
  return [];
}

export function pageFromBody(body: string): Page {
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const html = jsonStrings(JSON.parse(trimmed)).join("\n");
      return { html: `${body}\n${html}`, text: htmlToText(html) };
    } catch {
      // Not JSON after all; read it as HTML.
    }
  }
  return { html: body, text: htmlToText(body) };
}

/**
 * Checks each researched fact against the fetched text of the page it cites:
 * quotes and reverse DNS suffixes in the page text, user-agent tokens in any of
 * the operator's pages, and documented URLs in the page source.
 */
export function checkEvidence(
  researched: readonly OperatorSource[],
  fetched: ReadonlyMap<string, FetchedFile>,
): EvidenceCheck[] {
  const decoder = new TextDecoder();
  const pages = new Map<string, Page | null>();
  const page = (url: string): Page | null => {
    if (!pages.has(url)) {
      const file = fetched.get(url);
      if (file?.entry.outcome === "ok" && file.body) {
        pages.set(url, pageFromBody(decoder.decode(file.body)));
      } else pages.set(url, null);
    }
    return pages.get(url) ?? null;
  };
  const unavailable = (url: string) => {
    const entry = fetched.get(url)?.entry;
    if (!entry) return "not fetched";
    return entry.detail ? `${entry.outcome}: ${entry.detail}` : entry.outcome;
  };

  const checks: EvidenceCheck[] = [];
  for (const op of researched) {
    const urlOf = (id: string) => op.sources.find((ref) => ref.id === id)?.url ?? "";
    const inText = (fact: string, value: string, id: string) => {
      const url = urlOf(id);
      const found = page(url);
      checks.push({
        operator: op.slug,
        fact,
        value,
        sourceUrl: url,
        result: found ? findText(value, found.text) : "page_unavailable",
        detail: found ? null : unavailable(url),
      });
    };
    const inSource = (fact: string, value: string, id: string) => {
      const url = urlOf(id);
      const found = page(url);
      const bare = value.replace(/^https:/, "");
      // A same-host link may be relative, so its path is evidence too.
      let path: string | null = null;
      try {
        const target = new URL(value);
        if (target.host === new URL(url).host) path = target.pathname + target.search;
      } catch {
        path = null;
      }
      const present =
        found &&
        (found.html.includes(value) ||
          found.html.includes(bare) ||
          (path !== null && path.length > 1 && found.html.includes(`"${path}"`)));
      checks.push({
        operator: op.slug,
        fact,
        value,
        sourceUrl: url,
        result: found ? (present ? "verbatim" : findText(value, found.text)) : "page_unavailable",
        detail: found ? null : unavailable(url),
      });
    };

    for (const agent of op.agents) {
      inText(`${agent.name} purpose_quote`, agent.purpose_quote, agent.purpose_source);
      if (agent.robots_quote && agent.robots_source) {
        inText(`${agent.name} robots_quote`, agent.robots_quote, agent.robots_source);
      }
      const tokens = [...agent.user_agent_tokens];
      if (agent.robots_token && !tokens.includes(agent.robots_token))
        tokens.push(agent.robots_token);
      for (const token of tokens) {
        const available = op.sources.map((ref) => ({ url: ref.url, found: page(ref.url) }));
        const hit = available.find((candidate) => candidate.found?.text.includes(token));
        const anyPage = available.some((candidate) => candidate.found);
        checks.push({
          operator: op.slug,
          fact: `${agent.name} token`,
          value: token,
          sourceUrl: hit?.url ?? op.sources[0]?.url ?? "",
          result: hit ? "verbatim" : anyPage ? "not_found" : "page_unavailable",
          detail: anyPage ? null : "none of the operator's pages could be fetched",
        });
      }
    }
    for (const list of op.ip_lists) inSource(`ip list ${list.id} URL`, list.url, list.source);
    if (op.reverse_dns) {
      for (const suffix of op.reverse_dns.suffixes) {
        inText("reverse DNS suffix", suffix, op.reverse_dns.source);
      }
      if (op.reverse_dns.quote)
        inText("reverse DNS quote", op.reverse_dns.quote, op.reverse_dns.source);
    }
    if (op.signing.directory_url && op.signing.basis === "documented") {
      const origin = new URL(op.signing.directory_url).host;
      for (const id of op.signing.sources) inSource("key directory host", origin, id);
    }
  }
  return checks;
}
