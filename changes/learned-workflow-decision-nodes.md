---
packages: @parcha/agentrun-serve
kind: feature
---
A learned workflow can hold decision nodes (judge, pick, sift, a route by question, an ask predicate, a verify), under the run's spend cap. Each decision is admitted on the run's cap before it is sent, priced the way a workflow agent's decision is, and booked at what it charged. If the cap has no room, the decision is never sent: the run pauses at the cap, and the `learned_workflow` call says why. A decision node's provider (the one it names, else the default, `jev`) is checked against the run's tool settings, with the provider's id as the settings key, the same way a call node's tool is: set to ask or deny, the workflow is refused before any node runs, in the gate's words. A provider the run has no key for refuses the workflow too. A run with no decision providers still refuses decision nodes, as before.
Upgrading: nothing to do. To keep an agent's learned workflows from asking a provider, set that provider's id (`jev`, `parallel`, `openrouter`) to deny in the agent's tool settings.
