---
packages: @parcha/agentrun-serve
kind: fix
---
On codex and claude-agent, a request's cost is written with its answer even when it is booked after the harness has the answer: the harness's proxy answers before it books the response. A turn's end now waits up to 2 s for those costs. A cost that comes later still leaves the answer written at unknown cost, and marked booked, so the next open of the run never writes the request twice. Through a gateway (`AGENT_MODEL_BASE_URL`), codex now sends the model id as the gateway was configured with it, provider-qualified or not, and no longer strips `openai/` from it.
