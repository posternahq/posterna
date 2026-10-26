import ipaddr from "ipaddr.js";
import { decodeEntities } from "./text";

export type ParsedIpList =
  | { ok: true; format: string; entries: string[] }
  | { ok: false; error: string };

/**
 * Reads a published IP list. Supported formats:
 * - `ipranges-json`: `{"prefixes": [{"ipv4Prefix": ...} | {"ipv6Prefix": ...}]}`, the format
 *   Google introduced and many operators copy
 * - `json-array`: a JSON array of CIDR strings
 * - `text-cidr`: one CIDR per line, `#` comments allowed
 */
export function parseIpList(body: string): ParsedIpList {
  const text = body.replace(/^﻿/, "").trim();
  if (text.startsWith("<")) {
    // Some operators publish the JSON inside a <pre> block on an HTML page.
    const blocks = [...text.matchAll(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi)].map((match) =>
      decodeEntities((match[1] ?? "").replace(/<[^>]+>/g, "")).trim(),
    );
    const json = blocks.find((block) => block.startsWith("{") || block.startsWith("["));
    if (!json) return { ok: false, error: "HTML page without a JSON <pre> block" };
    const inner = parseIpList(json);
    return inner.ok ? { ...inner, format: `html-pre+${inner.format}` } : inner;
  }
  if (text.startsWith("{") || text.startsWith("[")) {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (error) {
      return { ok: false, error: `invalid JSON: ${(error as Error).message}` };
    }
    if (Array.isArray(data)) {
      if (data.every((item) => typeof item === "string")) {
        return { ok: true, format: "json-array", entries: data };
      }
      return { ok: false, error: "JSON array contains values that are not strings" };
    }
    const prefixes = (data as { prefixes?: unknown }).prefixes;
    if (!Array.isArray(prefixes)) {
      return { ok: false, error: 'JSON object has no "prefixes" array' };
    }
    const entries: string[] = [];
    for (const item of prefixes) {
      if (typeof item === "string") entries.push(item);
      else if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        const value =
          record.ipv4Prefix ?? record.ipv6Prefix ?? record.ip_prefix ?? record.ipv6_prefix;
        if (typeof value !== "string") {
          return { ok: false, error: "prefix entry without ipv4Prefix, ipv6Prefix or ip_prefix" };
        }
        entries.push(value);
      } else return { ok: false, error: "unexpected value in prefixes" };
    }
    return { ok: true, format: "ipranges-json", entries };
  }
  const entries = text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, "").trim())
    .filter((line) => line.length > 0);
  return { ok: true, format: "text-cidr", entries };
}

export type NormalizedPrefix =
  | { ok: true; prefix: string; changed: boolean }
  | { ok: false; error: string };

/**
 * Normalizes one CIDR prefix: strict dotted-quad IPv4 or RFC 5952 IPv6, host
 * bits cleared, and a bare address read as a /32 or /128.
 */
export function normalizePrefix(input: string): NormalizedPrefix {
  const value = input.trim();
  const [address = "", lengthText, extra] = value.split("/");
  if (extra !== undefined) return { ok: false, error: `not a prefix: ${input}` };
  if (address.includes("%")) return { ok: false, error: `zone ids are not allowed: ${input}` };

  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  if (ipaddr.IPv4.isValidFourPartDecimal(address)) parsed = ipaddr.IPv4.parse(address);
  else if (address.includes(":") && ipaddr.IPv6.isValid(address))
    parsed = ipaddr.IPv6.parse(address);
  else return { ok: false, error: `not an IP address: ${input}` };

  const max = parsed.kind() === "ipv4" ? 32 : 128;
  let length = max;
  if (lengthText !== undefined) {
    if (!/^\d{1,3}$/.test(lengthText)) return { ok: false, error: `bad prefix length: ${input}` };
    length = Number(lengthText);
    if (length > max) return { ok: false, error: `prefix length over ${max}: ${input}` };
  }
  const cidr = `${parsed.toString()}/${length}`;
  const network =
    parsed.kind() === "ipv4"
      ? ipaddr.IPv4.networkAddressFromCIDR(cidr).toString()
      : ipaddr.IPv6.networkAddressFromCIDR(cidr).toRFC5952String();
  const prefix = `${network}/${length}`;
  return { ok: true, prefix, changed: prefix !== input };
}

function sortKey(prefix: string): [number, number[], number] {
  const [address = "", length = "0"] = prefix.split("/");
  const parsed = ipaddr.parse(address);
  return [parsed.kind() === "ipv4" ? 4 : 6, parsed.toByteArray(), Number(length)];
}

export function comparePrefixes(a: string, b: string): number {
  const [kindA, bytesA, lengthA] = sortKey(a);
  const [kindB, bytesB, lengthB] = sortKey(b);
  if (kindA !== kindB) return kindA - kindB;
  for (let i = 0; i < bytesA.length; i++) {
    const diff = (bytesA[i] ?? 0) - (bytesB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return lengthA - lengthB;
}

export interface NormalizedList {
  prefixes: string[];
  invalid: string[];
  /** Entries that were valid but not already in normal form. */
  rewritten: number;
  duplicates: number;
}

/** Normalizes, deduplicates and sorts (IPv4 first, then numerically). */
export function normalizePrefixes(entries: readonly string[]): NormalizedList {
  const seen = new Set<string>();
  const invalid: string[] = [];
  let rewritten = 0;
  let duplicates = 0;
  for (const entry of entries) {
    const result = normalizePrefix(entry);
    if (!result.ok) {
      invalid.push(entry);
      continue;
    }
    if (result.changed) rewritten++;
    if (seen.has(result.prefix)) duplicates++;
    seen.add(result.prefix);
  }
  return { prefixes: [...seen].sort(comparePrefixes), invalid, rewritten, duplicates };
}
