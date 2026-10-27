---
packages: @parcha/agentrun-serve
kind: feature
---
AgentRun Server reviews what a learning run proposed and merges it into the agent's `main`. Once a run's branch is proposed, the server curates it in the agent's queue with `@parcha/pi-agent-learn`'s curate: the checker on the tools this server binds, the injection screen and the judge. `learning: auto` merges what passes; `learning: approve` holds the plan until a person approves or refuses it (`learning.approve` and `learning.refuse` on the server, each naming who decided). A merged branch is deleted while it is still at the commit proposed.
- The injection screen is the host's (`learning.screen` in `startServe`'s options), and the judge is Jev on `TYPESAFE_API_KEY`, now one of the server's own variables that no run's process gets. With no screen or no judge nothing is curated: the branch waits, the run's learning state says why, and the next start reviews it.
- A run awaiting approval is never curated without a person, at start or after. The judge's cost is the agent's learning cost, recorded on the run's learning state, and never moves a run's own cost.
- Propose and review guard every learning write against one list of the host's secrets: the server's token, the door token, `TYPESAFE_API_KEY` and every key, token, secret and password variable. A judge call that does not answer in 2 minutes, or one still out when the server closes, is let go: nothing is curated and the run waits as `no_judge` for the next start, so a hung judge never holds shutdown. A run whose branch is gone is not recorded as merged.
