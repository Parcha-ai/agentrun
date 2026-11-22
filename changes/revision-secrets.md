---
packages: @parcha/agentrun-serve
kind: feature
---
A template's apply keeps the names of the keys the package declared (its `secrets`, and those of the model choice it took) on the revision it writes, never their values, so `GET /v2/agents/{agent_id}/package` names them after the server's copy of the template changes, as a bundled template does on every upgrade. Applying the same package again still writes no revision. Only an agent applied before this keeps its `report.remade` entry for keys that can't be recovered.
