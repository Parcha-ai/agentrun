---
packages: @parcha/agentrun-serve
kind: fix
---
A cancel holds on every harness. A run on codex or claude-agent whose cancel serve has marked sends no further model request, as a pi run already did. Each request the harness's session asks for is refused before it leaves: the turn ends on the refusal, with nothing sent or paid. That holds whatever started the turn, a message or a recovery the run's process starts itself.
