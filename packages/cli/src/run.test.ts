import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DirectoryFile, KeysFile } from "@posterna/core";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { type PosternaOptions, posterna } from "../../express/src/index";
import pkg from "../package.json";
import { FORGED_CLIENT, FORGED_HOST } from "./commands/doctor";
import { VERSION } from "./index";
import type { Io, Prompter } from "./io";
import { run } from "./run";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const NOW = Date.parse("2026-10-27T12:00:00Z");

function project(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "posterna-cli-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

function scripted(answers: unknown[]): Prompter & { asked: string[] } {
  const asked: string[] = [];
  const next = (message: string) => {
    asked.push(message);
    return Promise.resolve(answers.shift() as never);
  };
  return { asked, select: next, confirm: next, password: next };
}

async function cli(args: string[], options: Partial<Io> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(args, {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    cwd: project(),
    env: {},
    fetch: globalThis.fetch,
    now: () => NOW,
    prompts: null,
    ...options,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("posterna CLI", () => {
  it("exports the version from package.json", async () => {
    expect(VERSION).toBe(pkg.version);
    expect((await cli(["--version"])).out).toBe(VERSION);
  });

  it.each([[[]], [["--help"]], [["-h"]], [["help"]]])("prints help for %j", async (args) => {
    const result = await cli(args);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Usage: posterna <command>");
    for (const command of ["init", "doctor --url", "robots", "policy check"]) {
      expect(result.out).toMatch(new RegExp(`^  ${command}`, "m"));
    }
    expect(result.out).not.toContain("coming soon");
  });

  it("rejects unknown commands and options", async () => {
    expect(await cli(["deploy"])).toMatchObject({
      code: 1,
      err: expect.stringContaining("Unknown command: deploy"),
    });
    expect(await cli(["init", "--template"])).toMatchObject({
      code: 1,
      err: "--template needs a value.",
    });
    expect(await cli(["init", "-x"])).toMatchObject({ code: 1, err: "Unknown option -x." });
  });
});

describe("posterna init", () => {
  it("writes the monitor template and prints the Express code, without editing code", async () => {
    const cwd = project({
      "package.json": JSON.stringify({ dependencies: { express: "^5.1.0" } }),
      "pnpm-lock.yaml": "",
    });
    const result = await cli(["init"], { cwd });
    expect(result.code).toBe(0);
    expect(readFileSync(join(cwd, "agents.yaml"), "utf8")).toBe(
      readFileSync(join(REPO, "packages", "core", "templates", "monitor.yaml"), "utf8"),
    );
    expect(result.out).toContain("Detected Express");
    expect(result.out).toContain("pnpm add @posterna/express");
    expect(result.out).toContain("app.use(");
    expect(result.out).toContain("posterna doctor --url");
  });

  it("asks for a template on a terminal and writes a site key only after confirmation", async () => {
    const cwd = project({
      "package.json": JSON.stringify({ dependencies: { next: "16.4.3" } }),
      "src/app/page.tsx": "",
      ".gitignore": "node_modules\n",
    });
    const key = "psk_abcdefghijklmnopqrstuvwxyz0123456789";
    const prompts = scripted(["saas-signup", true, key, true]);
    const result = await cli(["init"], { cwd, prompts });
    expect(result.code).toBe(0);
    expect(prompts.asked[0]).toContain("Which policy");
    expect(readFileSync(join(cwd, "agents.yaml"), "utf8")).toContain('"/signup"');
    expect(result.out).toContain("Detected Next.js 16");
    expect(result.out).toContain("Create src/proxy.ts");
    expect(result.out).toContain("export const proxy = withPosterna({");
    expect(result.out).not.toContain('runtime: "nodejs"');
    expect(readFileSync(join(cwd, ".env.local"), "utf8")).toBe(`POSTERNA_SITE_KEY=${key}\n`);
    expect(statSync(join(cwd, ".env.local")).mode & 0o777).toBe(0o600);
    expect(result.out).not.toContain(key);
    expect(result.err).toContain(".env.local is not in .gitignore");
  });

  it("does not write the key when the person declines", async () => {
    const cwd = project({
      "package.json": JSON.stringify({ dependencies: { express: "5.1.0" } }),
      ".env": "PORT=3000",
    });
    const result = await cli(["init"], {
      cwd,
      prompts: scripted(["monitor", true, "psk_abcdefghijklmnopqrstuvwxyz0123", false]),
    });
    expect(result.code).toBe(0);
    expect(readFileSync(join(cwd, ".env"), "utf8")).toBe("PORT=3000");
  });

  it("covers Next.js 15 on the Node.js runtime, before 15.5, and with an existing middleware", async () => {
    const node = await cli(["init"], {
      cwd: project({ "package.json": JSON.stringify({ dependencies: { next: "^15.5.0" } }) }),
    });
    expect(node.out).toContain("Create middleware.ts");
    expect(node.out).toContain('runtime: "nodejs"');

    const edge = await cli(["init"], {
      cwd: project({ "package.json": JSON.stringify({ dependencies: { next: "15.3.2" } }) }),
    });
    expect(edge.out).toContain("Next.js before 15.5 runs middleware on the Edge runtime");

    const existing = await cli(["init"], {
      cwd: project({
        "package.json": JSON.stringify({ dependencies: { next: "15.5.28" } }),
        "middleware.ts": "export function middleware() {}",
      }),
    });
    expect(existing.out).toContain(
      "You already have middleware.ts. Wrap your function instead of replacing it",
    );
    expect(existing.out).toContain(
      "export const middleware = withPosterna({ /* options as below */ }, yourMiddleware);",
    );
  });

  it("keeps an existing agents.yaml unless told to replace it", async () => {
    const cwd = project({ "package.json": "{}", "agents.yaml": "version: 1\n# mine\n" });
    const kept = await cli(["init", "--template", "allow-list"], { cwd });
    expect(kept.code).toBe(1);
    expect(readFileSync(join(cwd, "agents.yaml"), "utf8")).toContain("# mine");
    const replaced = await cli(["init", "--template", "allow-list", "--force"], { cwd });
    expect(replaced.code).toBe(0);
    expect(readFileSync(join(cwd, "agents.yaml"), "utf8")).toContain("training: block");
    expect(replaced.out).toContain("No Express or Next.js dependency");
    expect((await cli(["init", "--template", "strict"], { cwd })).err).toContain(
      'Unknown template "strict"',
    );
  });
});

describe("posterna policy check and robots", () => {
  it("reports errors with file, line and column, and exits 1", async () => {
    const cwd = project({
      "agents.yaml": "version: 1\nmode: enforced\npurposes:\n  trainng: block\n",
    });
    const result = await cli(["policy", "check"], { cwd });
    expect(result.code).toBe(1);
    expect(result.err.split("\n")).toEqual([
      'agents.yaml:2:7 error: mode must be monitor or enforce (got "enforced"). Did you mean "enforce"?',
      'agents.yaml:4:3 error: Unknown key "trainng" in purposes. Did you mean "training"?',
      "2 errors in agents.yaml.",
    ]);
  });

  it("accepts a valid file, warning about operators the directory does not list", async () => {
    const cwd = project({
      "policy/agents.yaml":
        "version: 1\noperators:\n  openai:\n    agent: block\n  open-ai:\n    agent: block\n",
    });
    const result = await cli(["policy", "check", "--policy", "policy/agents.yaml"], { cwd });
    expect(result.code).toBe(0);
    expect(result.out).toBe("policy/agents.yaml is valid: mode monitor, 1 warning.");
    expect(result.err).toContain(
      'policy/agents.yaml:5:3 warning: Operator "open-ai" is not in the operator directory',
    );
  });

  it("prints robots.txt from the bundled directory", async () => {
    const cwd = project({
      "agents.yaml": readFileSync(
        join(REPO, "packages", "core", "templates", "allow-list.yaml"),
        "utf8",
      ),
    });
    const result = await cli(["robots"], { cwd });
    expect(result.code).toBe(0);
    expect(result.out).toMatch(
      /^# robots\.txt written by Posterna from agents\.yaml \(policy sha256-[0-9a-f]{16}\)\./,
    );
    expect(result.out).toContain("User-agent: *\nContent-Signal: ai-train=no\nAllow: /");
    expect(result.out).toContain("# Training\nUser-agent: ");
    expect((await cli(["robots"], { cwd: project() })).code).toBe(1);
  });
});

describe("posterna doctor", () => {
  let servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    servers = [];
  });

  const listen = (server: Server) =>
    new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () =>
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
      );
      servers.push(server);
    });

  async function site(options: PosternaOptions) {
    const mw = posterna({
      directory: {
        snapshot: () => ({
          directory: JSON.parse(
            readFileSync(join(REPO, "conformance", "fixtures", "directory.json"), "utf8"),
          ) as DirectoryFile,
          keys: JSON.parse(
            readFileSync(join(REPO, "conformance", "fixtures", "keys.json"), "utf8"),
          ) as KeysFile,
        }),
        refresh: false,
      },
      dns: null,
      counters: false,
      env: {},
      policy: "version: 1\nmode: enforce\n",
      debugToken: "doctor-token",
      onError: () => {},
      ...options,
    });
    const app = express();
    app.use(mw);
    app.get(/.*/, (_req, res) => {
      res.send("the app");
    });
    const url = await listen(createServer(app));
    return { url, close: () => mw.close() };
  }

  async function cloud(ip: string | null) {
    return `${await listen(
      createServer((req, res) => {
        if (req.url === "/v1/whoami" && ip) {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ip }));
        } else {
          res.statusCode = 404;
          res.end();
        }
      }),
    )}/v1`;
  }

  it("passes every check on a correct setup", async () => {
    const app = await site({});
    const result = await cli(["doctor", "--url", app.url, "--base-url", await cloud("127.0.0.1")], {
      env: { POSTERNA_DEBUG_TOKEN: "doctor-token" },
    });
    app.close();
    expect(result.out).toContain("PASS  Debug route: @posterna/express");
    expect(result.out).toContain("PASS  Client IP: the site sees 127.0.0.1");
    expect(result.out).toContain(
      `PASS  Signed host: signatures are checked against ${new URL(app.url).host}.`,
    );
    expect(result.out).toContain("PASS  Signature headers");
    expect(result.out).toContain("PASS  Directory: version 2026-10-26");
    expect(result.out).toContain("PASS  Mode: enforce (agents.yaml says enforce).");
    expect(result.out).toContain("Everything Posterna needs is in place.");
    expect(result.code).toBe(0);
  });

  it("catches forged forwarding headers being trusted", async () => {
    const app = await site({ trustedProxies: ["127.0.0.0/8"] });
    const result = await cli(["doctor", "--url", app.url, "--base-url", await cloud("127.0.0.1")], {
      env: { POSTERNA_DEBUG_TOKEN: "doctor-token" },
    });
    app.close();
    expect(result.code).toBe(1);
    expect(result.out).toContain(
      `FAIL  Client IP: the app believed an X-Forwarded-For entry that doctor forged (${FORGED_CLIENT})`,
    );
    expect(result.out).toContain(
      `FAIL  Signed host: the app took the signed host from an X-Forwarded-Host that doctor forged (${FORGED_HOST})`,
    );
    expect(result.out).toContain(`Fix: Set publicHost: "${new URL(app.url).host}"`);
    expect(result.out).toContain("2 checks failed.");
  });

  it("reports a wrong client address with the fix", async () => {
    const app = await site({ env: { POSTERNA_MODE: "monitor" } });
    const result = await cli(["doctor", app.url, "--base-url", await cloud("198.51.100.7")], {
      env: { POSTERNA_DEBUG_TOKEN: "doctor-token" },
    });
    app.close();
    expect(result.out).toContain(
      "FAIL  Client IP: the site sees 127.0.0.1 (from socket), but this machine is 198.51.100.7.",
    );
    expect(result.out).toContain(
      "The app sees its proxy's address. Set trustedProxies for your host.",
    );
    expect(result.out).toContain(
      "WARN  Mode: monitor (agents.yaml says enforce); POSTERNA_MODE=monitor is set.",
    );
    expect(result.code).toBe(1);
  });

  it("explains a missing token or an unreachable debug route", async () => {
    const noToken = await cli(["doctor", "--url", "https://www.site.example"]);
    expect(noToken.code).toBe(1);
    expect(noToken.err).toContain("Set POSTERNA_DEBUG_TOKEN here");

    const app = await site({ debugToken: null });
    const result = await cli(["doctor", "--url", app.url, "--base-url", await cloud(null)], {
      env: { POSTERNA_DEBUG_TOKEN: "doctor-token" },
    });
    app.close();
    expect(result.code).toBe(1);
    expect(result.out).toContain("FAIL  Debug route:");
    expect(result.out).toContain("Fix: Set POSTERNA_DEBUG_TOKEN on the server");

    expect(
      (await cli(["doctor", "--url", "ftp://x"], { env: { POSTERNA_DEBUG_TOKEN: "t" } })).err,
    ).toContain("is not an http or https URL");
  });
});
