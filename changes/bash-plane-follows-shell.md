---
packages: @parcha/agentrun-serve
kind: fix
---
An agent's read and capabilities show bash and the background tools only where a run gets them. `GET /v2/agents/{id}` reads where a run of the agent has its shell by the claim's own rule (`runShellOf`, on its computer setting and the server's folder mode now), and a tool of bash's family the run would not have carries `resolved: "unavailable: ..."` in the words a call of it gets there: with no computer that mounts the run's folder the background tools are not there, and bash neither in Mode 1. Capabilities show bash available on a server with no box when its folders are on Archil, whose exec runs it; the background tools still need a box.
