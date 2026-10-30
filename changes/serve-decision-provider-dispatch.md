---
packages: @parcha/agentrun-serve
kind: fix
---
A workflow's typed questions honour the node's own decision settings, and a decision's unknown cost survives a restart.
- A run's judge goes through `judgeFromProviders` over the server's providers (Jev here), and the run's checks before any node runs take the same providers. A node naming a provider the server does not run is refused before the run, naming the node and the provider, instead of being asked of Jev. A node's `timeoutMs` bounds its request, and each receipt names the provider that answered.
- A workflow run a restarted server adopts as ended reads its decisions' cost from its store again, so a run with a decision of unknown cost reads `cost.usd: null`, never the model's priced usage alone.
