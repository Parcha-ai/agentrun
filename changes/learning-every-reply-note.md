---
packages: @parcha/agentrun-serve
kind: fix
---
A rule for every reply (its format, its tone, what every answer includes) is now kept as a note, which every later run reads, rather than as a skill, which a run reads only when its job calls for it. The end-of-run prompt says so, and the learning grader drops a skill that holds such a rule, saying it belongs in a note. The steps of one kind of job ("whenever I ask for a weekly summary, do it like this") are still a skill. A note holds its own lesson and no longer repeats another note's rule, and the grader drops one that does as a duplicate, so retiring a rule takes it out of every later run; a note that names another is still kept. Upgrading: nothing to do.
