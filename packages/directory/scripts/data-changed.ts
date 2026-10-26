// `pnpm --filter @posterna/directory data:changed`: tells the daily workflow
// whether a rebuild changed anything that matters. Fetch dates, build
// timestamps, file hashes and the build report change on every run; they are
// ignored here so a pull request only opens when facts change.
//
// Prints `changed=true` or `changed=false`, and appends the same line to
// $GITHUB_OUTPUT when it is set.

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { DATA_DIR, REPO_DIR } from "./lib/config";

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

function main(): void {
  const changed = ["directory.json", "keys.json"].some((name) => {
    const path = join(DATA_DIR, name);
    const before = committed(path);
    return before === null || !substantiveEqual(before, readFileSync(path, "utf8"));
  });
  const line = `changed=${changed}`;
  console.log(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
