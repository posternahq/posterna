import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const POLICY = join(REPO, "test", "e2e", "fixtures", "enforce.yaml");
export const SITE_KEY = "psk_e2eTestKeyThatIsNotRealAtAll0123456789";
export const DEBUG_TOKEN = "e2e-debug-token";

interface OperatorRecord {
  slug: string;
  verification: { ip_lists: { agent: string; prefixes: string[] }[]; reverse_dns: unknown };
  agents: { name: string; purpose: string; user_agent_tokens: string[] }[];
}
const directory = JSON.parse(
  readFileSync(join(REPO, "packages", "directory", "data", "directory.json"), "utf8"),
) as { operators: OperatorRecord[] };
const keys = JSON.parse(
  readFileSync(join(REPO, "packages", "directory", "data", "keys.json"), "utf8"),
) as {
  operators: Record<string, { keys: unknown[] }>;
};

/** A Googlebot address from Google's published common-crawlers list (verified by IP, no DNS needed). */
export const GOOGLEBOT_ADDRESS = (() => {
  const google = directory.operators.find((operator) => operator.slug === "google");
  const prefix = google?.verification.ip_lists.find((list) => list.agent === "common-crawlers")
    ?.prefixes[0];
  if (!prefix?.includes("."))
    throw new Error("the directory has no IPv4 Google common-crawlers prefix");
  return prefix.replace(/\.0\/\d+$/, ".1").replace(/\/\d+$/, "");
})();

/** An AWS EC2 address (216.244.7.0/24) outside Anthropic's crawler list. Anthropic publishes no reverse DNS rule, so no lookup runs. */
export const SPOOF_ADDRESS = "216.244.7.10";

/**
 * A listed agent, not a training crawler, whose operator publishes no keys, IP
 * lists or reverse DNS: always declared_unverifiable.
 */
export const UNVERIFIABLE_AGENT = (() => {
  for (const operator of directory.operators) {
    const v = operator.verification;
    if (
      v.ip_lists.length > 0 ||
      v.reverse_dns ||
      (keys.operators[operator.slug]?.keys.length ?? 0) > 0
    )
      continue;
    const token = operator.agents
      .filter((agent) => agent.purpose !== "training")
      .flatMap((agent) => agent.user_agent_tokens)
      .find((t) => /^[A-Za-z][\w-]+$/.test(t));
    if (token)
      return { operator: operator.slug, userAgent: `Mozilla/5.0 (compatible; ${token}/1.0)` };
  }
  throw new Error("the directory has no operator that publishes nothing");
})();

export const BROWSER = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml",
  "accept-language": "en-US,en;q=0.9",
};
export const GOOGLEBOT = {
  "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "x-forwarded-for": GOOGLEBOT_ADDRESS,
};
export const SPOOFED_CLAUDEBOT = {
  "user-agent":
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
  "x-forwarded-for": SPOOF_ADDRESS,
};
export const CURL = {
  "user-agent": "curl/8.4.0",
  accept: "*/*",
  "x-forwarded-for": "198.51.100.23",
};

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export interface IngestCall {
  headers: IncomingHttpHeaders;
  payload: {
    schema: number;
    sdk: { name: string; version: string; runtime: string };
    instance: string;
    mode: string;
    state: Record<string, unknown>;
    buckets: {
      verdict: string;
      reason: string | null;
      operator: string | null;
      pathGroup: string;
      action: string;
      enforced: boolean;
      count: number;
      bytes: number;
    }[];
  };
}

/** A stand-in for POST /v1/ingest in the Posterna cloud. */
export async function startIngest() {
  const calls: IngestCall[] = [];
  const state = { modeOverride: null as "monitor" | null };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/v1/ingest") {
        res.statusCode = 404;
        res.end();
        return;
      }
      const body = Buffer.concat(chunks);
      const text =
        req.headers["content-encoding"] === "gzip"
          ? gunzipSync(body).toString("utf8")
          : body.toString("utf8");
      calls.push({ headers: req.headers, payload: JSON.parse(text) as IngestCall["payload"] });
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          accepted: calls.at(-1)?.payload.buckets.length ?? 0,
          modeOverride: state.modeOverride,
        }),
      );
    });
  });
  const port = await new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
  return {
    calls,
    state,
    baseUrl: `http://127.0.0.1:${port}/v1/`,
    /** Waits for the next ingest call after now. */
    async next(timeoutMs = 20_000): Promise<IngestCall> {
      const seen = calls.length;
      await waitFor(() => calls.length > seen, timeoutMs, "an ingest call");
      return calls[seen] as IngestCall;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export async function waitFor(
  check: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Runs a command to completion, failing with its output. */
export function runToEnd(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} failed:\n${output}`)),
    );
  });
}

export interface App {
  url: string;
  output: () => string;
  /** SIGTERM, then wait for the process to exit. */
  stop(): Promise<number | null>;
}

/** Starts an example app and waits until it answers HTTP. */
export async function startApp(options: {
  cwd: string;
  command: string;
  args: string[];
  port: number;
  env: Record<string, string>;
}): Promise<App> {
  const child: ChildProcess = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1",
      ...options.env,
      PORT: String(options.port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk;
  });
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const url = `http://127.0.0.1:${options.port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the app exited early:\n${output}`);
    try {
      await fetch(`${url}/`, { headers: BROWSER, signal: AbortSignal.timeout(2_000) });
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`the app did not start:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return {
    url,
    output: () => output,
    async stop() {
      if (child.exitCode !== null) return child.exitCode;
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      const code = await exited;
      clearTimeout(timer);
      return code;
    },
  };
}

/** The environment every example runs with in these tests. */
export function appEnv(ingestBaseUrl: string): Record<string, string> {
  return {
    POSTERNA_POLICY: POLICY,
    POSTERNA_SITE_KEY: SITE_KEY,
    POSTERNA_BASE_URL: ingestBaseUrl,
    POSTERNA_COUNTERS_INTERVAL_MS: "1000",
    POSTERNA_DEBUG_TOKEN: DEBUG_TOKEN,
  };
}
