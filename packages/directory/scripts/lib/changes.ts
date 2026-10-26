/**
 * A plain-English summary of what a rebuild changed compared with main, for
 * the daily pull request. Timestamps and hashes are left out; facts are not.
 */

import type { AgentRecord, DirectoryFile, KeysFile } from "../../../core/src/directory/types";
import { agentKey } from "./community";
import type { Finding } from "./findings";
import type { Manifest } from "./manifest";
import { findingsTable } from "./report";

/** One side of the comparison. Any file may be missing (for example on the first run). */
export interface Snapshot {
  directory: DirectoryFile | null;
  keys: KeysFile | null;
  findings: Finding[] | null;
  manifest: Manifest | null;
}

const LIMIT = 25;

function capped(items: string[], limit = LIMIT): string[] {
  if (items.length <= limit) return items;
  return [...items.slice(0, limit), `and ${items.length - limit} more`];
}

function bullets(items: string[]): string {
  return capped(items)
    .map((item) => `- ${item}`)
    .join("\n");
}

const findingKey = (finding: Finding) =>
  `${finding.operator}\u0000${finding.kind}\u0000${finding.value}`;

interface PlacedAgent {
  operator: string;
  agent: AgentRecord;
}

function agentsByKey(directory: DirectoryFile | null): Map<string, PlacedAgent> {
  const agents = new Map<string, PlacedAgent>();
  for (const op of directory?.operators ?? []) {
    for (const agent of op.agents) agents.set(agentKey(agent.name), { operator: op.slug, agent });
  }
  return agents;
}

function agentChanges(before: AgentRecord, after: AgentRecord): string[] {
  const changes: string[] = [];
  const fields = ["coverage", "purpose", "robots_policy", "search_engine", "signs"] as const;
  for (const field of fields) {
    if (before[field] !== after[field])
      changes.push(`${field} ${before[field]} to ${after[field]}`);
  }
  const tokens = (agent: AgentRecord) => [...agent.user_agent_tokens].sort().join(", ");
  if (tokens(before) !== tokens(after)) {
    changes.push(`user-agent tokens [${tokens(before)}] to [${tokens(after)}]`);
  }
  return changes;
}

