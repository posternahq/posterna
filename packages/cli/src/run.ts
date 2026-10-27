import { doctor } from "./commands/doctor";
import { init } from "./commands/init";
import { policyCheck, robots } from "./commands/policy";
import { VERSION } from "./index";
import type { Io } from "./io";

export type { Io, Prompter } from "./io";

/** The commands in docs/SPEC.md section 8. */
const COMMANDS = [
  {
    name: "init",
    usage: "init [--template <name>] [--force] [--yes]",
    summary: "Set up Posterna in this project and write agents.yaml",
  },
  {
    name: "doctor",
    usage: "doctor --url <site>",
    summary: "Check a deployed site's client IP, signed host and signature headers",
  },
  {
    name: "robots",
    usage: "robots [--policy <path>]",
    summary: "Print robots.txt and Content Signals from agents.yaml",
  },
  {
    name: "policy check",
    usage: "policy check [--policy <path>]",
    summary: "Validate agents.yaml",
  },
] as const;

const COLUMN = 34;

/** Returns the help text for `posterna --help`. */
export function helpText(): string {
  return [
    `posterna ${VERSION}`,
    "Verify AI agents and crawlers inside your own app.",
    "",
    "Usage: posterna <command> [options]",
    "",
    "Commands:",
    ...COMMANDS.map((command) => `  ${command.usage.padEnd(COLUMN)}${command.summary}`),
    "",
    "Options:",
    `  ${"--base-url <url>".padEnd(COLUMN)}Posterna cloud base URL (default https://posterna.com/v1/, or POSTERNA_BASE_URL)`,
    `  ${"-h, --help".padEnd(COLUMN)}Show this help`,
    `  ${"-v, --version".padEnd(COLUMN)}Show the version`,
    "",
    "doctor reads POSTERNA_DEBUG_TOKEN from the environment; set it to the same value as on the server.",
    "Templates: monitor (default), allow-list, saas-signup. All start in monitor mode.",
    "Learn more at https://posterna.com",
  ].join("\n");
}

interface Parsed {
  positional: string[];
  flags: Record<string, string | true>;
}

const VALUE_FLAGS = new Set(["url", "template", "policy", "base-url"]);

function parse(args: readonly string[]): Parsed | string {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    if (arg === "-h") flags.help = true;
    else if (arg === "-v") flags.version = true;
    else if (arg === "-y") flags.yes = true;
    else if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      if (VALUE_FLAGS.has(name)) {
        const value = inline ?? args[++i];
        if (value === undefined || value.startsWith("--")) return `--${name} needs a value.`;
        flags[name] = value;
      } else flags[name] = true;
    } else return `Unknown option ${arg}.`;
  }
  return { positional, flags };
}

const text = (value: string | true | undefined) => (typeof value === "string" ? value : undefined);

/**
 * Runs the CLI with the given arguments (without the node and script paths).
 * Resolves to the process exit code.
 */
export async function run(args: readonly string[], io: Io): Promise<number> {
  const parsed = parse(args);
  if (typeof parsed === "string") {
    io.err(parsed);
    return 1;
  }
  const { positional, flags } = parsed;
  const [first, second] = positional;

  if (flags.version) {
    io.out(VERSION);
    return 0;
  }
  if (first === undefined || first === "help" || flags.help) {
    io.out(helpText());
    return 0;
  }

  const prompts = flags.yes ? null : io.prompts;
  const scoped: Io = { ...io, prompts };
  switch (first) {
    case "init":
      return init(scoped, { template: text(flags.template), force: flags.force === true });
    case "doctor":
      return doctor(scoped, { url: text(flags.url) ?? second, baseUrl: text(flags["base-url"]) });
    case "robots":
      return robots(scoped, { policy: text(flags.policy) });
    case "policy":
      if (second === "check") return policyCheck(scoped, { policy: text(flags.policy) });
      io.err("Usage: posterna policy check [--policy <path>]");
      return 1;
    default:
      io.err(`Unknown command: ${first}`);
      io.err("");
      io.err(helpText());
      return 1;
  }
}
