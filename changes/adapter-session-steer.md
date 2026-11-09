---
packages: @parcha/agentrun-kernel
kind: feature
---
`AdapterSession.steer?(text, id?, mode?)`: an adapter whose harness takes a person's message mid-turn places it in the turn in flight, at its next boundary. `id` is the request id the placement carries, so a host can tell the commit that placed it. `mode` is `"steer"` (the default) or `"followUp"`, which waits for the turn's end and runs as a turn of its own (a message that answers nothing, such as a trigger's). An adapter without it takes no message mid-turn, and the host refuses the steer in words.
