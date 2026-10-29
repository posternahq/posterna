import { posterna } from "@posterna/express";
import express from "express";

const app = express();

// Posterna runs before your routes. It labels every request, applies
// agents.yaml (read from this folder, or POSTERNA_POLICY), and tells your
// routes what it found. A fresh agents.yaml is in monitor mode: nothing is
// blocked until you change it to enforce.
const agents = posterna({
  // The proxies in front of the app. This example assumes nginx on the same
  // machine; use the setting for your host from
  // https://posterna.com/docs/hosts#settings-by-host
  trustedProxies: ["127.0.0.1/32", "::1/128"],
  // The hostname agents sign. Set it in production, for example "www.example.com".
  publicHost: process.env.PUBLIC_HOST || undefined,
});
app.use(agents);

app.get("/", (req, res) => {
  res
    .type("text/plain")
    .send(`Hello. Posterna labeled this request ${req.get("x-agent-verdict")}.\n`);
});

// What Posterna told the app about this request.
app.get("/agent", (req, res) => {
  res.json({
    verdict: req.get("x-agent-verdict") ?? null,
    operator: req.get("x-agent-operator") ?? null,
    purpose: req.get("x-agent-purpose") ?? null,
    method: req.get("x-agent-method") ?? null,
    posterna: req.posterna
      ? { result: req.posterna.result, decision: req.posterna.decision }
      : null,
  });
});

app.get("/api/items", (_req, res) => {
  res.json({ items: ["alpha", "beta", "gamma"] });
});

const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, () => {
  console.log(`express-basic listening on http://localhost:${port}`);
});

// On shutdown, send the counters Posterna has not sent yet.
process.on("SIGTERM", async () => {
  await agents.flush();
  agents.close();
  server.close(() => process.exit(0));
});
