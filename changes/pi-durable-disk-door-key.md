---
packages: @parcha/pi-durable-disk
kind: feature
---
`doorKey(requestId)` names the submission key the door records a request's admission under in a run's store (`door <requestId>`), so a host can find a request a run already took without its door: serve reads it before sending a trigger's message to a run that has no live process.
The door's `POST /submit` takes `answers: false` with `asks` (tool names): such an input never answers a question the conversation waits on. It is refused with `409 WAITING` when the conversation's last model message is the result of a tool in `asks`, and with `409 BUSY` while a turn runs (a door hook, another harness, takes the busy refusal), so it is never queued behind a turn that may end on such a tool. Such an input takes no `origin` (`400`): refused while busy, it would leave the origin's marker with no message after it.
