---
packages: @parcha/agentrun-serve
kind: fix
---
A run that learns no longer keeps a note about learning itself, or a note beside a skill it keeps, which a grader could judge as planted and so drop the skill with it. It says it will keep what the person asked at the start of its reply, never after a sign-off they asked it to end with. A run whose learning the grader dropped names any skill or workflow draft lost with it. Upgrading: nothing to do.
