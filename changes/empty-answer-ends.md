---
packages: @parcha/pi-durable-agent, @parcha/agentrun-serve
kind: fix
---
A pi run whose model ends its turn with a stop that holds no text, and no tool call, now completes. The stop can be an empty text block, only a thinking block, or no content at all. Before, the timeline showed no row for it, so the run read `working` and `idle` until it was cancelled, and its timeline never turned final. The timeline now shows a `final_answer` row with empty text for that answer, and the run completes with `result.final_answer` `""`. An entry a host writes with no text still shows no row: the Claude and Codex bridge's requests without content (a cost, a cut, a compaction), and an imported session's turns.
