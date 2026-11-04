---
packages: @parcha/agentrun-serve
kind: feature
---
A run's `effort` now also adds a short note on how to work, right after the agent's instructions, on every harness (pi, claude-agent and codex), as well as setting the thinking level as before. `low` says to answer directly, search once only for a fact it lacks, and stop; `medium` to plan briefly, check key claims against a second source, and check the answer once; `high` to plan each part, fill the gaps and review the result against the request. On claude-agent the note is system prompt text, not a skill. A run with no `effort` gets no note, and its prompt is unchanged. The notes are one table in `src/effort-guidance.ts`, and the contract's `Effort` description says so.
