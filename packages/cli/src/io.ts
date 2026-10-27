import { createRequire } from "node:module";
import type { DirectoryFile } from "@posterna/core";

/** Where the CLI reads and writes. Tests pass their own. */
export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  cwd: string;
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  /**
   * A fetch over IPv4 or IPv6 only, so doctor can check both. Without it,
   * doctor checks the client address once, over whichever family `fetch` uses.
   */
  fetchOver?: (family: 4 | 6) => typeof fetch;
  now: () => number;
  /** Null when there is no terminal to ask (CI, pipes, `--yes`). */
  prompts: Prompter | null;
}

/** The questions `posterna init` asks. Each resolves to null when the person cancels. */
export interface Prompter {
  select<T extends string>(
    message: string,
    options: { value: T; label: string; hint?: string }[],
    initial: T,
  ): Promise<T | null>;
  confirm(message: string, initial: boolean): Promise<boolean | null>;
  password(message: string): Promise<string | null>;
}

/** The default Posterna cloud. `--base-url` or `POSTERNA_BASE_URL` override it (for tests). */
export const DEFAULT_BASE_URL = "https://posterna.com/v1/";

export function baseUrl(flag: string | undefined, env: Io["env"]): string {
  return (flag ?? (env.POSTERNA_BASE_URL?.trim() || DEFAULT_BASE_URL)).replace(/\/?$/, "/");
}

const require = createRequire(import.meta.url);

/** A template shipped in @posterna/core. */
export function readTemplate(name: string): string {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  return readFileSync(require.resolve(`@posterna/core/templates/${name}.yaml`), "utf8");
}

let directory: DirectoryFile | null = null;
/** The operator directory snapshot bundled with @posterna/directory. */
export function bundledDirectory(): DirectoryFile {
  directory ??= require("@posterna/directory/data/directory.json") as DirectoryFile;
  return directory;
}

/** Interactive prompts on a terminal, through @clack/prompts. A cancel (Ctrl+C or Escape) becomes null. */
export async function clackPrompter(): Promise<Prompter> {
  const clack = await import("@clack/prompts");
  return {
    async select(message, options, initial) {
      const value: unknown = await clack.select({
        message,
        options: options.map((option) => ({
          value: option.value,
          label: option.label,
          hint: option.hint,
        })),
        initialValue: initial,
      } as Parameters<typeof clack.select>[0]);
      return typeof value === "string" ? (value as typeof initial) : null;
    },
    async confirm(message, initial) {
      const value: unknown = await clack.confirm({ message, initialValue: initial });
      return typeof value === "boolean" ? value : null;
    },
    async password(message) {
      const value: unknown = await clack.password({ message, mask: "*" });
      return typeof value === "string" ? value : null;
    },
  };
}
