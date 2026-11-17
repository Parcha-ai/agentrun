---
packages: @parcha/agentrun-serve
kind: breaking
---
A run can bring its own model key, such as a LiteLLM virtual key minted for it: `model_key` on `POST /v2/runs`, `POST /v2/agents/{agent_id}/runs` and `POST /v2/runs/{run_id}/messages`. Every model request tied to the run carries it in place of the server's key, through the model proxy: its turns, subagents, learned workflows' nodes, workflow model nodes and end-of-run compile turn. AgentRun never mints, lists or revokes it.
- Custody follows `mcp_auth`: taken out of the body first, sealed with the run bound to the gateway's origin, opened at each claim (a reclaim after a crash too), erased by the write that ends the turn, redacted, and never seen by the harness, its tools or its sandbox. A message's key replaces the run's from the turn it starts.
- No setting: a server with a gateway (`AGENT_MODEL_BASE_URL`) and no model key of its own starts and reads ready, and its callers bring their own. A run whose model goes to the gateway with no key to spend is 422 `model_key_required` at its start, as is a message that would start a new turn without one; a trigger's firing on such a server fails the same way.
- Behavior change for a gateway that takes no key: a server with `AGENT_MODEL_BASE_URL` and no `AGENT_MODEL_API_KEY` used to send `none` as the key; its runs now need `model_key`. Set `AGENT_MODEL_API_KEY` to any value to keep the old behavior.
- claude-agent with `ANTHROPIC_BASE_URL` on the gateway's origin no longer needs a standing `ANTHROPIC_API_KEY`: it runs on the run's key.
- `model_key` where the run's model never goes to the gateway (no gateway, a native run, a model routed elsewhere) is 422 at `model_key`.
- Spend after a run's turn ends is never sent on the run's key or the server's: a run that brought its own key starts no shadow audit or replay check, and a server with no key skips them and an SDK run's compile turn, refuses an owner's replay (409), and opens no grade feedback round.
