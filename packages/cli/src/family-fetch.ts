import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/** Doctor reads small JSON answers; anything larger is not a Posterna report. */
const MAX_BODY_BYTES = 1_000_000;

/**
 * A minimal `fetch` that connects over one address family only, so doctor can
 * check IPv4 and IPv6 separately. It never follows redirects, supports the
 * `method`, `headers` and `signal` options doctor uses, and rejects when the
 * host has no address in that family or this machine has no route to it.
 */
export function familyFetch(family: 4 | 6): typeof fetch {
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
        { method: init.method ?? "GET", headers, family, signal: init.signal ?? undefined },
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
