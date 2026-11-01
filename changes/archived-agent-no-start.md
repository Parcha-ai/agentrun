---
packages: @parcha/agentrun-serve
kind: fix
---
**An archived agent's page offers no Start run**
- The server already refuses a run of an archived agent (409 `agent_not_runnable`); the page now shows "It is archived: unarchive it to start a run." in place of the run form, beside the Unarchive button.
