---
packages: repo
kind: feature
---
The playground checks a spend cap against the agent's least cap, when the server gives one (GET /agents/{id} `min_cap_usd`, else the harness's in capabilities): "At least $0.11 for this agent." under the field (at default effort when another effort is chosen), a cap under it refused before it is sent, and "No cap can be kept on this agent's model." when the server says null. The least is the current revision's, so a start of an older revision leaves its cap to the server. A server that names none gets no hint and no check. A 422 that refuses the cap as too low says why under the field, in the server's words, until the agent, revision, effort or cap changes. The code pane shows the request as the form has it, a refused cap included, and the least is read again each time the playground opens.
