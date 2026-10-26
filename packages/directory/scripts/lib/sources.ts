import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse } from "yaml";
import type { Purpose, RobotsPolicy } from "../../../core/src/directory/types";
import { COMMUNITY_OPERATORS_PATH, KEY_DIRECTORY_PATH, SOURCES_DIR } from "./config";

/** A page cited by a researched operator file. */
export interface SourceRef {
  id: string;
  url: string;
  title: string;
}

export interface SourceAgent {
  name: string;
  user_agent_tokens: string[];
  robots_token: string | null;
  purpose: Purpose;
  purpose_quote: string;
  purpose_source: string;
  search_engine: boolean;
  robots_policy: RobotsPolicy;
  robots_quote: string | null;
  robots_source: string | null;
  ip_list: string | null;
  aliases: string[];
  aliases_source: string | null;
  note: string | null;
}

export interface SourceIpList {
  id: string;
  url: string;
  source: string;
  note: string | null;
}

export interface SourceReverseDns {
  suffixes: string[];
  forward_confirm: boolean;
  quote: string | null;
  source: string;
  note: string | null;
}

export interface SourceAsn {
  asn: number;
  note: string | null;
  source: string;
}

export interface SourceSigning {
  directory_url: string | null;
  basis: "documented" | "reported" | "none";
  status: "pending" | null;
  covers: string[];
  note: string | null;
  sources: string[];
}

/** One packages/directory/sources/<slug>.yaml file. */
export interface OperatorSource {
  slug: string;
  name: string;
  website: string | null;
  docs_url: string | null;
  checked_on: string;
  note: string | null;
  community_agents: string[];
  sources: SourceRef[];
  agents: SourceAgent[];
  ip_lists: SourceIpList[];
  reverse_dns: SourceReverseDns | null;
  asn: SourceAsn[];
  signing: SourceSigning;
}

const nullableText = { type: ["string", "null"], minLength: 1 };
const httpsUrl = { type: "string", pattern: "^https://[^\\s]+$" };
const sourceId = { type: "string", pattern: "^[a-z0-9][a-z0-9_-]*$" };

const operatorSchema = {
  type: "object",
  additionalProperties: false,
  required: ["slug", "name", "checked_on", "sources", "agents", "signing"],
  properties: {
    slug: { type: "string", pattern: "^[a-z0-9]+(-[a-z0-9]+)*$" },
    name: { type: "string", minLength: 1 },
    website: { anyOf: [httpsUrl, { type: "null" }], default: null },
    docs_url: { anyOf: [httpsUrl, { type: "null" }], default: null },
    checked_on: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    note: { ...nullableText, default: null },
    community_agents: {
      type: "array",
      items: { type: "string", minLength: 1 },
      uniqueItems: true,
      default: [],
    },
    sources: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "url", "title"],
        properties: {
          id: sourceId,
          url: httpsUrl,
          title: { type: "string", minLength: 1 },
        },
      },
    },
    agents: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "name",
          "user_agent_tokens",
          "purpose",
          "purpose_quote",
          "purpose_source",
          "search_engine",
          "robots_policy",
        ],
        properties: {
          name: { type: "string", minLength: 1 },
          user_agent_tokens: {
            type: "array",
            items: { type: "string", minLength: 1 },
            uniqueItems: true,
          },
          robots_token: { ...nullableText, default: null },
          purpose: {
            enum: ["training", "search", "user_fetch", "agent", "preview", "ads", "other"],
          },
          purpose_quote: { type: "string", minLength: 1, maxLength: 600 },
          purpose_source: sourceId,
          search_engine: { type: "boolean" },
          robots_policy: { enum: ["honors", "may_ignore", "unstated"] },
          robots_quote: { ...nullableText, maxLength: 600, default: null },
          robots_source: { anyOf: [sourceId, { type: "null" }], default: null },
          ip_list: { anyOf: [sourceId, { type: "null" }], default: null },
          aliases: {
            type: "array",
            items: { type: "string", minLength: 1 },
            uniqueItems: true,
            default: [],
          },
          aliases_source: { anyOf: [sourceId, { type: "null" }], default: null },
          note: { ...nullableText, default: null },
        },
      },
    },
    ip_lists: {
      type: "array",
      default: [],
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "url", "source"],
        properties: {
          id: sourceId,
          url: httpsUrl,
          source: sourceId,
          note: { ...nullableText, default: null },
        },
      },
    },
    reverse_dns: {
      type: ["object", "null"],
      default: null,
      additionalProperties: false,
      required: ["suffixes", "forward_confirm", "source"],
      properties: {
        suffixes: {
          type: "array",
          minItems: 1,
          items: { type: "string", pattern: "^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$" },
        },
        forward_confirm: { type: "boolean" },
        quote: { ...nullableText, maxLength: 600, default: null },
        source: sourceId,
        note: { ...nullableText, default: null },
      },
    },
    asn: {
      type: "array",
      default: [],
      items: {
        type: "object",
        additionalProperties: false,
        required: ["asn", "source"],
        properties: {
          asn: { type: "integer", minimum: 1 },
          note: { ...nullableText, default: null },
          source: sourceId,
        },
      },
    },
    signing: {
      type: "object",
      additionalProperties: false,
      required: ["basis"],
      properties: {
        directory_url: { anyOf: [httpsUrl, { type: "null" }], default: null },
        basis: { enum: ["documented", "reported", "none"] },
        status: { enum: ["pending", null], default: null },
        covers: { type: "array", items: { type: "string", minLength: 1 }, default: [] },
        note: { ...nullableText, default: null },
        sources: { type: "array", items: sourceId, default: [] },
      },
    },
  },
} as const;

