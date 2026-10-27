import type { webcrypto } from "node:crypto";
import { DEBUG_PATH, DEBUG_TOKEN_HEADER, type DebugReport } from "@posterna/core";
import { sign } from "web-bot-auth";
import { signerFromJWK } from "web-bot-auth/crypto";
import { VERSION } from "../index";
import { baseUrl, type Io } from "../io";

export interface DoctorFlags {
  url?: string;
  baseUrl?: string;
}

type Status = "pass" | "warn" | "fail";
interface Check {
  name: string;
  status: Status;
  detail: string;
  fix?: string;
}

const GUIDE = "https://github.com/posternahq/posterna/blob/main/docs/install.md";
/** The Signature-Agent the doctor request names. The site never fetches it. */
const DOCTOR_AGENT = "https://posterna.com";
const DIRECTORY_MAX_AGE_DAYS = 7;
/**
 * Forged forwarding headers sent with the doctor request. A correct setup
 * ignores both: the address is in a documentation range and the host is
 * reserved, so neither can be anyone's real value.
 */
export const FORGED_CLIENT = "192.0.2.1";
export const FORGED_HOST = "doctor.invalid";

function isPrivate(address: string): boolean {
  return (
    /^(10\.|127\.|192\.168\.|169\.254\.|0\.)/.test(address) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address) ||
    /^(::1$|fc|fd|fe80:)/i.test(address)
  );
}

/** Signs a GET of the debug route with a throwaway Ed25519 key, as an agent would. */
async function signedHeaders(target: URL, now: number): Promise<Record<string, string>> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as webcrypto.CryptoKeyPair;
  const exported = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as webcrypto.JsonWebKey;
  // Newer runtimes export alg "Ed25519"; the library accepts only "EdDSA" or none, so leave it out.
  const signer = await signerFromJWK({
    kty: exported.kty,
    crv: exported.crv,
    x: exported.x,
    d: exported.d,
  });
  const agent = `sig1="${DOCTOR_AGENT}"`;
  const nonce = new Uint8Array(64);
  crypto.getRandomValues(nonce);
  const seconds = Math.floor(now / 1000);
  const fields = await sign(
    {
      kind: "request",
      method: "GET",
      targetUri: target.href,
      fields: [{ name: "signature-agent", value: agent }],
    },
    {
      signer,
      created: new Date((seconds - 1) * 1000),
      expires: new Date((seconds + 60) * 1000),
      nonce: Buffer.from(nonce).toString("base64"),
    },
  );
  return {
    "signature-agent": agent,
    signature: fields.signature,
    "signature-input": fields.signatureInput,
  };
}

function print(io: Io, check: Check): void {
  const label = { pass: "PASS", warn: "WARN", fail: "FAIL" }[check.status];
  io.out(`${label}  ${check.name}: ${check.detail}`);
  if (check.fix) io.out(`      Fix: ${check.fix}`);
}

