---
packages: @parcha/agentrun-serve
kind: fix
---
A `PUT /v2/settings/tools`, and a tool key's `PUT` or `DELETE /v2/settings/tool-keys/{id}`, answers in milliseconds: each one used to check every harness again (each CLI's package and pins, codex's binary hashed), which took seconds, though neither a tool setting nor a tool key changes what a harness offers. The server checks the harnesses once at its start and remakes only what a write changes, so capabilities, a save's checks and a run's checks read right after the answer show it: what a web tool resolves to, a tool's `available` and `missing`, the decision providers. A start logs the check's length as `event=harness_offers why=start ms=<n>`. A save or a run check no longer checks the harnesses again after a key write either.
