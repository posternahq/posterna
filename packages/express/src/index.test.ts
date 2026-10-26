import { describe, expect, it } from "vitest";
import pkg from "../package.json";
import { VERSION } from "./index";

describe("@posterna/express", () => {
  it("exports the version from package.json", () => {
    expect(VERSION).toBe(pkg.version);
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/);
  });
});
