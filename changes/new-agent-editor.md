---
packages: @parcha/agentrun-serve
kind: fix
---
The console can make a Decision or a Workflow agent again. Since "New agent" opened the Build page, the editor that offers those two (its harness picker's Decision and Workflow) only ever opened on an existing agent. Build now links "set one up in the editor", which opens the editor creating a new agent at `#/agents/new?editor`, with every harness, Decision and Workflow to pick from. An agent named `new` keeps its own pages, its editor at `#/agents/new/edit`.
