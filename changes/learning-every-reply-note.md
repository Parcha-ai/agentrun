---
packages: @parcha/agentrun-serve
kind: fix
---
A rule for every reply (its format, its tone, what every answer includes) is now kept as a note, which every later run reads, rather than as a skill, which a run reads only when its job calls for it. The end-of-run prompt says so, and the learning grader drops a skill that holds such a rule, saying it belongs in a note. The steps of one kind of job ("whenever I ask for a weekly summary, do it like this") are still a skill. Upgrading: nothing to do.
