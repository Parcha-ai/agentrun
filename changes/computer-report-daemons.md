---
packages: @parcha/agentrun-computer
kind: breaking
---
The conformance report's `daemon` is now `daemons`: one entry per computer that answered `hello`, each naming the computer and its role (`"shared"`, the run's computer, or the id of the case that made it), with its own `fence`. Read `report.daemons` where you read `report.daemon`. Each of `computerNotes` also names its computer's `role`, and the text report prints a `daemon <computer> (<role>)` line per computer.
