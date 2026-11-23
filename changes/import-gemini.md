---
packages: @parcha/agentrun-import, @parcha/agentrun-serve
kind: feature
---
`@parcha/agentrun-import` reads Gemini CLI sessions (`~/.gemini/tmp/<project>/chats/session-*.jsonl`, and the legacy `session-*.json`; `GEMINI_CLI_HOME` moves the home) as a fourth source, `gemini`: `parseHome`, the `agentrun-import` known answer and serve's import list it. `normalizeUsage("gemini", tokens)` takes the prompt tokens less the cached ones as `input`, adds thoughts to `output` (kept as `reasoning`) and the tool-use prompt tokens to `input`. A message the CLI wrote again counts once, at its last record; a legacy file and the `.jsonl` it was migrated into count a request once. A Gemini import runs as pi does, as serve has no Gemini harness. serve's API accepts `gemini` wherever it takes an import source.
