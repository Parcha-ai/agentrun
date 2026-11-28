---
packages: @parcha/agentrun-serve
kind: feature
---
`codemode` runs Python: a call with `language: "python"` runs its script in Monty (`@pydantic/monty`, loaded on the first Python script), by the JavaScript script's rules. Each `await tools.<name>(args)` is a nested call, asked about at the gate, recorded and answered from its record on a rerun after a park or a crash; a refused call ends the script; `print()` output and the script's value are the answer. A Python script runs at most 10 minutes in 256 MiB, prints at most 120,000 characters, and makes at most 1,000 tool calls; the 10 minutes cut the tool call it waits on too. It gets no `computer` (it calls the computer's tools among its `tools`). Python is opt-in: `@pydantic/monty` is an optional peer that npm leaves out, and `npm i @pydantic/monty@1.6.0` beside the server adds it. An install without it runs JavaScript scripts as before; a Python one answers that line.
