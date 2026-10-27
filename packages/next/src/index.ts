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
import { type NextFetchEvent, type NextRequest, NextResponse } from "next/server";
import { version } from "../package.json";

/** The version of @posterna/next, read from its package.json at build time. */
export const VERSION: string = version;

export { DEBUG_PATH, DEBUG_TOKEN_HEADER };

/**
 * The matcher we recommend: every route except Next.js build output and image
 * optimization. Next.js reads `config` statically, so copy this literal into
 * your own proxy.ts or middleware.ts rather than importing it.
 */
export const RECOMMENDED_MATCHER = "/((?!_next/static|_next/image|favicon.ico).*)";

export interface PosternaNextOptions extends ProxyOptions {
  /**
   * The policy, as agents.yaml text or a parsed policy. Required on the Edge
   * runtime, which cannot read files. On the Node.js runtime it defaults to the
   * file at `policyPath`.
   */
  policy?: Policy | string;
  /**
   * Path to agents.yaml on the Node.js runtime. Defaults to `POSTERNA_POLICY`,
   * else `agents.yaml` in the working directory. A missing or invalid file is
   * reported through `onError`, and every request is allowed.
   */
  policyPath?: string;
  headers?: Partial<VerdictHeaderNames>;
  /** Site key for counters. Defaults to `POSTERNA_SITE_KEY`; without one, nothing is sent. */
  siteKey?: string | null;
  /** Base URL of the Posterna cloud. Defaults to `POSTERNA_BASE_URL`, else https://posterna.com/v1/. */
  baseUrl?: string;
  /** Enables the debug route. Defaults to `POSTERNA_DEBUG_TOKEN`. */
  debugToken?: string | null;
  directory?: DirectoryOptions;
  /** Counters settings, or false to turn counting off. */
  counters?: false | Partial<Omit<CountersOptions, "sdk" | "source">>;
  env?: Record<string, string | undefined>;
  /** Where configuration problems go. Defaults to `console.warn`. Never receives request data. */
  onError?: (message: string) => void;
}

/** One configured Posterna instance: what `withPosterna` and route handlers use. */
export interface Posterna {
  readonly verifier: Verifier;
  readonly engine: PolicyEngine;
  readonly counters: Counters | null;
  /** Labels a request. In Next.js there is no socket address; see `trustedProxies`. */
  verify(request: Request): Promise<VerdictResult>;
  /** Decides for a labeled request. `path` defaults to the request's path. */
  decide(result: VerdictResult, context: DecideContext): Decision;
  close(): void;
}

/** A Next.js proxy (16) or middleware (15) function. */
export type ProxyFunction = (
  request: NextRequest,
  event: NextFetchEvent,
) =>
  | Response
  | NextResponse
  | null
  | undefined
  | void
  // biome-ignore lint/suspicious/noConfusingVoidType: matches Next.js's own middleware result type, so a function that returns nothing fits.
  | Promise<Response | NextResponse | null | undefined | void>;

/** What the wrapped function can read about the current request through {@link getPosterna}. */
export interface PosternaRequestState {
  result: VerdictResult;
  decision: Decision;
  decide(context?: Partial<DecideContext>): Decision;
}

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

const states = new WeakMap<Request, PosternaRequestState>();

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function processEnv(): Record<string, string | undefined> {
  return (
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
  );
}

/** Reads agents.yaml through process.getBuiltinModule, which bundlers do not touch and the Edge runtime lacks. */
function readPolicyFile(path: string | undefined, warn: (m: string) => void): string {
  const process = (
    globalThis as {
      process?: { cwd?: () => string; getBuiltinModule?: (id: string) => unknown };
    }
  ).process;
  const fs = process?.getBuiltinModule?.("node:fs") as typeof import("node:fs") | undefined;
  if (!fs || !process?.cwd) {
    warn(
      "This runtime cannot read agents.yaml. Pass the policy text as `policy`, or use the Node.js runtime (Node 20.16 or later). Every request is allowed and labeled.",
    );
    return FALLBACK_POLICY;
  }
  const file = path ?? "agents.yaml";
  const full = file.startsWith("/") ? file : `${process.cwd()}/${file}`;
  try {
    return fs.readFileSync(full, "utf8");
  } catch (error) {
    warn(
      (error as { code?: string }).code === "ENOENT"
        ? `No policy file at ${full}. Every request is allowed and labeled. Run \`npx posterna init\` to create one.`
        : `Could not read ${full} (${message(error)}). Every request is allowed and labeled.`,
    );
    return FALLBACK_POLICY;
  }
}

