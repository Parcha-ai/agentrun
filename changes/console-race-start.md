---
packages: @parcha/agentrun-serve
kind: feature
---
The console starts a race at `#/races/new` (New race, on the Runs toolbar): one task, a spend cap per lane, and 2 to 4 lanes, each a harness and model this server runs. Each lane gets the tools a new agent of its harness gets here. A refused lane says why, and the others start; Start again never starts a lane twice. A refused last lane can be removed, and the race opens once every lane left has a run.
- Each lane is an agent of the console's own, named `Race <label>, lane <n>`, so the Agents list edits and archives it like any other once the race is over.
