// scripts/generate-directory-key.mjs against the built @posterna/core. Every
// key here is a throwaway written to a temporary folder and deleted after.

import { spawnSync } from "node:child_process";
import { createPrivateKey, sign } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(REPO, "scripts", "generate-directory-key.mjs");
const scratch = mkdtempSync(join(tmpdir(), "posterna-key-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The two functions used here, from the built package (loaded at run time, after `pnpm build`). */
interface Core {
  directoryKeyThumbprint(jwk: { kty: string; crv: string; x: string }): Promise<string>;
  checkDirectorySignature(
    bytes: Uint8Array,
    signature: string,
    trustedKeys: readonly unknown[],
    minGeneration?: number,
  ): Promise<unknown>;
}
let core: Core;
beforeAll(async () => {
  core = (await import(pathToFileURL(join(REPO, "packages/core/dist/index.js")).href)) as Core;
});

function run(...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO, encoding: "utf8" });
}

describe("generate-directory-key", () => {
  it("writes a private JWK at mode 600 and prints only public material", async () => {
    const outDir = join(scratch, "keys");
    const result = run("--role", "backup", "--generation", "7", "--out-dir", outDir);
    expect(result.status, result.stderr).toBe(0);

    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(result.stdout).not.toMatch(/"d"/);
    const [file] = readdirSync(outDir);
    expect(file).toMatch(/^posterna-directory-backup-gen7-\d{8}\.jwk\.json$/);
    const path = join(outDir, file as string);
    expect(lines[0]).toBe(`Private key file (mode 600): ${path}`);
    expect(statSync(outDir).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys(saved).sort()).toEqual(
      ["created", "crv", "d", "generation", "kid", "kty", "role", "x"].sort(),
    );
    const publicJwk = { kty: "OKP", crv: "Ed25519", x: saved.x };
    expect(lines[1]).toBe(`Public JWK: ${JSON.stringify(publicJwk)}`);
    expect(saved.kid).toBe(await core.directoryKeyThumbprint(publicJwk));
    expect(lines[2]).toBe(`kid: ${saved.kid}`);
    expect(saved).toMatchObject({ role: "backup", generation: 7 });

    // The saved key signs files that core accepts under the printed public key.
    const bytes = new TextEncoder().encode('{"schema":1}\n');
    const signature = sign(null, bytes, createPrivateKey({ key: saved, format: "jwk" }));
    const trusted = [
      { kid: saved.kid, role: "backup", generation: 7, added: "2026-10-26", jwk: publicJwk },
    ] as const;
    expect(
      await core.checkDirectorySignature(bytes, signature.toString("base64url"), trusted, 7),
    ).toEqual({ ok: true, kid: saved.kid, generation: 7 });

    // A second run the same day refuses to overwrite.
    const again = run("--role", "backup", "--generation", "7", "--out-dir", outDir);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("refusing to overwrite");
    expect(readdirSync(outDir)).toEqual([file]);
  });

  it("refuses a folder inside a git working tree, and bad arguments", () => {
    const inside = run(
      "--role",
      "backup",
      "--generation",
      "2",
      "--out-dir",
      join(REPO, "tmp-keys"),
    );
    expect(inside.status).toBe(1);
    expect(inside.stderr).toContain("inside a git working tree");
    expect(statSync(REPO).isDirectory()).toBe(true);
    expect(readdirSync(REPO)).not.toContain("tmp-keys");

    const outDir = join(scratch, "bad-arguments");
    expect(run("--role", "spare", "--generation", "2", "--out-dir", outDir).stderr).toContain(
      "--role",
    );
    for (const generation of ["0", "2.5", "-1", "two"]) {
      const result = run("--role", "backup", "--generation", generation, "--out-dir", outDir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("--generation");
    }
    expect(readdirSync(scratch)).not.toContain("bad-arguments");
  });
});
