/**
 * Things on an operator's own pages that the directory does not know yet: IP
 * list links, key directory links and user-agent tokens. The build reports
 * them for a person to review; it never adds them to the data by itself.
 */

import type { DirectoryFile } from "../../../core/src/directory/types";
import { agentKey } from "./community";
import { type EvidenceCheck, pageFromBody } from "./evidence";
import type { FetchedFile } from "./merge";
import type { OperatorSource } from "./sources";

export type FindingKind = "ip_list_link" | "key_directory_link" | "user_agent_token" | "evidence";

export interface Finding {
  operator: string;
  kind: FindingKind;
  /** The link, token, or failing fact. Matched exactly by `ignore_findings`. */
  value: string;
  /** The page it was found on, or the page a failing fact cites. */
  source: string;
  detail: string | null;
}

/** Tokens that appear in ordinary browser User-Agent strings and protocol names. */
const COMMON_TOKENS = new Set(
  [
    "Mozilla",
    "AppleWebKit",
    "Chrome",
    "Chromium",
    "Safari",
    "Version",
    "Gecko",
    "Firefox",
    "Edge",
    "Edg",
    "Mobile",
    "CriOS",
    "OPR",
    "Trident",
    "MSIE",
    "HTTP",
    "HTTPS",
    "TLS",
    "OAuth",
    "HeadlessChrome",
    "IEMobile",
  ].map((token) => token.toLowerCase()),
);

/** Ordinary words that follow "User-agent:" in prose ("the User-agent: line"). */
const PROSE_WORDS = new Set([
  "line",
  "lines",
  "token",
  "tokens",
  "name",
  "names",
  "value",
  "values",
  "string",
  "strings",
  "header",
  "field",
  "rule",
  "rules",
  "group",
  "groups",
  "directive",
  "directives",
  "the",
  "and",
  "or",
]);

