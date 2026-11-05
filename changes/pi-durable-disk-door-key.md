---
packages: @parcha/pi-durable-disk
kind: feature
---
`doorKey(requestId)` names the submission key the door records a request's admission under in a run's store (`door <requestId>`), so a host can find a request a run already took without its door: serve reads it before sending a trigger's message to a run that has no live process.
