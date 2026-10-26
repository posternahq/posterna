import type {
  AgentRecord,
  DirectoryFile,
  DirectorySource,
  IpList,
  KeyEntry,
  KeysFile,
  KeysOperator,
  OperatorRecord,
  SigningInfo,
  SigningStatus,
} from "../../../core/src/directory/types";
import {
  agentKey,
  baseAgentName,
  type CommunityEntry,
  type CommunityList,
  communityPurpose,
  communityRobotsPolicy,
  parseOperatorField,
  plainText,
  slugify,
} from "./community";
import { ATTRIBUTION, DATA_LICENSE } from "./config";
import type { ManifestEntry } from "./fetcher";
import { kidConvention, type ParsedKey, parseKeyDirectory } from "./keys";
import { normalizePrefixes, parseIpList } from "./prefixes";
import type { OperatorSource, SourceAgent } from "./sources";

export interface FetchedFile {
  entry: ManifestEntry;
  body: Uint8Array | null;
}

export interface BuildInput {
  generatedAt: Date;
  researched: OperatorSource[];
  communityOperatorNames: ReadonlyMap<string, string>;
  /** Null when robots.json could not be fetched. */
  community: { list: CommunityList; source: DirectorySource } | null;
  /** Fetch results by requested URL. */
  fetched: ReadonlyMap<string, FetchedFile>;
  previousKeys: KeysFile | null;
  /** The last published directory, used to keep an IP list when this build cannot fetch it. */
  previousDirectory: DirectoryFile | null;
}

export interface IpListLog {
  operator: string;
  id: string;
  url: string;
  outcome: string;
  detail: string | null;
  format: string | null;
  count: number | null;
  invalid: string[];
  rewritten: number;
  duplicates: number;
}

export interface SigningLog {
  operator: string;
  status: SigningStatus;
  basis: string;
  directory_url: string | null;
  keys: number;
  rejected: string[];
  detail: string | null;
}

export interface BuildLog {
  /** Community entries folded into a researched agent. */
  merged: { community: string; operator: string; agent: string }[];
  /** Community entries kept as community agents of a researched operator. */
  claimed: { community: string; operator: string; how: "listed" | "operator name" }[];
  /** Spellings of one community agent collapsed into one record (case or version differences). */
  collapsed: { kept: string; dropped: string }[];
  /** Names listed in community_agents that robots.json no longer has. */
  missingClaims: { operator: string; community: string }[];
  ipLists: IpListLog[];
  signing: SigningLog[];
  /** Problems that make the data invalid. The build fails when this is not empty. */
  problems: string[];
}

export interface BuildOutput {
  directory: DirectoryFile;
  keys: KeysFile;
  log: BuildLog;
}

const decoder = new TextDecoder();
const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.name.localeCompare(b.name);

function emptySigning(status: SigningStatus, note: string | null): SigningInfo {
  return {
    status,
    directory_url: null,
    kid_convention: null,
    purpose_field: null,
    covers: [],
    note,
    sources: [],
  };
}

function okFile(input: BuildInput, url: string): FetchedFile | null {
  const file = input.fetched.get(url);
  return file && file.entry.outcome === "ok" && file.body ? file : null;
}

function describeFailure(file: FetchedFile | undefined): string {
  if (!file) return "not fetched";
  const { outcome, detail } = file.entry;
  return detail ? `${outcome}: ${detail}` : outcome;
}

function joinNotes(...notes: (string | null | undefined)[]): string | null {
  const parts = notes.filter((note): note is string => Boolean(note?.trim()));
  return parts.length > 0 ? parts.join(" ") : null;
}

function uniqueSources(sources: DirectorySource[]): DirectorySource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    if (seen.has(source.url)) return false;
    seen.add(source.url);
    return true;
  });
}

interface ResearchedResult {
  record: OperatorRecord;
  keys: KeysOperator | null;
}

