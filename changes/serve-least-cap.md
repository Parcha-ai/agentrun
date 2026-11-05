---
packages: @parcha/agentrun-serve
kind: feature
---
A run paused at its spend cap serves `pending.least_cap_usd`: the least cap that sends the refused request, the very figure
its words name ("Raise the cap to at least $X to run it."), so a client can show it beside `suggested_cap_usd` without
parsing the sentence. It is carried from the refusal that wrote the words (a model request's and a paid call's alike), so
the two never differ, and it is absent on a refusal an older server wrote.
