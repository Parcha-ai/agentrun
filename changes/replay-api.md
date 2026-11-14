---
packages: @parcha/agentrun-serve
kind: feature
---
An agent's owner can replay a learned workflow's revision on the agent's graded inputs: `POST /v2/agents/{id}/learning/workflows/{name}/revisions/{digest}/replays` starts it, and `GET` the same path plus `/{replay_id}` reads it (`agentrun learning replay`). Before, only a run's claim started a replay, for a new revision only, so a held revision could not be checked again and an edited one waited for a run that fit it.
- `inputs`: `held` (the default), the graded runs the revision's last replay or hold was decided on, else the agent's newest 20; or a number from 1 to 500, that many of the agent's newest graded runs. 202 with the replay's id and how many inputs it replays.
- It is the claim's replay: the same reservation and replay runs (handed no per-run MCP credentials), the same records (`source: replay`, now with `replay_id`), promoted within 2 points of the agent or held, then refit, as a claim-started one is. The read decides it once its runs ended, so a revision no run lays is decided too.
- 404 for an unknown agent, workflow or revision; 409 `replay_conflict` while it replays, while another revision of it replays, once it is promoted, or with no graded input it fits; 400 for any other `inputs`. Only the owner's password session starts one; a token is 403.
- Fix: a graded run a learned workflow answered alone (path `workflow`) is now a replay input, beside the agent's (`agent`, `handed_back`). It has a recorded answer and a grade, which is all a replay scores against.