async function buildResearched(
  input: BuildInput,
  op: OperatorSource,
  log: BuildLog,
): Promise<ResearchedResult> {
  const source = (id: string): DirectorySource => {
    const ref = op.sources.find((candidate) => candidate.id === id);
    if (!ref) throw new Error(`${op.slug}: unknown source ${id}`);
    const fetched = okFile(input, ref.url);
    return {
      url: ref.url,
      title: ref.title,
      fetched_at: fetched?.entry.fetched_at ?? op.checked_on,
    };
  };

  // IP lists: prefixes come only from the fetched files.
  const ipLists: IpList[] = [];
  for (const list of op.ip_lists) {
    const file = okFile(input, list.url);
    const entry: IpList = {
      agent: list.id,
      url: list.url,
      format: null,
      prefix_count: null,
      fetched_at: null,
      sha256: null,
      prefixes: [],
      note: list.note,
      sources: [source(list.source)],
    };
    const logEntry: IpListLog = {
      operator: op.slug,
      id: list.id,
      url: list.url,
      outcome: input.fetched.get(list.url)?.entry.outcome ?? "not_fetched",
      detail: null,
      format: null,
      count: null,
      invalid: [],
      rewritten: 0,
      duplicates: 0,
    };
    if (file?.body) {
      entry.fetched_at = file.entry.fetched_at;
      entry.sha256 = file.entry.sha256;
      const parsed = parseIpList(decoder.decode(file.body));
      if (parsed.ok) {
        const normalized = normalizePrefixes(parsed.entries);
        entry.format = parsed.format;
        entry.prefixes = normalized.prefixes;
        entry.prefix_count = normalized.prefixes.length;
        Object.assign(logEntry, {
          format: parsed.format,
          count: normalized.prefixes.length,
          invalid: normalized.invalid,
          rewritten: normalized.rewritten,
          duplicates: normalized.duplicates,
        });
        if (normalized.invalid.length > 0) {
          entry.note = joinNotes(
            entry.note,
            `${normalized.invalid.length} entries were not valid prefixes and were left out.`,
          );
        }
      } else {
        entry.note = joinNotes(entry.note, `Fetched but could not be parsed: ${parsed.error}.`);
        logEntry.outcome = "unparsed";
        logEntry.detail = parsed.error;
      }
    } else {
      const failure = describeFailure(input.fetched.get(list.url));
      logEntry.detail = failure;
      const previous = input.previousDirectory?.operators
        .find((candidate) => candidate.slug === op.slug)
        ?.verification.ip_lists.find((candidate) => candidate.url === list.url);
      if (previous?.fetched_at && previous.prefix_count !== null) {
        // Keep the last good copy, with its own fetch date, rather than dropping the prefixes.
        Object.assign(entry, {
          format: previous.format,
          prefix_count: previous.prefix_count,
          fetched_at: previous.fetched_at,
          sha256: previous.sha256,
          prefixes: previous.prefixes,
        });
        entry.note = joinNotes(
          entry.note,
          `This build could not fetch the list (${failure}); prefixes are from the fetch at ${previous.fetched_at}.`,
        );
        logEntry.format = previous.format;
        logEntry.count = previous.prefix_count;
        logEntry.outcome = `${logEntry.outcome}, kept previous`;
      } else {
        entry.note = joinNotes(entry.note, `Not fetched in this build (${failure}).`);
      }
    }
    ipLists.push(entry);
    log.ipLists.push(logEntry);
  }

  // Signing: live only when the key directory was fetched and parsed.
  const plan = op.signing;
  const signing: SigningInfo = {
    ...emptySigning("none_found", plan.note),
    directory_url: plan.directory_url,
    covers: [...plan.covers].sort(),
    sources: plan.sources.map(source),
  };
  const signingLog: SigningLog = {
    operator: op.slug,
    status: "none_found",
    basis: plan.basis,
    directory_url: plan.directory_url,
    keys: 0,
    rejected: [],
    detail: null,
  };
  let parsedKeys: ParsedKey[] = [];
  let directoryFetchedAt: string | null = null;
  if (plan.status === "pending") {
    signing.status = "pending";
  } else if (!plan.directory_url) {
    signing.status = plan.basis === "none" ? "none_found" : "reported";
    if (plan.basis === "none") {
      signing.note = joinNotes(
        signing.note,
        "No key directory found in the operator's documentation.",
      );
    }
  } else {
    const fetched = input.fetched.get(plan.directory_url);
    const file = okFile(input, plan.directory_url);
    if (file?.body) {
      directoryFetchedAt = file.entry.fetched_at;
      const parsed = await parseKeyDirectory(decoder.decode(file.body));
      parsedKeys = parsed.keys;
      signingLog.rejected = parsed.rejected;
      signing.purpose_field = parsed.purposeField;
      if (parsed.keys.length > 0) {
        signing.status = "live";
        signing.kid_convention = kidConvention(parsed.keys);
        signing.sources.push({
          url: plan.directory_url,
          title: "Key directory",
          fetched_at: file.entry.fetched_at,
        });
      } else {
        signing.status = "none_found";
        const why =
          parsed.error ?? `no usable public keys (${parsed.rejected.join("; ") || "empty"})`;
        signing.note = joinNotes(signing.note, `The key directory was fetched but ${why}.`);
        signingLog.detail = why;
      }
    } else if (
      fetched?.entry.outcome === "http_error" &&
      [404, 410].includes(fetched.entry.http_status ?? 0)
    ) {
      signing.status = "none_found";
      signing.note = joinNotes(
        signing.note,
        `The key directory URL returned HTTP ${fetched.entry.http_status}.`,
      );
      signingLog.detail = describeFailure(fetched);
    } else {
      signing.status = "reported";
      signing.note = joinNotes(
        signing.note,
        `Could not confirm in this build (${describeFailure(fetched)}).`,
      );
      signingLog.detail = describeFailure(fetched);
    }
  }
  signingLog.status = signing.status;
  signingLog.keys = parsedKeys.length;
  log.signing.push(signingLog);
  const live = signing.status === "live";

  const agents: AgentRecord[] = op.agents.map((agent: SourceAgent) => ({
    name: agent.name,
    coverage: "researched",
    user_agent_tokens: agent.user_agent_tokens,
    aliases: [...agent.aliases].sort(),
    purpose: agent.purpose,
    purpose_quote: agent.purpose_quote,
    search_engine: agent.search_engine,
    robots_token: agent.robots_token,
    robots_policy: agent.robots_policy,
    robots_quote: agent.robots_quote,
    ip_list_agent: agent.ip_list,
    signs: live && plan.covers.includes(agent.name),
    note: agent.note,
    sources: uniqueSources(
      [agent.purpose_source, agent.robots_source, agent.aliases_source]
        .filter((id): id is string => Boolean(id))
        .map(source),
    ),
  }));

  const record: OperatorRecord = {
    slug: op.slug,
    name: op.name,
    website: op.website,
    docs_url: op.docs_url,
    coverage: "researched",
    note: op.note,
    verification: {
      signing,
      ip_lists: ipLists,
      reverse_dns: op.reverse_dns
        ? {
            suffixes: op.reverse_dns.suffixes,
            forward_confirm: op.reverse_dns.forward_confirm,
            note: op.reverse_dns.note,
            sources: [source(op.reverse_dns.source)],
          }
        : null,
      asn: op.asn.map((entry) => ({
        asn: entry.asn,
        note: entry.note,
        sources: [source(entry.source)],
      })),
    },
    agents,
    observed: {},
    enrollment: { status: "none" },
    identity_anchors: [],
    sources: op.sources.map((ref) => source(ref.id)),
  };

  let keys: KeysOperator | null = null;
  if (plan.directory_url) {
    const now = input.generatedAt.toISOString();
    const previous = input.previousKeys?.operators[op.slug]?.keys ?? [];
    keys = {
      directory_url: plan.directory_url,
      fetched_at: directoryFetchedAt,
      status: signing.status,
      keys: parsedKeys.map(
        (key): KeyEntry => ({
          jwk: key.jwk,
          thumbprint: key.thumbprint,
          kid: key.kid,
          first_seen:
            previous.find((old) => old.thumbprint === key.thumbprint)?.first_seen ??
            directoryFetchedAt ??
            now,
          last_seen: directoryFetchedAt ?? now,
        }),
      ),
    };
  }
  return { record, keys };
}

