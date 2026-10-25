---
packages: @parcha/pi-durable-agent
kind: feature
---
`commitRevision(agent, revision, { ifCurrent })` makes a commit a compare-and-swap: `ifCurrent` is the agent's current revision as the caller read it (null for none), compared inside the commit's own transaction, and another current revision refuses the commit with `AgentHomeError` `stale` and writes nothing. A host serving `If-Match` passes it, so of two edits that read the same revision exactly one lands.
