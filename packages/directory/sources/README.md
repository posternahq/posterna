# Researched operator sources

One hand-curated YAML file per researched operator. `pnpm directory:build` merges these with the fetched files in `raw/` and the community list from ai.robots.txt into the published data in `data/`.

The rule above all others: never invent a URL, key, IP prefix, user-agent token or quote. Every fact points at a source the operator published. If something cannot be found, leave it out or record it as unknown with a note saying why.

## Checks the build runs

- Every URL cited by a fact must be listed under `sources`.
- `pnpm directory:fetch` downloads every source page. The build then checks that each quote, and each user-agent token, appears in the text of a page it cites. Results go into `docs/directory-build-report.md`. A quote that cannot be found there is a bug in this file, or a sign the page changed.
- IP prefixes and keys are never written here. They come only from the fetched IP list files and key directories.

## Format

```yaml
slug: example                 # lowercase letters, digits and hyphens
name: Example AI              # as the operator writes it
website: https://example.com/
docs_url: https://example.com/docs/bots   # the main page about the operator's bots
checked_on: "2026-10-26"      # date the facts below were last checked by a person

# Entries in ai.robots.txt robots.json (by exact key) that belong to this
# operator. Entries that match an agent below are merged into it; the rest
# are kept as community agents of this operator.
community_agents: [ExampleBot, Example-User]

sources:                      # every page cited below, by id
  - id: bots
    url: https://example.com/docs/bots
    title: Example crawlers and user agents

agents:
  - name: ExampleBot
    user_agent_tokens: [ExampleBot]   # tokens that appear in the User-Agent header; [] for robots-only tokens
    robots_token: ExampleBot          # token for robots.txt, or null
    purpose: training                 # training | search | user_fetch | agent | preview | ads | other
    purpose_quote: "ExampleBot collects pages to train our models."   # verbatim and short
    purpose_source: bots
    search_engine: false
    robots_policy: honors             # honors | may_ignore | unstated
    robots_quote: "ExampleBot respects robots.txt."   # verbatim, or null when unstated
    robots_source: bots               # or null when unstated
    ip_list: examplebot               # id of an entry in ip_lists, or null
    aliases: []                       # other names the operator's own docs give this agent
    aliases_source: null              # required when aliases is not empty
    note: null

ip_lists:                     # published files of IP prefixes
  - id: examplebot
    url: https://example.com/examplebot.json
    source: bots              # the page that documents this URL

reverse_dns:                  # documented reverse DNS rule, or null
  suffixes: [crawl.example.com]   # the verified hostname must end with one of these
  forward_confirm: true
  quote: "Run a reverse DNS lookup and check that the name ends in crawl.example.com."
  source: bots

asn: []                       # [{asn: 64496, note: "...", source: bots}], only when documented

signing:                      # Web Bot Auth key directory
  directory_url: https://example.com/.well-known/http-message-signatures-directory   # or null
  basis: documented           # documented (operator's own docs) | reported (third party) | none
  status: null                # leave null; the build decides. Only `pending` may be set by hand.
  covers: [ExampleBot]        # agent names the signatures cover
  note: null
  sources: [bots]

ignore_findings:              # optional: findings reviewed and deliberately left out
  - value: https://example.com/all-ranges.json   # exactly as the finding shows it
    reason: Company-wide ranges, not a crawler list.
```

## Findings

Every build scans the operator's own pages (not pages cited only as a third-party report) for things the directory does not know yet:

- links that look like IP lists, and links to key directories, that are not in this file
- user-agent tokens (`ExampleBot/1.2`, `User-agent: ExampleBot`) that are not in the directory
- quotes, tokens and URLs that no longer appear on the page they cite

They are listed in `raw/findings.json` and in the "Needs review" section of `docs/directory-build-report.md`, and a change in them opens the daily pull request. The build never adds them to the data. A person either adds the fact to this file, with its source, or lists it under `ignore_findings` with the reason it was left out.

## Community records

`community-operators.yaml` holds the only curation applied to ai.robots.txt records, which always stay labeled `community`:

- `operator_names`: display names for `operator` fields that are a sentence or a bare URL.
- `described_operators`: entries whose operator field says "Unclear at this time." but whose own description names the operator. Each one quotes the phrase that names it, and the build fails if that phrase is not in the description. Descriptions that name only a product, hedge ("associated with"), or name no company are not attributed.

## How the build decides signing status

| What happened | Status |
|---|---|
| The key directory was fetched and contains at least one valid public key | `live` |
| The directory URL was documented or reported, but returned 404 or no valid keys | `none_found` |
| The directory URL was documented or reported, but could not be fetched (robots.txt, timeout, error) | `reported` |
| Nothing documented or reported | `none_found` |
| `status: pending` in this file (Posterna's own probe, not live yet) | `pending` |

Community operators that have no file here are `not_probed`.
