---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent
kind: feature
---
AgentRun Server's agent page compares the agent's revisions side by side: each revision's runs, how many completed, failed or escalated, their total cost, the cost per completed run with the cheapest marked, and the median time; a row filters the runs to that revision. A completed run whose revision names the `learn` tool gets a "Learn from this run" button, which sends `POST /v2/agents/{id}/learn` and says which revision it committed.
A server with no agents says what to do on its first page: make a new agent, or run the command that seeds the showcase. An agent whose current revision names a tool this server can't bind says so on its card, with the variables the tool needs, before a run is refused.
The store page's host script (`window.agentStoreHost`) can also answer `cards(agent, revisions, filter)`, cards between an agent's card and its runs, `run(data)`, what it adds to a stored run's head, and `empty()`, what the picker shows for a store with no agent. `pi-durable-agent serve` loads no host and draws as before.
