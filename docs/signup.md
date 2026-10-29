# Sign-up routes

On a sign-up route, Posterna gives your app a recommendation and your app acts on it with the friction it already has: `lift` (skip a friction step), `cap` (apply your own limits) or `challenge` (hand the request to your existing CAPTCHA). The `signup` section of [agents.yaml](policy.md#keys) sets the recommendations. Act on one only when `decision.enforced` is true: in monitor mode it is recorded as what would have happened, and `enforced` is false ([what a decision contains](policy.md#what-a-decision-contains)).

<!-- posterna:selectors framework -->

<!-- posterna:framework express -->

## Express

On a sign-up route, ask for a recommendation and act on it only when it is enforced:

```js
app.post("/signup", (req, res) => {
  const decision = req.posterna?.decide({ kind: "signup" });
  const action = decision?.enforced ? decision.action : "allow";
  // "lift": skip a friction step. "cap": apply your own limits.
  // "challenge": hand the request to your existing CAPTCHA.
});
```

See [examples/express-basic](../examples/express-basic) and [examples/express-signup](../examples/express-signup).

<!-- posterna:framework next -->

## Next.js

### Route handlers

A route handler that needs a sign-up recommendation verifies and decides itself, because it runs in a different bundle from the proxy. It gets the same built-in copy of `agents.yaml`. Turn counting off there, since the proxy already counted the request:

```ts
import { createPosterna } from "@posterna/next";

const posterna = createPosterna({
  clientIpHeader: "x-real-ip", // the same setting as your proxy
  publicHost: "www.example.com",
  counters: false,
});

export async function POST(request: Request) {
  const result = await posterna.verify(request);
  const decision = posterna.decide(result, { path: "/api/signup", kind: "signup" });
  // act on decision.action when decision.enforced is true
}
```

### Server Actions

A sign-up form built as a Server Action posts to the page's own path, not to a route handler. Ask for the recommendation in your proxy function and hand it to the action in a request header:

```ts
import { getPosterna, withPosterna } from "@posterna/next";
import { type NextRequest, NextResponse } from "next/server";

export const proxy = withPosterna(
  { clientIpHeader: "x-real-ip", publicHost: "www.example.com" },
  (request: NextRequest) => {
    if (request.method !== "POST" || request.nextUrl.pathname !== "/signup") return;
    const decision = getPosterna(request)?.decide({ kind: "signup" });
    const headers = new Headers(request.headers);
    // Always set it, so a value the client sent is never passed on.
    headers.set("x-signup-recommendation", decision?.enforced ? decision.action : "allow");
    return NextResponse.next({ request: { headers } });
  },
);
```

In the action, read it with `(await headers()).get("x-signup-recommendation")`. Your own header names cannot start with `x-agent-` or `x-posterna-`, because Posterna removes those. A matcher that excludes a page also skips its Server Actions.

See [examples/next-basic](../examples/next-basic) and [examples/next-signup](../examples/next-signup).

<!-- posterna:end framework -->
