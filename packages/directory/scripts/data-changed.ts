// `pnpm --filter @posterna/directory data:changed [--summary <file>]`: tells
// the daily workflow whether a rebuild changed anything that matters. Fetch
// dates, build timestamps, file hashes and the build report change on every
// run; they are ignored here so a pull request only opens when facts or
// findings change.
//
// Prints `changed=true` or `changed=false`, and appends the same line to
// $GITHUB_OUTPUT when it is set. With --summary, also writes a Markdown
// summary of what changed compared with the committed files.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { type Snapshot, summarizeChanges } from "./lib/changes";
import { DATA_DIR, FINDINGS_PATH, MANIFEST_PATH, REPO_DIR } from "./lib/config";

const VOLATILE_KEYS = new Set(["generated_at", "version", "fetched_at", "last_seen", "sha256"]);

/** A copy of parsed JSON without the fields that change on every run. */
export function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !VOLATILE_KEYS.has(key))
        .map(([key, inner]) => [key, stripVolatile(inner)]),
    );
  }
  return value;
}

/** Notes that mention fetch dates change with them; compare them without timestamps. */
function stripTimestamps(text: string): string {
  return text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<time>");
}

export function substantiveEqual(before: string, after: string): boolean {
  return (
    stripTimestamps(JSON.stringify(stripVolatile(JSON.parse(before)))) ===
    stripTimestamps(JSON.stringify(stripVolatile(JSON.parse(after))))
  );
}

function committed(path: string): string | null {
  try {
    return execFileSync("git", ["show", `HEAD:${relative(REPO_DIR, path)}`], {
      cwd: REPO_DIR,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

const DIRECTORY_PATH = join(DATA_DIR, "directory.json");
const KEYS_PATH = join(DATA_DIR, "keys.json");

/** True when facts or findings differ between the committed text and the new text. */
export function hasChanges(
  before: Record<string, string | null>,
  after: Record<string, string | null>,
): boolean {
  return Object.keys(after).some((name) => {
    const old = before[name] ?? null;
    const now = after[name] ?? null;
    if (old === null || now === null) return old !== now;
    return !substantiveEqual(old, now);
  });
}

function parse<T>(text: string | null): T | null {
  return text === null ? null : (JSON.parse(text) as T);
}

function snapshot(texts: Record<string, string | null>): Snapshot {
  return {
    directory: parse(texts.directory ?? null),
    keys: parse(texts.keys ?? null),
    findings: parse<{ findings: Snapshot["findings"] }>(texts.findings ?? null)?.findings ?? null,
    manifest: parse(texts.manifest ?? null),
  };
}

function main(args: string[]): void {
  const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);
  const paths = { directory: DIRECTORY_PATH, keys: KEYS_PATH, findings: FINDINGS_PATH };
  const before = Object.fromEntries(
    Object.entries(paths).map(([name, path]) => [name, committed(path)]),
  );
  const after = Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, read(path)]));

  const changed = hasChanges(before, after);
  const line = `changed=${changed}`;
  console.log(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);

  const summaryIndex = args.indexOf("--summary");
  if (summaryIndex !== -1) {
    const target = args[summaryIndex + 1];
    if (!target) throw new Error("--summary needs a file path");
    const summary = summarizeChanges(
      snapshot({ ...before, manifest: committed(MANIFEST_PATH) }),
      snapshot({ ...after, manifest: read(MANIFEST_PATH) }),
    );
    writeFileSync(target, summary);
    console.log(`Summary written to ${target}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2));
