---
packages: @parcha/pi-durable-agent
kind: feature
---
An agent store: `openStore(dir)` opens one folder that holds many agents, each with revisions written once and never edited, and every run pinned to the revision it ran. `store.sqlite` is four plain tables (`agents`, `revisions`, `skills`, `runs`), so an agent's runs by revision are one SQL join; a revision is an agentic prompt or a workflow, and its id is the SHA-256 of the canonical JSON of `{ agent, parent, kind, body }`. The methods are `createAgent`, `commitRevision`, `setCurrent`, `listAgents`, `listRevisions`, `readRevision`, `listRuns`, `startRun` (seeds the run's directory, then records the run), `carryBack` (ends a run once, with its state, cost and summary) and `importHome` (a beta.24 home becomes one agent with one agentic revision). `openStoreReader(dir)` opens the file read-only for a copy of the folder. Copy the whole folder to move the agents. The single-home API of beta.24 is unchanged.