/** Absolute https URLs linked or written on a page. */
export function extractLinks(html: string, base: string): string[] {
  const found = new Set<string>();
  const add = (raw: string) => {
    try {
      const url = new URL(raw.replace(/&amp;/g, "&"), base);
      if (url.protocol === "https:") {
        url.hash = "";
        found.add(url.href);
      }
    } catch {
      // Not a URL.
    }
  };
  for (const match of html.matchAll(/\bhref\s*=\s*["']([^"'#][^"']*)["']/gi)) add(match[1] ?? "");
  // A backtick cannot appear in a URL; in Markdown it closes inline code.
  for (const match of html.matchAll(/https:\/\/[^\s"'<>()\\`]+/g)) {
    add((match[0] ?? "").replace(/[.,;:]+$/, ""));
  }
  return [...found].sort();
}

/** Does this URL look like a published list of IP prefixes? */
export function looksLikeIpList(url: string): boolean {
  const path = new URL(url).pathname.toLowerCase();
  // Images, styles, scripts and fonts are never lists, whatever their path says.
  if (/\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|woff2?|ttf|pdf|mp4)$/.test(path)) return false;
  if (/ip-?addresses|ip-?ranges|ipranges|ip-?prefixes/.test(path)) return true;
  const file = path.split("/").pop() ?? "";
  if (file === "robots.txt") return false;
  return (
    /\.(json|txt)$/.test(file) && /(ips?|ranges?|prefix|bot|crawl|fetch|agent|user)/.test(file)
  );
}

/**
 * Candidate user-agent tokens in page text: product tokens with a version
 * ("ExampleBot/1.2") and names in robots.txt examples ("User-agent: ExampleBot").
 */
export function extractTokens(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(
    /(?<![\w./-])([A-Za-z][A-Za-z0-9_-]{2,40})\/(?:\d+(?:\.\d+)*|[A-Z](?:\.[A-Z])+)\b/g,
  )) {
    const token = match[1] ?? "";
    if (!COMMON_TOKENS.has(token.toLowerCase())) found.add(token);
  }
  for (const match of text.matchAll(/User-agent:\s*([A-Za-z][A-Za-z0-9_.-]{1,40})/gi)) {
    const token = (match[1] ?? "").replace(/\.$/, "");
    const lower = token.toLowerCase();
    if (!COMMON_TOKENS.has(lower) && !PROSE_WORDS.has(lower)) found.add(token);
  }
  return [...found].sort();
}

/** host label without www and top-level domain, plus path: "perplexity/perplexitybot.json". */
function listIdentity(url: string): string {
  const parsed = new URL(url);
  const labels = parsed.hostname.replace(/^www\./, "").split(".");
  const name = labels.length > 1 ? labels.slice(0, -1).join(".") : labels[0];
  return `${name}${parsed.pathname.replace(/\/+$/, "").toLowerCase()}`;
}

/**
 * The source ids that are the operator's own pages: everything except pages
 * cited only as a third-party report of a key directory.
 */
export function ownSourceIds(op: OperatorSource): Set<string> {
  const thirdParty = new Set(op.signing.basis === "reported" ? op.signing.sources : []);
  for (const agent of op.agents) {
    for (const id of [agent.purpose_source, agent.robots_source, agent.aliases_source]) {
      if (id) thirdParty.delete(id);
    }
  }
  for (const list of op.ip_lists) thirdParty.delete(list.source);
  if (op.reverse_dns) thirdParty.delete(op.reverse_dns.source);
  for (const entry of op.asn) thirdParty.delete(entry.source);
  return new Set(op.sources.map((ref) => ref.id).filter((id) => !thirdParty.has(id)));
}

export interface FindingsResult {
  findings: Finding[];
  /** Findings dropped because an operator file lists them under ignore_findings. */
  ignored: number;
}

/**
 * Compares each researched operator's fetched pages with what the directory
 * already holds, and turns evidence checks that did not match into findings.
 */
export function findNewThings(
  researched: readonly OperatorSource[],
  fetched: ReadonlyMap<string, FetchedFile>,
  directory: DirectoryFile,
  evidence: readonly EvidenceCheck[],
): FindingsResult {
  const knownTokens = new Set<string>();
  const knownLists = new Set<string>();
  const knownDirectories = new Set<string>();
  for (const op of directory.operators) {
    for (const agent of op.agents) {
      for (const name of [agent.name, ...agent.user_agent_tokens, ...agent.aliases]) {
        knownTokens.add(agentKey(name));
      }
      if (agent.robots_token) knownTokens.add(agentKey(agent.robots_token));
    }
    for (const list of op.verification.ip_lists) knownLists.add(listIdentity(list.url));
    if (op.verification.signing.directory_url) {
      knownDirectories.add(op.verification.signing.directory_url);
    }
  }
  for (const file of fetched.values()) {
    if (file.entry.kind === "ip_list" && file.entry.final_url) {
      knownLists.add(listIdentity(file.entry.final_url));
    }
  }

  const findings: Finding[] = [];
  const decoder = new TextDecoder();
  for (const op of researched) {
    const seen = new Set<string>();
    const add = (finding: Finding) => {
      const key = `${finding.kind}\u0000${finding.value}`;
      if (!seen.has(key)) {
        seen.add(key);
        findings.push(finding);
      }
    };
    const own = ownSourceIds(op);
    // Pages the operator file already cites are known, even if their URL looks like a list.
    const cited = new Set(op.sources.map((ref) => listIdentity(ref.url)));
    for (const ref of op.sources.filter((candidate) => own.has(candidate.id))) {
      const file = fetched.get(ref.url);
      if (!file?.body || file.entry.outcome !== "ok") continue;
      const page = pageFromBody(decoder.decode(file.body));
      for (const link of extractLinks(page.html, file.entry.final_url ?? ref.url)) {
        if (link.includes("http-message-signatures-directory")) {
          if (!knownDirectories.has(link)) {
            add({
              operator: op.slug,
              kind: "key_directory_link",
              value: link,
              source: ref.url,
              detail: null,
            });
          }
        } else if (
          looksLikeIpList(link) &&
          !knownLists.has(listIdentity(link)) &&
          !cited.has(listIdentity(link))
        ) {
          add({
            operator: op.slug,
            kind: "ip_list_link",
            value: link,
            source: ref.url,
            detail: null,
          });
        }
      }
      for (const token of extractTokens(page.text)) {
        if (!knownTokens.has(agentKey(token))) {
          add({
            operator: op.slug,
            kind: "user_agent_token",
            value: token,
            source: ref.url,
            detail: null,
          });
        }
      }
    }
  }
  for (const check of evidence) {
    if (check.result === "verbatim") continue;
    findings.push({
      operator: check.operator,
      kind: "evidence",
      value: `${check.fact}: ${check.value}`,
      source: check.sourceUrl,
      detail: check.detail ? `${check.result} (${check.detail})` : check.result,
    });
  }

  const ignore = new Map(
    researched.map((op) => [op.slug, new Set(op.ignore_findings.map((entry) => entry.value))]),
  );
  const kept = findings.filter((finding) => !ignore.get(finding.operator)?.has(finding.value));
  kept.sort(
    (a, b) =>
      a.operator.localeCompare(b.operator) ||
      a.kind.localeCompare(b.kind) ||
      a.value.localeCompare(b.value),
  );
  return { findings: kept, ignored: findings.length - kept.length };
}
