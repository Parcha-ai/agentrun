---
packages: @parcha/agentrun-serve
kind: fix
---
A trigger's message that reaches a pi run while the turn that calls `ask_person` is still running no longer takes the person's place. The runner handed such a message to pi as a follow-up, and pi runs a follow-up as soon as its turn would end, so the message ran right after the question: the run never waited for the person, and it ended with the question unanswered. The runner now keeps a trigger's message that arrives mid-turn until the turn ends, as it already did for Claude Code, Codex and OpenCode runs. A turn that ends on a question parks on it first, and the message runs as a turn of its own after the person's answer. A turn that ends any other way runs the message next, as before. The firing still reads `sent`.
