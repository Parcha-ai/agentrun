---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent
kind: feature
---
AgentRun Server keeps a learning repository for each agent that learns. A run of that agent starts from the repository's `main` at one commit, and once the run ends the server leaves its branch `runs/<run id>` there with a memo.
- A definition takes `learning`: `off`, `auto` or `approve`. It is for agentic agents only. A new agentic agent gets `auto`, and an edit that leaves the field out keeps the current revision's value. A revision saved before the field existed is `off`, and its id does not change, because `off` is stored as the field's absence (`AgenticBody.learning` in `@parcha/pi-durable-agent`).
- The repository is a bare git repository at `DATA/agents/<id>/learning.git`, beside the store. Its `main` carries `AGENTS.md` and `agent.json` for the agent's current revision. The server writes them as one commit, with a `Revision` trailer, whenever the current revision changes.
- A run's process resolves `main` once and journals that commit in the run's store, so a run opened again keeps its base. The notes active at that commit go to `work/.agent/learnings/` and into the `<learned>` section of the prompt, and the skills the agent wrote join the revision's own; a revision skill of the same name wins. The run gets the `learn` tool.
- Before the server carries a run back, it proposes what the run learned as `runs/<run id>` from that commit, with the memo's front matter `run`, `base`, `harness: pi`, `outcome` (`completed`, `failed` or `stopped`), `untrusted` and `cost_usd`. The `Run-Id` trailer makes a second proposal of the same run a no-op. Nothing merges into `main` yet.
