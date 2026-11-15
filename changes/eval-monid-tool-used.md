---
packages: @parcha/agentrun-serve
kind: fix
---
A template eval's `tool_used` grader can name a monid endpoint (`monid:<provider>/<endpoint>`) that the package's `tools` grants by name, and counts its calls under that name. A monid name the package does not grant by name is refused when the cases are read, and so is one granted only by its provider's wildcard (`monid:<provider>/*`): the wildcard is filled from monid's listing when the agent is saved, so the eval cannot check the name before the run.
