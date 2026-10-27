import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { checkPolicy, emitRobots, type PolicyIssue, policyHash } from "@posterna/core";
import { bundledDirectory, type Io } from "../io";

export interface PolicyFlags {
  policy?: string;
}

function load(io: Io, flags: PolicyFlags): { text: string; name: string } | null {
  const path = resolve(io.cwd, flags.policy ?? io.env.POSTERNA_POLICY ?? "agents.yaml");
  const name = relative(io.cwd, path) || path;
  try {
    return { text: readFileSync(path, "utf8"), name };
  } catch {
    io.err(`Cannot read ${name}. Run \`posterna init\` to create one, or pass --policy <path>.`);
    return null;
  }
}

function line(name: string, issue: PolicyIssue): string {
  const where = issue.line === null ? name : `${name}:${issue.line}:${issue.column}`;
  return `${where} ${issue.severity}: ${issue.message}`;
}

/** `posterna policy check` (docs/SPEC.md section 8). Exit code 1 when there are errors. */
export function policyCheck(io: Io, flags: PolicyFlags): number {
  const file = load(io, flags);
  if (!file) return 1;
  const operators = bundledDirectory().operators.map((operator) => operator.slug);
  const result = checkPolicy(file.text, { knownOperators: operators });
  for (const issue of result.errors) io.err(line(file.name, issue));
  for (const issue of result.warnings) io.err(line(file.name, issue));
  if (!result.policy) {
    io.err(
      `${result.errors.length} error${result.errors.length === 1 ? "" : "s"} in ${file.name}.`,
    );
    return 1;
  }
  const warnings = result.warnings.length;
  io.out(
    `${file.name} is valid: mode ${result.policy.mode}${warnings > 0 ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}.`,
  );
  return 0;
}

/** `posterna robots`: prints robots.txt and Content Signals from agents.yaml (docs/SPEC.md section 5.6). */
export async function robots(io: Io, flags: PolicyFlags): Promise<number> {
  const file = load(io, flags);
  if (!file) return 1;
  const result = checkPolicy(file.text);
  if (!result.policy) {
    for (const issue of result.errors) io.err(line(file.name, issue));
    return 1;
  }
  const text = emitRobots(result.policy, bundledDirectory().operators, {
    policyHash: await policyHash(result.policy),
  });
  io.out(text.replace(/\n$/, ""));
  return 0;
}
