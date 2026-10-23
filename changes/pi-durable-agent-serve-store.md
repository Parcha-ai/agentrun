---
packages: @parcha/pi-durable-agent
kind: feature
---
`pi-durable-agent serve <dir>` serves an agent store (a directory holding a `store.sqlite`) as well as a home: an agent picker, each agent's revisions newest first (an agentic one's prompt diffed line by line against its parent, with its tools, skills, model and thinking changes; a workflow's graph with graphDiff's badges), its runs across revisions filtered by revision, and each run (an agentic run's timeline, a workflow run's node path on its graph). `serveStore(store, { port?, signal?, openReader?, workflow? })` from `@parcha/pi-durable-agent/serve` is the same from code. It is read-only and loopback-only as a home's page is: the index is read from a SQLite backup copy, run stores through read-only handles or a copy. A run with no recorded cost reads unknown, and escalated and missing are states of their own.
