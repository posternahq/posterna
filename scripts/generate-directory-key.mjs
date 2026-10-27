#!/usr/bin/env node
// Generates a Posterna directory signing key (docs/KEYS.md).
//
//   pnpm build
//   node scripts/generate-directory-key.mjs --role backup --generation 2
//
// The private JWK is written to
// ~/posterna-keys/posterna-directory-<role>-gen<N>-<YYYYMMDD>.jwk.json (folder
// mode 700, file mode 600), never over an existing file and never inside a git
// working tree. The file is one JWK, so its whole contents can be pasted into
// the POSTERNA_DIRECTORY_SIGNING_KEY variable when this key goes into service.
// Only the file path, the public JWK and the kid are printed.
//
// Before writing, the new key signs the bundled directory.json and
// @posterna/core's own verification code checks that signature. Key generation
// uses Node's built-in crypto only.
//
// Options: --role primary|backup, --generation <positive integer>, and
// --out-dir <folder> (default ~/posterna-keys), which tests use.

import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORE = join(REPO, "packages", "core", "dist", "index.js");
const BUNDLED_DIRECTORY = join(REPO, "packages", "directory", "data", "directory.json");

function fail(message) {
  console.error(`generate-directory-key: ${message}`);
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    role: { type: "string" },
    generation: { type: "string" },
    "out-dir": { type: "string" },
  },
  strict: true,
});

const role = values.role;
if (role !== "primary" && role !== "backup") fail("--role must be primary or backup");
const generation = Number(values.generation);
if (!/^[1-9]\d*$/.test(values.generation ?? "") || !Number.isSafeInteger(generation)) {
  fail("--generation must be a positive integer");
}
const outDir = resolve(values["out-dir"] ?? join(homedir(), "posterna-keys"));

/** The nearest folder at or above `path` that exists, with symbolic links resolved. */
function nearestExisting(path) {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return realpathSync(current);
}

/** True when `path` is inside a git working tree, by `.git` entries and by asking git. */
function insideGitTree(path) {
  const start = nearestExisting(path);
  for (let current = start; ; current = dirname(current)) {
    if (existsSync(join(current, ".git"))) return true;
    if (dirname(current) === current) break;
  }
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  const git = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: start,
    encoding: "utf8",
    env,
  });
  return git.status === 0 && git.stdout.trim() === "true";
}

if (insideGitTree(outDir)) {
  fail(`refusing to write inside a git working tree: ${outDir}`);
}

const today = new Date();
const stamp = [
  today.getFullYear(),
  String(today.getMonth() + 1).padStart(2, "0"),
  String(today.getDate()).padStart(2, "0"),
].join("");
const file = join(outDir, `posterna-directory-${role}-gen${generation}-${stamp}.jwk.json`);
if (existsSync(file)) fail(`refusing to overwrite ${file}`);

if (!existsSync(CORE)) fail("@posterna/core is not built; run pnpm build first");
const core = await import(pathToFileURL(CORE).href);

// Generate the key pair and compute its RFC 7638 thumbprint.
const { privateKey } = generateKeyPairSync("ed25519");
const exported = privateKey.export({ format: "jwk" });
const publicJwk = { kty: "OKP", crv: "Ed25519", x: exported.x };
const kid = await core.directoryKeyThumbprint(publicJwk);
const independent = createHash("sha256")
  .update(JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x }))
  .digest("base64url");
if (kid !== independent) fail("self-test failed: the two thumbprint computations disagree");

// Self-test: sign the bundled directory.json, then verify with core's real code
// given a trusted list that holds only the new public key.
const bytes = new Uint8Array(readFileSync(BUNDLED_DIRECTORY));
const signature = sign(null, bytes, privateKey).toString("base64url");
const trusted = [{ kid, role, generation, added: "2000-01-01", jwk: publicJwk }];
const check = await core.checkDirectorySignature(bytes, signature, trusted, generation);
const tampered = bytes.slice();
tampered[0] ^= 1;
const tamperedCheck = await core.checkDirectorySignature(tampered, signature, trusted, generation);
if (!check.ok || check.kid !== kid || check.generation !== generation || tamperedCheck.ok) {
  fail("self-test failed: core did not verify a signature made with the new key; nothing written");
}

// Write the private JWK. "wx" fails if the file appeared in the meantime.
mkdirSync(outDir, { recursive: true, mode: 0o700 });
chmodSync(outDir, 0o700);
const contents = {
  kty: "OKP",
  crv: "Ed25519",
  x: exported.x,
  d: exported.d,
  kid,
  role,
  generation,
  created: today.toISOString(),
};
writeFileSync(file, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600, flag: "wx" });
chmodSync(file, 0o600);

console.log(`Private key file (mode 600): ${file}`);
console.log(`Public JWK: ${JSON.stringify(publicJwk)}`);
console.log(`kid: ${kid}`);
