---
packages: @parcha/agentrun-serve
kind: feature
---
An import cuts the keys [secretlint](https://github.com/secretlint/secretlint)'s recommended rules find in what it reads (Anthropic, OpenAI, GitHub, Slack and Stripe keys, AWS secret keys beside their name, private keys, database URLs with a password, and more), as well as the environment's values and the saved keys. It reads each session file as it is and as its records' strings, so a key in a Codex shell output kept as JSON is found too. The cut reaches everything the import writes: transcripts, run titles and inputs, the agent's name and description, its instructions, its skills' text and their file paths. A key in a folder's or file's name, one split across folders among them, is kept as `redacted-<hash>`, and a skill's files stay one skill.
- `agentrun-serve import` prints `N secrets removed` after its import line (`N secrets would be removed` with `--dry-run`), counting each distinct key once.
- Known key formats are removed. Other secrets in your session history, like passwords in config files, are imported as they are.
- Runs imported before this change are not cut again: a re-import skips sessions it already holds.
- New dependencies: `@secretlint/core` and `@secretlint/secretlint-rule-preset-recommend`, both 13.1.0 (MIT).
