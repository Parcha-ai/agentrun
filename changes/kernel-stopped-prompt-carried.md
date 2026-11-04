---
packages: @parcha/agentrun-kernel, @parcha/agentrun-serve
kind: fix
---
A message the person stopped before the harness began it is no longer lost. A Codex or Claude run stopped in its first seconds (Codex still starting), then told "Go on.", answered "I'm missing the earlier task context": the stop withdrew the first message, and the follow-up reached the model alone. Now the stopped message stays in the conversation. The next message carries it first, with a line saying it was stopped before any work on it began, and the stopped turn still never runs on its own. Several stopped messages are carried in order. A stopped steer is not carried.
