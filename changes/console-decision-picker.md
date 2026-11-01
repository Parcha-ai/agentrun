---
packages: repo
kind: feature
---
The console's agent builder can create a decision agent: on a new agent, the harness picker lists **Decision** after Pi, Claude and Codex. Picking it makes the agent a workflow revision built from a starter decision workflow (one typed question on the server's default decision provider, a threshold, and a person for an unclear answer, adapted from the repository's jury demo), with no instructions, tools, thinking or model to fill in; after Create the agent opens on its Workflow step, where its nodes are edited. Decision is offered when the server's capabilities list the `runJudge` workflow adapter, and shown disabled with why otherwise. It is a choice in the console only: the revision names no harness, and the server is unchanged.
