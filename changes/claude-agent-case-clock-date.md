---
packages: @parcha/agentrun-harness-claude, @parcha/agentrun-serve
kind: fix
---
A claude-agent run on a clock the host set (the adapter's `now`; in serve, a template eval case's `now:`) is now told that clock's day by the Claude CLI too. The CLI dates the session from the machine's clock in its own lines ("Today's date is 2026-11-24.", and "Today's date is now ..." on a later day), and has no setting for it. On a case clock set to another day, the model was told both days and went by the CLI's, so every date a grader checked against the case clock failed. The session's model proxy now rewrites those two lines to the clock's day in the run's zone (`zone`). A tool's result is never rewritten, so a file or page that says a date reaches the model as it was. A run with no `now`, which is every production run, is unchanged.
A session on a person's Claude login has no model proxy, so there the CLI's lines keep the machine's date. Run clocked cases on the provider route (an API key or gateway).
