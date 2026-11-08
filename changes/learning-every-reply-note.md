---
packages: @parcha/agentrun-serve
kind: fix
---
A rule for every reply (its format, its tone, what every answer includes) is now kept as a note, which every later run reads, rather than as a skill, which a run reads only when its job calls for it. The end-of-run prompt says so, and the learning grader says when a skill holds such a rule that it belongs in a note, without dropping it. A rule for every reply applies whatever the job is; steps or a format for one kind of job, named by when it applies, are a skill. A note holds its own lesson and no longer repeats another note's rule, and the grader drops one that does as a duplicate (a note that supersedes another may restate its rule), so retiring a rule takes it out of every later run; a note that names another is still kept. Folders already learned are not rewritten: a note there that restates a rule since retired keeps restating it until its owner retires or supersedes that note too. Upgrading: nothing to do.
