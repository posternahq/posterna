# @posterna/next

**Pre-release, not yet published.**

Next.js integration for [Posterna](https://posterna.com): a wrapper for `proxy.ts` (Next.js 16) and `middleware.ts` (Next.js 15) that verifies which AI agents and crawlers are calling your app and applies your `agents.yaml` policy. Route handlers can call `verify()` and `decide()` directly. It starts in monitor mode and fails open on every error.

See the [specification](https://github.com/posternahq/posterna/blob/main/docs/SPEC.md). MIT licensed.