/**
 * Creates a Posterna instance for Next.js. `withPosterna` makes one for you;
 * route handlers can make their own to verify and decide directly.
 *
 * Next.js never gives middleware or proxy the client's socket address. With
 * `trustedProxies` unset, forwarding headers are ignored, as everywhere else,
 * so IP-based verification is off until you set it for your host (for example
 * `trustedProxies: 1` on Vercel). Set `publicHost` too, so signatures are
 * checked against your public hostname.
 */
export function createPosterna(options: PosternaNextOptions = {}): Posterna {
  const env = options.env ?? processEnv();
  const warn = (text: string) => {
    try {
      (options.onError ?? ((m: string) => console.warn(`[posterna] ${m}`)))(text);
    } catch {
      // A failing logger must not break requests.
    }
  };
  const verifier = createVerifier({
    trustedProxies: options.trustedProxies,
    forwardedHeader: options.forwardedHeader,
    publicHost: options.publicHost,
    trustForwardedHost: options.trustForwardedHost,
    directory: directoryOptions(options, env),
  });
  let engine: PolicyEngine;
  try {
    const policy =
      options.policy ?? readPolicyFile(options.policyPath ?? env.POSTERNA_POLICY, warn);
    engine = createPolicyEngine(policy, { verifier, env });
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
        sdk: { name: "@posterna/next", version: VERSION },
        source: engine,
      });
    } catch (error) {
      warn(`Counters are off: ${message(error)}`);
    }
  }
  return {
    verifier,
    engine,
    counters,
    verify: (request) => verifier.verify(request, { remoteAddress: null }),
    decide: (result, context) => engine.decide(result, context),
    close() {
      counters?.close();
      verifier.close();
    },
  };
}

/** The verdict and decision for a request inside a function wrapped by {@link withPosterna}. */
export function getPosterna(request: Request): PosternaRequestState | undefined {
  return states.get(request);
}

/**
 * Passes `headers` to the application as the request headers, on top of what
 * the wrapped function returned. Next.js only forwards request headers set
 * through `NextResponse.next({ request: { headers } })`; this applies the same
 * override to a response the wrapped function built itself, keeping any
 * request headers it set.
 */
function forwardRequestHeaders(response: Response | null | undefined, headers: Headers): Response {
  if (!response) return NextResponse.next({ request: { headers } });
  const continues =
    response.headers.has("x-middleware-next") || response.headers.has("x-middleware-rewrite");
  if (!continues) return response; // A redirect or a final response: the application never sees the request.
  const existing = response.headers.get("x-middleware-override-headers");
  const merged = new Headers(headers);
  if (existing !== null) {
    const kept = new Set(
      existing
        .split(",")
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean),
    );
    for (const name of [...merged.keys()]) {
      if (!kept.has(name) && !name.startsWith("x-agent-")) merged.delete(name);
    }
    for (const name of kept) {
      if (name.startsWith("x-agent-") || name.startsWith("x-posterna-")) continue;
      const value = response.headers.get(`x-middleware-request-${name}`);
      if (value !== null) merged.set(name, value);
    }
  }
  const generated = NextResponse.next({ request: { headers: merged } });
  for (const name of [...response.headers.keys()]) {
    if (name.startsWith("x-middleware-request-")) response.headers.delete(name);
  }
  generated.headers.forEach((value, name) => {
    if (name === "x-middleware-override-headers" || name.startsWith("x-middleware-request-")) {
      response.headers.set(name, value);
    }
  });
  return response;
}

