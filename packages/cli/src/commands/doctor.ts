import type { webcrypto } from "node:crypto";
import { isIP } from "node:net";
import { DEBUG_PATH, DEBUG_TOKEN_HEADER, type DebugReport } from "@posterna/core";
import { sign } from "web-bot-auth";
import { signerFromJWK } from "web-bot-auth/crypto";
import { VERSION } from "../index";
import { baseUrl, type Io } from "../io";
import { INSTALL_GUIDE } from "./init";

export interface DoctorFlags {
  url?: string;
  baseUrl?: string;
}

type Status = "pass" | "warn" | "fail" | "skip";
interface Check {
  name: string;
  status: Status;
  detail: string;
  fix?: string;
}

const PROXY_SETTINGS = `${INSTALL_GUIDE}#trusted-proxies`;
const HEALTH_CHECKS = `${INSTALL_GUIDE}#health-checks`;
const CLOUDFRONT = `${INSTALL_GUIDE}#cloudfront`;
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
const FORGED_FORWARDING = { "x-forwarded-for": FORGED_CLIENT, "x-forwarded-host": FORGED_HOST };

/** Error codes meaning the host has no address in the family asked for. */
const NO_ADDRESS = new Set(["ENOTFOUND", "ENODATA", "EAI_NODATA", "EAI_NONAME", "EAI_ADDRFAMILY"]);
/** Error codes meaning this machine cannot use the family at all. */
const NO_ROUTE = new Set(["ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL", "EAFNOSUPPORT"]);
const TIMED_OUT = new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "TimeoutError", "AbortError"]);

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const own = (error as { code?: unknown }).code;
  const cause = (error.cause as { code?: unknown } | undefined)?.code;
  const code = typeof own === "string" ? own : typeof cause === "string" ? cause : undefined;
  return code ?? (TIMED_OUT.has(error.name) ? error.name : undefined);
}

/** An error message with its code, for example "fetch failed, ENOTFOUND". */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = errorCode(error);
  return code && !error.message.includes(code) ? `${error.message}, ${code}` : error.message;
}

type Whoami = { ip: string } | { failure: string };

/** This machine's public address, as the Posterna cloud sees it. */
async function whoami(fetchImpl: typeof fetch, cloud: string): Promise<Whoami> {
  const url = `${cloud}whoami`;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    const text = await response.text();
    try {
      const body = JSON.parse(text) as { ip?: unknown } | null;
      if (response.ok && typeof body?.ip === "string") return { ip: body.ip };
    } catch {
      // Not JSON: not Posterna's whoami.
    }
    const type = response.headers.get("content-type")?.split(";")[0]?.trim();
    return {
      failure: `${url} answered ${response.status}${type ? ` (${type})` : ""} without an address, so the request did not reach Posterna`,
    };
  } catch (error) {
    return { failure: `${url} could not be reached (${describe(error)})` };
  }
}

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
  const label = { pass: "PASS", warn: "WARN", fail: "FAIL", skip: "SKIP" }[check.status];
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
  const cloudHost = new URL(cloud).host;

  // A signed request to the debug route, with forged forwarding headers a
  // correct setup ignores.
  const target = new URL(DEBUG_PATH, site);
  const probe = async (
    fetchImpl: typeof fetch,
    forged: Record<string, string>,
  ): Promise<{ report: DebugReport | null; failure: string; error?: unknown }> => {
    try {
      const response = await fetchImpl(target, {
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
      return { report: null, failure: `the request failed (${describe(error)})`, error };
    }
  };
  const { report, failure } = await probe(io.fetch, FORGED_FORWARDING);

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

  // Client IP resolution. With clientIpHeader, forge that header too: it is
  // safe only if the host overwrites it.
  const header = report.client.header;
  const clientIp = async (
    name: string,
    fetchImpl: typeof fetch,
    seenReport: DebugReport,
  ): Promise<Check> => {
    const mine = await whoami(fetchImpl, cloud);
    const forgedHeader = header
      ? (await probe(fetchImpl, { [header]: FORGED_CLIENT })).report
      : null;
    return clientIpCheck(name, seenReport, mine, forgedHeader, cloudHost);
  };

  let familyChecks: Check[] = [];
  if (io.fetchOver) {
    const literal = isIP(site.hostname.replace(/^\[|\]$/g, ""));
    for (const family of [4, 6] as const) {
      const name = `Client IP (IPv${family})`;
      if (literal && literal !== family) {
        familyChecks.push({
          name,
          status: "skip",
          detail: `not checked: the site's address is IPv${literal}.`,
        });
        continue;
      }
      const fetchImpl = io.fetchOver(family);
      const attempt = await probe(fetchImpl, FORGED_FORWARDING);
      familyChecks.push(
        attempt.report
          ? await clientIp(name, fetchImpl, attempt.report)
          : unreachable(name, family, target, attempt),
      );
    }
    // Both families failed to connect: the per-family fetch itself may not
    // work here, so fall back to the single check below.
    if (familyChecks.every((check) => check.status === "skip") && !literal) familyChecks = [];
  }
  if (familyChecks.length > 0) checks.push(...familyChecks);
  else checks.push(await clientIp("Client IP", io.fetch, report));

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
          fix: `A proxy, CDN or firewall in front of the app removes them. Allow these request headers through. On CloudFront, set the origin request policy to AllViewerExceptHostHeader: ${CLOUDFRONT}`,
        },
  );

  // The policy the site loaded.
  const policy = report.policy;
  if (policy && policy.source !== "unknown") {
    checks.push(
      policy.source === "fallback"
        ? {
            name: "Policy",
            status: "fail",
            detail: `your policy was not loaded, so a built-in monitor policy without your rules is in use. The server said: ${(policy.problem ?? "no reason given").split("\n")[0]}`,
            fix: policyFix(policy.problem ?? "", report.posterna.adapter),
          }
        : {
            name: "Policy",
            status: "pass",
            detail: `${policy.source === "file" ? "agents.yaml" : "the policy in the adapter options"} is in use${policy.hash ? ` (${policy.hash})` : ""}.`,
          },
    );
  }

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
      fix: `Set trustedProxies for your host (${PROXY_SETTINGS}). On a quiet site, load balancer health checks can cause this too: keep them out of Posterna (${HEALTH_CHECKS}).`,
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

