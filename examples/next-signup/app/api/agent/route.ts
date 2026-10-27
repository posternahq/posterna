import { headers } from "next/headers";

// What Posterna told the app about this request.
export async function GET() {
  const request = await headers();
  return Response.json({
    verdict: request.get("x-agent-verdict"),
    operator: request.get("x-agent-operator"),
    purpose: request.get("x-agent-purpose"),
    method: request.get("x-agent-method"),
    forged: request.get("x-posterna-action"),
  });
}
