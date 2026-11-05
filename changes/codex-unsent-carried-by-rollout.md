---
packages: @parcha/agentrun-kernel, @parcha/agentrun-harness-codex
kind: fix
---
A Codex run stopped just after its message was sent to Codex no longer loses the message. Codex answers `turn/start` before it writes the message to its rollout: on the real app-server, killed at the answer or 20 ms after it, the rollout held no user message; 100 ms after, it did. A stop in that window kills Codex with the message sent and never recorded, and the next Codex, resumed from the session's rollout, never has it. The stop's settle now reads Codex's rollout as the session keeps it, the rollout the next Codex is resumed from, and carries a placed message it lacks into the next one, as claude-agent's settle reads its CLI's transcript. The `turn/start` send mark is gone (the kernel's `markSent` and `sentMarks` with it); a stopped drive still starts no turn.
