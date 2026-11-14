---
packages: @parcha/agentrun-serve
kind: feature
---
A template's webhook trigger may filter its deliveries by a parameter, as a github trigger already could.
- A `${parameters.<name>}` may go in the `in` values of a webhook trigger's `accept` where conditions, and apply fills it. The parameter must be required or have a default, so the filter never fills empty.
- A provider that sends every trigger of a project to one URL (Composio) then starts a run only for the repository the owner set: `{pointer: /data/repository_name, in: ["${parameters.repo}"]}`. A delivery for another repository is answered `200 {"ok": "ignored"}` and starts nothing.
