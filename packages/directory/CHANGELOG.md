# @posterna/directory

## 0.1.3

### Patch Changes

- c047866: DuckDuckGo: DuckAssistBot is listed as the agent that signs with DuckDuckGo's key directory, from a dated public observation of Duck.ai's signed requests (28 October 2026).

## 0.1.2

### Patch Changes

- 3a7999d: Directory data from 27 October 2026. Posterna's own key directory at `https://posterna.com/.well-known/http-message-signatures-directory` is now fetched like any other operator's, and Posterna's signing status is `live` (requests from the hosted probe verify; `posterna doctor` still signs with a throwaway key, which installs label `declared_unverifiable` with reason `unknown_kid`). `PosternaDirectoryBuilder`, the fetcher that builds this directory, is listed as an agent. OpenAI's ChatGPT-User and ChatGPT connectors lists each gained a range. The build's link scanner no longer reads a closing Markdown backtick as part of a URL.

## 0.1.1

### Patch Changes

- No code changes. The first release published from GitHub Actions with npm trusted publishing, so every package carries a provenance statement linking it to the commit and workflow that built it.

## 0.1.0

### Patch Changes

- First public release. The open directory of 125 AI agent and crawler operators (snapshot 2026-10-26, keys 2026-10-26T23), every fact with its source and fetch date. Data under CC BY 4.0; community records from ai.robots.txt (MIT).
