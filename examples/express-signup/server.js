import { posterna } from "@posterna/express";
import express from "express";

const app = express();

const agents = posterna({
  // Use the setting for your host:
  // https://github.com/posternahq/posterna/blob/main/docs/install.md#trusted-proxies
  trustedProxies: ["127.0.0.1/32", "::1/128"],
  publicHost: process.env.PUBLIC_HOST || undefined,
});
app.use(agents);

app.get("/signup", (_req, res) => {
  res
    .type("html")
    .send(
      '<form method="post" action="/signup"><input name="email" type="email"><button>Sign up</button></form>\n',
    );
});

app.post("/signup", express.urlencoded({ extended: false }), (req, res) => {
  // Posterna recommends; this route decides. The recommendation counts only
  // when `enforced` is true: agents.yaml is in enforce mode and nothing has
  // suspended enforcement.
  const decision = req.posterna?.decide({ kind: "signup" });
  const action = decision?.enforced ? decision.action : "allow";

  switch (action) {
    case "lift":
      // A verified agent acting for a person: skip the email confirmation step.
      return res.json({ created: true, emailConfirmation: "skipped", recommendation: action });

    case "cap":
      // An agent that cannot be verified: create the account under your own limits.
      return res.json({
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
      return res
        .status(403)
        .json({ created: false, challenge: "required", recommendation: action });

    default:
      // People and everything else: your normal sign-up flow.
      return res.json({ created: true, emailConfirmation: "sent", recommendation: action });
  }
});

const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, () => {
  console.log(`express-signup listening on http://localhost:${port}`);
});

process.on("SIGTERM", async () => {
  await agents.flush();
  agents.close();
  server.close(() => process.exit(0));
});
