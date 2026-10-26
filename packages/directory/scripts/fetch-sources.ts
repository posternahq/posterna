// `pnpm directory:fetch`: downloads robots.json, every documentation page,
// IP list and key directory named in sources/*.yaml into raw/, and records
// each outcome in raw/manifest.json. See docs/SPEC.md section 3.
//
// It identifies itself as PosternaDirectoryBuilder, honors robots.txt, waits
// between requests to the same host, uses timeouts, and never retries: a
// blocked, missing or slow file is recorded as such.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MANIFEST_PATH,
  RAW_DIR,
  ROBOTS_JSON_TITLE,
  ROBOTS_JSON_URL,
  USER_AGENT,
} from "./lib/config";
import { type FetchKind, type FetchTarget, type ManifestEntry, PoliteFetcher } from "./lib/fetcher";
import type { Manifest } from "./lib/manifest";
import { loadOperatorSources } from "./lib/sources";

const ACCEPT: Record<FetchKind, string> = {
  robots_json: "application/json",
  ip_list: "application/json, text/plain;q=0.9, */*;q=0.1",
  key_directory: "application/http-message-signatures-directory+json, application/json;q=0.9",
  // HTML only: some docs sites answer a Markdown Accept with different punctuation.
  doc: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
};

const FOLDER: Record<FetchKind, string> = {
  robots_json: "community",
  ip_list: "ip-lists",
  key_directory: "key-directories",
  doc: "docs",
};

/** Every URL the sources name, each once, in a stable order. */
export function fetchTargets(): FetchTarget[] {
  const targets: FetchTarget[] = [
    { url: ROBOTS_JSON_URL, kind: "robots_json", operator: null, label: ROBOTS_JSON_TITLE },
  ];
  for (const op of loadOperatorSources()) {
    for (const list of op.ip_lists) {
      targets.push({ url: list.url, kind: "ip_list", operator: op.slug, label: list.id });
    }
    if (op.signing.directory_url && op.signing.status !== "pending") {
      targets.push({
        url: op.signing.directory_url,
        kind: "key_directory",
        operator: op.slug,
        label: "key directory",
      });
    }
    for (const ref of op.sources) {
      targets.push({ url: ref.url, kind: "doc", operator: op.slug, label: ref.id });
    }
  }
  const seen = new Set<string>();
  return targets.filter((target) => {
    if (seen.has(target.url)) return false;
    seen.add(target.url);
    return true;
  });
}

function fileName(target: FetchTarget, contentType: string | null): string {
  const url = new URL(target.url);
  const stem = `${url.host}${url.pathname}${url.search}`
    .replace(/[^A-Za-z0-9.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 150);
  const known = /\.(json|txt|html?|md|csv)$/i.test(stem);
  const extension = known
    ? ""
    : contentType?.includes("json")
      ? ".json"
      : contentType?.includes("html")
        ? ".html"
        : ".txt";
  return `${FOLDER[target.kind]}/${stem}${extension}`;
}

async function main(): Promise<void> {
  const targets = fetchTargets();
  rmSync(RAW_DIR, { recursive: true, force: true });
  mkdirSync(RAW_DIR, { recursive: true });

  const fetcher = new PoliteFetcher();
  const entries: ManifestEntry[] = [];
  const started = new Date().toISOString();
  for (const target of targets) {
    const { entry, body } = await fetcher.fetch(target, ACCEPT[target.kind]);
    if (entry.outcome === "ok" && body) {
      entry.file = fileName(target, entry.content_type);
      const path = join(RAW_DIR, entry.file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);
    }
    entries.push(entry);
    const status = entry.outcome === "ok" ? "ok" : `${entry.outcome} (${entry.detail ?? ""})`;
    console.log(`${entry.kind.padEnd(13)} ${status.padEnd(12)} ${entry.url}`);
  }

  const manifest: Manifest = {
    generated_at: started,
    user_agent: USER_AGENT,
    robots: await fetcher.robotsRecords(),
    entries: entries.sort((a, b) => a.kind.localeCompare(b.kind) || a.url.localeCompare(b.url)),
  };
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  const failed = entries.filter((entry) => entry.outcome !== "ok").length;
  console.log(
    `\n${entries.length - failed} of ${entries.length} fetched, ${failed} recorded as failed. Manifest: ${MANIFEST_PATH}`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
