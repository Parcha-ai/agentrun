---
packages: @parcha/agentrun-serve
kind: feature
---
Learning asks for a workflow draft once a job repeats: when a run that learns ends, and a learned skill it was given has been given to 3 or more earlier runs of its agent with no learned workflow of that name (active or waiting for its owner's OK), its end-of-run prompt gains one line asking for that skill's job as a workflow draft under the skill's name, which the usual checks and grader judge. One skill at most per run, and no extra request. A run's learning start now records the learned skills its seed offered it (`learning.skills` in its launch), which is what the count reads.
Upgrading: runs started before the upgrade recorded no skills, so they count for none; the first ask comes 3 learning runs after the upgrade.
