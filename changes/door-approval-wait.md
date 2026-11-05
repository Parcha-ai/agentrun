---
packages: @parcha/pi-durable-disk, @parcha/agentrun-serve
kind: fix
---
A trigger's message never reaches a run parked on a tool call's approval. The door's `POST /submit` with `answers: false` takes `parks` (entry kinds): it is refused with `409 WAITING`, by pi's root and by a door hook alike, while a call waits in a park of one of those kinds (an entry `{phase: "requested", id}` with no `{phase: "resolved", id}` after it). Serve sends its tool gate's park with each message a trigger sends, so a run that comes to wait on an approval just before the message reaches its door has the firing skipped ("The run is waiting on a person."), instead of taking the message, or being retried every 5 s as busy, and the approval stays pending.
