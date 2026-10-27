import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SignatureErrorCode } from "http-message-sig";
import { describe, expect, it } from "vitest";
import type { DirectoryFile, KeysFile } from "../directory/types";
import { rejectionReason } from "./signature-path";
import { REASON_CODES } from "./types";
import { createVerifier } from "./verifier";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const json = <T>(...parts: string[]) => JSON.parse(readFileSync(join(REPO, ...parts), "utf8")) as T;
const fixtureDirectory = json<DirectoryFile>("conformance", "fixtures", "directory.json");
const fixtureKeys = json<KeysFile>("conformance", "fixtures", "keys.json");
const BROWSER = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  accept: "text/html",
  "accept-language": "en-US",
};

describe("reason codes", () => {
  it("are unique lowercase identifiers", () => {
    expect(new Set(REASON_CODES).size).toBe(REASON_CODES.length);
    for (const code of REASON_CODES) expect(code).toMatch(/^[a-z][a-z_]*$/);
  });

  it("map the signature library's rejections", () => {
    expect(rejectionReason(SignatureErrorCode.VerificationFailed, "x")).toBe("signature_invalid");
    expect(rejectionReason(SignatureErrorCode.PolicyViolation, "Signature has expired")).toBe(
      "expired",
    );
    expect(rejectionReason(SignatureErrorCode.PolicyViolation, "Signature is too old")).toBe(
      "expired",
    );
    expect(
      rejectionReason(SignatureErrorCode.PolicyViolation, "Signature was created in the future"),
    ).toBe("created_in_future");
    expect(
      rejectionReason(
        SignatureErrorCode.PolicyViolation,
        "nonce must be canonical base64 or unpadded base64url encoding of 64 bytes",
      ),
    ).toBe("nonce_rejected");
    expect(rejectionReason(SignatureErrorCode.PolicyViolation, "tag must be 'web-bot-auth'")).toBe(
      "profile_rejected",
    );
    expect(rejectionReason(SignatureErrorCode.AlgorithmMismatch, "x")).toBe("profile_rejected");
    expect(rejectionReason(SignatureErrorCode.MalformedField, "Malformed Signature-Input")).toBe(
      "malformed_signature",
    );
    expect(rejectionReason(SignatureErrorCode.LabelMismatch, "x")).toBe("malformed_signature");
  });

  it("label the remaining verifier outcomes", async () => {
    // A community token that is an ordinary word, on an otherwise ordinary browser request.
    const community = fixtureDirectory.operators.find(
      (operator) => operator.slug === "community-operator",
    );
    if (!community) throw new Error("fixture is missing community-operator");
    const directory: DirectoryFile = {
      ...fixtureDirectory,
      operators: [
        ...fixtureDirectory.operators.filter((operator) => operator !== community),
        {
          ...community,
          agents: [
            ...community.agents,
            {
              ...(community.agents[0] as DirectoryFile["operators"][number]["agents"][number]),
              name: "Lantern",
              user_agent_tokens: ["Lantern"],
              aliases: [],
              robots_token: "Lantern",
            },
          ],
        },
      ],
    };
    const verifier = createVerifier({
      dns: null,
      now: () => Date.parse("2026-10-26T12:00:00Z"),
      directory: { snapshot: () => ({ directory, keys: fixtureKeys }), refresh: false },
    });
    try {
      const browserWithToken = await verifier.verify(
        new Request("https://www.site.example/", {
          headers: { ...BROWSER, "user-agent": `${BROWSER["user-agent"]} Lantern/2.1` },
        }),
        { remoteAddress: "203.0.113.5" },
      );
      expect(browserWithToken).toMatchObject({
        verdict: "declared_unverifiable",
        agent: "Lantern",
        reason: "community_token_on_browser",
      });

      const noAddress = await verifier.verify(
        new Request("https://www.site.example/", {
          headers: { "user-agent": "Mozilla/5.0 (compatible; ExampleBot/1.0)" },
        }),
      );
      expect(noAddress).toMatchObject({
        verdict: "declared_unverifiable",
        reason: "no_client_address",
      });

      const hostile = new Proxy(
        {},
        {
          get() {
            throw new Error("boom");
          },
        },
      );
      const broken = await verifier.verify(hostile as Request);
      expect(broken).toMatchObject({ verdict: "unknown_automation", reason: "unexpected_error" });
      expect(broken.error).toBeDefined();

      const person = await verifier.verify(
        new Request("https://www.site.example/", { headers: BROWSER }),
        {
          remoteAddress: "203.0.113.6",
        },
      );
      expect(person).toEqual({ verdict: "human", method: "none" });
    } finally {
      verifier.close();
    }
  });
});