/**
 * Wraps (or is) your Next.js proxy (16) or middleware (15). It labels each
 * request, applies enforced block and throttle responses, passes the verdict
 * headers to your app, removes forged ones, counts the request, and serves the
 * debug route. Your own function, if any, runs after it and can read the
 * verdict with {@link getPosterna}. Every error path lets the request through.
 *
 * ```ts
 * // proxy.ts (Next.js 16)
 * export const proxy = withPosterna({ trustedProxies: 1, publicHost: "www.example.com" });
 * export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
 * ```
 */
export function withPosterna(
  options: PosternaNextOptions = {},
  handler?: ProxyFunction,
): ProxyFunction {
  let instance: Posterna | null = null;
  let debugToken: string | null = null;
  const setup = () => {
    if (!instance) {
      instance = createPosterna(options);
      const env = options.env ?? processEnv();
      debugToken =
        (options.debugToken === undefined
          ? env.POSTERNA_DEBUG_TOKEN
          : options.debugToken
        )?.trim() || null;
    }
    return instance;
  };
  const warn = (text: string) => {
    try {
      (options.onError ?? ((m: string) => console.warn(`[posterna] ${m}`)))(text);
    } catch {
      // ignore
    }
  };

  return async function posternaProxy(request, event) {
    // Null when the headers cannot be read: then nothing is overridden, since an
    // empty override would make Next.js drop every request header.
    let forwarded: Headers | null = null;
    try {
      forwarded = new Headers(request.headers);
      stripInboundHeaders(forwarded);
    } catch {
      forwarded = null;
    }
    try {
      const posterna = setup();
      const path = request.nextUrl?.pathname ?? new URL(request.url).pathname;
      const result = await posterna.verify(request);

      if (debugToken && path === DEBUG_PATH) {
        if (await debugTokenMatches(request.headers.get(DEBUG_TOKEN_HEADER), debugToken)) {
          const report = debugReport({
            adapter: "@posterna/next",
            version: VERSION,
            request,
            callOptions: { remoteAddress: null },
            result,
            verifier: posterna.verifier,
            engine: posterna.engine,
            counters: posterna.counters,
          });
          return Response.json(report, { headers: { "Cache-Control": "no-store" } });
        }
      }

      const decision = posterna.decide(result, { path });
      states.set(request, {
        result,
        decision,
        decide: (context = {}) => posterna.decide(result, { path, ...context }),
      });
      if (posterna.counters) {
        posterna.counters.record(result, decision, { pathGroup: posterna.engine.pathGroup(path) });
        const due = posterna.counters.flushIfDue();
        if (due) event?.waitUntil?.(due);
      }
      const enforced = enforcementResponse(decision, result);
      if (enforced)
        return new Response(enforced.body, { status: enforced.status, headers: enforced.headers });
      for (const [name, value] of Object.entries(verdictHeaders(result, options.headers)))
        forwarded?.set(name, value);
    } catch (error) {
      warn(`A request was let through after an internal error: ${message(error)}`);
    }

    const response = (handler ? await handler(request, event) : undefined) ?? undefined;
    try {
      if (!forwarded) return response ?? NextResponse.next();
      return forwardRequestHeaders(response, forwarded);
    } catch (error) {
      warn(`Verdict headers could not be passed on: ${message(error)}`);
      return response ?? NextResponse.next();
    }
  };
}

let shared: Posterna | null = null;

/**
 * Verifies and decides in a route handler, with a shared instance configured
 * from the environment and agents.yaml (or `options` on first use). For a
 * sign-up route: `const { decision } = await decideRequest(request, { kind: "signup" })`.
 */
export async function decideRequest(
  request: Request,
  context: Partial<DecideContext> = {},
  options?: PosternaNextOptions,
): Promise<{ result: VerdictResult; decision: Decision }> {
  shared ??= createPosterna(options);
  const result = await shared.verify(request);
  const path = context.path ?? new URL(request.url).pathname;
  return { result, decision: shared.decide(result, { ...context, path }) };
}

export default withPosterna;
