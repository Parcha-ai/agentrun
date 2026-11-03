---
packages: @parcha/agentrun-serve
kind: fix
---
`agentrun-serve import` titles a Claude Code run the way Claude Code shows it: the person's `/rename` (`custom-title`), else its own `ai-title`, else (in older files) the `summary` of this session's last message. A session with none is titled by the person's first words, never by a slash command's `<command-name>` markup, its `<local-command-stdout>` output or the "Caveat:" preamble before it. A session with no words of the person's at all (only `/resume` and `/model`, or a Codex or pi session kept by `--all`) is titled "Session in <folder>" in place of the markup, "codex session" or an empty title. An imported run with no answer no longer keeps a slash command's markup as its summary.