interface CommunityAgentDraft {
  name: string;
  spellings: string[];
  entry: CommunityEntry;
}

function communityAgent(draft: CommunityAgentDraft, source: DirectorySource): AgentRecord {
  const { entry } = draft;
  const fn = plainText(entry.function ?? "");
  const respect = plainText(entry.respect ?? "");
  return {
    name: draft.name,
    coverage: "community",
    user_agent_tokens: [draft.name],
    aliases: draft.spellings.filter((spelling) => spelling !== draft.name).sort(),
    purpose: communityPurpose(entry.function),
    purpose_quote: null,
    search_engine: false,
    robots_token: draft.name,
    robots_policy: communityRobotsPolicy(entry.respect),
    robots_quote: null,
    ip_list_agent: null,
    signs: false,
    note: joinNotes(
      "Community record from ai.robots.txt.",
      fn ? `Function: "${fn}".` : null,
      respect ? `Respects robots.txt: "${respect}".` : null,
    ),
    sources: [source],
  };
}

function httpsOrNull(url: string | null): string | null {
  return url?.startsWith("https://") ? url : null;
}

/**
 * Merges researched operator files, fetched files and the community list into
 * directory.json and keys.json. Researched facts always win over community ones.
 */
export async function buildDirectory(input: BuildInput): Promise<BuildOutput> {
  const log: BuildLog = {
    merged: [],
    claimed: [],
    collapsed: [],
    missingClaims: [],
    ipLists: [],
    signing: [],
    problems: [],
  };
  const operators = new Map<string, OperatorRecord>();
  const keyOperators: Record<string, KeysOperator> = {};

  for (const op of input.researched) {
    const { record, keys } = await buildResearched(input, op, log);
    operators.set(op.slug, record);
    if (keys) keyOperators[op.slug] = keys;
  }

  // Index researched agents by every name they go by.
  const researchedByKey = new Map<string, { operator: string; agent: string }>();
  for (const op of input.researched) {
    for (const agent of op.agents) {
      const names = [agent.name, ...agent.aliases, ...agent.user_agent_tokens];
      if (agent.robots_token) names.push(agent.robots_token);
      for (const name of names) {
        const key = agentKey(name);
        const existing = researchedByKey.get(key);
        if (existing && existing.operator !== op.slug) {
          log.problems.push(
            `"${name}" is claimed by researched agents of both ${existing.operator} and ${op.slug}`,
          );
        }
        if (!existing) researchedByKey.set(key, { operator: op.slug, agent: agent.name });
      }
    }
  }

  const claimedBy = new Map<string, string>();
  for (const op of input.researched) {
    for (const name of op.community_agents) {
      const other = claimedBy.get(name);
      if (other && other !== op.slug) {
        log.problems.push(`community agent "${name}" is listed by both ${other} and ${op.slug}`);
      }
      claimedBy.set(name, op.slug);
    }
  }

  if (input.community) {
    const { list, source } = input.community;
    for (const [name, operator] of claimedBy) {
      if (!(name in list)) log.missingClaims.push({ operator, community: name });
    }

    // Group spellings of the same agent ("MistralAI-User", "MistralAI-User/1.0").
    const groups = new Map<string, string[]>();
    for (const name of Object.keys(list).sort()) {
      const key = agentKey(name);
      groups.set(key, [...(groups.get(key) ?? []), name]);
    }

    for (const [key, spellings] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      const researched = researchedByKey.get(key);
      if (researched) {
        for (const spelling of spellings) {
          const listedBy = claimedBy.get(spelling);
          if (listedBy && listedBy !== researched.operator) {
            log.problems.push(
              `"${spelling}" is listed by ${listedBy} but matches ${researched.operator}'s ${researched.agent}`,
            );
          }
          log.merged.push({
            community: spelling,
            operator: researched.operator,
            agent: researched.agent,
          });
        }
        continue;
      }

      // Prefer a spelling without a version, then a claimed one, then one whose operator is named.
      const ranked = [...spellings].sort((a, b) => {
        const score = (name: string) =>
          (baseAgentName(name) === name ? 0 : 4) +
          (claimedBy.has(name) ? 0 : 2) +
          (parseOperatorField(list[name]?.operator, input.communityOperatorNames).name ? 0 : 1);
        return score(a) - score(b) || a.localeCompare(b);
      });
      const primary = ranked[0] as string;
      // Facts come from the spelling that names its operator, if any does.
      const informed =
        ranked.find(
          (name) => parseOperatorField(list[name]?.operator, input.communityOperatorNames).name,
        ) ?? primary;
      const entry = list[informed] as CommunityEntry;
      const draft: CommunityAgentDraft = { name: baseAgentName(primary), spellings, entry };
      for (const dropped of ranked.slice(1)) log.collapsed.push({ kept: primary, dropped });

      const listedBy = spellings.map((spelling) => claimedBy.get(spelling)).find(Boolean);
      const parsed = parseOperatorField(entry.operator, input.communityOperatorNames);
      let slug: string;
      if (listedBy) {
        slug = listedBy;
        for (const spelling of spellings)
          log.claimed.push({ community: spelling, operator: slug, how: "listed" });
      } else if (parsed.name && operators.get(slugify(parsed.name))?.coverage === "researched") {
        slug = slugify(parsed.name);
        for (const spelling of spellings) {
          log.claimed.push({ community: spelling, operator: slug, how: "operator name" });
        }
      } else {
        slug = parsed.name ? slugify(parsed.name) : `unknown-${slugify(draft.name)}`;
        if (!slug || slug === "unknown-") slug = `unknown-${slugify(primary) || "agent"}`;
      }

      const agent = communityAgent(draft, source);
      const owner = input.researched.find((op) => op.slug === slug);
      if (
        owner &&
        operators.get(slug)?.verification.signing.status === "live" &&
        spellings.some((spelling) => owner.signing.covers.includes(spelling))
      ) {
        agent.signs = true;
      }

      let record = operators.get(slug);
      if (!record) {
        const path = parsed.url ? new URL(parsed.url).pathname : null;
        record = {
          slug,
          name: parsed.name ?? `Unknown operator (${draft.name})`,
          website: path === "/" || path === "" ? httpsOrNull(parsed.url) : null,
          docs_url: path && path !== "/" ? httpsOrNull(parsed.url) : null,
          coverage: "community",
          note: parsed.name ? null : "ai.robots.txt does not name the operator of this agent.",
          verification: {
            signing: emptySigning("not_probed", null),
            ip_lists: [],
            reverse_dns: null,
            asn: [],
          },
          agents: [],
          observed: {},
          enrollment: { status: "none" },
          identity_anchors: [],
          sources: [source],
        };
        operators.set(slug, record);
      }
      record.agents.push(agent);
    }
  }

  const sorted = [...operators.values()].sort((a, b) => a.slug.localeCompare(b.slug));
  for (const record of sorted) {
    record.agents.sort((a, b) =>
      a.coverage === b.coverage ? byName(a, b) : a.coverage === "researched" ? -1 : 1,
    );
  }
  log.problems.push(...findDuplicates(sorted));

  const iso = input.generatedAt.toISOString().replace(/\.\d{3}Z$/, "Z");
  return {
    directory: {
      schema: 1,
      version: iso.slice(0, 10),
      generated_at: iso,
      license: DATA_LICENSE,
      attribution: ATTRIBUTION,
      operators: sorted,
    },
    keys: {
      version: iso.slice(0, 13),
      generated_at: iso,
      operators: Object.fromEntries(
        Object.entries(keyOperators).sort(([a], [b]) => a.localeCompare(b)),
      ),
    },
    log,
  };
}

