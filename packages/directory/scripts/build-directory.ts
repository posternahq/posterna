// `pnpm directory:build`: merges sources/*.yaml, the files fetched by
// `pnpm directory:fetch` and the ai.robots.txt community list into data/
// (directory.json, keys.json, agents.csv, summary.json), validates them
// against the JSON Schemas in packages/core/src/schema, and writes
// docs/directory-build-report.md. Fails on invalid or duplicate data.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DirectoryFile, KeysFile } from "../../core/src/directory/types";
import { parseCommunityList } from "./lib/community";
import {
  DATA_DIR,
  FINDINGS_PATH,
  REPORT_PATH,
  ROBOTS_JSON_TITLE,
  ROBOTS_JSON_URL,
} from "./lib/config";
import { checkEvidence } from "./lib/evidence";
import { findNewThings } from "./lib/findings";
import { loadFetched, readManifest } from "./lib/manifest";
import { buildDirectory } from "./lib/merge";
import { agentsCsv, schemaValidators, summary } from "./lib/outputs";
import { buildReport } from "./lib/report";
import { loadCommunityAttributions, loadOperatorSources } from "./lib/sources";

function readJson<T>(path: string): T | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

async function main(): Promise<void> {
  const researched = loadOperatorSources();
  const manifest = readManifest();
  const fetched = loadFetched(manifest);

  const robotsJson = fetched.get(ROBOTS_JSON_URL);
  if (!robotsJson?.body) {
    const why = robotsJson
      ? `${robotsJson.entry.outcome}: ${robotsJson.entry.detail}`
      : "not fetched";
    throw new Error(`ai.robots.txt robots.json is required but was not fetched (${why}).`);
  }

  const attributions = loadCommunityAttributions();
  const { directory, keys, log } = await buildDirectory({
    generatedAt: new Date(),
    researched,
    communityOperatorNames: attributions.operatorNames,
    describedOperators: attributions.describedOperators,
    community: {
      list: parseCommunityList(new TextDecoder().decode(robotsJson.body)),
      source: {
        url: ROBOTS_JSON_URL,
        title: ROBOTS_JSON_TITLE,
        fetched_at: robotsJson.entry.fetched_at,
      },
    },
    fetched,
    previousKeys: readJson<KeysFile>(join(DATA_DIR, "keys.json")),
    previousDirectory: readJson<DirectoryFile>(join(DATA_DIR, "directory.json")),
  });

  if (log.problems.length > 0) {
    throw new Error(`The merged data has problems:\n- ${log.problems.join("\n- ")}`);
  }
  const validate = schemaValidators();
  const invalid = [
    ...validate.directory(directory).map((error) => `directory.json ${error}`),
    ...validate.keys(keys).map((error) => `keys.json ${error}`),
  ];
  if (invalid.length > 0) {
    throw new Error(`Schema validation failed:\n- ${invalid.slice(0, 50).join("\n- ")}`);
  }

  const evidence = checkEvidence(researched, fetched);
  const { findings, ignored } = findNewThings(researched, fetched, directory, evidence);
  writeFileSync(FINDINGS_PATH, json({ findings }));
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, "directory.json"), json(directory));
  writeFileSync(join(DATA_DIR, "keys.json"), json(keys));
  writeFileSync(join(DATA_DIR, "agents.csv"), agentsCsv(directory));
  const counts = summary(directory, keys);
  writeFileSync(join(DATA_DIR, "summary.json"), json(counts));
  writeFileSync(
    REPORT_PATH,
    buildReport({ directory, keys, log, evidence, findings, ignored, manifest, researched }),
  );

  const notVerbatim = evidence.filter((check) => check.result !== "verbatim");
  console.log(
    `Built ${counts.operators.total} operators and ${counts.agents.total} agents ` +
      `(${counts.agents.by_coverage.researched ?? 0} researched). Signing: ${JSON.stringify(counts.signing)}. ` +
      `Keys: ${counts.keys}. IP prefixes: ${counts.ip_lists.prefixes}.`,
  );
  if (notVerbatim.length > 0) {
    console.warn(
      `${notVerbatim.length} of ${evidence.length} evidence checks were not verbatim; see ${REPORT_PATH}.`,
    );
  }
  console.log(
    `${findings.length} findings need review (${ignored} reviewed and ignored); see ${FINDINGS_PATH}.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
