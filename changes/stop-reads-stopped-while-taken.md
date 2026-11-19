---
packages: @parcha/agentrun-serve
kind: fix
---
A run stopped while it waited on a person (a tool call waiting for approval, a browser or desktop hand-over) reads `input_required`, `idle` and `pending` kind `stopped` from the stop's answer to its end, in `GET /v2/runs/{id}` and in its item in `GET /v2/runs`. Before, it read `working`, `working` and no `pending` for the half second or so the runner held the run to take the stop, between two reads that said stopped, so a client polling after the stop could see the run start working again.