const BUILD_IN_POLICY =
  "With the latest @posterna/next, wrap next.config in withPosternaConfig from @posterna/next/config, so agents.yaml is built into the proxy, and deploy again.";

/** The fix for a policy that fell back, from the reason the server gave. */
function policyFix(problem: string, adapter: string): string {
  const next = adapter === "@posterna/next";
  if (problem.includes("Node 20.16"))
    return next
      ? `${BUILD_IN_POLICY} Or run the server on Node.js 20.16 or later.`
      : "Run the server on Node.js 20.16 or later, or pass the policy text as `policy`.";
  if (problem.startsWith("No policy file"))
    return next
      ? `${BUILD_IN_POLICY} \`posterna init\` writes agents.yaml if there is none.`
      : "Put agents.yaml in the folder the server starts in, or set POSTERNA_POLICY to its path. `posterna init` writes one.";
  if (problem.includes("invalid"))
    return "Run `posterna policy check` on agents.yaml and fix what it reports.";
  return "Check the [posterna] lines in the server log.";
}

/** A family whose request to the debug route did not get a Posterna report. */
function unreachable(
  name: string,
  family: 4 | 6,
  target: URL,
  attempt: { failure: string; error?: unknown },
): Check {
  const records = family === 4 ? "A" : "AAAA";
  if (attempt.error === undefined) {
    return {
      name,
      status: "fail",
      detail: `over IPv${family}, ${target.href} ${attempt.failure.replace(/^it /, "")}, so IPv${family} visitors reach a different server.`,
      fix: `Check the site's ${records} DNS records: they should point at the same host as the rest of the site.`,
    };
  }
  const code = errorCode(attempt.error);
  if (code && NO_ADDRESS.has(code))
    return { name, status: "skip", detail: `not checked: the site has no IPv${family} address.` };
  if (code && NO_ROUTE.has(code))
    return {
      name,
      status: "skip",
      detail: `not checked: this machine has no IPv${family} route. Run doctor from a network with IPv${family} to check it.`,
    };
  if (code && TIMED_OUT.has(code))
    return {
      name,
      status: "skip",
      detail: `not checked: the request over IPv${family} timed out, which usually means this machine's IPv${family} does not work.`,
    };
  return {
    name,
    status: "warn",
    detail: `over IPv${family}, ${attempt.failure}.`,
    fix: `If other sites work over IPv${family} from this machine, check the site's ${records} DNS records.`,
  };
}

/** Compares the address the site saw with this machine's public address. */
function clientIpCheck(
  name: string,
  report: DebugReport,
  mine: Whoami,
  forgedHeader: DebugReport | null,
  cloudHost: string,
): Check {
  const seen = report.client.address;
  const header = report.client.header;
  if (header && forgedHeader?.client.address === FORGED_CLIENT) {
    return {
      name,
      status: "fail",
      detail: `the app believed a ${header} header that doctor forged (${FORGED_CLIENT}): your host does not overwrite it, so any client can claim any address.`,
      fix: `Remove clientIpHeader and set trustedProxies for your host. See ${PROXY_SETTINGS}`,
    };
  }
  if (seen === FORGED_CLIENT) {
    return {
      name,
      status: "fail",
      detail: `the app believed an X-Forwarded-For entry that doctor forged (${FORGED_CLIENT}), so any client can claim any address.`,
      fix: `trustedProxies counts more proxies than there are in front of the app, or a listed range includes clients. See ${PROXY_SETTINGS}`,
    };
  }
  if ("failure" in mine) {
    return {
      name,
      status: "warn",
      detail: `the site sees ${seen ?? "no address"} (from ${report.client.source}), but this machine's public address could not be learned: ${mine.failure}.`,
      fix: `Compare it with your public address yourself. If this network's DNS still has an old address for ${cloudHost}, run doctor from another network, or pass --base-url.`,
    };
  }
  const publicIp = mine.ip;
  if (seen === publicIp) {
    return {
      name,
      status: "pass",
      detail: `the site sees ${seen}, this machine's public address.`,
    };
  }
  if (seen && seen.includes(":") !== publicIp.includes(":")) {
    return {
      name,
      status: "warn",
      detail: `the site sees ${seen} and whoami saw ${publicIp}: one is IPv4 and the other IPv6, so they cannot be compared.`,
      fix: "Run doctor from a machine with only IPv4 or only IPv6, or compare the addresses yourself.",
    };
  }
  return {
    name,
    status: "fail",
    detail: `the site sees ${seen ?? "no address"} (from ${report.client.source}), but this machine is ${publicIp}.`,
    fix:
      seen === null
        ? `Set clientIpHeader or trustedProxies for your host (Next.js never sees the socket address). See ${PROXY_SETTINGS}`
        : isPrivate(seen)
          ? `The app sees its proxy's address. Set clientIpHeader or trustedProxies for your host. See ${PROXY_SETTINGS}`
          : `Another proxy or CDN is in front of the app. Count it in trustedProxies, or list its address ranges. See ${PROXY_SETTINGS}`,
  };
}
