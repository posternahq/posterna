# @posterna/core

**Pre-release, not yet published.**

The core of [Posterna](https://posterna.com): the verifier, policy engine and counters client behind `verify()` and `decide()`. It checks which AI agents and crawlers are calling your site, using HTTP message signatures (RFC 9421), published IP ranges and reverse DNS, and gives every request one of six verdicts. It runs in your own process, fails open on every error, and starts in monitor mode.

Most apps use an adapter instead: [`@posterna/express`](https://www.npmjs.com/package/@posterna/express) or [`@posterna/next`](https://www.npmjs.com/package/@posterna/next).

See the [specification](https://github.com/posternahq/posterna/blob/main/docs/SPEC.md). MIT licensed.
