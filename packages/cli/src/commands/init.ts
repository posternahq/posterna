import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEMPLATE_NAMES, type TemplateName } from "@posterna/core";
import { type Io, readTemplate } from "../io";

export interface InitFlags {
  template?: string;
  force?: boolean;
}

export type Framework =
  | { kind: "express" }
  | {
      kind: "next";
      /** The Next.js major version from package.json. The adapter supports 15 and 16. */
      major: number;
      nodeMiddleware: boolean;
      srcDir: boolean;
      existing: string | null;
    }
  | { kind: "unknown" };

const TEMPLATE_HINTS: Record<TemplateName, string> = {
  monitor: "label and count everything, block nothing",
  "allow-list": "block training crawlers, allow everything else",
  "saas-signup": "allow-list, plus recommendations for your sign-up page",
};

/** The install guide as posterna.com serves it (the GitHub copy is not public yet). */
export const INSTALL_GUIDE = "https://posterna.com/docs/install";
const MATCHER = '"/((?!_next/static|_next/image|favicon.ico).*)"';

/** A host recognized from its config file, with the client-address setting docs/install.md gives for it. */
export interface Host {
  name: string;
  file: string;
  /** The option line to paste, without a trailing comma. */
  option: string;
  note?: string;
}

const HOSTS: { files: string[]; host: Omit<Host, "file"> }[] = [
  {
    files: ["railway.json", "railway.toml", ".railway"],
    host: { name: "Railway", option: 'clientIpHeader: "x-real-ip"' },
  },
  {
    files: ["vercel.json", ".vercel"],
    host: { name: "Vercel", option: 'clientIpHeader: "x-vercel-forwarded-for"' },
  },
  {
    files: ["fly.toml"],
    host: { name: "Fly.io", option: "trustedProxies: 2", note: "3 with Cloudflare in front" },
  },
  {
    files: ["render.yaml"],
    host: {
      name: "Render",
      option: "trustedProxies: 3",
      note: "check with posterna doctor; use 2 if it reports a forged address",
    },
  },
];

/** The host, from a config file in the project folder. Null when none is found. */
export function detectHost(cwd: string): Host | null {
  for (const { files, host } of HOSTS) {
    const file = files.find((name) => existsSync(join(cwd, name)));
    if (file) return { ...host, file };
  }
  return null;
}

