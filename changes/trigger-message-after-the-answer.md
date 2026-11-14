---
packages: @parcha/agentrun-serve
kind: fix
---
A trigger's message that reaches a run just as it comes to wait on a person is now delivered after the person's answer, as a turn of its own, whenever it lands. Before, one that reached the runner between the question's turn end and the park (or while the run waited in its claim) was refused and never ran, while its firing still read `sent`.
