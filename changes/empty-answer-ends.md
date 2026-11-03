---
packages: @parcha/pi-durable-agent, @parcha/agentrun-serve
kind: fix
---
A pi run whose model ends its turn with a stop that holds only an empty text block (and perhaps an empty thinking block), with no tool call, now completes. Before, the timeline showed no row for it, so the run read `working` and `idle` until it was cancelled and its timeline never turned final. The timeline now shows a `final_answer` row with empty text for that answer, and the run completes with `result.final_answer` `""`. A message with no text block at all, such as a request the Claude or Codex bridge writes without content, still shows no row.