/** `posterna doctor --url <site>` (docs/SPEC.md section 8). */
export async function doctor(io: Io, flags: DoctorFlags): Promise<number> {
  if (!flags.url) {
    io.err("Usage: posterna doctor --url https://your-site.example");
    return 1;
  }
  let site: URL;
  try {
    site = new URL(flags.url);
    if (site.protocol !== "https:" && site.protocol !== "http:") throw new Error("not http");
  } catch {
    io.err(`"${flags.url}" is not an http or https URL.`);
    return 1;
  }
  const token = io.env.POSTERNA_DEBUG_TOKEN?.trim();
  if (!token) {
    io.err(
      "Set POSTERNA_DEBUG_TOKEN here to the same value as on the server, then run doctor again.",
    );
    io.err("The debug route only answers requests carrying that token.");
    return 1;
  }

  const checks: Check[] = [];
  const cloud = baseUrl(flags.baseUrl, io.env);

  // 1. This machine's public address, as the cloud sees it.
  let publicIp: string | null = null;
  try {
    const response = await io.fetch(`${cloud}whoami`, { signal: AbortSignal.timeout(10_000) });
    const body = (await response.json()) as { ip?: unknown };
    if (response.ok && typeof body.ip === "string") publicIp = body.ip;
  } catch {
    publicIp = null;
  }

  // 2. A signed request to the debug route, with forged forwarding headers a
  // correct setup ignores.
  const target = new URL(DEBUG_PATH, site);
  const probe = async (
    forged: Record<string, string>,
  ): Promise<{ report: DebugReport | null; failure: string }> => {
    try {
      const response = await io.fetch(target, {
        headers: {
          "user-agent": `posterna-doctor/${VERSION}`,
          accept: "application/json",
          [DEBUG_TOKEN_HEADER]: token,
          ...forged,
          ...(await signedHeaders(target, io.now())),
        },
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      try {
        const parsed = JSON.parse(text) as DebugReport;
        if (response.ok && parsed?.posterna?.adapter) return { report: parsed, failure: "" };
      } catch {
        // Not a Posterna report.
      }
      return { report: null, failure: `it answered ${response.status} without a Posterna report` };
    } catch (error) {
      return {
        report: null,
        failure: `the request failed (${error instanceof Error ? error.message : String(error)})`,
      };
    }
  };
  const { report, failure } = await probe({
    "x-forwarded-for": FORGED_CLIENT,
    "x-forwarded-host": FORGED_HOST,
  });

  if (!report) {
    print(io, {
      name: "Debug route",
      status: "fail",
      detail: `${target.href}: ${failure}.`,
      fix: "Set POSTERNA_DEBUG_TOKEN on the server to the same value and redeploy. With Next.js, make sure the matcher in proxy.ts or middleware.ts covers /.well-known/posterna/debug.",
    });
    return 1;
  }
  checks.push({
    name: "Debug route",
    status: "pass",
    detail: `${report.posterna.adapter} ${report.posterna.version} answered.`,
  });

  // Client IP resolution.
  const seen = report.client.address;
  // With clientIpHeader, forge that header too: it is safe only if the host overwrites it.
  const header = report.client.header;
  const forgedHeader = header ? (await probe({ [header]: FORGED_CLIENT })).report : null;
  if (header && forgedHeader?.client.address === FORGED_CLIENT) {
    checks.push({
      name: "Client IP",
      status: "fail",
      detail: `the app believed a ${header} header that doctor forged (${FORGED_CLIENT}): your host does not overwrite it, so any client can claim any address.`,
      fix: `Remove clientIpHeader and set trustedProxies for your host. See ${GUIDE}#trusted-proxies`,
    });
  } else if (seen === FORGED_CLIENT) {
    checks.push({
      name: "Client IP",
      status: "fail",
      detail: `the app believed an X-Forwarded-For entry that doctor forged (${FORGED_CLIENT}), so any client can claim any address.`,
      fix: `trustedProxies counts more proxies than there are in front of the app, or a listed range includes clients. See ${GUIDE}#trusted-proxies`,
    });
  } else if (publicIp === null) {
    checks.push({
      name: "Client IP",
      status: "warn",
      detail: `the site sees ${seen ?? "no address"} (from ${report.client.source}), but this machine's public address could not be learned from ${cloud}whoami.`,
      fix: "Compare it with your public address yourself.",
    });
  } else if (seen === publicIp) {
    checks.push({
      name: "Client IP",
      status: "pass",
      detail: `the site sees ${seen}, this machine's public address.`,
    });
  } else if (seen && seen.includes(":") !== publicIp.includes(":")) {
    checks.push({
      name: "Client IP",
      status: "warn",
      detail: `the site sees ${seen} and whoami saw ${publicIp}: one is IPv4 and the other IPv6, so they cannot be compared.`,
      fix: "Run doctor from a machine with only IPv4 or only IPv6, or compare the addresses yourself.",
    });
  } else {
    checks.push({
      name: "Client IP",
      status: "fail",
      detail: `the site sees ${seen ?? "no address"} (from ${report.client.source}), but this machine is ${publicIp}.`,
      fix:
        seen === null
          ? `Set clientIpHeader or trustedProxies for your host (Next.js never sees the socket address). See ${GUIDE}#trusted-proxies`
          : isPrivate(seen)
            ? `The app sees its proxy's address. Set clientIpHeader or trustedProxies for your host. See ${GUIDE}#trusted-proxies`
            : `Another proxy or CDN is in front of the app. Count it in trustedProxies, or list its address ranges. See ${GUIDE}#trusted-proxies`,
    });
  }

  // The host agents sign.
  const expectedHost = site.host.toLowerCase();
  checks.push(
    report.authority.host === FORGED_HOST
      ? {
          name: "Signed host",
          status: "fail",
          detail: `the app took the signed host from an X-Forwarded-Host that doctor forged (${FORGED_HOST}). Any client can choose the host signatures are checked against.`,
          fix: `Your proxy passes a client's X-Forwarded-Host through. Remove trustForwardedHost and set publicHost: "${expectedHost}" in the Posterna options.`,
        }
      : report.authority.host === expectedHost
        ? {
            name: "Signed host",
            status: "pass",
            detail: `signatures are checked against ${expectedHost}.`,
          }
        : {
            name: "Signed host",
            status: "fail",
            detail: `agents sign ${expectedHost}, but the app checks ${report.authority.host ?? "no host"} (from ${report.authority.source}).`,
            fix: `Set publicHost: "${expectedHost}" in the Posterna options, or have your proxy pass the original Host header.`,
          },
  );

  // Signature headers through the proxies.
  const missing = ["signature", "signature-input", "signature-agent"].filter(
    (name) => !report.signatureHeaders.includes(name),
  );
  checks.push(
    missing.length === 0
      ? {
          name: "Signature headers",
          status: "pass",
          detail: "Signature, Signature-Input and Signature-Agent reach the app.",
        }
      : {
          name: "Signature headers",
          status: "fail",
          detail: `${missing.join(", ")} did not reach the app.`,
          fix: "A proxy, CDN or firewall in front of the app removes them. Allow these request headers through.",
        },
  );

  // Directory freshness.
  const version = report.directory.directoryVersion;
  const age = version
    ? Math.floor((io.now() - Date.parse(`${version}T00:00:00Z`)) / 86_400_000)
    : null;
  if (!report.directory.ready || age === null) {
    checks.push({
      name: "Directory",
      status: "fail",
      detail: "the operator directory is not loaded.",
      fix: "Check that @posterna/directory is installed and the server logs for [posterna] errors.",
    });
  } else if (age > DIRECTORY_MAX_AGE_DAYS) {
    checks.push({
      name: "Directory",
      status: "warn",
      detail: `version ${version} is ${age} days old.`,
      fix: "Update @posterna/directory, and allow outbound HTTPS to posterna.com so the server refreshes it.",
    });
  } else {
    checks.push({
      name: "Directory",
      status: "pass",
      detail: `version ${version}, keys ${report.directory.keysVersion ?? "none"}.`,
    });
  }

  // Mode and suspensions.
  const suspensions = report.suspensions;
  if (suspensions.includes("proxy")) {
    checks.push({
      name: "Mode",
      status: "fail",
      detail:
        "enforcement is suspended: most requests seem to come from internal addresses (proxy guard).",
      fix: `Set trustedProxies for your host. See ${GUIDE}#trusted-proxies`,
    });
  } else {
    const notes = [
      ...(suspensions.includes("env") ? ["POSTERNA_MODE=monitor is set"] : []),
      ...(suspensions.includes("remote")
        ? ["the Posterna dashboard switched this site to monitor"]
        : []),
      ...(report.breakerTripped.length > 0
        ? [`the breaker is tripped for ${report.breakerTripped.join(", ")}`]
        : []),
    ];
    checks.push({
      name: "Mode",
      status: notes.length > 0 ? "warn" : "pass",
      detail: `${report.mode} (agents.yaml says ${report.configuredMode})${notes.length > 0 ? `; ${notes.join("; ")}` : ""}.`,
    });
  }

  for (const check of checks) print(io, check);
  const failed = checks.filter((check) => check.status === "fail").length;
  io.out("");
  io.out(
    failed === 0
      ? "Everything Posterna needs is in place."
      : `${failed} check${failed === 1 ? "" : "s"} failed.`,
  );
  return failed === 0 ? 0 : 1;
}
