---
packages: @parcha/pi-durable-disk
kind: feature
---
`doorKey(requestId, n)` names the submission keys the door records a request under in a run's store (`door <requestId>` for its admission, then `door <requestId> <n>`), and `doorTook(requestId, statusAt)` reads from them whether the door took it, so a host can find a request a run already took without its door: serve reads it before sending a trigger's message to a run that has no live process.
A busy refusal is no longer a request's final outcome. A `whenBusy: "reject"` input to a busy hook is refused with nothing written, and one the hook refuses after its admission is admitted again when it is sent again, so a retry reaches the hook once the run is idle.
The door's `POST /submit` takes `answers: false` with `asks` (tool names): such an input never answers a question the conversation waits on. It is refused with `409 WAITING` when the conversation's last model message is the result of a tool in `asks`, and with `409 BUSY` while a turn runs (a door hook, another harness, takes the busy refusal), so it is never queued behind a turn that may end on such a tool. Such an input takes no `origin` (`400`): refused while busy, it would leave the origin's marker with no message after it.
