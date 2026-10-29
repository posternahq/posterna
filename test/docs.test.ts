// Checks the docs in docs/: no em dashes, host tables generated from
// docs/data/hosts.json, every link between pages lands on a real heading or
// anchor, and the markers posterna.com renders (selectors, framework
// sections, host snippets, the Moved list) are well formed.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOCS, generated, loadHosts } from "../scripts/docs-hosts";

/** U+2014, written as a code so this file does not contain one. */
const EM_DASH = String.fromCharCode(0x2014);

const pages = readdirSync(DOCS)
  .filter((name) => name.endsWith(".md"))
  .sort();
const read = (name: string) => readFileSync(join(DOCS, name), "utf8");

/** The markdown with fenced code blocks blanked out, line for line. */
function withoutCode(text: string): string {
  let fence: string | null = null;
  return text
    .split("\n")
    .map((line) => {
      const marker = /^\s*(```+|~~~+)/.exec(line)?.[1];
      if (marker && (fence === null || marker.startsWith(fence))) {
        fence = fence === null ? marker : null;
        return "";
      }
      return fence === null ? line : "";
    })
    .join("\n");
}

/** GitHub's heading slugs (github-slugger), with -1, -2 for repeats. */
function headingIds(text: string): string[] {
  const seen = new Map<string, number>();
  const ids: string[] = [];
  for (const match of withoutCode(text).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const plain = (match[1] ?? "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
    const base = plain
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
      .replace(/ /g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    ids.push(count === 0 ? base : `${base}-${count}`);
  }
  return ids;
}

function explicitIds(text: string): string[] {
  return [...withoutCode(text).matchAll(/<a id="([^"]+)"><\/a>/g)].map((match) => match[1] ?? "");
}

function anchorsOf(name: string): Set<string> {
  const text = read(name);
  return new Set([...headingIds(text), ...explicitIds(text)]);
}

/** Markdown link targets outside code, without inline code spans. */
function links(text: string): string[] {
  return [
    ...withoutCode(text)
      .replace(/`[^`]*`/g, "")
      .matchAll(/\]\(([^)\s]+)\)/g),
  ].map((match) => match[1] ?? "");
}

/** Whether a relative link from docs/ lands on a file and, for a page, an anchor. */
function resolves(from: string, target: string): boolean {
  const [path = "", hash] = target.split("#");
  const file = path === "" ? from : path;
  if (file.endsWith(".md") && !file.includes("/")) {
    if (!pages.includes(file)) return false;
    return hash === undefined || anchorsOf(file).has(hash);
  }
  return existsSync(join(DOCS, dirname(from), file));
}

describe("the docs", () => {
  it("have no em dashes", () => {
    for (const name of [...pages, "data/hosts.json"]) {
      expect(read(name), `${name} uses an em dash`).not.toContain(EM_DASH);
    }
  });

  it("have host tables generated from docs/data/hosts.json (run pnpm docs:hosts)", () => {
    for (const { path, text } of generated()) {
      expect(readFileSync(path, "utf8"), path).toBe(text);
    }
  });

  it("link only to pages, headings and anchors that exist", () => {
    for (const name of pages) {
      for (const target of links(read(name))) {
        if (/^(https?:|mailto:)/.test(target)) continue;
        expect(resolves(name, target), `${name} links to ${target}`).toBe(true);
      }
    }
    for (const host of loadHosts().hosts) {
      expect(resolves("hosts.md", host.section), `${host.id}: ${host.section}`).toBe(true);
    }
  });

  it("have no repeated anchors on a page", () => {
    for (const name of pages) {
      const ids = [...headingIds(read(name)), ...explicitIds(read(name))];
      expect(
        ids.filter((id, index) => ids.indexOf(id) !== index),
        name,
      ).toEqual([]);
    }
  });

  it("mark framework sections with a heading the site can hide", () => {
    for (const name of pages) {
      const text = read(name);
      const markers = [...text.matchAll(/<!-- posterna:framework (\S+) -->\n+(.*)/g)];
      if (markers.length === 0) continue;
      expect(text, name).toMatch(/<!-- posterna:selectors( framework)? -->/);
      for (const [, id, next] of markers) {
        expect(["express", "next"], name).toContain(id);
        expect(next, `${name}: ${id}`).toMatch(id === "express" ? /^#+ Express$/ : /^#+ Next\.js$/);
      }
      expect(text.split("<!-- posterna:end framework -->").length - 1, name).toBeGreaterThan(0);
    }
  });

  it("give each host snippet exactly one Railway line to replace", () => {
    for (const name of pages) {
      for (const match of read(name).matchAll(
        /<!-- posterna:host-snippet (\S+) -->\n```\w*\n([\s\S]*?)\n```/g,
      )) {
        const lines = (match[2] ?? "")
          .split("\n")
          .filter((line) => line.includes('clientIpHeader: "x-real-ip",'));
        expect(lines, `${name}: ${match[1]}`).toHaveLength(1);
      }
    }
    expect(read("install.md")).toContain("<!-- posterna:host-snippet express-app -->\n```js");
    expect(read("install.md")).toContain("<!-- posterna:host-snippet next-proxy -->\n```ts");
  });

  it("offer the quickstart hosts in order", () => {
    const hosts = loadHosts().hosts;
    expect(hosts.filter((host) => host.quickstart).map((host) => host.id)).toEqual([
      "railway",
      "vercel",
      "fly",
      "render",
      "aws-alb",
      "nginx",
      "other",
    ]);
    for (const host of hosts) {
      for (const line of host.lines) {
        expect(line, host.id).toMatch(/^(\/\/ .+|[A-Za-z]+: .+,( \/\/ .+)?)$/);
      }
    }
  });

  it("send every old install guide anchor somewhere from the Moved list", () => {
    const text = read("install.md");
    const moved = text.slice(text.indexOf("\n## Moved\n"));
    expect(moved.length).toBeGreaterThan(20);
    const items = moved.split("\n").filter((line) => line.startsWith("- "));
    const ids: string[] = [];
    for (const item of items) {
      const found = [...item.matchAll(/<a id="([^"]+)"><\/a>/g)].map((match) => match[1] ?? "");
      expect(found.length, item).toBeGreaterThan(0);
      expect(item, item).toMatch(/^- (<a id="[^"]+"><\/a>)+[^<]/);
      expect(links(item), item).toHaveLength(1);
      ids.push(...found);
    }
    // docs/install.md before it became the quickstart: its explicit anchors,
    // and GitHub's heading anchors except those the quickstart still has.
    expect(new Set(ids)).toEqual(
      new Set([
        "health-checks",
        "trusted-proxies",
        "cloudfront",
        "from-source",
        "pre-release",
        "install",
        "1-create-agentsyaml",
        "nextjs-16-proxyts",
        "nextjs-15-middlewarets",
        "the-edge-runtime",
        "keep-health-checks-out-of-posterna",
        "3-tell-posterna-about-your-proxies",
        "settings-by-host",
        "4-check-the-setup-with-doctor",
        "testing-by-hand",
        "5-optional-send-counters",
        "6-switch-to-enforce-safely",
        "configuration-reference",
        "install-from-a-source-build",
      ]),
    );
    const headings = headingIds(text);
    expect(headings).toContain("2-add-posterna-to-your-app");
    expect(headings).toContain("express");
    for (const id of ids) expect(headings, id).not.toContain(id);
  });
});
