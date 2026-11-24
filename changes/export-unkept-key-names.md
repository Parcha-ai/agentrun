---
packages: @parcha/agentrun, @parcha/agentrun-serve
kind: fix
---
An export of a revision applied before an apply kept its key names names none, and says so: a `remade` note of kind `secrets` that names the package it came from and asks for the keys to be saved on the target and named under `secrets`. This corrects 0.1.0-beta.55's note, which said `report.remade[].kind` no longer lists `secrets`: it lists it for such a revision. An export of a revision whose apply kept its key names names them, with no note, as in 0.1.0-beta.55.
