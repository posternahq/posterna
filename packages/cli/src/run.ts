import { VERSION } from "./index";

/** Where the CLI writes its output, one line per call. Tests pass their own. */
export interface Output {
  out: (line: string) => void;
  err: (line: string) => void;
}

/** The commands planned for v1 (docs/SPEC.md section 8). None of them work yet. */
const COMMANDS = [
  { name: "init", summary: "Set up Posterna in this project and write agents.yaml" },
  { name: "doctor", summary: "Check a deployed site's IP, host and signature handling" },
  { name: "robots", summary: "Print robots.txt and Content Signals from agents.yaml" },
  { name: "policy check", summary: "Validate agents.yaml" },
] as const;

const COLUMN = 16;

/** Returns the help text for `posterna --help`. */
export function helpText(): string {
  const commands = COMMANDS.map(
    (command) => `  ${command.name.padEnd(COLUMN)}${command.summary} (coming soon)`,
  );
  return [
    `posterna ${VERSION}`,
    "Verify AI agents and crawlers inside your own app.",
    "",
    "Usage: posterna <command> [options]",
    "",
    "Commands:",
    ...commands,
    "",
    "Options:",
    `  ${"-h, --help".padEnd(COLUMN)}Show this help`,
    `  ${"-v, --version".padEnd(COLUMN)}Show the version`,
    "",
    "This is a pre-release. The commands above are not available yet.",
    "Learn more at https://posterna.com",
  ].join("\n");
}

/**
 * Runs the CLI with the given arguments (without the node and script paths).
 * Returns the process exit code.
 */
export function run(args: readonly string[], output: Output): number {
  const [first, second] = args;

  if (first === undefined || first === "help" || first === "-h" || first === "--help") {
    output.out(helpText());
    return 0;
  }

  if (first === "-v" || first === "--version") {
    output.out(VERSION);
    return 0;
  }

  const name = first === "policy" && second === "check" ? "policy check" : first;
  if (COMMANDS.some((command) => command.name === name)) {
    output.err(`posterna ${name} is coming soon. It is not available in this pre-release.`);
    return 1;
  }

  output.err(`Unknown command: ${name}`);
  output.err("");
  output.err(helpText());
  return 1;
}
