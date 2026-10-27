import { createPosterna, type Posterna } from "@posterna/next";
import type { NextRequest } from "next/server";

// Route handlers run in a different bundle from middleware, so they verify the
// request themselves. Counting is left to the middleware, which already
// counted this request.
let posterna: Posterna | null = null;
const instance = () => {
  posterna ??= createPosterna({
    trustedProxies: 1,
    publicHost: process.env.PUBLIC_HOST || undefined,
    counters: false,
  });
  return posterna;
};

export async function POST(request: NextRequest) {
  const agents = instance();
  const result = await agents.verify(request);
  // Posterna recommends; this route decides. The recommendation counts only
  // when `enforced` is true: agents.yaml is in enforce mode and nothing has
  // suspended enforcement.
  const decision = agents.decide(result, { path: "/api/signup", kind: "signup" });
  const action = decision.enforced ? decision.action : "allow";

  switch (action) {
    case "lift":
      // A verified agent acting for a person: skip the email confirmation step.
      return Response.json({ created: true, emailConfirmation: "skipped", recommendation: action });

    case "cap":
      // An agent that cannot be verified: create the account under your own limits.
      return Response.json({
        created: true,
        limits: { projects: 1, requestsPerDay: 100 },
        recommendation: action,
      });

    case "challenge":
      // ------------------------------------------------------------------
      // PLACEHOLDER: hand the request to your existing CAPTCHA here
      // (Turnstile, hCaptcha, reCAPTCHA, an email or SMS code, ...).
      // Posterna never builds a challenge of its own.
      // ------------------------------------------------------------------
      return Response.json(
        { created: false, challenge: "required", recommendation: action },
        { status: 403 },
      );

    default:
      // People and everything else: your normal sign-up flow.
      return Response.json({ created: true, emailConfirmation: "sent", recommendation: action });
  }
}
