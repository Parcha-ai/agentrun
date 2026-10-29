---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent
kind: fix
---
On codex and claude-agent, a request's cost is written with its answer even when it is booked after the harness has the answer: the harness's proxy answers before it books the response. A turn's end now waits up to 2 s for those costs. A cost that comes after the wait leaves the answer written with its cost pending (`REQUEST_COST_PENDING`): the run's cost reads unknown until it comes in, as a `REQUEST_COST_LATE` the timeline adds to the cost without counting another request. So the run's spend, its spend cap and `/usage` count it once, and one paid request is one request. If the process goes before it can, the next open writes it from the session's booking, and never writes the request twice. Through a gateway (`AGENT_MODEL_BASE_URL`), codex now sends the model id as the gateway was configured with it, provider-qualified or not, and no longer strips `openai/` from it.
