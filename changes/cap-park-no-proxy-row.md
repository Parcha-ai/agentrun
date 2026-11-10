---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent, @parcha/agentrun-kernel
kind: fix
---
A run parked at its spend cap no longer shows a "Model request failed: 400 {…agentrun_proxy…}" row in its Timeline. The model proxy refused that request before it was sent, and the park's row already says what happened. That refused request also no longer counts as a model request in the run's usage line. The proxy's refusal body now carries `code: "spend_cap_reached"` beside its message, and the Timeline matches on that code and `type: "agentrun_proxy"`, never on the message's words. Every other model failure, a provider's 400 included, keeps its row.
