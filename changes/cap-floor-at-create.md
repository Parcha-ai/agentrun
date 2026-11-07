---
packages: @parcha/agentrun-serve
kind: feature
---
A spend cap too small for one model request is refused when the run is created, instead of starting a run that pauses before doing anything. Each run's first request records its floor, priced in the run's process by the cap's own rule: the least a cap must be to send it (its input and least output) and a typical first request (its input and 4,096 output tokens). `GET /v2/agents/{agent_id}` serves the current revision's newest one as `cap_floor` (`least_usd`, `typical_usd`, `model`, `effort`, `measured_at`, `by_effort`), and `POST /v2/agents/{agent_id}/runs` with a cap under that least, the run's own message counted, is `422 input_invalid` with `fields[0].reason` `below_least` and `details.least_cap_usd`, `least_usd` and `typical_usd`, in words naming the model and both figures. The server prices no model itself, so the floor appears after a revision's first run: until then a too-small cap pauses at step 0 once, and that pause records the floor.

Upgrading: a client that started a revision's runs with a cap below its first request's least, expecting them to pause at once, now gets a 422 for every run after the first; give the cap `details.least_cap_usd` names, or more.
