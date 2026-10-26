import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** packages/directory */
export const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const REPO_DIR = join(PACKAGE_DIR, "..", "..");
export const SOURCES_DIR = join(PACKAGE_DIR, "sources");
export const COMMUNITY_OPERATORS_PATH = join(SOURCES_DIR, "community-operators.yaml");
export const RAW_DIR = join(PACKAGE_DIR, "raw");
export const MANIFEST_PATH = join(RAW_DIR, "manifest.json");
export const DATA_DIR = join(PACKAGE_DIR, "data");
export const SCHEMA_DIR = join(REPO_DIR, "packages", "core", "src", "schema");
export const REPORT_PATH = join(REPO_DIR, "docs", "directory-build-report.md");

/** How the pipeline identifies itself on every request. */
export const USER_AGENT = "PosternaDirectoryBuilder/0.1 (+https://posterna.com/directory)";
/** The product token matched against robots.txt groups (RFC 9309). */
export const ROBOTS_PRODUCT_TOKEN = "PosternaDirectoryBuilder";

/** The community list, MIT licensed, credited in packages/directory/NOTICE. */
export const ROBOTS_JSON_URL =
  "https://raw.githubusercontent.com/ai-robots-txt/ai.robots.txt/main/robots.json";
export const ROBOTS_JSON_TITLE = "ai.robots.txt robots.json";

export const KEY_DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";

export const REQUEST_TIMEOUT_MS = 15_000;
export const MAX_BODY_BYTES = 10 * 1024 * 1024;
/** RFC 9309 section 2.5: crawlers must parse at least 500 kibibytes. */
export const ROBOTS_MAX_BYTES = 500 * 1024;
export const MAX_REDIRECTS = 5;
/** Minimum gap between two requests to the same host. Crawl-delay can raise it. */
export const MIN_HOST_INTERVAL_MS = 1_000;
export const MAX_CRAWL_DELAY_MS = 30_000;

export const DATA_LICENSE = "CC-BY-4.0";
export const ATTRIBUTION =
  "Posterna operator directory (https://github.com/posternahq/posterna), CC BY 4.0. " +
  "Community records derived from ai.robots.txt (https://github.com/ai-robots-txt/ai.robots.txt), MIT.";
