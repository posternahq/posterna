import type { IncomingMessage } from "node:http";

/** A Fetch API Request, or a Node IncomingMessage. */
export type RequestLike = Request | IncomingMessage;

export interface Field {
  /** Lowercase field name. */
  name: string;
  value: string;
}

/** The parts of a request the verifier reads, the same for both request types. */
export interface NormalizedRequest {
  method: string;
  /** Path and query, for example `/docs?page=2`. */
  target: string;
  /** Header fields in arrival order, without inbound X-Agent-* and X-Posterna-* fields. */
  fields: Field[];
  /** The TCP peer, when known. */
  remoteAddress: string | null;
  /** Scheme and host as the server saw them, before any proxy configuration applies. */
  urlScheme: "http" | "https" | null;
  urlHost: string | null;
  /** Lowercase names of the inbound X-Agent-* and X-Posterna-* fields that were dropped. */
  stripped: string[];
}

/** True for header names a client must never be able to set (docs/SPEC.md section 4.7). */
export function isInboundVerdictHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("x-agent-") || lower.startsWith("x-posterna-");
}

function isFetchRequest(input: RequestLike): input is Request {
  return typeof (input as Request).headers?.get === "function" && typeof input.url === "string";
}

function splitTarget(raw: string): {
  target: string;
  scheme: "http" | "https" | null;
  host: string | null;
} {
  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    return {
      target: `${url.pathname}${url.search}`,
      scheme: url.protocol === "https:" ? "https" : "http",
      host: url.host,
    };
  }
  return { target: raw.startsWith("/") ? raw : `/${raw}`, scheme: null, host: null };
}

/**
 * Reads a Fetch Request or Node IncomingMessage into one shape, dropping
 * inbound verdict headers before anything else can read them.
 *
 * @param remoteAddress - The TCP peer for Fetch requests, which do not carry it.
 */
export function normalizeRequest(
  input: RequestLike,
  remoteAddress?: string | null,
): NormalizedRequest {
  const fields: Field[] = [];
  const stripped = new Set<string>();
  const add = (name: string, value: string) => {
    const lower = name.toLowerCase();
    if (isInboundVerdictHeader(lower)) stripped.add(lower);
    else fields.push({ name: lower, value });
  };

  if (isFetchRequest(input)) {
    input.headers.forEach((value, name) => {
      add(name, value);
    });
    const url = splitTarget(input.url);
    return {
      method: input.method.toUpperCase(),
      target: url.target,
      fields,
      remoteAddress: remoteAddress ?? null,
      urlScheme: url.scheme,
      urlHost: url.host,
      stripped: [...stripped].sort(),
    };
  }

  const raw = input.rawHeaders;
  if (Array.isArray(raw) && raw.length > 0) {
    for (let i = 0; i + 1 < raw.length; i += 2) add(raw[i] as string, raw[i + 1] as string);
  } else {
    for (const [name, value] of Object.entries(input.headers ?? {})) {
      if (Array.isArray(value)) for (const item of value) add(name, item);
      else if (typeof value === "string") add(name, value);
    }
  }
  const url = splitTarget(input.url ?? "/");
  const socket = input.socket as (IncomingMessage["socket"] & { encrypted?: boolean }) | undefined;
  return {
    method: (input.method ?? "GET").toUpperCase(),
    target: url.target,
    fields,
    remoteAddress: remoteAddress ?? socket?.remoteAddress ?? null,
    urlScheme: url.scheme ?? (socket?.encrypted ? "https" : "http"),
    urlHost: url.host,
    stripped: [...stripped].sort(),
  };
}

/** All values of a field, in order. */
export function fieldValues(request: NormalizedRequest, name: string): string[] {
  return request.fields.filter((field) => field.name === name).map((field) => field.value);
}

/** A field's values joined with ", " as HTTP combines repeated field lines, or undefined. */
export function fieldValue(request: NormalizedRequest, name: string): string | undefined {
  const values = fieldValues(request, name);
  return values.length > 0 ? values.join(", ") : undefined;
}
