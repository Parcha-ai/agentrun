---
packages: repo
kind: fix
---
`--record` takes the exact secret values out of a recording: the values of the environment names the demo declares, and the sign-in's tokens (the access, refresh and id token strings and an API-key credential's key from `auth.json` under `$AGENTRUN_HOME`, else `~/.config/agentrun`). Every recorded line, text blob and the manifest has them replaced, a sign-in file that cannot be read fails the record, and the finished recording is scanned and refused if a value slipped through, naming the key and the file and never the value.
A refreshed token is redacted too (the sign-in file is read again when its mtime or size changes, and the redaction uses every value seen), the finished-recording scan reads the file once more, and the child is handed `AGENTRUN_HOME` so it uses the file the recorder reads.
