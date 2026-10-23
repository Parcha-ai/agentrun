---
packages: @parcha/pi-durable-agent
kind: feature
---
`pi-durable-agent serve <dir>` on an agent store (a folder holding `store.sqlite`) serves the store's page: its agents, each agent's revisions (an agentic prompt diffed line by line against its parent's, a workflow's graph with what changed) and its runs across revisions, and each run (an agentic run's timeline, a workflow run's path lit on its graph). It reads the store and the runs' own stores in place, read-only, and never copies them. `serveStore({ dir }, { port?, signal? })` from `@parcha/pi-durable-agent/serve` is the same from code.
