---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: fix
---
A served run a restart cut mid-call no longer counts as the learned workflow being unsure. When a runner was lost while the workflow's call was out, the next claim ended that call `interrupted` and handed the run back, and `GET /agents/{id}/learning/cost` `summary.hand_backs.back` counted it with the workflow's own escalates. `hand_backs` now has a third count, `cut`: the hand-backs whose workflow call ended `interrupted`. `back` keeps only the hand-backs the workflow made itself (an escalate, a failed step, an answer cut by size or schema). A cut run's path stays `handed_back` and its cost stays the agent's. The console's Unsure stage reads `back` over `ran` and says "N cut by a restart" when `cut` is above 0. The cost chart's headline does the same, and the Learning tab's "Finished alone" leaves cut runs out. The TypeScript and Python clients' `hand_backs` types gain `cut`.
