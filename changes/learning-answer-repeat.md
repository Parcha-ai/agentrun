---
packages: @parcha/agentrun-serve
kind: fix
---
A run's end-of-run answer is read by one rule: a learning block opens with the fence the format asks for (three or four backticks for a note, four for a skill or a workflow draft) and runs to the next line that is that fence. A shorter fence is text and a longer one is an example, so a skill first given in three backticks, cut short by its own code examples, no longer hides the four-backtick block that gives it again. An opening that is never closed, or that reaches another opening first, is left out alone instead of refusing the whole answer. A block repeated word for word is read once; two different blocks under one name are still refused. Notes fenced with tildes are no longer read. Upgrading: nothing to do.
