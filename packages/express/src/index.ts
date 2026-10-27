import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve as resolvePath } from "node:path";
import {
  type Counters,
  type CountersOptions,
  createCounters,
  createPolicyEngine,
  createVerifier,
  DEBUG_PATH,
  DEBUG_TOKEN_HEADER,
  type DecideContext,
  type Decision,
  type DirectoryOptions,
  type DnsResolver,
  debugReport,
  debugTokenMatches,
  enforcementResponse,
  type Policy,
  type PolicyEngine,
  type ProxyOptions,
  stripInboundHeaders,
  type VerdictHeaderNames,
  type VerdictResult,
  type Verifier,
  verdictHeaders,
} from "@posterna/core";
import { version } from "../package.json";

/** The version of @posterna/express, read from its package.json at build time. */
export const VERSION: string = version;

export { DEBUG_PATH, DEBUG_TOKEN_HEADER };

export interface PosternaOptions extends ProxyOptions {
  /**
   * Path to agents.yaml. Defaults to `POSTERNA_POLICY`, else `agents.yaml` in
   * the working directory. A missing or invalid file is reported through
   * `onError` and the middleware allows everything.
   */
  policyPath?: string;
  /** The policy itself, as agents.yaml text or a parsed policy. Overrides `policyPath`. */
  policy?: Policy | string;
  /** Names for the verdict request headers. Defaults to X-Agent-Verdict, X-Agent-Operator, X-Agent-Purpose and X-Agent-Method. */
  headers?: Partial<VerdictHeaderNames>;
  /** Site key for counters. Defaults to `POSTERNA_SITE_KEY`; without one, nothing is sent. */
  siteKey?: string | null;
  /** Base URL of the Posterna cloud. Defaults to `POSTERNA_BASE_URL`, else https://posterna.com/v1/. */
  baseUrl?: string;
  /** Enables the debug route. Defaults to `POSTERNA_DEBUG_TOKEN`; without one the route does not exist. */
  debugToken?: string | null;
  /** Operator directory options for the verifier. */
  directory?: DirectoryOptions;
  /** DNS for reverse lookups; null turns reverse DNS off. Defaults to node:dns. */
  dns?: DnsResolver | null;
  /** Counters settings, or false to turn counting off entirely. */
  counters?: false | Partial<Omit<CountersOptions, "sdk" | "source">>;
  /** An existing verifier to share, instead of creating one. */
  verifier?: Verifier;
  /** Environment variables. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Where configuration problems go. Defaults to `console.warn`. Never receives request data. */
  onError?: (message: string) => void;
}

/** What the middleware leaves on `req.posterna` for the application. */
export interface PosternaRequestState {
  result: VerdictResult;
  decision: Decision;
  /**
   * Decides again for this request with another context, for example on a
   * sign-up route: `req.posterna.decide({ kind: "signup" })`. The path
   * defaults to this request's path.
   */
  decide(context?: Partial<DecideContext>): Decision;
}

export type PosternaMiddleware = ((
  req: IncomingMessage,
  res: ServerResponse,
  next: (error?: unknown) => void,
) => Promise<void>) & {
  readonly verifier: Verifier;
  readonly engine: PolicyEngine;
  readonly counters: Counters | null;
  /** Sends pending counters now, for graceful shutdown. */
  flush(): Promise<void>;
  /** Stops background work: directory refreshes and the counters timer. */
  close(): void;
};

declare global {
  namespace Express {
    interface Request {
      /** Set by `@posterna/express` before your routes run. */
      posterna?: PosternaRequestState;
    }
  }
}

type ExpressLikeRequest = IncomingMessage & {
  originalUrl?: string;
  posterna?: PosternaRequestState;
};

const FALLBACK_POLICY = "version: 1\nmode: monitor\n";

/** The directory refreshes from the same Posterna cloud as counters. */
function directoryOptions(
  options: { baseUrl?: string; directory?: DirectoryOptions },
  env: Record<string, string | undefined>,
): DirectoryOptions | undefined {
  const baseUrl = options.baseUrl ?? (env.POSTERNA_BASE_URL?.trim() || undefined);
  if (!baseUrl) return options.directory;
  return { baseUrl, ...options.directory };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loadPolicy(
  options: PosternaOptions,
  env: Record<string, string | undefined>,
  warn: (m: string) => void,
) {
  if (options.policy !== undefined) return options.policy;
  const path = resolvePath(options.policyPath ?? env.POSTERNA_POLICY ?? "agents.yaml");
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as { code?: string }).code;
    warn(
      code === "ENOENT"
        ? `No policy file at ${path}. Every request is allowed and labeled. Run \`npx posterna init\` to create one.`
        : `Could not read ${path} (${message(error)}). Every request is allowed and labeled.`,
    );
    return FALLBACK_POLICY;
  }
}

function firstHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Removes inbound X-Agent-* and X-Posterna-* fields from rawHeaders too, so nothing downstream sees them. */
function stripRawHeaders(req: IncomingMessage): void {
  const raw = req.rawHeaders;
  if (!Array.isArray(raw)) return;
  const kept: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = (raw[i] as string).toLowerCase();
    if (name.startsWith("x-agent-") || name.startsWith("x-posterna-")) continue;
    kept.push(raw[i] as string, raw[i + 1] as string);
  }
  if (kept.length !== raw.length) raw.splice(0, raw.length, ...kept);
}

