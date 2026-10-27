# Directory signing keys

The Posterna cloud signs `directory.json` and `keys.json` with an Ed25519 key, and every install of `@posterna/core` checks those signatures before it uses a downloaded file (docs/SPEC.md section 3.1). This page lists the keys installs trust, who holds the private halves, and what to do when a key has to change.

Nothing secret belongs on this page or anywhere in this repository. Only public keys appear here.

## Trusted keys

Every release of `@posterna/core` from 0.1.0 on embeds these public keys in `TRUSTED_DIRECTORY_KEYS` (`packages/core/src/directory/signature.ts`). A test checks that this table matches that list.

| kid | Role | Generation | Added |
|---|---|---|---|
| `2qUSU6hxNFv8aoHtbtW12lPokB8olcots8I1Re8Ow04` | primary | 1 | 2026-10-26 |
| `8l853J2OG3QMQmih_3xjxkE6kL-aYERKjaCza171yBQ` | backup | 2 | 2026-10-26 |

- **kid** is the RFC 7638 SHA-256 thumbprint of the public key.
- **primary** signs the files the cloud publishes today.
- **backup** signs nothing until the day it is needed. It exists so the cloud can stop using the primary without waiting for every site to upgrade.
- **Generation** grows by one with each new key. The backup always has the highest generation.

## How installs use the generations

- An install accepts a file signed by any trusted key at or above its current minimum generation, which starts at the lowest generation in the list.
- When an install accepts a file signed by generation N, its minimum rises to N, and it rejects files signed only by older generations from then on. This ratchet is kept in memory, so a restarted install starts from the lowest generation again until it fetches a newer file.
- An install also rejects a file whose version is older than the copy it already has, unless the file is signed by a higher generation than that copy.
- A rejected file never breaks a site. The install keeps its last good copy, counts an error and records why (docs/SPEC.md sections 3.1 and 4.8).

Because of the ratchet, the backup must always have a higher generation than the primary. Never add a primary above the backup: the first file it signed would make every install stop trusting the backup.

## Who holds the private keys

- The primary private key lives only in Railway, in the `POSTERNA_DIRECTORY_SIGNING_KEY` variable of the cloud's two signing jobs (`publish-directory` and `refresh-keys`).
- The backup private key lives only offline, in two separate places. It is never put on a server or in a repository.
- Neither private key is ever sent by chat or email, pasted into an issue, or written to a log.
- New keys are made with `scripts/generate-directory-key.mjs` on a trusted machine. The script writes the private key to `~/posterna-keys/` with owner-only permissions and prints only public material. Move the file to its two offline places, or paste its contents into Railway, then delete it from `~/posterna-keys/`.

Guardrails in both repositories: `.gitignore` excludes `*.jwk.json` and `posterna-keys/`, and a test in CI fails if any tracked file holds a private key. The cloud's signing jobs refuse to publish when their key's kid is not in the trusted list of the `@posterna/core` they run with, so a wrong key pasted into Railway stops the job instead of publishing files every install rejects.

## Making a key

```sh
pnpm build
node scripts/generate-directory-key.mjs --role backup --generation 3
```

The script signs the bundled `directory.json` with the new key and checks the signature with `@posterna/core`'s own verification code before it writes anything. It prints the file path, the public JWK and the kid. Add the public JWK to `TRUSTED_DIRECTORY_KEYS` with its kid, role, generation and today's date, and add the same row to the table above.

The file holds one JWK, so its whole contents can go into `POSTERNA_DIRECTORY_SIGNING_KEY` when the key goes into service.

## Planned rotation

A planned rotation promotes the backup and adds a new backup above it. With the primary at generation N and the backup at N+1:

1. Generate a new backup at generation N+2. Ship a release that trusts N (still the primary), N+1 and N+2 (both backups).
2. Wait until most installs run that release. Each install reports its SDK version with its counters.
3. Re-vendor core in the cloud (`scripts/vendor-core.sh`) and deploy. Set `POSTERNA_DIRECTORY_SIGNING_KEY` on both signing jobs to the generation N+1 private key and run each job once. Installs ratchet to N+1 when they first fetch a file it signed.
4. In the next release, remove generation N and mark N+1 as the primary. Then destroy every copy of the generation N private key.

## Emergency: the primary leaks or is lost

1. Secure the Railway account and rotate its access: passwords, tokens and team members.
2. Set `POSTERNA_DIRECTORY_SIGNING_KEY` on both signing jobs to the backup private key, then run the directory publish job and the keys job once by hand (`railway cron run --service publish-directory`, then `--service refresh-keys`). Installs that fetch the new files ratchet to generation 2 and stop trusting generation 1.
3. Generate a new backup at generation 3 with the script. Ship a patch release whose trusted list is generation 2 (now the primary) and generation 3 (the new backup), with generation 1 removed. Re-vendor core in the cloud and deploy.
4. Post a short notice in the repository saying which key was retired and which release removes it.

Until installs restart onto the patch release, a restarted install trusts generation 1 again until its next refresh, which brings it a generation 2 file and the ratchet. A stolen primary alone does not reach installs: an attacker would also have to control what they download from posterna.com.

## Reporting

If you think a Posterna signing key has leaked, email hello@posterna.com (SECURITY.md).
