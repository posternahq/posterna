import type { Purpose, RobotsPolicy } from "../../../core/src/directory/types";

/** One entry of ai.robots.txt's robots.json, keyed by agent name. */
export interface CommunityEntry {
  operator?: string;
  respect?: string;
  function?: string;
  frequency?: string;
  description?: string;
}

export type CommunityList = Record<string, CommunityEntry>;

export function parseCommunityList(body: string): CommunityList {
  const data: unknown = JSON.parse(body);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("robots.json is not an object keyed by agent name");
  }
  return data as CommunityList;
}

/**
 * Removes a trailing version from an agent name: `MistralAI-User/1.0`,
 * `iaskspider/2.0` and `Brightbot 1.0` become `MistralAI-User`, `iaskspider`
 * and `Brightbot`.
 */
export function baseAgentName(name: string): string {
  return name
    .trim()
    .replace(/(?:\/|\s+)v?\d+(?:\.\d+)*$/i, "")
    .trim();
}

/** The key used to decide whether two names are the same agent: no version, case folded. */
export function agentKey(name: string): string {
  return baseAgentName(name).toLowerCase();
}

export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

const UNKNOWN_OPERATOR = /^(unclear at this time\.?|unknown)$/i;

export interface CommunityOperatorName {
  /** Null when ai.robots.txt does not name the operator. */
  name: string | null;
  /** A link given in the field, if any. */
  url: string | null;
}

/**
 * Reads the free-text `operator` field: a Markdown link, a bare URL, or a
 * sentence that starts with the operator's name.
 */
export function parseOperatorField(
  field: string | undefined,
  overrides: ReadonlyMap<string, string> = new Map(),
): CommunityOperatorName {
  const raw = (field ?? "").trim();
  const override = overrides.get(raw);
  const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/.exec(raw);
  const url = link?.[2] ?? (/^https?:\/\/\S+$/.test(raw) ? raw : null);
  if (override) return { name: override, url };
  if (raw === "" || UNKNOWN_OPERATOR.test(raw)) return { name: null, url: null };
  if (link?.[1]) return { name: link[1].trim(), url };
  if (url) return { name: new URL(url).hostname.replace(/^www\./, ""), url };
  const name = raw
    .split(/,\s|\s+that\s|\s+to\s|\s+used\s|\s\(|\.\s/)[0]
    ?.replace(/\.$/, "")
    .trim();
  return { name: name || null, url: null };
}

const CATEGORY_PURPOSES: Record<string, Purpose> = {
  "ai search crawlers": "search",
  "ai assistants": "user_fetch",
  "ai agents": "agent",
  "undocumented ai agents": "agent",
  "ai coding agents": "agent",
  "ai data scrapers": "training",
  "ai data scraper": "training",
  "ai data providers": "other",
};

/**
 * Maps ai.robots.txt's free-text `function` field to a purpose. The original
 * text is kept in the record's note, so this mapping is a label, not a claim.
 */
export function communityPurpose(fn: string | undefined): Purpose {
  const text = (fn ?? "").trim().toLowerCase();
  const category = CATEGORY_PURPOSES[text.replace(/\.$/, "")];
  if (category) return category;
  if (/\btrain/.test(text)) return "training";
  if (/\bads?\b|advertis/.test(text)) return "ads";
  if (/search/.test(text)) return "search";
  if (/\bagents?\b|takes action/.test(text)) return "agent";
  if (/\buser|prompt|quer(y|ies)|assistant|answers?\b/.test(text)) return "user_fetch";
  if (/shar(e|ing)|preview/.test(text)) return "preview";
  return "other";
}

/** Maps the `respect` field ("Yes", "[No](...)", "Unclear at this time.") to a robots policy. */
export function communityRobotsPolicy(respect: string | undefined): RobotsPolicy {
  const text = (respect ?? "").trim();
  if (/^\[?yes\b/i.test(text)) return "honors";
  if (/^\[?no\b/i.test(text)) return "may_ignore";
  return "unstated";
}

/** Markdown links reduced to their text, for notes. */
export function plainText(value: string): string {
  return value.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").trim();
}
