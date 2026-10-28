---
packages: @parcha/agentrun-serve
kind: docs
---
Corrections to the entries above that describe earlier stages of the package, and the README brought to what the server does.

- The server follows the `agentrun.v2/0` contract; the entries above do not say what the hosted API serves. The npm package is not published (it is private); the server ships as the public image `ghcr.io/parcha-ai/agentrun-server`.
- It serves one agent store, not an agent home per agent.
- `PUT /v2/agents/{id}/definition` commits a new revision; definition updates do not answer `501`.
- It listens on 127.0.0.1 by default, and `--listen ADDR` listens on another address (the image listens on `0.0.0.0`); it does not bind loopback only.
- Without `--faux`, pi-ai's providers serve the models, with their keys from the environment; `AGENT_MODEL_BASE_URL` is an optional gateway, not the default.
- A definition's `output_schema` is refused by name (`422`); there is no `output_invalid`.
- The README now documents a run's body (`effort`, `max_cost_usd`, `file_ids`, `quote_id`, and that `max_message_chars` does not bound the first message), that `/messages` takes only `{content}` and picks `steer`, `answer` or `follow_up` from the run's state, that an ended run cannot be continued, how a client applies timeline pages (`reset`, `drop`, then upserts by `id`) and what a `waiting` row means, `/usage`'s `from`, `to` and groupings, and the one token and its `401`.