/** The client-address lines of the options object, at the given indent. */
function addressLines(host: Host | null, indent: string): string[] {
  if (!host) {
    return [
      `${indent}// Set clientIpHeader or trustedProxies for your host:`,
      `${indent}// ${INSTALL_GUIDE}#trusted-proxies`,
    ];
  }
  return [
    `${indent}// ${host.name}, found from ${host.file}${host.note ? ` (${host.note})` : ""}:`,
    `${indent}${host.option},`,
  ];
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** `^15.5.2` is 15.5; `latest` or anything unreadable is treated as the newest. */
function versionOf(range: string): [number, number] {
  const match = /(\d+)(?:\.(\d+))?/.exec(range);
  return match ? [Number(match[1]), Number(match[2] ?? 0)] : [99, 0];
}

/** Works out the framework from package.json. Next.js wins when both are present. */
export function detectFramework(cwd: string): Framework {
  const pkg = readJson(join(cwd, "package.json"));
  const deps = {
    ...((pkg?.dependencies as Record<string, string> | undefined) ?? {}),
    ...((pkg?.devDependencies as Record<string, string> | undefined) ?? {}),
  };
  if (deps.next) {
    const [major, minor] = versionOf(deps.next);
    const srcDir = existsSync(join(cwd, "src", "app")) || existsSync(join(cwd, "src", "pages"));
    const base = srcDir ? join(cwd, "src") : cwd;
    const existing =
      ["proxy.ts", "proxy.js", "middleware.ts", "middleware.js"].find((file) =>
        existsSync(join(base, file)),
      ) ?? null;
    return {
      kind: "next",
      major,
      nodeMiddleware: major >= 16 || (major === 15 && minor >= 5),
      srcDir,
      existing,
    };
  }
  if (deps.express) return { kind: "express" };
  return { kind: "unknown" };
}

function packageManager(cwd: string): string {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm add";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn add";
  if (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb"))) return "bun add";
  return "npm install";
}

/** The code to add, printed for the person to paste. `posterna init` never edits code. */
export function codeToAdd(framework: Framework, cwd: string): string[] {
  const install = packageManager(cwd);
  const host = detectHost(cwd);
  if (framework.kind === "express") {
    return [
      `1. Install the middleware:`,
      "",
      `   ${install} @posterna/express`,
      "",
      "2. Add it before your routes:",
      "",
      '   import { posterna } from "@posterna/express";',
      "",
      "   app.use(",
      "     posterna({",
      ...addressLines(host, "       "),
      '       // publicHost: "www.example.com",',
      "     }),",
      "   );",
    ];
  }
  if (framework.kind === "next" && framework.major < 15) {
    return [
      `Posterna supports Next.js 15 and 16, and this project uses Next.js ${framework.major}.`,
      "Upgrade Next.js first, then run posterna init again.",
    ];
  }
  if (framework.kind === "next") {
    const dir = framework.srcDir ? "src/" : "";
    const file = framework.major >= 16 ? "proxy.ts" : "middleware.ts";
    const exportName = framework.major >= 16 ? "proxy" : "middleware";
    const lines = [`1. Install the integration:`, "", `   ${install} @posterna/next`, ""];
    if (framework.existing) {
      lines.push(
        `2. You already have ${dir}${framework.existing}. Wrap your function instead of replacing it:`,
        "",
        '   import { withPosterna } from "@posterna/next";',
        "",
        `   export const ${exportName} = withPosterna({ /* options as in ${INSTALL_GUIDE} */ }, your${exportName === "proxy" ? "Proxy" : "Middleware"});`,
        "",
        "   Keep your own `config` export, and make sure its matcher includes the pages you want labeled.",
      );
    } else {
      lines.push(
        `2. Create ${dir}${file}:`,
        "",
        '   import { withPosterna } from "@posterna/next";',
        "",
        `   export const ${exportName} = withPosterna({`,
        ...addressLines(host, "     "),
        '     // publicHost: "www.example.com",',
        "   });",
        "",
        "   export const config = {",
        ...(framework.major === 15 && framework.nodeMiddleware ? ['     runtime: "nodejs",'] : []),
        `     matcher: [${MATCHER}],`,
        "   };",
      );
    }
    if (framework.major === 15 && !framework.nodeMiddleware) {
      lines.push(
        "",
        "   Next.js before 15.5 runs middleware on the Edge runtime, which cannot read agents.yaml",
        "   or do reverse DNS. Upgrade to 15.5 or later, or pass the policy text as `policy`.",
      );
    }
    return lines;
  }
  return [
    "No Express or Next.js dependency was found in package.json. In any Node.js server:",
    "",
    `   ${install} @posterna/core`,
    "",
    '   import { createPolicyEngine, createVerifier, enforcementResponse } from "@posterna/core";',
    "",
    `   See ${INSTALL_GUIDE}`,
  ];
}

/** True when .gitignore has a line that covers the env file. */
function ignored(cwd: string, file: string): boolean {
  try {
    const lines = readFileSync(join(cwd, ".gitignore"), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim());
    return lines.some(
      (line) =>
        line === file ||
        line === `/${file}` ||
        line === ".env*" ||
        (line === ".env*.local" && file.endsWith(".local")),
    );
  } catch {
    return false;
  }
}

const SITE_KEY_REMINDER =
  "To send counters, set POSTERNA_SITE_KEY on the server to the site key from https://posterna.com/dashboard (optional; without one nothing is sent).";

async function siteKeyStep(io: Io, framework: Framework): Promise<void> {
  const prompts = io.prompts;
  if (!prompts) {
    io.out(SITE_KEY_REMINDER);
    return;
  }
  const wants = await prompts.confirm(
    "Add a site key from the Posterna dashboard now? (optional; without one nothing is sent)",
    false,
  );
  if (!wants) {
    io.out(SITE_KEY_REMINDER);
    return;
  }
  const key = (await prompts.password("Site key"))?.trim();
  if (!key) return;
  if (!/^psk_[A-Za-z0-9_-]{20,}$/.test(key)) {
    io.err("That does not look like a site key (they start with psk_). Nothing was written.");
    return;
  }
  const file = framework.kind === "next" ? ".env.local" : ".env";
  const path = join(io.cwd, file);
  const confirmed = await prompts.confirm(`Write POSTERNA_SITE_KEY to ${file}?`, true);
  if (!confirmed) {
    io.out(`Not written. Set POSTERNA_SITE_KEY in your environment yourself.`);
    return;
  }
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const line = `POSTERNA_SITE_KEY=${key}`;
  const next = /^POSTERNA_SITE_KEY=.*$/m.test(current)
    ? current.replace(/^POSTERNA_SITE_KEY=.*$/m, line)
    : `${current}${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`;
  writeFileSync(path, next, { mode: 0o600 });
  io.out(`Wrote POSTERNA_SITE_KEY to ${file}.`);
  if (!ignored(io.cwd, file))
    io.err(`Warning: ${file} is not in .gitignore. Add it, so the key is never committed.`);
}

/** `posterna init` (docs/SPEC.md section 8). */
export async function init(io: Io, flags: InitFlags): Promise<number> {
  const framework = detectFramework(io.cwd);
  const names = TEMPLATE_NAMES as readonly string[];
  if (flags.template !== undefined && !names.includes(flags.template)) {
    io.err(`Unknown template "${flags.template}". Choose one of: ${names.join(", ")}.`);
    return 1;
  }
  let template = (flags.template ?? "monitor") as TemplateName;
  if (flags.template === undefined && io.prompts) {
    const picked = await io.prompts.select(
      "Which policy should agents.yaml start from? Every template starts in monitor mode.",
      TEMPLATE_NAMES.map((name) => ({ value: name, label: name, hint: TEMPLATE_HINTS[name] })),
      "monitor",
    );
    if (picked === null) {
      io.err("Cancelled. Nothing was written.");
      return 1;
    }
    template = picked;
  }

  const target = join(io.cwd, "agents.yaml");
  if (existsSync(target) && !flags.force) {
    const replace = io.prompts
      ? await io.prompts.confirm("agents.yaml already exists. Replace it?", false)
      : false;
    if (!replace) {
      io.err("agents.yaml already exists; it was left as it is. Use --force to replace it.");
      return 1;
    }
  }
  writeFileSync(target, readTemplate(template));
  io.out(`Wrote agents.yaml from the ${template} template (monitor mode: nothing is blocked).`);
  io.out("");
  const label =
    framework.kind === "next"
      ? `Next.js ${framework.major}`
      : framework.kind === "express"
        ? "Express"
        : "no supported framework";
  io.out(`Detected ${label}. Add this to your app (posterna init does not edit your code):`);
  io.out("");
  for (const line of codeToAdd(framework, io.cwd)) io.out(line);
  io.out("");
  await siteKeyStep(io, framework);
  io.out(
    "Then set POSTERNA_DEBUG_TOKEN on the server to a random value, deploy, and run `npx posterna doctor --url https://your-site` with the same token to check the setup.",
  );
  return 0;
}
