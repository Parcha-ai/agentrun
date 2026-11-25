---
packages: @parcha/agentrun, @parcha/agentrun-serve
kind: breaking
---
`agentrun deploy` no longer checks a package with the server bundled beside the CLI before it sends it, and `agentrun-serve check-upload` is gone. The target's import is the check: a package the target refuses exits 2 in the target's own words (its 422 `input_invalid`), with nothing applied, and a package the target accepts deploys even when an older CLI's server would have refused it. A script that ran `agentrun-serve check-upload` should deploy and read the exit code and refusal instead. A refused `category` names the value it got: `category is one of engineering, security, sales, marketing, research, finance, operations, compliance, personal, not "productivity"`. `agentrun deploy DIR` with a hidden file in the folder (a `.DS_Store`, a `.env`) no longer throws a TypeError; it names the hidden paths it leaves out, as before.
