---
packages: @parcha/agentrun-adapters, @parcha/agentrun-serve
kind: fix
---
Claude and Codex runs keep their token counts and their model in the run's journal, as pi runs do. A `runner.turn` record now keeps its request's tokens (`usage: {input, output, cacheRead, cacheWrite}`), so a request re-booked when the run opens again keeps them; a cost written late (`agentrun.request_cost_late`) and a compaction's cost (`agentrun.request_cost`) carry the request's tokens in `data.usage`; and an adapter answer's `pi.assistant` entry names the model its request asked for, its provider still the harness. Tokens that are not known are left out, never written as counts. Journals written before this change open and re-book as before, with no tokens. No cost changes.
