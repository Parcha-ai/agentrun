---
packages: @parcha/agentrun-serve
kind: fix
---
A learned workflow's answer keeps the format its last node wrote (#2412): `learned_workflow` hands back a text output (a string, or an object of one string field) as its text, never JSON-quoted, and its description tells the model that a workflow doing the job asked gives the answer, to reply with as it is. Before, the model got the report as one escaped line and wrote its own reply around it, so a skill's fixed format was lost once its workflow took over. Upgrading: nothing to do.
