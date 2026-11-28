---
packages: @parcha/agentrun-serve
kind: feature
---
`codemode` runs Python: a call with `language: "python"` runs its script in Monty (`@pydantic/monty`, an optional dependency loaded on the first Python script), by the JavaScript script's rules. Each `await tools.<name>(args)` is a nested call, asked about at the gate, recorded and answered from its record on a rerun after a park or a crash; a refused call ends the script; `print()` output and the script's value are the answer. A Python script runs at most 10 minutes in 256 MiB and makes at most 1,000 tool calls, and gets no `computer` (it calls the computer's tools among its `tools`). An install without `@pydantic/monty` runs JavaScript scripts as before; a Python one answers that the package is missing.
