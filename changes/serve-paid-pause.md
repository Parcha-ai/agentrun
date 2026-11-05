---
packages: @parcha/agentrun-serve
kind: feature
---
A paid tool call the spend cap refuses for room pauses the run, as a refused model request does: monid's run, Parallel's search and fetch, and browser time, on pi, claude-agent, codex and opencode.
- **The call is not sent.** Its result says so in the cap's words, and the model's next request is refused in those words, so the turn ends there and the model gets no turn to work around it.
- **The run waits on a raise:** `input_required`, `waiting`, `pending.kind: "budget"`, with what was taken, the call's hold as what it needs, and the raise it is offered. A raise sends it on, and the model makes the call again if it still needs it, once per call it makes.
- **A stop between the refusal and the next request**, then a message, starts a turn judged as any other.
- **A spend that is unknown still fails the run**, as for a model request.
