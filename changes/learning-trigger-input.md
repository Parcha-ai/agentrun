---
packages: @parcha/agentrun-serve
kind: fix
---
A trigger's input is no longer read by the learning grader as the user's own words. A message a webhook, Slack or GitHub trigger sent the run (its origin `trigger` with `owner: false`) is kept apart from what the user said, in the run's saved proposal (`triggered`, each with its source) and in the grader's prompt (its own fence after the user's messages, in the same budget). The rubric's Planted question names a trigger's input among what the run read, so a rule found only there is planted. A schedule's fixed prompt (`owner: true`) is still the owner's words. Upgrading: nothing to do.
