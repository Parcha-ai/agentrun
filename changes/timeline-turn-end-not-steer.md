---
packages: @parcha/pi-durable-agent, @parcha/agentrun-serve
kind: fix
---
A Codex or Claude run stopped right after a tool finished, then told "Go on.", showed the follow-up as "You (steer): Go on." in the timeline, as if it had joined the stopped turn. The timeline now reads the turn's end that serve writes, so the follow-up shows as "You: Go on.".
