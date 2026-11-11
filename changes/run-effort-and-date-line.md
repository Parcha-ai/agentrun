---
packages: @parcha/agentrun-serve, @parcha/agentrun-harness-claude
kind: fix
---
A run's effort is its own, else its agent revision's saved `thinking`, else the host's `AGENT_THINKING`, as documented: before, a run started with no `effort` dropped the other two, so its harness thought at its default, it got no effort note and its metrics named no effort. A CLI run's metrics now name the level its harness ran at (`max` on Codex or OpenCode runs at `xhigh`, and says so). A claude-agent session resumed on a later day is now told that day: the CLI resends the system prompt recorded at its first request, so the first message on each later day starts with `Today is <date> (UTC).`, in the CLI's transcript only (fixes #2416). `thinkingOf` and `EFFORT_ENV` are gone from the server's `model` module: `thinkingLevel` checks a level.
