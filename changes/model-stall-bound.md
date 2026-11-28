---
packages: @parcha/agentrun-kernel, @parcha/agentrun-serve, @parcha/agentrun-harness-claude, @parcha/agentrun-harness-acp, @parcha/agentrun-harness-codex
kind: fix
---
A run whose model provider takes a request and then sends nothing now ends failed after 4 minutes, in words that name the stall, rather than staying working. Before, the session's model proxy waited on the transport: Node's fetch cut such a request after 5 minutes as "terminated", pi retried that up to 8 times (about 48 minutes of "Model request failed: terminated" rows while the run showed working), and a run on a provider that kept silent never ended until it was cancelled.

The proxy now stops a forwarded request that goes `stallMs` (default `MODEL_STALL_MS`, 240 s) with nothing from the provider, before its headers or between two pieces of its answer. Time spent waiting on a slow client is not counted. The client is told "the model sent nothing for 240 s, so the request was stopped" (code `model_stalled`): at the refused status before the answer began, or as the stream's last `error` event after. None of these words is one a client retries on. The request is booked once, at an unknown cost. A host with `onFinal` (claude-agent, goose, opencode and codex) ends the turn in those words, and the turn's next answer request is refused until the host opens its next turn. pi ends it because it does not retry those words. The run's timeline shows "Model request failed: the model sent nothing for 240 s, so the request was stopped".

`MODEL_STALL_MS`, `MODEL_STALLED` and `stalledWords` are exported from `@parcha/agentrun-kernel/host`. `ModelProxyOptions.stallMs` and pi's `PiAdapterOptions.stallMs` set the bound.