function pathOf(req: ExpressLikeRequest): string {
  const url = req.originalUrl ?? req.url ?? "/";
  const end = url.search(/[?#]/);
  return (end === -1 ? url : url.slice(0, end)) || "/";
}

/**
 * Express middleware (docs/SPEC.md section 6): strips inbound verdict headers,
 * verifies the request, decides with agents.yaml, sets `req.posterna` and the
 * verdict headers, sends enforced block and throttle responses, counts the
 * request, and serves the debug route when a debug token is set. Every error
 * path lets the request through.
 *
 * ```ts
 * app.use(posterna({ trustedProxies: 1 }));
 * ```
 */
export function posterna(options: PosternaOptions = {}): PosternaMiddleware {
  const env = options.env ?? process.env;
  const warn = (text: string) => {
    try {
      (options.onError ?? ((m: string) => console.warn(`[posterna] ${m}`)))(text);
    } catch {
      // A failing logger must not break requests.
    }
  };

  const verifier =
    options.verifier ??
    createVerifier({
      trustedProxies: options.trustedProxies,
      forwardedHeader: options.forwardedHeader,
      publicHost: options.publicHost,
      directory: directoryOptions(options, env),
      ...(options.dns !== undefined ? { dns: options.dns } : {}),
    });

  let engine: PolicyEngine;
  try {
    engine = createPolicyEngine(loadPolicy(options, env, warn), { verifier, env });
  } catch (error) {
    warn(`agents.yaml is invalid, so every request is allowed and labeled:\n${message(error)}`);
    engine = createPolicyEngine(FALLBACK_POLICY, { verifier, env });
  }

  let counters: Counters | null = null;
  if (options.counters !== false) {
    try {
      counters = createCounters({
        siteKey: options.siteKey,
        baseUrl: options.baseUrl,
        env,
        onError: warn,
        ...(options.counters ?? {}),
        sdk: { name: "@posterna/express", version: VERSION },
        source: engine,
      });
    } catch (error) {
      warn(`Counters are off: ${message(error)}`);
    }
  }

  const debugToken =
    (options.debugToken === undefined ? env.POSTERNA_DEBUG_TOKEN : options.debugToken)?.trim() ||
    null;

  const debugResponse = (req: ExpressLikeRequest, res: ServerResponse, result: VerdictResult) => {
    const body = JSON.stringify(
      debugReport({
        adapter: "@posterna/express",
        version: VERSION,
        request: req,
        result,
        verifier,
        engine,
        counters,
      }),
    );
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(body);
  };

  const middleware = async (
    req: ExpressLikeRequest,
    res: ServerResponse,
    next: (error?: unknown) => void,
  ) => {
    let passed = false;
    const pass = () => {
      if (passed) return;
      passed = true;
      next();
    };
    try {
      // Read the debug token before the X-Posterna-* headers are stripped.
      const path = pathOf(req);
      const isDebug = debugToken !== null && path === DEBUG_PATH;
      const presented = isDebug ? firstHeader(req, DEBUG_TOKEN_HEADER) : undefined;

      stripInboundHeaders(req.headers);
      stripRawHeaders(req);

      // Verify with the original URL: a signature covers the path as sent, even under a mount point.
      const input = {
        method: req.method,
        url: req.originalUrl ?? req.url,
        headers: req.headers,
        rawHeaders: req.rawHeaders,
        socket: req.socket,
      };
      const result = await verifier.verify(input as unknown as IncomingMessage);

      if (isDebug && debugToken && (await debugTokenMatches(presented, debugToken))) {
        debugResponse(req, res, result);
        return;
      }

      const decision = engine.decide(result, { path });
      req.posterna = {
        result,
        decision,
        decide: (context = {}) => engine.decide(result, { path, ...context }),
      };
      for (const [name, value] of Object.entries(verdictHeaders(result, options.headers))) {
        req.headers[name.toLowerCase()] = value;
      }

      if (counters) {
        const record = counters.record;
        const pathGroup = engine.pathGroup(path);
        let counted = false;
        const count = () => {
          if (counted) return;
          counted = true;
          const length = Number(res.getHeader("content-length"));
          record(result, decision, {
            pathGroup,
            bytes: Number.isFinite(length) ? length : undefined,
          });
        };
        res.once("finish", count);
        res.once("close", count);
      }

      const response = enforcementResponse(decision, result);
      if (response && !res.headersSent) {
        res.statusCode = response.status;
        for (const [name, value] of Object.entries(response.headers)) res.setHeader(name, value);
        res.setHeader("Content-Length", Buffer.byteLength(response.body));
        res.end(response.body);
        return;
      }
      pass();
    } catch (error) {
      warn(`A request was let through after an internal error: ${message(error)}`);
      pass();
    }
  };

  return Object.assign(middleware, {
    verifier,
    engine,
    counters,
    async flush() {
      await counters?.flush();
    },
    close() {
      counters?.close();
      if (!options.verifier) verifier.close();
    },
  }) as PosternaMiddleware;
}

export default posterna;
