---
packages: @parcha/agentrun-serve
kind: fix
---
AgentRun Server refuses to start on a data directory that holds agent homes from 0.1.0-beta.26 or earlier (`<data>/<agent>/agent.sqlite`), naming each one, instead of starting with none of their agents or runs showing. That includes a volume already started on 0.1.0-beta.27 that still holds one, an agent named `runs`, and a symlinked home. The serve README's "Upgrading from 0.1.0-beta.26" says what to do: keep the earlier version on that directory, or start this one on a new directory, or with the old homes moved out.
