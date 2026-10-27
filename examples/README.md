# Examples

Small apps that use Posterna, one folder each. They are private workspace packages: never published, used as starting points and by the end-to-end tests (`test/e2e/`, run with `pnpm test:e2e`).

| Folder | What it shows |
|---|---|
| `express-basic` | Express with `app.use(posterna(options))`: verdict headers, `req.posterna`, enforced block and throttle responses. |
| `express-signup` | An Express sign-up route acting on Posterna's `lift`, `cap` and `challenge` recommendations, with a marked placeholder for your own CAPTCHA. |
| `next-basic` | Next.js 16 with `proxy.ts`. Pages and route handlers read the verdict from the `X-Agent-*` request headers. |
| `next-signup` | Next.js 15 with `middleware.ts` on the Node.js runtime, and a sign-up route handler that verifies and decides itself. |

Every example starts in monitor mode, like every real install: its `agents.yaml` comes from a template. The end-to-end tests point `POSTERNA_POLICY` at an enforcing policy to exercise blocks, throttles and recommendations. The Next.js examples wrap `next.config.ts` in `withPosternaConfig`, so for them the tests set it when building, and the policy reaches the app only through the build.

Run one from the repository root after `pnpm install` and `pnpm build`:

```bash
pnpm --filter @posterna/example-express-basic start
```

The Next.js examples need `pnpm --filter @posterna/example-next-basic build` before `start`.
