import type { WebBotAlgorithm } from "web-bot-auth";
import { verifierFromJWK } from "web-bot-auth/crypto";
import { PrefixMatcher } from "../ip/prefix-matcher";
import type { AgentRecord, DirectoryFile, KeysFile, OperatorRecord } from "./types";

/** An agent and the operator it belongs to. */
export interface AgentRef {
  operator: OperatorRecord;
  agent: AgentRecord;
}

/** One operator signing key, imported once and reused for every request. */
export interface KeyVerifier {
  kid: string | null;
  /** RFC 7638 thumbprint, computed by Cloudflare's library from the key itself. */
  thumbprint: string;
  algorithm: WebBotAlgorithm;
  verify(data: Uint8Array, signature: Uint8Array): boolean | Promise<boolean>;
}

export interface OperatorKeys {
  keys: KeyVerifier[];
  /** True when at least one key has a kid; when none do, every key is tried. */
  usesKid: boolean;
}

export interface OperatorIpLists {
  byList: Map<string, PrefixMatcher>;
  all: PrefixMatcher;
}

/** Lookups the verifier needs on the hot path, built once per directory version. */
export interface DirectoryIndex {
  directoryVersion: string | null;
  keysVersion: string | null;
  operators: Map<string, OperatorRecord>;
  /** Operators by the origin of their key directory URL. */
  signingOrigins: Map<string, OperatorRecord>;
  /** Single-word user-agent tokens, lowercase. */
  tokens: Map<string, AgentRef>;
  /** Tokens with spaces or punctuation, matched as whole phrases. */
  phrases: { pattern: RegExp; ref: AgentRef }[];
  ipLists: Map<string, OperatorIpLists>;
  keys: Map<string, OperatorKeys>;
  /** Keys left out, with the reason, for the debug route. */
  skippedKeys: string[];
}

/**
 * The RFC 9421 example key. The protocol draft says verifiers SHOULD reject
 * known test keys found in key directories.
 */
const KNOWN_TEST_KEYS = new Set(["JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs"]);

const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The origin a key directory URL belongs to, or null. */
export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** Checks the parts of directory.json the verifier relies on. Throws on anything malformed. */
export function checkDirectoryShape(value: unknown): DirectoryFile {
  const file = value as DirectoryFile;
  if (!file || typeof file !== "object" || !Array.isArray(file.operators)) {
    throw new Error("directory.json has no operators array");
  }
  for (const op of file.operators) {
    if (
      !op ||
      typeof op.slug !== "string" ||
      !Array.isArray(op.agents) ||
      !op.verification ||
      !Array.isArray(op.verification.ip_lists) ||
      !op.verification.signing
    ) {
      throw new Error("directory.json has a malformed operator record");
    }
    for (const agent of op.agents) {
      if (!agent || typeof agent.name !== "string" || !Array.isArray(agent.user_agent_tokens)) {
        throw new Error(`directory.json has a malformed agent in ${op.slug}`);
      }
    }
  }
  return file;
}

/** Checks the parts of keys.json the verifier relies on. Throws on anything malformed. */
export function checkKeysShape(value: unknown): KeysFile {
  const file = value as KeysFile;
  if (!file || typeof file !== "object" || !file.operators || typeof file.operators !== "object") {
    throw new Error("keys.json has no operators object");
  }
  for (const [slug, op] of Object.entries(file.operators)) {
    if (!op || !Array.isArray(op.keys)) throw new Error(`keys.json has malformed keys for ${slug}`);
  }
  return file;
}

function addToken(index: DirectoryIndex, raw: string, ref: AgentRef): void {
  const token = raw.replace(/\/[\w.-]*$/, "").trim();
  if (!token) return;
  if (TOKEN_PATTERN.test(token)) {
    const key = token.toLowerCase();
    const existing = index.tokens.get(key);
    // A researched agent wins over a community one with the same token.
    if (
      !existing ||
      (existing.agent.coverage === "community" && ref.agent.coverage === "researched")
    ) {
      index.tokens.set(key, ref);
    }
  } else {
    index.phrases.push({
      pattern: new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(token)}($|[^A-Za-z0-9])`, "i"),
      ref,
    });
  }
}

/** Builds every lookup from a directory and keys file. Key import is the only async step. */
export async function buildIndex(
  directory: DirectoryFile,
  keys: KeysFile | null,
): Promise<DirectoryIndex> {
  const index: DirectoryIndex = {
    directoryVersion: directory.version ?? null,
    keysVersion: keys?.version ?? null,
    operators: new Map(),
    signingOrigins: new Map(),
    tokens: new Map(),
    phrases: [],
    ipLists: new Map(),
    keys: new Map(),
    skippedKeys: [],
  };

  for (const op of directory.operators) {
    index.operators.set(op.slug, op);
    const directoryUrl = op.verification.signing.directory_url;
    const origin = directoryUrl ? originOf(directoryUrl) : null;
    if (origin && !index.signingOrigins.has(origin)) index.signingOrigins.set(origin, op);

    for (const agent of op.agents) {
      const ref = { operator: op, agent };
      for (const token of agent.user_agent_tokens) addToken(index, token, ref);
      for (const alias of agent.aliases ?? []) {
        if (TOKEN_PATTERN.test(alias.replace(/\/[\w.-]*$/, ""))) addToken(index, alias, ref);
      }
    }

    const lists = op.verification.ip_lists;
    if (lists.length > 0) {
      index.ipLists.set(op.slug, {
        byList: new Map(
          lists.map((list) => [list.agent, PrefixMatcher.compile(list.prefixes ?? [])]),
        ),
        all: PrefixMatcher.compile(lists.flatMap((list) => list.prefixes ?? [])),
      });
    }
  }
  index.phrases.sort((a, b) => b.pattern.source.length - a.pattern.source.length);

  for (const [slug, op] of Object.entries(keys?.operators ?? {})) {
    if (!index.operators.has(slug)) continue;
    const imported: KeyVerifier[] = [];
    for (const entry of op.keys) {
      const jwk = entry.jwk as Parameters<typeof verifierFromJWK>[0] & { x?: string };
      if (typeof jwk.x === "string" && KNOWN_TEST_KEYS.has(jwk.x)) {
        index.skippedKeys.push(`${slug}: a published test key was ignored`);
        continue;
      }
      try {
        const verifier = await verifierFromJWK(jwk);
        imported.push({
          kid: entry.kid ?? null,
          thumbprint: verifier.keyid,
          algorithm: verifier.algorithm,
          verify: (data, signature) => verifier.verify(data, signature),
        });
      } catch (error) {
        index.skippedKeys.push(`${slug}: ${(error as Error).message}`);
      }
    }
    index.keys.set(slug, { keys: imported, usesKid: imported.some((key) => key.kid !== null) });
  }
  return index;
}
