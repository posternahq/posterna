#!/usr/bin/env node
import { clackPrompter } from "./io";
import { run } from "./run";

// Piping into `head` closes stdout early; that is not an error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw error;
  });
}

const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !process.env.CI;

process.exitCode = await run(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  cwd: process.cwd(),
  env: process.env,
  fetch: globalThis.fetch,
  now: () => Date.now(),
  prompts: interactive ? await clackPrompter() : null,
});
