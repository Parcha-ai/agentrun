---
packages: @parcha/agentrun-serve
kind: fix
---
A learned workflow's answer keeps the format its last node wrote (#2412): `learned_workflow` hands back a text output (a string, or an object of one string field) as its text, never JSON-quoted, and its description tells the model that a workflow doing the job asked gives the answer, to reply with as it is. Before, the model got the report as one escaped line and wrote its own reply around it, so a skill's fixed format was lost once its workflow took over.
The draft side holds it too: the ask for a skill's job as a workflow says the draft's output is the job's answer in the skill's output format, written by its last node; a run's proposal carries the skill of each draft's name as the folder holds it (`drafted`), the grader is shown it under the draft, and its rubric drops a draft whose output cannot give the skill's format (Format). Upgrading: nothing to do.
