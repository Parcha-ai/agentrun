---
packages: @parcha/agentrun-serve, repo
kind: fix
---
A run runs where its agent's definition puts it: a run request names no place, and `POST /agents/{id}/runs` with `place` is `422 input_invalid` at `place`, as with any field the body does not keep. The served OpenAPI document has no `RunCreate.place`, and the console's run bar and playground offer no "Run on the server instead".
