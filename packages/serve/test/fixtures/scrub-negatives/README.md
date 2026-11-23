# Scrub known negatives

Text that looks like a secret and is not one. `scrub()` (src/secret-cut.ts) must leave every case here alone:
`test/scrub-negatives.test.mjs` scrubs each case in count mode (zero cuts) and in cut mode (the text back byte for
byte), as written and as a JSON string holds it, since transcripts keep text in JSON.

**Any cut here fails CI.** If a rule change cuts a case, fix the rule. Changing or deleting a fixture so a rule passes
needs a reason in the PR description, and a reviewer who agrees the case was never a clear negative.

Every value is synthetic: made by hand, or by `generate.mjs` from a fixed seed. Nothing here comes from a real
session, repository or person. The shapes (lengths, prefixes, surrounding syntax) were checked against aggregate
statistics of real transcripts, computed off-repo; no sampled text was copied.

## Files

| File | Written by | What |
|---|---|---|
| `git-shas.jsonl` | generate.mjs | 40-hex and 7–12-hex SHAs in `git log`, `rev-parse`, PR/commit/blob URLs, merge lines, `Co-Authored-By` trailers, diff `index` lines, `ls-remote`, reflog, submodules, pinned Actions, `describe` |
| `uuids.jsonl` | generate.mjs | v4, v5, v7, nil/max, uppercase, braced, undashed, `urn:uuid:`; in URLs, JSON, headers, logs, SQL, k8s; trace and span ids |
| `content-hashes.jsonl` | generate.mjs | sha1/sha256/sha512/md5 `*sum` output, `SHASUMS256.txt`, docker/OCI digests, ETags, S3 checksums, SRI script tags, SSH/GPG fingerprints, build-chunk hashes, nix store paths |
| `lockfiles.jsonl` | generate.mjs | npm `integrity`, yarn v1/berry, pnpm, Cargo.lock, go.sum `h1:`, poetry/uv/pip `--hash`, Pipfile.lock, Gemfile.lock, flake.lock, composer, SwiftPM |
| `base64-images.jsonl` | generate.mjs | small valid `data:image/png|gif|svg+xml|jpeg|webp;base64,...` URIs, alone and in markdown, HTML, CSS, a Messages-API image block, a woff2 font |
| `test-vectors.jsonl` | generate.mjs | published hash/HMAC/AES/Ed25519 vectors (SHA-256 of "abc", RFC 4231, FIPS-197, RFC 8032), git's empty tree and blob |
| `terminal.jsonl` | hand | ANSI-coloured output: node:test, git log/diff, tsc, eslint, pytest, docker compose, cursor codes, OSC 8 links, 256/true colour |
| `code.txt` | hand | TS/Python/Go/Rust/shell/YAML/HCL/SQL that names token/password/secret/key, env references (`process.env.X`, `${X}`, `$X`, `${{ secrets.X }}`), `<your-api-key>`, `sk-...`/`sk-xxxx`, secret-detecting regex literals |
| `prose.txt` | hand | commit messages, PR bodies, chat, docs and errors about passwords, keys, tokens, bearer authentication |
| `addresses.txt` | hand | loopback/any/public-DNS/RFC 5737 addresses, version strings that look like IPs, git remotes, noreply trailers, `pkg@1.2.3`, `logo@2x.png`, system and `/tmp` paths, `/home` with no user |

`.jsonl` files hold one `{"id": "...", "text": "..."}` per line (escapes such as `\u001b` for ESC are JSON's).
`.txt` files hold cases each opened by a `### <id>` line and running to the next; the newline before the next header
is not part of the case. A case's text must not contain a line starting with `### `.

## What is and is not a negative here

Only clear negatives: text where any cut is wrong. A placeholder that a format rule would reasonably cut (a
full-length `ghp_` run of `x`, AWS's documented example key id), a realistic literal next to a label
(`password: "hunter2"`), and personal-kind shapes (`/home/<user>`, a person's email, a private IP) are not here. They
are listed in `GRAY.md` with the reason; they are not tested.

Decisions this corpus encodes:

- A variable reference is never a secret: `$TOKEN`, `${GITHUB_TOKEN}`, `${{ secrets.NPM_TOKEN }}`,
  `process.env.API_KEY`, `os.environ["X"]`, also after a label (`PGPASSWORD=$PGPASSWORD`, `sshpass -p "$SSHPASS"`,
  `Authorization: Bearer $OPENAI_API_KEY`, `_authToken=${NPM_TOKEN}`, `?api_key=${SERPAPI_API_KEY}`).
- A placeholder that cannot be a value stays: `<your-api-key>`, `<token>`, `YOUR_API_KEY`, `REPLACE_ME`, `sk-...`,
  `sk-xxxx`, `sk-proj-...`, `xoxb-...`.
- A label with no value stays: `mysql -p` (prompts), `--password-stdin`, `-e POSTGRES_PASSWORD`.
- Public, non-personal addresses stay: `127.0.0.1`, `localhost`, `0.0.0.0`, `::1`, `8.8.8.8`, `1.1.1.1`, RFC 5737
  documentation ranges, `git@github.com:org/repo.git`, `noreply@anthropic.com`, `noreply@github.com`, bot
  `users.noreply.github.com` addresses (dependabot, github-actions).
- Paths with no user in them stay: `/usr/local/...`, `/tmp/...`, `/etc/...`, `/app/...`, `~/.config/...`,
  `$HOME/...`, and `/home` or `/home/` alone. A user directory under `/home` is personal-kind and not here.
- Dotted numbers that are not addresses stay: `1.2.3.4` as a version, `10.0.1`, `10.0.19045.3803`,
  `131.0.6778.85`, OIDs.

## Adding a case

1. Hand files: append a `### <new-id>` block to the `.txt`, or a line to `terminal.jsonl`. Ids are unique per file.
2. Generated files: add it to the matching function in `generate.mjs` and run
   `node packages/serve/test/fixtures/scrub-negatives/generate.mjs`. Append new cases at the end of a function, so
   the values of cases before it (drawn from the same seeded stream) do not change; `--check` reports a file that
   differs from what the script writes. Commit the script and its output together.
3. Synthetic only. No value from a real session, log, repository or person, and nothing a format rule
   would rightly cut (no real-length key shapes, even fake ones). The source export scan
   (scripts/export-source.mjs) also rejects quoted literals after `password=`/`api_key=` and the like; write a
   variable reference unquoted.
4. Run `npm run build -w packages/serve && node --test packages/serve/test/scrub-negatives.test.mjs`.

A new category gets its own file and an entry with a minimum count in `CATEGORIES` in the test, so emptying it fails.
