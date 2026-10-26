import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST_PATH, RAW_DIR } from "./config";
import type { ManifestEntry, RobotsRecord } from "./fetcher";
import type { FetchedFile } from "./merge";

/** raw/manifest.json: one entry per fetched URL, committed so every build is auditable. */
export interface Manifest {
  generated_at: string;
  user_agent: string;
  robots: RobotsRecord[];
  entries: ManifestEntry[];
}

export function readManifest(path = MANIFEST_PATH): Manifest {
  if (!existsSync(path)) {
    throw new Error(`${path} not found. Run \`pnpm directory:fetch\` first.`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

/** Loads the manifest and the saved body of every successful fetch, by requested URL. */
export function loadFetched(manifest: Manifest, rawDir = RAW_DIR): Map<string, FetchedFile> {
  const fetched = new Map<string, FetchedFile>();
  for (const entry of manifest.entries) {
    let body: Uint8Array | null = null;
    if (entry.outcome === "ok" && entry.file) {
      const path = join(rawDir, entry.file);
      if (!existsSync(path)) {
        throw new Error(`${path} is missing. Run \`pnpm directory:fetch\` again.`);
      }
      body = new Uint8Array(readFileSync(path));
    }
    fetched.set(entry.url, { entry, body });
  }
  return fetched;
}
