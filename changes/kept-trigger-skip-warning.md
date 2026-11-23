---
packages: @parcha/agentrun-serve
kind: fix
---
An update apply that skips a template's trigger (with `AGENTRUN_RUN_KEYS=1` and an agent that owes a key, or on an API-only server, and no launch hook) leaves the agent's trigger of that name as it was. When that trigger is on, the skip's warning now says it is kept and still fires, names it, and says how to turn it off: `PATCH /v2/triggers/{id}` with `{"enabled": false}`, or, on an API-only server, the agent's archive. With `AGENTRUN_RUN_KEYS=1` it also says which firings are refused: one that would start a run of the new revision is refused 409 for the keys it owes and starts no run, but a `message_run` firing aimed at a run of an earlier revision that owes no keys still reaches that run, which may spend. Turning the trigger off stops both. In 0.1.0-beta.54 the warning said only that the trigger was not made.