/**
 * The same agent must not appear twice. Agent names and user-agent tokens are
 * unique across the whole directory; robots tokens may be shared only within
 * one operator (several Google crawlers obey the Googlebot token).
 */
export function findDuplicates(operators: readonly OperatorRecord[]): string[] {
  const problems: string[] = [];
  const names = new Map<string, string>();
  const tokens = new Map<string, string>();
  const robots = new Map<string, string>();
  for (const op of operators) {
    for (const agent of op.agents) {
      const where = `${op.slug}/${agent.name}`;
      const nameKey = agentKey(agent.name);
      const previous = names.get(nameKey);
      if (previous) problems.push(`duplicate agent name: ${previous} and ${where}`);
      else names.set(nameKey, where);

      for (const token of agent.user_agent_tokens) {
        const owner = tokens.get(agentKey(token));
        if (owner && owner !== where)
          problems.push(`user-agent token "${token}" used by ${owner} and ${where}`);
        else tokens.set(agentKey(token), where);
      }
      if (agent.robots_token) {
        const owner = robots.get(agentKey(agent.robots_token));
        if (owner && owner !== op.slug) {
          problems.push(`robots token "${agent.robots_token}" used by ${owner} and ${op.slug}`);
        } else robots.set(agentKey(agent.robots_token), op.slug);
      }
    }
  }
  return problems;
}
