---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent, @parcha/agentrun-kernel
kind: fix
---
A run parked at its spend cap no longer shows a "Model request failed: 400 {…agentrun_proxy…}" row in its Timeline. The model proxy refused that request before it was sent, and the park's row already says what happened. That refused request also no longer counts as a model request in the run's usage line.

The cap's refusal now carries its code through to the proxy as a field: the runner's `Refusal.code`, then `HarnessRunError.refusal`. The proxy writes `code: "spend_cap_reached"` in its refusal body. The Timeline matches on that code and `type: "agentrun_proxy"`, never on the words. Every other model failure, a provider's 400 included, keeps its row.
