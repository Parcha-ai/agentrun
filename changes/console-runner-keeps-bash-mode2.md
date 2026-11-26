---
packages: @parcha/agentrun-serve
kind: fix
---
In Mode 2, where the runner's shell (Archil's serverless exec) runs bash and the server gives new agents the runner, the console keeps bash on a runner agent: a new agent and a new race's pi lanes start with bash ticked, the Tools step lets you tick it, and a move to the runner keeps it. The background shell tools still need a box. In Mode 1 the runner has no shell, and a move there still drops bash.
