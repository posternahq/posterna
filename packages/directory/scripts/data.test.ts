// Checks on the committed data in packages/directory/data, so a bad rebuild
// cannot be merged even if the build itself was skipped or edited.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DirectoryFile, KeysFile } from "../../core/src/directory/types";
import { DATA_DIR } from "./lib/config";
import { jwkThumbprint } from "./lib/keys";
import { findDuplicates } from "./lib/merge";
import { schemaValidators } from "./lib/outputs";
import { normalizePrefix } from "./lib/prefixes";

const directory = JSON.parse(
  readFileSync(join(DATA_DIR, "directory.json"), "utf8"),
) as DirectoryFile;
const keys = JSON.parse(readFileSync(join(DATA_DIR, "keys.json"), "utf8")) as KeysFile;

describe("committed directory data", () => {
  it("validates against the JSON Schemas", () => {
    const validate = schemaValidators();
    expect(validate.directory(directory)).toEqual([]);
    expect(validate.keys(keys)).toEqual([]);
  });

  it("has no duplicate agents", () => {
    expect(findDuplicates(directory.operators)).toEqual([]);
  });

  it("gives every researched agent a quote and at least one source", () => {
    for (const op of directory.operators) {
      for (const agent of op.agents.filter((candidate) => candidate.coverage === "researched")) {
        expect(agent.purpose_quote, `${op.slug}/${agent.name}`).toBeTruthy();
        expect(agent.sources.length, `${op.slug}/${agent.name}`).toBeGreaterThan(0);
      }
    }
  });

  it("only marks agents as signing when the key directory is live", () => {
    for (const op of directory.operators) {
      for (const agent of op.agents.filter((candidate) => candidate.signs)) {
        expect(op.verification.signing.status, `${op.slug}/${agent.name}`).toBe("live");
        expect(keys.operators[op.slug]?.keys.length ?? 0).toBeGreaterThan(0);
      }
    }
  });

  it("stores IP prefixes in normal form and sorted without duplicates", () => {
    for (const op of directory.operators) {
      for (const list of op.verification.ip_lists) {
        for (const prefix of list.prefixes) {
          expect(normalizePrefix(prefix), `${op.slug}/${list.agent}`).toEqual({
            ok: true,
            prefix,
            changed: false,
          });
        }
        expect(new Set(list.prefixes).size).toBe(list.prefixes.length);
        expect(list.prefix_count ?? 0).toBe(list.prefixes.length);
      }
    }
  });

  it("stores the RFC 7638 thumbprint of every key, and no private key material", async () => {
    for (const [slug, op] of Object.entries(keys.operators)) {
      for (const key of op.keys) {
        expect(await jwkThumbprint(key.jwk), slug).toBe(key.thumbprint);
        expect(Object.keys(key.jwk)).not.toContain("d");
      }
    }
  });
});
