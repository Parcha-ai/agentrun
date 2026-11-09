---
packages: @parcha/agentrun-serve
kind: fix
---
Template follow-ups after the QA cut:
- The template eval runner grades a background shell call (`bash_background`, `bash_output`, `bash_list`, ...) under its own name, as the tool gate names its request; it was counted as `bash`, so its own `tool_used` grader never saw it.
- `kyb` has an overflow rule for beneficial owners: past 10 (a public company's holders of 5% or more) it keeps the largest holdings and says in `limitations` how many it left out, citing the filings that list them.
- A template parameter can declare `enum`, a closed set of values that `GET /v2/templates` shows and apply checks (`not_an_option` outside it). `inbound-lead`'s `post_to` and `kyb`'s `risk_appetite` use it in place of a pattern, so the console shows a choice. Patterned parameters' descriptions now say their format in words ("a Slack channel ID like C0123ABCD").
