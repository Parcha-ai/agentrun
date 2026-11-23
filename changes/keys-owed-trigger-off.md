---
packages: @parcha/agentrun-serve
kind: fix
---
With `AGENTRUN_RUN_KEYS=1` and no launch hook, a template's update apply now turns off the agent's trigger that has the name of a trigger the apply skips, when that trigger is on: each of its firings would be refused (409 `agent_not_runnable`) for the tool keys its agent's runs must carry. The trigger reads `disabled: {at, reason: "keys_owed", detail}`, `next_at` null, the detail naming the keys and the fix: set the launch hook, then turn it on, or start the agent's runs through the API with their keys. The apply's warning for the skip says it was turned off. `keys_owed` is a new `disabled.reason`. In 0.1.0-beta.54 the trigger stayed on and failed every firing until its failure streak paused it.
- On an API-only server without the run-keys setting, a trigger like that still fires, on this server's keys. It stays on, and the skip's warning now names it and says that archiving the agent turns it off.
