---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent
kind: feature
---
A run has one workspace. A run on a harness other than pi keeps it in the directory its harness is lent, `<run>/harness/work`. That is where the harness's own tools write, so pi's door tools, its skills, the files route and the file list all read and write the same tree. A pi run keeps `<run>/work`.
- serve records the workspace in the run's `serve.json` (`workspace`) when the run starts, and opens every later process of the run on it (`pi-durable-disk run --workspace`). A run without the field, one started before it, keeps `work`, and it is never moved.
- The agent store's `startRun({ agent, revision?, workspace? })` seeds the run's skills into that workspace and makes `harness/` mode 0700. `WORKSPACES` and `isWorkspace` name the two places; anything else is refused (`invalid`).
