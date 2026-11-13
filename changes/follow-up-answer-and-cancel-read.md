---
packages: @parcha/agentrun-serve
kind: fix
---
A run's answer is its last turn's own: a follow-up whose stop shows no text (a thinking-only or contentless stop, a `/compact`) now reads `result.final_answer: null` instead of the previous turn's answer. A cancel reads `cancelled` from the `202` on: `GET /runs/{id}` reports the run as cancelled as soon as its cancel is written, before the runner has cut the turn, never `working` or `completed` in between.
