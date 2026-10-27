import { version } from "../package.json";

/** The version of posterna, read from its package.json at build time. */
export const VERSION: string = version;

export { codeToAdd, detectFramework, type Framework } from "./commands/init";
export { DEFAULT_BASE_URL, type Io, type Prompter } from "./io";
export { helpText, run } from "./run";
