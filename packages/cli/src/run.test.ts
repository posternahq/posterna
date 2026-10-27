import type { LookupAddress } from "node:dns";
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
import { familyFetch, familyLookup, type Resolve } from "./family-fetch";
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
    // Every usage is followed by at least two spaces before its summary.
    expect(result.out).toMatch(/^ {2}init \[--template <name>\] \[--force\] \[--yes\] {2,}Set up/m);
    expect(result.out).toMatch(/^ {2}--base-url <url> {2,}Posterna cloud/m);
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
    expect(result.out).toContain(
      "3. Wrap the export in next.config.ts, so agents.yaml is built into the proxy",
    );
    expect(result.out).toContain('import { withPosternaConfig } from "@posterna/next/config";');
    expect(result.out).toContain("export default withPosternaConfig(nextConfig);");
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
      "export const middleware = withPosterna({ /* options as in https://posterna.com/docs/install */ }, yourMiddleware);",
    );

    // A CommonJS next.config gets the require form.
    const commonJs = await cli(["init"], {
      cwd: project({
        "package.json": JSON.stringify({ dependencies: { next: "15.5.28" } }),
        "next.config.js": "module.exports = {};",
      }),
    });
    expect(commonJs.out).toContain(
      "3. Wrap the export in next.config.js, so agents.yaml is built into the middleware",
    );
    expect(commonJs.out).toContain(
      'const { withPosternaConfig } = require("@posterna/next/config");',
    );
    expect(commonJs.out).toContain("module.exports = withPosternaConfig(nextConfig);");
    const esm = await cli(["init"], {
      cwd: project({
        "package.json": JSON.stringify({ type: "module", dependencies: { next: "16.4.3" } }),
        "next.config.js": "export default {};",
      }),
    });
    expect(esm.out).toContain("3. Wrap the export in next.config.js");
    expect(esm.out).toContain("export default withPosternaConfig(nextConfig);");

    const old = await cli(["init"], {
      cwd: project({ "package.json": JSON.stringify({ dependencies: { next: "14.2.18" } }) }),
    });
    expect(old.out).toContain("Detected Next.js 14.");
    expect(old.out).toContain(
      "Posterna supports Next.js 15 and 16, and this project uses Next.js 14.",
    );
    expect(old.out).not.toContain("withPosterna");
  });

  it("suggests the client-address setting for a host it recognizes, and the guide otherwise", async () => {
    const next = JSON.stringify({ dependencies: { next: "16.4.3" } });
    const railway = await cli(["init"], {
      cwd: project({ "package.json": next, "railway.json": "{}" }),
    });
    expect(railway.out).toContain("// Railway, found from railway.json:");
    expect(railway.out).toContain('     clientIpHeader: "x-real-ip",');

    const fly = await cli(["init"], {
      cwd: project({
        "package.json": JSON.stringify({ dependencies: { express: "5.1.0" } }),
        "fly.toml": "",
      }),
    });
    expect(fly.out).toContain("// Fly.io, found from fly.toml (3 with Cloudflare in front):");
    expect(fly.out).toContain("       trustedProxies: 2,");

    const unknown = await cli(["init"], { cwd: project({ "package.json": next }) });
    expect(unknown.out).toContain("// Set clientIpHeader or trustedProxies for your host:");
    expect(unknown.out).toContain("// https://posterna.com/docs/install#trusted-proxies");
    for (const result of [railway, fly, unknown]) {
      expect(result.out).not.toContain("trustedProxies: 1");
      expect(result.out).not.toContain("github.com");
      expect(result.out).not.toContain("not on npm");
    }
  });

  it("reminds about POSTERNA_SITE_KEY and POSTERNA_DEBUG_TOKEN when it cannot ask", async () => {
    const result = await cli(["init", "--yes"], {
      cwd: project({ "package.json": JSON.stringify({ dependencies: { express: "5.1.0" } }) }),
      prompts: scripted([]),
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain("To send counters, set POSTERNA_SITE_KEY on the server");
    expect(result.out).toContain("set POSTERNA_DEBUG_TOKEN on the server");
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

  async function site(options: PosternaOptions, before?: express.RequestHandler) {
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
    if (before) app.use(before);
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
    expect(result.out).toMatch(
      /PASS {2}Policy: the policy in the adapter options is in use( \(sha256-[0-9a-f]{16}\))?\./,
    );
    expect(result.out).toContain("Everything Posterna needs is in place.");
    expect(result.code).toBe(0);
  });

  it("checks IPv4 and IPv6 separately, and skips a family this machine cannot use", async () => {
    const app = await site({});
    const noRoute = (async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ENETUNREACH"), { code: "ENETUNREACH" }),
      });
    }) as unknown as typeof fetch;
    // A hostname, not an address, so that both families are tried.
    const url = app.url.replace("127.0.0.1", "localhost");
    const result = await cli(["doctor", "--url", url, "--base-url", await cloud("127.0.0.1")], {
      env: { POSTERNA_DEBUG_TOKEN: "doctor-token" },
      fetchOver: (family) => (family === 4 ? globalThis.fetch : noRoute),
    });
    app.close();
    expect(result.out).toContain("PASS  Client IP (IPv4): the site sees 127.0.0.1");
    expect(result.out).toContain(
      "SKIP  Client IP (IPv6): not checked: this machine has no IPv6 route.",
    );
    expect(result.out).not.toMatch(/^PASS {2}Client IP:/m);
    expect(result.code).toBe(0);
  });

  it("skips IPv6 for a site with no IPv6 address, even when the lookup returns IPv4-mapped ones", async () => {
    const app = await site({});
    // What macOS answers for a host with only an A record: a connection to
    // ::ffff:127.0.0.1 would reach the IPv4 server.
    const macosLookup: Resolve = async (_hostname, family) =>
      family === 4
        ? [{ address: "127.0.0.1", family: 4 }]
        : [{ address: "::ffff:127.0.0.1", family: 6 }];
    const url = app.url.replace("127.0.0.1", "localhost");
    const result = await cli(["doctor", "--url", url, "--base-url", await cloud("127.0.0.1")], {
      env: { POSTERNA_DEBUG_TOKEN: "doctor-token" },
      fetchOver: (family) => familyFetch(family, macosLookup),
    });
    app.close();
    expect(result.out).toContain("PASS  Client IP (IPv4): the site sees 127.0.0.1");
    expect(result.out).toContain(
      "SKIP  Client IP (IPv6): not checked: the site has no IPv6 address.",
    );
    expect(result.code).toBe(0);
  });

  it("fails a family that reaches a different server, as stale DNS records would", async () => {
    const app = await site({});
    const elsewhere = (async () =>
      new Response("<html>Coming soon</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    const url = app.url.replace("127.0.0.1", "localhost");
    const result = await cli(["doctor", "--url", url, "--base-url", await cloud("127.0.0.1")], {
      env: { POSTERNA_DEBUG_TOKEN: "doctor-token" },
      fetchOver: (family) => (family === 4 ? elsewhere : globalThis.fetch),
    });
    app.close();
    expect(result.out).toContain(
      "FAIL  Client IP (IPv4): over IPv4, " +
        `${url}/.well-known/posterna/debug answered 200 without a Posterna report, so IPv4 visitors reach a different server.`,
    );
    expect(result.out).toContain("Fix: Check the site's A DNS records");
    expect(result.out).toContain("PASS  Client IP (IPv6): the site sees 127.0.0.1");
    expect(result.code).toBe(1);
  });

  it("names the whoami step when posterna.com cannot be reached", async () => {
    const app = await site({});
    const cloudUrl = await cloud(null);
    const result = await cli(["doctor", "--url", app.url, "--base-url", cloudUrl], {
      env: { POSTERNA_DEBUG_TOKEN: "doctor-token" },
    });
    app.close();
    expect(result.out).toContain(
      `this machine's public address could not be learned: ${cloudUrl}/whoami answered 404 without an address, so the request did not reach Posterna.`,
    );
    expect(result.out).toContain("run doctor from another network, or pass --base-url.");
  });

  it("fails the policy check when agents.yaml was not loaded", async () => {
    const app = await site({ policy: undefined, policyPath: "/nonexistent/agents.yaml" });
    const result = await cli(["doctor", "--url", app.url, "--base-url", await cloud("127.0.0.1")], {
      env: { POSTERNA_DEBUG_TOKEN: "doctor-token" },
    });
    app.close();
    expect(result.out).toContain(
      "FAIL  Policy: your policy was not loaded, so a built-in monitor policy without your rules is in use. The server said: No policy file at /nonexistent/agents.yaml.",
    );
    expect(result.out).toContain("Fix: Put agents.yaml in the folder the server starts in");
    expect(result.code).toBe(1);
  });

  it("points a Next.js site without its policy at withPosternaConfig", async () => {
    // The same report, as the Next.js adapter on Vercel sends it.
    const app = await site({ policy: undefined, policyPath: "/var/task/agents.yaml" });
    const report = (await (
      await fetch(`${app.url}/.well-known/posterna/debug`, {
        headers: { "x-posterna-debug-token": "doctor-token" },
      })
    ).json()) as { posterna: { adapter: string } };
    app.close();
    report.posterna.adapter = "@posterna/next";
    const url = await listen(
      createServer((_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(report));
      }),
    );
    const result = await cli(["doctor", "--url", url, "--base-url", await cloud("127.0.0.1")], {
      env: { POSTERNA_DEBUG_TOKEN: "doctor-token" },
    });
    expect(result.out).toContain("FAIL  Policy: your policy was not loaded");
    expect(result.out).toContain(
      "Fix: With the latest @posterna/next, wrap next.config in withPosternaConfig from @posterna/next/config",
    );
    expect(result.code).toBe(1);
  });

  it("catches forged forwarding headers being trusted", async () => {
    const app = await site({ trustedProxies: ["127.0.0.0/8"], trustForwardedHost: true });
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
    expect(result.out).toContain(
      `Fix: Your proxy passes a client's X-Forwarded-Host through. Remove trustForwardedHost and set publicHost: "${new URL(app.url).host}"`,
    );
    expect(result.out).toContain("2 checks failed.");
  });

  it("ignores a forged X-Forwarded-Host unless the site opts in", async () => {
    const app = await site({ trustedProxies: ["127.0.0.0/8"] });
    const result = await cli(["doctor", "--url", app.url, "--base-url", await cloud("127.0.0.1")], {
      env: { POSTERNA_DEBUG_TOKEN: "doctor-token" },
    });
    app.close();
    expect(result.out).toContain(
      `PASS  Signed host: signatures are checked against ${new URL(app.url).host}.`,
    );
    expect(result.out).toContain("1 check failed.");
  });

  it("passes a clientIpHeader the host overwrites, and fails one it does not", async () => {
    // A stand-in for a host that overwrites X-Real-IP with the address it sees.
    // A real host rewrites the header before Node parses the request, so rewrite the raw list too.
    const overwriting: express.RequestHandler = (req, _res, next) => {
      const address = req.socket.remoteAddress ?? "";
      const raw: string[] = [];
      for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
        if ((req.rawHeaders[i] as string).toLowerCase() !== "x-real-ip") {
          raw.push(req.rawHeaders[i] as string, req.rawHeaders[i + 1] as string);
        }
      }
      req.rawHeaders.splice(0, req.rawHeaders.length, ...raw, "X-Real-IP", address);
      req.headers["x-real-ip"] = address;
      next();
    };
    const good = await site({ clientIpHeader: "x-real-ip" }, overwriting);
    const passed = await cli(
      ["doctor", "--url", good.url, "--base-url", await cloud("127.0.0.1")],
      {
        env: { POSTERNA_DEBUG_TOKEN: "doctor-token" },
      },
    );
    good.close();
    expect(passed.out).toContain("PASS  Client IP: the site sees 127.0.0.1");
    expect(passed.code).toBe(0);

    const bad = await site({ clientIpHeader: "x-real-ip" });
    const failed = await cli(["doctor", "--url", bad.url, "--base-url", await cloud("127.0.0.1")], {
      env: { POSTERNA_DEBUG_TOKEN: "doctor-token" },
    });
    bad.close();
    expect(failed.out).toContain(
      `FAIL  Client IP: the app believed a x-real-ip header that doctor forged (${FORGED_CLIENT}): your host does not overwrite it`,
    );
    expect(failed.out).toContain(
      "Fix: Remove clientIpHeader and set trustedProxies for your host.",
    );
    expect(failed.code).toBe(1);
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
      "The app sees its proxy's address. Set clientIpHeader or trustedProxies for your host.",
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

describe("familyFetch", () => {
  it("connects over the family asked for only", async () => {
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ path: req.url, token: req.headers["x-test"] ?? null }));
    });
    const port = await new Promise<number>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
    );
    try {
      const response = await familyFetch(4)(`http://localhost:${port}/hello`, {
        headers: { "x-test": "yes" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(await response.json()).toEqual({ path: "/hello", token: "yes" });
      // Nothing listens on IPv6, so the same URL over IPv6 cannot reach this server.
      await expect(familyFetch(6)(`http://localhost:${port}/hello`)).rejects.toThrow();
      // Nor through an IPv4-mapped address, which would connect over IPv4.
      const mapped: Resolve = async () => [{ address: "::ffff:127.0.0.1", family: 6 }];
      await expect(familyFetch(6, mapped)(`http://localhost:${port}/hello`)).rejects.toMatchObject({
        code: "ENODATA",
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("familyLookup", () => {
  const lookup = (family: 4 | 6, found: LookupAddress[] | Error, all = false) =>
    new Promise((resolve) => {
      const resolver: Resolve = async () => {
        if (found instanceof Error) throw found;
        return found;
      };
      familyLookup(family, resolver)("site.example", { family, all }, (error, address, kind) =>
        resolve({ error: error?.code ?? null, address, family: kind }),
      );
    });

  it("drops IPv4-mapped addresses from an IPv6 lookup", async () => {
    const mapped = [
      { address: "::ffff:64.29.17.131", family: 6 },
      { address: "::ffff:401d:1183", family: 6 },
      { address: "0:0:0:0:0:ffff:4.4.4.4", family: 6 },
    ];
    expect(await lookup(6, mapped)).toEqual({ error: "ENODATA", address: "", family: undefined });
    const mixed = [...mapped, { address: "2001:db8::1", family: 6 }];
    expect(await lookup(6, mixed)).toEqual({ error: null, address: "2001:db8::1", family: 6 });
    expect(await lookup(6, mixed, true)).toMatchObject({
      address: [{ address: "2001:db8::1", family: 6 }],
    });
  });

  it("keeps IPv4 answers and passes lookup errors through", async () => {
    expect(await lookup(4, [{ address: "192.0.2.10", family: 4 }])).toEqual({
      error: null,
      address: "192.0.2.10",
      family: 4,
    });
    expect(await lookup(6, [{ address: "192.0.2.10", family: 4 }])).toMatchObject({
      error: "ENODATA",
    });
    const notFound = Object.assign(new Error("getaddrinfo ENOTFOUND site.example"), {
      code: "ENOTFOUND",
    });
    expect(await lookup(6, notFound)).toMatchObject({ error: "ENOTFOUND" });
  });
});
