---
packages: @parcha/agentrun-serve
kind: fix
---
`agentrun-serve import` (and its `--dry-run`) now says once, on stderr, when it cannot open this server's webhook signing secret to cut it: with no `AGENTRUN_SEAL_KEY`, or one the secret was not sealed under, it prints `event=webhook_secret condition=seal_key_missing` (or `condition=unreadable`) `name=AGENTRUN_SEAL_KEY`, the file, and that the import does not cut it, in the same log-line form as the tool keys' `seal_key_missing` line. The import goes on as before. Before, it left the secret uncut and said nothing. What the CLI says on stderr (this line, and the tool keys' line) now goes through the same cut as its printed lines, so a key in the data directory's path prints as `[redacted]`.
