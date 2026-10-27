# @posterna/express

**Pre-release, not yet published.**

Express middleware for [Posterna](https://posterna.com). It verifies which AI agents and crawlers are calling your app, applies your `agents.yaml` policy, and tells your routes what it found. It starts in monitor mode and fails open on every error.

```js
import express from "express";
import { posterna } from "@posterna/express";

const app = express();
app.use(posterna({ trustedProxies: 1, publicHost: "www.example.com" }));

app.get("/", (req, res) => {
  // req.posterna.result: { verdict: "verified_by_ip", operator: "google", ... }
  // req.posterna.decision: { action: "allow", enforced: false, ... }
  // and the X-Agent-Verdict, X-Agent-Operator, X-Agent-Purpose, X-Agent-Method request headers
});

app.post("/signup", (req, res) => {
  const decision = req.posterna?.decide({ kind: "signup" }); // lift, cap or challenge
});
```

- Removes client-sent `X-Agent-*` and `X-Posterna-*` headers before anything reads them.
- Sends the 403 and 429 responses for enforced block and throttle decisions.
- Counts requests and, with `POSTERNA_SITE_KEY`, sends aggregate counters (never addresses, URLs or header values).
- Serves `/.well-known/posterna/debug` for `posterna doctor` when `POSTERNA_DEBUG_TOKEN` is set.
- `middleware.flush()` sends pending counters (for graceful shutdown); `middleware.close()` stops background work.

Set `trustedProxies` and `publicHost` for your host: see the [install guide](https://github.com/posternahq/posterna/blob/main/docs/install.md). Express 4.21 or later and 5 are supported. MIT licensed.
