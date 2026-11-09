---
packages: @parcha/agentrun-serve
kind: fix
---
A call that waited for approval reads in order over the one store too: its own rows say "Held for your approval", then "Asked your approval: <tool> <arguments>", then what came of it, from the run's ask and answer entries; before an outcome, the call reads "Not run yet: it waits for your approval" beside "Waiting for your approval". The runner's answers (`approved`) now read as allow or deny in the run's view. The words change on both paths: a deny reads "You declined <tool>: <note>" (one colon), or "You declined <tool>." with no note, and a declining message "Your message declined <tool>."; an allowed call with no output reads "Its result: (no output)". An allow reads as before, "AgentRun: <tool> ran once you allowed it; its result went to the agent".