/** Markdown for the daily pull request body. */
export function summarizeChanges(before: Snapshot, after: Snapshot): string {
  const out: string[] = [];
  /** Sections about facts, as opposed to findings and fetch problems. */
  let factSections = 0;
  const section = (title: string, body: string, fact = true) => {
    if (!body.trim()) return;
    out.push(`### ${title}\n\n${body.trim()}\n`);
    if (fact) factSections++;
  };

  // Findings first: they are what most needs a person.
  const known = new Set((before.findings ?? []).map(findingKey));
  const current = after.findings ?? [];
  const fresh = current.filter((finding) => !known.has(findingKey(finding)));
  const resolved = (before.findings ?? []).filter(
    (finding) => !current.some((candidate) => findingKey(candidate) === findingKey(finding)),
  );
  {
    const parts: string[] = [];
    if (fresh.length > 0) parts.push(`${fresh.length} new:\n\n${findingsTable(fresh)}`);
    const stillOpen = current.length - fresh.length;
    if (stillOpen > 0) {
      parts.push(`${stillOpen} still open from earlier runs (see the build report).`);
    }
    if (resolved.length > 0) {
      parts.push(
        `No longer found:\n\n${bullets(resolved.map((finding) => `${finding.operator}: ${finding.value}`))}`,
      );
    }
    section("Needs review", parts.join("\n\n"), false);
  }

  // Operators.
  const opsBefore = new Map((before.directory?.operators ?? []).map((op) => [op.slug, op]));
  const opsAfter = new Map((after.directory?.operators ?? []).map((op) => [op.slug, op]));
  {
    const added = [...opsAfter.values()]
      .filter((op) => !opsBefore.has(op.slug))
      .map((op) => `Added \`${op.slug}\` (${op.name}, ${op.coverage})`);
    const removed = [...opsBefore.values()]
      .filter((op) => !opsAfter.has(op.slug))
      .map((op) => `Removed \`${op.slug}\` (${op.name})`);
    const coverage = [...opsAfter.values()]
      .filter((op) => {
        const old = opsBefore.get(op.slug);
        return old && old.coverage !== op.coverage;
      })
      .map((op) => `\`${op.slug}\` coverage ${opsBefore.get(op.slug)?.coverage} to ${op.coverage}`);
    section("Operators", bullets([...added, ...removed, ...coverage]));
  }

  // Agents.
  {
    const agentsBefore = agentsByKey(before.directory);
    const agentsAfter = agentsByKey(after.directory);
    const lines: string[] = [];
    for (const [key, placed] of agentsAfter) {
      const old = agentsBefore.get(key);
      const where = `\`${placed.operator}/${placed.agent.name}\``;
      if (!old) {
        lines.push(`Added ${where} (${placed.agent.coverage}, ${placed.agent.purpose})`);
        continue;
      }
      if (old.operator !== placed.operator) {
        lines.push(
          `Moved \`${placed.agent.name}\` from \`${old.operator}\` to \`${placed.operator}\``,
        );
      }
      const changes = agentChanges(old.agent, placed.agent);
      if (changes.length > 0) lines.push(`${where}: ${changes.join("; ")}`);
    }
    for (const [key, placed] of agentsBefore) {
      if (!agentsAfter.has(key)) lines.push(`Removed \`${placed.operator}/${placed.agent.name}\``);
    }
    section("Agents", bullets(lines));
  }

  // Signing and keys.
  {
    const lines: string[] = [];
    for (const op of opsAfter.values()) {
      const old = opsBefore.get(op.slug);
      const was = old?.verification.signing.status;
      const now = op.verification.signing.status;
      if (old && was !== now) lines.push(`\`${op.slug}\`: ${was} to ${now}`);
    }
    const slugs = new Set([
      ...Object.keys(before.keys?.operators ?? {}),
      ...Object.keys(after.keys?.operators ?? {}),
    ]);
    for (const slug of [...slugs].sort()) {
      const oldKeys = new Set(
        before.keys?.operators[slug]?.keys.map((key) => key.thumbprint) ?? [],
      );
      const newKeys = new Set(after.keys?.operators[slug]?.keys.map((key) => key.thumbprint) ?? []);
      const added = [...newKeys].filter((thumbprint) => !oldKeys.has(thumbprint));
      const removed = [...oldKeys].filter((thumbprint) => !newKeys.has(thumbprint));
      if (added.length > 0)
        lines.push(`\`${slug}\`: new keys ${added.map((t) => `\`${t}\``).join(", ")}`);
      if (removed.length > 0) {
        lines.push(`\`${slug}\`: keys gone ${removed.map((t) => `\`${t}\``).join(", ")}`);
      }
    }
    section("Signing", bullets(lines));
  }

  // IP lists.
  {
    const rows: string[] = [];
    const other: string[] = [];
    const lists = (directory: DirectoryFile | null) => {
      const map = new Map<string, { operator: string; agent: string; prefixes: string[] }>();
      for (const op of directory?.operators ?? []) {
        for (const list of op.verification.ip_lists) {
          map.set(`${op.slug} ${list.url}`, {
            operator: op.slug,
            agent: list.agent,
            prefixes: list.prefixes,
          });
        }
      }
      return map;
    };
    const listsBefore = lists(before.directory);
    const listsAfter = lists(after.directory);
    for (const [key, list] of listsAfter) {
      const old = listsBefore.get(key);
      if (!old) {
        other.push(
          `Added list \`${list.operator}/${list.agent}\` (${list.prefixes.length} prefixes)`,
        );
        continue;
      }
      const oldSet = new Set(old.prefixes);
      const newSet = new Set(list.prefixes);
      const added = list.prefixes.filter((prefix) => !oldSet.has(prefix)).length;
      const removed = old.prefixes.filter((prefix) => !newSet.has(prefix)).length;
      if (added > 0 || removed > 0) {
        rows.push(
          `| ${list.operator} | \`${list.agent}\` | ${old.prefixes.length} | ${list.prefixes.length} | +${added} | -${removed} |`,
        );
      }
    }
    for (const [key, list] of listsBefore) {
      if (!listsAfter.has(key)) other.push(`Removed list \`${list.operator}/${list.agent}\``);
    }
    const table =
      rows.length > 0
        ? [
            "| Operator | List | Prefixes before | After | Added | Removed |",
            "|---|---|---|---|---|---|",
            ...capped(rows).map((row) => (row.startsWith("|") ? row : `| ${row} | | | | | |`)),
          ].join("\n")
        : "";
    section("IP lists", [table, bullets(other)].filter(Boolean).join("\n\n"));
  }

  // Reverse DNS.
  {
    const lines: string[] = [];
    const suffixes = (op?: DirectoryFile["operators"][number]) =>
      op?.verification.reverse_dns?.suffixes.join(", ") ?? "none";
    for (const op of opsAfter.values()) {
      const old = opsBefore.get(op.slug);
      if (old && suffixes(old) !== suffixes(op)) {
        lines.push(`\`${op.slug}\`: ${suffixes(old)} to ${suffixes(op)}`);
      }
    }
    section("Reverse DNS", bullets(lines));
  }

  // Fetch failures in this run.
  {
    const failedBefore = new Set(
      (before.manifest?.entries ?? [])
        .filter((entry) => entry.outcome !== "ok")
        .map((entry) => entry.url),
    );
    const failures = (after.manifest?.entries ?? []).filter((entry) => entry.outcome !== "ok");
    const lines = failures.map(
      (entry) =>
        `${failedBefore.has(entry.url) ? "" : "**New:** "}${entry.url} (${entry.kind}): ${entry.outcome}${entry.detail ? `, ${entry.detail}` : ""}`,
    );
    section("Fetch failures in this run", bullets(lines), false);
  }

  const from = before.directory?.version ?? "none";
  const to = after.directory?.version ?? "none";
  const header = `## What changed\n\nCompared with \`main\` (directory version ${from} to ${to}). Fetch dates, build times and file hashes are left out.\n`;
  const quiet = factSections === 0 ? "\nNo facts changed.\n" : "";
  return `${header}${quiet}${out.length > 0 ? `\n${out.join("\n")}` : ""}`;
}
