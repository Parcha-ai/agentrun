---
packages: @parcha/agentrun-serve
kind: fix
---
Three fixes found by running again the tests the cutover skipped:
- A paid tool call's cost row on a run's timeline names the tool it ran (`web_search`, `web_fetch`) in its `tool_name` and its words, as the API docs say. Before, it named the fee ("Parallel's search").
- Saving an agent whose workflow the DSL can't read, with `POST /v2/agents` or `PUT /v2/agents/{agent_id}/definition`, answers 422 on `definition.workflow` in the DSL's words. Before, it answered 500.
- The contract's form of `PUT /v2/agents/{agent_id}/definition` takes any `version` past the current revision's, as the contract says; the revision is numbered the next. Before, a version further on than the next was refused 422.
