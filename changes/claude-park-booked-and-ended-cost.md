---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent
kind: fix
---
A claude-agent run whose tool call waits for a person's approval now books the model request that asked for the call at its price. The Claude CLI runs a tool as soon as its call has streamed, before that request has ended and before its usage arrives, so the park's interrupt cut the request and booked it at an unknown cost: a run that waited for an approval could read "1 not priced". The interrupt now waits for the requests in flight to be booked, up to the booking wait (2 s). A request whose end does not come within the wait is cut as before, its cost unknown, and the run still parks.
An ended run (completed, failed, cancelled) says its cost, never what it has cost "so far": the console shows "$0.0084 est. known · 1 not priced" in place of "so far $0.0084 est. · 1 not priced", and the run's usage row reads "Cost: …" in place of "Cost so far: …", for a workflow's decisions too. A live, paused or input_required run keeps "so far".
A workflow followed live through its end gets its usage row's ended wording on its last page too.
- `@parcha/pi-durable-agent`: the timeline's `ended` option, `costLabel(ended)` and `endedUsage(row)`.
