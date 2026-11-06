---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent
kind: fix
---
A call parked for approval no longer reads on the Timeline as if it ran. Its own call and result rows had the tool's
label and outcome ("Fetched public.example/a: ok") while the call waited. Now they say what came of the approval,
with no status: "Not run yet: it waits for your approval", "Allowed: it runs now", "Allowed: its result is in the message
that resumed the run", "Not run: you declined it", "Not run: your message declined it", "Not run: the run was stopped
(or cancelled) while it waited", or "Allowed, then the run was stopped (or cancelled): no result of it reached the
model". The gate's resume message is the server's row (`origin: "server"`, through the same origin a raised cap's
follow-up carries), not "You (steer): [tool approval] …". Its summary is the approval's outcome: "AgentRun: <tool> ran
once you allowed it" (", and failed" when it did), or "AgentRun: <tool> was refused: you declined it" ("your message
declined it"). A declining message's words stay the person's own row. `@parcha/pi-durable-agent`: that declined approval's server row now has `origin: "server"` too, and `isMessageRow` passes
over it (its id ends in the new `BESIDE_SUFFIX`, `:server`), so the turn still counts one message, the person's.
