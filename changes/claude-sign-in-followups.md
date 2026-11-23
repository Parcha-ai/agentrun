---
packages: @parcha/agentrun-serve, @parcha/agentrun-harness-claude
kind: fix
---
Settings → Model keys' login on this machine: four fixes to the claude CLI's sign-in.
- The line shown for "this machine's" login on the CLI's default folder clears the CLI's folder variables in a subshell of the person's own shell, `(unset CLAUDE_CONFIG_DIR CLAUDE_SECURESTORAGE_CONFIG_DIR; ANTHROPIC_CONFIG_DIR=... claude auth login)`, in place of `env -u ...`. Under `env`, a CLI path holding `=` (a data folder such as `/srv/a=b`) was read as a variable and the CLI never started, and a `claude` alias (often the CLI's local install) was skipped.
