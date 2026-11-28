---
packages: @parcha/agentrun-serve
kind: feature
---
A request in a workspace (the `AgentRun-Workspace` header on an API-only server) is served the triggers of its own workspace's agents: their list, read, firings, create, edit, delete and run now. Another workspace's trigger answers the same `404` as an id no trigger has, and a new trigger naming another workspace's agent or run is refused in the words an unknown one gets.
On an API-only server a new trigger is a schedule or a feed that starts runs, with the launch hook set: any other source or target, or no hook, is `422` and nothing is made. A trigger is run now (`POST /triggers/{id}/fire`) only when it may be on there, so its firing goes to the backend through the launch hook.
