---
packages: @parcha/pi-durable-agent, @parcha/agentrun-serve
kind: feature
---
A trigger's Timeline row (`origin: "trigger"`) carries its trigger as fields, `trigger: {id, source, owner}`, so a client labels it by its source without reading its summary; no other row has it. A run's first message's origin read back from its `serve.json` after a restart is kept only when it names the run's own trigger and its `owner` is what its source makes it (true only for a schedule); one that does not hold up, or is missing from a triggered run, is read as that trigger's with `owner` false, never as the person's. Upgrading: nothing to do.
