import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { DirectoryFile, KeysFile } from "../../../core/src/directory/types";
import { SCHEMA_DIR } from "./config";

/** Compiled validators for the published files, from packages/core/src/schema. */
export function schemaValidators() {
  const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  const load = (name: string) => JSON.parse(readFileSync(join(SCHEMA_DIR, name), "utf8"));
  const directory = ajv.compile(load("directory.schema.json"));
  const keys = ajv.compile(load("keys.schema.json"));
  const run = (validate: typeof directory, data: unknown): string[] =>
    validate(data)
      ? []
      : (validate.errors ?? []).map(
          (error) => `${error.instancePath || "/"} ${error.message ?? ""}`,
        );
  return {
    directory: (data: unknown) => run(directory, data),
    keys: (data: unknown) => run(keys, data),
  };
}

const CSV_COLUMNS = [
  "operator",
  "operator_name",
  "operator_coverage",
  "agent",
  "agent_coverage",
  "purpose",
  "search_engine",
  "user_agent_tokens",
  "robots_token",
  "robots_policy",
  "signs",
  "signing_status",
  "ip_list",
  "ip_prefixes",
  "reverse_dns",
  "source_urls",
] as const;

function csvField(value: string | number | boolean | null): string {
  const text = value === null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One row per agent, RFC 4180 quoting with LF line endings (the repo stores text as LF), lists joined with `;`. */
export function agentsCsv(directory: DirectoryFile): string {
  const rows = [CSV_COLUMNS.join(",")];
  for (const op of directory.operators) {
    for (const agent of op.agents) {
      const list = op.verification.ip_lists.find(
        (candidate) => candidate.agent === agent.ip_list_agent,
      );
      const row = [
        op.slug,
        op.name,
        op.coverage,
        agent.name,
        agent.coverage,
        agent.purpose,
        agent.search_engine,
        agent.user_agent_tokens.join(";"),
        agent.robots_token,
        agent.robots_policy,
        agent.signs,
        op.verification.signing.status,
        list?.url ?? null,
        list?.prefix_count ?? null,
        op.verification.reverse_dns?.suffixes.join(";") ?? null,
        agent.sources.map((source) => source.url).join(";"),
      ];
      rows.push(row.map(csvField).join(","));
    }
  }
  return `${rows.join("\n")}\n`;
}

function count<T extends string>(values: T[]): Record<T, number> {
  const counts = {} as Record<T, number>;
  for (const value of [...values].sort()) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

/** Counts for dashboards and the build report. */
export function summary(directory: DirectoryFile, keys: KeysFile) {
  const agents = directory.operators.flatMap((op) => op.agents);
  const lists = directory.operators.flatMap((op) => op.verification.ip_lists);
  return {
    version: directory.version,
    generated_at: directory.generated_at,
    operators: {
      total: directory.operators.length,
      by_coverage: count(directory.operators.map((op) => op.coverage)),
    },
    agents: {
      total: agents.length,
      by_coverage: count(agents.map((agent) => agent.coverage)),
      by_purpose: count(agents.map((agent) => agent.purpose)),
      by_robots_policy: count(agents.map((agent) => agent.robots_policy)),
      search_engines: agents.filter((agent) => agent.search_engine).length,
      signing: agents.filter((agent) => agent.signs).length,
    },
    signing: count(directory.operators.map((op) => op.verification.signing.status)),
    keys: Object.values(keys.operators).reduce((total, op) => total + op.keys.length, 0),
    ip_lists: {
      total: lists.length,
      fetched: lists.filter((list) => list.prefix_count !== null).length,
      prefixes: lists.reduce((total, list) => total + (list.prefix_count ?? 0), 0),
    },
    reverse_dns_rules: directory.operators.filter((op) => op.verification.reverse_dns).length,
  };
}
