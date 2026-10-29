import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectHost } from "./commands/init";

// `posterna init` prints the same client-address setting as the docs, which
// come from docs/data/hosts.json. This keeps the two from drifting.
const hostsFile = JSON.parse(
  readFileSync(new URL("../../../docs/data/hosts.json", import.meta.url), "utf8"),
) as { hosts: { id: string; lines: string[] }[] };

const configFile: Record<string, string> = {
  railway: "railway.json",
  vercel: "vercel.json",
  fly: "fly.toml",
  render: "render.yaml",
};

describe("init's host settings", () => {
  it.each(Object.entries(configFile))("match docs/data/hosts.json for %s", (id, file) => {
    const dir = mkdtempSync(join(tmpdir(), "posterna-hosts-"));
    writeFileSync(join(dir, file), "");
    const host = detectHost(dir);
    expect(host).not.toBeNull();
    const line = `${host?.option},${host?.note ? ` // ${host.note}` : ""}`;
    expect(hostsFile.hosts.find((entry) => entry.id === id)?.lines).toEqual([line]);
  });
});
