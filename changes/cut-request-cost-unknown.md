---
packages: @parcha/pi-durable-agent, @parcha/agentrun-serve
kind: fix
---
**A run's cost reads unknown once a model request was cut, never $0**
- The timeline's cost row counts a request cut before its end (a stopped turn, a killed process) as unknown, so the run's sum reads "unknown" from then on. Before, the cut request added its stream's reported usage: $0 on the OpenAI Responses API, which reports usage only at the end, and only the input and first output token on Anthropic's Messages API. Either way the provider charged more than the sum showed.
- serve's run cost takes the timeline's usage row as it is. A run opened again by a follow-up whose rows say unknown no longer shows the cost the agent store kept from its earlier end.
- A request cut before it streamed any content leaves no assistant entry in the store, so it is not counted at all; that is unchanged here.
