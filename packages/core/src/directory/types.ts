/**
 * Types for the operator directory files (docs/SPEC.md section 3). They mirror
 * the JSON Schemas in `src/schema/`; keep both in step.
 */

/** What an agent does with the pages it fetches. */
export type Purpose = "training" | "search" | "user_fetch" | "agent" | "preview" | "ads" | "other";

/** `researched`: from the operator's own documentation. `community`: from ai.robots.txt. */
export type Coverage = "researched" | "community";

/** Whether an operator's Web Bot Auth key directory has been confirmed. */
export type SigningStatus = "live" | "reported" | "none_found" | "pending" | "not_probed";

/** How an operator assigns `kid` values to its signing keys. */
export type KidConvention = "thumbprint" | "short_id" | "none";

/** What the operator says about robots.txt for an agent. */
export type RobotsPolicy = "honors" | "may_ignore" | "unstated";

/** A page or file a fact comes from, with the date it was fetched or checked. */
export interface DirectorySource {
  url: string;
  title: string;
  /** RFC 3339 timestamp of a pipeline fetch, or a date a person checked the page. */
  fetched_at: string;
}

export interface SigningInfo {
  status: SigningStatus;
  /** Full URL of the key directory, `<origin>/.well-known/http-message-signatures-directory`. */
  directory_url: string | null;
  kid_convention: KidConvention | null;
  purpose_field: string | null;
  /** Names of the agents whose requests are signed. */
  covers: string[];
  note: string | null;
  sources: DirectorySource[];
}

export interface IpList {
  /** Identifier that agents use in `ip_list_agent` to point at this list. */
  agent: string;
  url: string;
  /** For example `ipranges-json`. Null when the file could not be fetched or parsed. */
  format: string | null;
  prefix_count: number | null;
  fetched_at: string | null;
  /** SHA-256 of the fetched file bytes, hex. */
  sha256: string | null;
  /** Normalized CIDR prefixes: network address, RFC 5952 for IPv6, deduplicated, sorted. */
  prefixes: string[];
  note: string | null;
  sources: DirectorySource[];
}

export interface ReverseDnsRule {
  /** The verified hostname must end with one of these suffixes. */
  suffixes: string[];
  forward_confirm: boolean;
  note: string | null;
  sources: DirectorySource[];
}

export interface AsnEntry {
  asn: number;
  note: string | null;
  sources: DirectorySource[];
}

export interface AgentRecord {
  name: string;
  coverage: Coverage;
  user_agent_tokens: string[];
  /** Other names for this agent: from the operator's docs, or spellings used by ai.robots.txt. */
  aliases: string[];
  purpose: Purpose;
  /** Short verbatim quote from the operator's documentation. Null for community records. */
  purpose_quote: string | null;
  search_engine: boolean;
  robots_token: string | null;
  robots_policy: RobotsPolicy;
  robots_quote: string | null;
  ip_list_agent: string | null;
  /** True only when the operator's key directory was fetched and parsed and covers this agent. */
  signs: boolean;
  note: string | null;
  sources: DirectorySource[];
}

export interface IdentityAnchor {
  kind: string;
  value: string;
  note: string | null;
  sources: DirectorySource[];
}

export interface OperatorRecord {
  slug: string;
  name: string;
  website: string | null;
  docs_url: string | null;
  coverage: Coverage;
  note: string | null;
  verification: {
    signing: SigningInfo;
    ip_lists: IpList[];
    reverse_dns: ReverseDnsRule | null;
    asn: AsnEntry[];
  };
  agents: AgentRecord[];
  /** Empty in v1. */
  observed: Record<string, never>;
  enrollment: { status: "none" | "requested" | "enrolled" };
  /** Schema only in v1. */
  identity_anchors: IdentityAnchor[];
  sources: DirectorySource[];
}

/** The contents of directory.json. */
export interface DirectoryFile {
  schema: 1;
  /** Build date, `YYYY-MM-DD`. */
  version: string;
  generated_at: string;
  license: string;
  attribution: string;
  operators: OperatorRecord[];
}

/** A public JWK. Private members are never stored. */
export interface PublicJwk {
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
  kid?: string;
  key_ops?: string[];
  nbf?: number;
  exp?: number;
}

export interface KeyEntry {
  jwk: PublicJwk;
  /** RFC 7638 SHA-256 thumbprint, base64url, computed by Posterna. */
  thumbprint: string;
  kid: string | null;
  first_seen: string;
  last_seen: string;
}

export interface KeysOperator {
  directory_url: string;
  fetched_at: string | null;
  status: SigningStatus;
  keys: KeyEntry[];
}

/** The contents of keys.json. */
export interface KeysFile {
  /** Build hour, `YYYY-MM-DDTHH`. */
  version: string;
  generated_at: string;
  operators: Record<string, KeysOperator>;
}
