---
packages: @parcha/agentrun-serve
kind: fix
---
In Mode 2, where the runner's shell (Archil's serverless exec) runs bash, the console keeps bash on an agent with no computer: a new agent and a new race's pi lanes start with bash ticked, the Tools step lets you tick it, and a move to no computer keeps it, also on a server that gives new agents Docker's box. The console reads this from the run shell GET /v2/computers serves for each choice, the same one the server checks: bash stays on a runner place only where that shell is the runner's own. The background shell tools still need a box. A computer that mounts the run's folder (a desktop) has its own shell, which the server doesn't let on a runner place, so a move to one drops bash and the Computer step says so. In Mode 1 no computer has no shell, and a move there still drops bash, as it does before the computers list is read.