const ajv = new Ajv2020({ allErrors: true, useDefaults: true, allowUnionTypes: true });
const validateShape = ajv.compile(operatorSchema);

/**
 * Checks that every fact in a researched file points at a source, and that
 * every reference resolves. Returns a list of problems; empty means valid.
 */
export function checkOperatorSource(source: OperatorSource): string[] {
  const problems: string[] = [];
  const at = (path: string, message: string) =>
    problems.push(`${source.slug}: ${path}: ${message}`);
  const sourceIds = new Set<string>();
  for (const ref of source.sources) {
    if (sourceIds.has(ref.id)) at(`sources.${ref.id}`, "duplicate source id");
    sourceIds.add(ref.id);
  }
  const needSource = (path: string, id: string | null | undefined) => {
    if (!id) at(path, "missing source");
    else if (!sourceIds.has(id)) at(path, `unknown source id "${id}"`);
  };

  const ipListIds = new Set(source.ip_lists.map((list) => list.id));
  for (const list of source.ip_lists) needSource(`ip_lists.${list.id}.source`, list.source);
  if (ipListIds.size !== source.ip_lists.length) at("ip_lists", "duplicate ip list id");

  const agentNames = new Set<string>();
  for (const agent of source.agents) {
    const path = `agents.${agent.name}`;
    if (agentNames.has(agent.name)) at(path, "duplicate agent name");
    agentNames.add(agent.name);
    needSource(`${path}.purpose_source`, agent.purpose_source);
    if (agent.robots_policy === "unstated") {
      if (agent.robots_quote || agent.robots_source) {
        at(path, "robots_policy unstated must not have a robots quote or source");
      }
    } else {
      if (!agent.robots_quote)
        at(`${path}.robots_quote`, "required unless robots_policy is unstated");
      needSource(`${path}.robots_source`, agent.robots_source);
    }
    if (agent.aliases.length > 0) needSource(`${path}.aliases_source`, agent.aliases_source);
    if (agent.ip_list && !ipListIds.has(agent.ip_list)) {
      at(`${path}.ip_list`, `unknown ip list id "${agent.ip_list}"`);
    }
  }

  if (source.reverse_dns) needSource("reverse_dns.source", source.reverse_dns.source);
  for (const entry of source.asn) needSource(`asn.${entry.asn}.source`, entry.source);

  const signing = source.signing;
  for (const id of signing.sources) needSource("signing.sources", id);
  if (signing.basis !== "none" && signing.sources.length === 0) {
    at("signing.sources", `basis ${signing.basis} needs at least one source`);
  }
  if (signing.basis === "none" && signing.directory_url) {
    at("signing", "basis none must not have a directory_url");
  }
  if (
    signing.directory_url &&
    !new URL(signing.directory_url).pathname.endsWith(KEY_DIRECTORY_PATH)
  ) {
    at("signing.directory_url", `must end with ${KEY_DIRECTORY_PATH}`);
  }
  for (const name of signing.covers) {
    if (!agentNames.has(name) && !source.community_agents.includes(name)) {
      at("signing.covers", `"${name}" is neither an agent here nor listed in community_agents`);
    }
  }
  return problems;
}

/** Parses and validates one source file. Throws with every problem found. */
export function parseOperatorSource(text: string, fileName: string): OperatorSource {
  const data: unknown = parse(text);
  if (!validateShape(data)) {
    const details = (validateShape.errors ?? [])
      .map((error) => `${error.instancePath || "/"} ${error.message ?? ""}`)
      .join("; ");
    throw new Error(`${fileName}: ${details}`);
  }
  const source = data as unknown as OperatorSource;
  const expected = basename(fileName, ".yaml");
  if (source.slug !== expected) {
    throw new Error(`${fileName}: slug "${source.slug}" must match the file name "${expected}"`);
  }
  const problems = checkOperatorSource(source);
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return source;
}

/** Loads every researched operator file, sorted by slug. */
export function loadOperatorSources(dir = SOURCES_DIR): OperatorSource[] {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".yaml") && name !== basename(COMMUNITY_OPERATORS_PATH))
    .sort();
  return files.map((name) => parseOperatorSource(readFileSync(join(dir, name), "utf8"), name));
}

/**
 * Display names for community operators whose ai.robots.txt `operator` field
 * is a sentence rather than a name. Keys are exact field values.
 */
export function loadCommunityOperatorNames(path = COMMUNITY_OPERATORS_PATH): Map<string, string> {
  const data: unknown = parse(readFileSync(path, "utf8")) ?? {};
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`${path}: expected a mapping of operator field to display name`);
  }
  const names = new Map<string, string>();
  for (const [field, name] of Object.entries(data)) {
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error(`${path}: "${field}" must map to a non-empty name`);
    }
    names.set(field, name.trim());
  }
  return names;
}
