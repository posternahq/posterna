// `pnpm docs:hosts`: writes the host tables in docs/install.md and
// docs/hosts.md from docs/data/hosts.json, the one source of the proxy
// settings per host. posterna.com renders its quickstart snippets from the
// same file. test/docs.test.ts fails when the markdown is stale.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DOCS = join(ROOT, "docs");

export interface HostEntry {
  id: string;
  /** Short label for the quickstart's host selector. */
  tab: string;
  /** The row name in the "Settings by host" table. */
  name: string;
  quickstart: boolean;
  table: boolean;
  /** Option lines as they go inside the options object, without indentation. */
  lines: string[];
  clientAddress: string | null;
  publicHost: string | null;
  confidence: string | null;
  /** Where the evidence is, as a link relative to docs/. */
  section: string;
  /** One line of markdown for hosts that need an extra step. */
  extra: string | null;
}

export interface HostsFile {
  about: string;
  checked: string;
  hosts: HostEntry[];
}

export function loadHosts(): HostsFile {
  return JSON.parse(readFileSync(join(DOCS, "data", "hosts.json"), "utf8")) as HostsFile;
}

/** `trustedProxies: 2, // 3 with ...` becomes the code and the comment. */
function splitLine(line: string): { code: string; comment: string | null } {
  const match = /^(.*?),?\s*(?:\/\/\s*(.*))?$/.exec(line.trim());
  return { code: (match?.[1] ?? "").replace(/,$/, ""), comment: match?.[2] ?? null };
}

/** The compact table on the quickstart: the hosts it offers, and their option lines. */
export function quickTable(data: HostsFile): string {
  const rows = data.hosts
    .filter((host) => host.quickstart)
    .map((host) => {
      const options = host.lines.filter((line) => !line.trim().startsWith("//")).map(splitLine);
      const setting = options.length
        ? options
            .map(({ code, comment }) => `\`${code}\`${comment ? ` (${comment})` : ""}`)
            .join(" and ")
        : "`clientIpHeader` or `trustedProxies`";
      return `| [${host.tab}](${host.section}) | ${setting} | ${host.extra ?? ""} |`;
    });
  return [
    "The setting for your host, from [Hosts and proxies](hosts.md#settings-by-host):",
    "",
    "| Host | Setting | Also |",
    "|---|---|---|",
    ...rows,
  ].join("\n");
}

/** The full table on docs/hosts.md, "Settings by host". */
export function hostsTable(data: HostsFile): string {
  const rows = data.hosts
    .filter((host) => host.table)
    .map(
      (host) =>
        `| ${host.name} | ${host.clientAddress} | ${host.publicHost} | ${host.confidence} |`,
    );
  return [
    "| Host | Client address | `publicHost` | Confidence |",
    "|---|---|---|---|",
    ...rows,
  ].join("\n");
}

/** Replaces what lies between `<!-- posterna:NAME -->` and `<!-- posterna:end NAME -->`. */
export function replaceRegion(text: string, name: string, content: string): string {
  const start = `<!-- posterna:${name} -->`;
  const end = `<!-- posterna:end ${name} -->`;
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (from === -1 || to === -1 || to < from) {
    throw new Error(`Missing the ${start} ... ${end} region.`);
  }
  return `${text.slice(0, from + start.length)}\n${content}\n${text.slice(to)}`;
}

/** Each generated file with its table brought up to date. */
export function generated(): { path: string; text: string }[] {
  const data = loadHosts();
  const install = join(DOCS, "install.md");
  const hosts = join(DOCS, "hosts.md");
  return [
    {
      path: install,
      text: replaceRegion(readFileSync(install, "utf8"), "hosts-quick", quickTable(data)),
    },
    {
      path: hosts,
      text: replaceRegion(readFileSync(hosts, "utf8"), "hosts-table", hostsTable(data)),
    },
  ];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const { path, text } of generated()) {
    writeFileSync(path, text);
    console.log(`Wrote the host table in ${path.slice(ROOT.length + 1)}.`);
  }
}
