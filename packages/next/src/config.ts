import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/**
 * The build-time variable that carries the agents.yaml text into the proxy.
 * `withPosternaConfig` sets it through `env` in next.config, and Next.js writes
 * the text into the compiled proxy wherever the adapter reads it.
 */
export const POLICY_TEXT_ENV = "POSTERNA_POLICY_TEXT";

export interface PosternaConfigOptions {
  /**
   * Path to agents.yaml. Defaults to `POSTERNA_POLICY`, else `agents.yaml` in
   * the folder Next.js runs in. A relative path is read from that folder.
   */
  policyPath?: string;
  /** Where a missing or unreadable file is reported. Defaults to `console.warn`. */
  onError?: (message: string) => void;
}

/** The part of a Next.js config that `withPosternaConfig` touches. */
export interface ConfigWithEnv {
  env?: Record<string, string | undefined>;
}

/**
 * Builds agents.yaml into your Next.js proxy (or middleware). Hosts such as
 * Vercel deploy the proxy with only the code it imports, so it cannot read
 * agents.yaml at run time; with this, it does not need to. The file stays the
 * one place your policy lives: each build copies it again, and `next dev`
 * picks up a change when restarted.
 *
 * ```ts
 * // next.config.ts
 * import { withPosternaConfig } from "@posterna/next/config";
 *
 * export default withPosternaConfig({ ... your config ... });
 * ```
 *
 * The file is read when Next.js loads next.config. A missing or unreadable file
 * is reported through `onError` and nothing is built in, so the proxy looks for
 * agents.yaml at run time as before. It never stops a build. The proxy uses the
 * built-in copy unless its options set `policy` or `policyPath`. Route handlers
 * that call `createPosterna()` get the same copy.
 */
export function withPosternaConfig<A extends unknown[], C extends object>(
  config: (...args: A) => C | Promise<C>,
  options?: PosternaConfigOptions,
): (...args: A) => Promise<C & ConfigWithEnv>;
export function withPosternaConfig<C extends object = ConfigWithEnv>(
  config?: C,
  options?: PosternaConfigOptions,
): C & ConfigWithEnv;
export function withPosternaConfig(
  config: object | ((...args: unknown[]) => object | Promise<object>) = {},
  options: PosternaConfigOptions = {},
): object | ((...args: unknown[]) => Promise<object>) {
  if (typeof config === "function") {
    return async (...args) => addPolicy(await config(...args), options);
  }
  return addPolicy(config, options);
}

function addPolicy<C extends object>(config: C, options: PosternaConfigOptions): C & ConfigWithEnv {
  const text = readPolicy(options);
  if (text === null) return config;
  const env = (config as ConfigWithEnv).env;
  return { ...config, env: { ...env, [POLICY_TEXT_ENV]: text } };
}

function readPolicy(options: PosternaConfigOptions): string | null {
  const file = options.policyPath ?? (process.env.POSTERNA_POLICY?.trim() || "agents.yaml");
  const full = isAbsolute(file) ? file : resolve(process.cwd(), file);
  try {
    return readFileSync(full, "utf8");
  } catch (error) {
    // `next start` loads next.config too, but serves a build that already holds
    // the text, and the file is often left out of the deployed image.
    if (process.argv.slice(2).includes("start")) return null;
    const code = (error as { code?: string }).code;
    const reason =
      code === "ENOENT"
        ? `No policy file at ${full}`
        : `Could not read ${full} (${error instanceof Error ? error.message : String(error)})`;
    try {
      (options.onError ?? ((m: string) => console.warn(`[posterna] ${m}`)))(
        `${reason}, so withPosternaConfig built no policy into the proxy. Run \`npx posterna init\` to create agents.yaml, or set policyPath.`,
      );
    } catch {
      // A failing logger must not break the build.
    }
    return null;
  }
}
