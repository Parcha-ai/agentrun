# Gray cases: not in the frozen negatives

Shapes a reasonable scrubber may cut. They are not tested as negatives: a cut on one is not a false positive by the
CI's rule. Some are candidates for a labelled positives set, or for beta 3's gray-zone (`jev`) pass. Each says why it
is here and what would move it.

| Case | Why gray | Expected today |
|---|---|---|
| A `ghp_`/`sk-` prefix followed by a full-length run of `x` or `X` (e.g. `sk-` and 24 `x`) | A placeholder to a reader, but exactly the format a format rule keys on; telling it from a key means guessing at entropy, and the contract allows no entropy rule. | `format` cut is acceptable |
| AWS's documented example key id (`AKIA…EXAMPLE`, 20 characters) and its example secret | Published as an example, but matches the format exactly; real keys get pasted next to it. | `format` cut is acceptable |
| `xoxb-your-token`, `xapp-your-app-token` | Words, but they fill the Slack format's 10+ character run. | `format` cut is acceptable |
| `password: "hunter2"`, `password=changeme`, `"secret": "test"`, `api_key: fake-key-123` in test fixtures | Obviously fake to a person; to a label rule, a literal value after a label. A real password can be a dictionary word. | `label` cut is acceptable (restorable) |
| `postgres://user:password@localhost:5432/app` | The canonical placeholder DSN, and also the exact shape of a credential URL. | `label`/`format` cut is acceptable |
| `export OPENAI_API_KEY=<your-api-key>` with the placeholder in double quotes | Still a placeholder (the unquoted form is in `code.txt`), but the repo's own source-export scan flags quoted literals after a key label, so it cannot live in the tree as-is. | should stay; not testable here |
| A `.env.example` with empty values (`OPENAI_API_KEY=` lines) | Holds no value, but is an env file by shape; the `dump` kind drops env/printenv output and `.env*` contents whole. | either; a drop of an empty template is harmless |
| `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA… comment` (a public key, `cat ~/.ssh/id_ed25519.pub`) | Public by design, but it is `~/.ssh` contents, which the `dump` kind drops. Its comment is usually `user@host`. | `dump`/`personal` cut is acceptable |
| `Authorization: Bearer eyJhbGciOi...` (a truncated JWT in docs) | Truncated, so not a token; but the label rule cannot tell truncation from a real value. | `label` cut is acceptable |
| Paths under `/home` for the `ubuntu` (default cloud) and `runner` (GitHub Actions) users, and under `/root` | The default cloud user and the CI runner are not people, but `/home/<name>` is the personal kind's shape and the most common path shape in real transcripts. | `personal` cut (restorable) |
| `/Users/Shared/...` | macOS's shared folder, not a user; the repo's own machine-path rule excludes it. A personal rule may or may not. | either |
| `12345+someone@users.noreply.github.com` for a human account | A no-reply address, but it names a GitHub user. Bot ones (dependabot, github-actions) are in the negatives. | `personal` cut (restorable) |
| `ada@example.com`, `user@example.org` | Reserved domains, never a real inbox, but an email by shape. | `personal` cut (restorable) |
| `ssh deploy@host`, `git clone user@server:repo` with a non-forge host | User@host, which identifies an account. `git@github.com` is in the negatives. | `personal` cut (restorable) |
| `10.0.0.1`, `192.168.1.1`, `172.17.0.1` (docker bridge), `10.0.0.0/8` in docs or default configs | Private addresses the contract names as personal, even when they are defaults everyone has. | `personal` cut (restorable) |
| `100.64.0.0/10` (CGNAT / Tailscale) addresses | Not RFC 1918, but they identify a tailnet node. Common in this project's real transcripts. | undecided: the contract names only private IPs |
| Docker MAC addresses (`02:42:ac:11:00:02`) | Generated per container, not personal; also not in the contract. | either |
| A 32/40/64-hex value assigned to a key-shaped variable (`SECRET_KEY=` and 64 hex, `API_TOKEN: <hex>`) | Same shape as a content hash; the variable name makes it a likely secret. The negatives never assign hex to a key-shaped variable name; they do keep hex after the words "key" in fixed tool output and published vectors (GitHub Actions' "Cache restored from key:", RFC 4231's "Key  =", FIPS-197's "KEY:"), which a label rule must not take. | `label` cut is expected |
