import { promises as dns, type LookupAddress } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, type LookupFunction } from "node:net";

/** Doctor reads small JSON answers; anything larger is not a Posterna report. */
const MAX_BODY_BYTES = 1_000_000;

/** Resolves a host name to its addresses in one family, as `dns.lookup` does. */
export type Resolve = (hostname: string, family: 4 | 6) => Promise<LookupAddress[]>;

const systemResolve: Resolve = (hostname, family) => dns.lookup(hostname, { family, all: true });

/** IPv4-mapped IPv6 addresses (::ffff:0:0/96): a connection to one goes out over IPv4. */
const IPV4_MAPPED = new BlockList();
IPV4_MAPPED.addSubnet("::ffff:0:0", 96, "ipv6");

/**
 * A lookup for `http.request` that returns addresses in one family only. On
 * macOS, an IPv6 lookup for a host with no IPv6 address returns IPv4-mapped
 * addresses (`::ffff:a.b.c.d`), which would send the "IPv6" request over IPv4,
 * so those are dropped. When nothing is left it fails with ENODATA, the code a
 * lookup for a missing record gives.
 */
export function familyLookup(family: 4 | 6, resolveHost: Resolve = systemResolve): LookupFunction {
  return (hostname, options, callback) => {
    resolveHost(hostname, family).then(
      (found) => {
        const usable = found.filter(
          (entry) =>
            entry.family === family && !(family === 6 && IPV4_MAPPED.check(entry.address, "ipv6")),
        );
        const first = usable[0];
        if (!first) callback(noAddress(hostname, family), "");
        else if (options.all) callback(null, usable);
        else callback(null, first.address, first.family);
      },
      (error: NodeJS.ErrnoException) => callback(error, ""),
    );
  };
}

function noAddress(hostname: string, family: 4 | 6): NodeJS.ErrnoException {
  return Object.assign(new Error(`${hostname} has no IPv${family} address`), {
    code: "ENODATA",
    syscall: "getaddrinfo",
    hostname,
  });
}

/**
 * A minimal `fetch` that connects over one address family only, so doctor can
 * check IPv4 and IPv6 separately. It never follows redirects, supports the
 * `method`, `headers` and `signal` options doctor uses, and rejects when the
 * host has no address in that family or this machine has no route to it.
 * `resolveHost` replaces the system lookup in tests.
 */
export function familyFetch(family: 4 | 6, resolveHost: Resolve = systemResolve): typeof fetch {
  const lookup = familyLookup(family, resolveHost);
  const fetchOver = (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise<Response>((resolve, reject) => {
      const request = send(
        url,
        {
          method: init.method ?? "GET",
          headers,
          family,
          lookup,
          signal: init.signal ?? undefined,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) request.destroy(new Error("the response was too large"));
            else chunks.push(chunk);
          });
          response.on("end", () => {
            const status = response.statusCode ?? 502;
            const answer = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              if (value === undefined) continue;
              for (const item of Array.isArray(value) ? value : [value]) answer.append(name, item);
            }
            const empty = status === 204 || status === 304;
            resolve(
              new Response(empty ? null : Buffer.concat(chunks), { status, headers: answer }),
            );
          });
          response.on("error", reject);
        },
      );
      request.on("error", reject);
      request.end();
    });
  };
  return fetchOver as typeof fetch;
}
