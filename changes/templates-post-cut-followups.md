---
packages: @parcha/agentrun-serve
kind: fix
---
Template follow-ups after the QA cut:
- The template eval runner grades a background shell call (`bash_background`, `bash_output`, `bash_list`, ...) under its own name, as the tool gate names its request; it was counted as `bash`, so its own `tool_used` grader never saw it.
- `kyb` has an overflow rule for beneficial owners: past 10 (a public company's holders of 5% or more) it keeps the largest holdings and says in `limitations` how many it left out, citing the filings that list them.
