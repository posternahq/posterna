// Fails when any file tracked by git holds private key material: a JSON object
// with kty "OKP" and a "d" member, an Ed25519 private JWK written in code or
// prose, or a PEM private key block. See docs/KEYS.md.
//
// The only exceptions are the throwaway conformance keys, pinned by file name
// below. Adding one is a deliberate change to this list.

import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Throwaway Ed25519 keys the conformance generator signs with (conformance/README.md). */
const THROWAWAY_TEST_KEYS = new Set(
  [
    "directory-signer",
    "directory-signer-gen2",
    "label-k1",
    "label-k2",
    "nokid-1",
    "nokid-2",
    "nokid-3",
    "rogue",
    "signer-a",
    "signer-b",
  ].map((name) => `conformance/fixtures/keys/${name}.json`),
);
const THROWAWAY_NOTE =
  "Throwaway Ed25519 key generated for the Posterna conformance suite. Test use only.";

const PEM_PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;
// A `d` member holding 32 bytes of base64url, quoted or not, as in JSON, YAML or code.
const D_MEMBER = /(?:^|[^A-Za-z0-9_$])["']?d["']?\s*:\s*["'`]([A-Za-z0-9_-]{43})["'`]/g;

interface Finding {
  file: string;
  what: string;
}

/** Every object inside a parsed JSON value. */
function* objects(value: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const item of value) yield* objects(item);
  } else if (value && typeof value === "object") {
    yield value as Record<string, unknown>;
    for (const item of Object.values(value)) yield* objects(item);
  }
}

/** Private key material in one file's text. */
function scanText(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  if (PEM_PRIVATE_KEY.test(text)) findings.push({ file, what: "a PEM private key block" });

  let parsed: unknown;
  let isJson = false;
  if (file.endsWith(".json")) {
    try {
      parsed = JSON.parse(text);
      isJson = true;
    } catch {
      // Not valid JSON: the text check below still runs.
    }
  }
  if (isJson) {
    for (const object of objects(parsed)) {
      if (object.kty === "OKP" && "d" in object) {
        findings.push({ file, what: 'a JSON object with kty "OKP" and a "d" member' });
      }
    }
    return findings;
  }
  for (const match of text.matchAll(D_MEMBER)) {
    const around = text.slice(Math.max(0, match.index - 400), match.index + 400);
    if (/OKP|Ed25519/.test(around)) {
      findings.push({ file, what: "an Ed25519 private JWK (a d member next to OKP)" });
      break;
    }
  }
  return findings;
}

/** True for the pinned throwaway conformance keys and nothing else. */
function allowed(finding: Finding, text: string): boolean {
  if (!THROWAWAY_TEST_KEYS.has(finding.file)) return false;
  const parsed = JSON.parse(text) as { note?: string; jwk?: Record<string, unknown> };
  return parsed.note === THROWAWAY_NOTE && Object.keys(parsed).sort().join() === "jwk,note";
}

function trackedFiles(root: string): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

/** Findings for every tracked text file under `root`, minus the pinned exceptions. */
function scanRepository(root: string): Finding[] {
  const findings: Finding[] = [];
  for (const file of trackedFiles(root)) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path);
    if (bytes.subarray(0, 8000).includes(0)) continue; // binary
    const text = bytes.toString("utf8");
    for (const finding of scanText(file, text)) {
      if (!allowed(finding, text)) findings.push(finding);
    }
  }
  return findings;
}

describe("no private keys in the repository", () => {
  it("finds none in any tracked file", () => {
    expect(scanRepository(REPO)).toEqual([]);
  });

  it("never trusts a throwaway conformance key to sign the directory", () => {
    const trusted = readFileSync(join(REPO, "packages/core/src/directory/signature.ts"), "utf8");
    for (const file of THROWAWAY_TEST_KEYS) {
      const { jwk } = JSON.parse(readFileSync(join(REPO, file), "utf8")) as { jwk: { x: string } };
      expect(trusted.includes(jwk.x), file).toBe(false);
    }
  });

  it("detects private keys in every form it looks for", () => {
    // Built at run time from a fresh key, so this file holds no key itself.
    const { privateKey } = generateKeyPairSync("ed25519");
    const jwk = privateKey.export({ format: "jwk" });
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const json = JSON.stringify(jwk, null, 2);

    expect(scanText("key.jwk.json", json)).toHaveLength(1);
    expect(scanText("nested.json", JSON.stringify({ keys: [{ ...jwk }] }))).toHaveLength(1);
    expect(scanText("notes.md", `Paste this:\n${json}\n`)).toHaveLength(1);
    expect(
      scanText(
        "key.ts",
        `const key = { kty: "OKP", crv: "Ed25519", x: "${jwk.x}", d: "${jwk.d}" };`,
      ),
    ).toHaveLength(1);
    expect(scanText("env.yaml", `kty: OKP\nd: '${jwk.d}'\n`)).toHaveLength(1);
    expect(scanText("key.pem", pem)).toHaveLength(1);
    expect(scanText("broken.json", `${json},`)).toHaveLength(1);

    // Public keys are fine.
    const publicJwk = { kty: "OKP", crv: "Ed25519", x: jwk.x };
    expect(scanText("public.json", JSON.stringify(publicJwk))).toEqual([]);
    expect(scanText("public.ts", `const key = ${JSON.stringify(publicJwk)};`)).toEqual([]);
    // A pinned file name alone is not enough: it must hold only a throwaway key and its note.
    const finding = { file: "conformance/fixtures/keys/rogue.json", what: "" };
    expect(allowed(finding, JSON.stringify({ note: "Production key", jwk }))).toBe(false);
  });
});
