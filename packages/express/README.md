# @posterna/express

**Pre-release, not yet published.**

Express middleware for [Posterna](https://posterna.com). One line, `app.use(posterna(options))`, verifies which AI agents and crawlers are calling your app, sets `req.posterna` and the verdict headers, and applies your `agents.yaml` policy. It starts in monitor mode and fails open on every error.

See the [specification](https://github.com/posternahq/posterna/blob/main/docs/SPEC.md). MIT licensed.
