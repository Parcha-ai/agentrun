---
packages: @parcha/agentrun-adapters
kind: feature
---
`followUpOnce` in `./kernel`: one more turn in a session that has answered, sent at most once. Its intent is durable before the prompt leaves, so a process that dies inside it leaves it interrupted and no later process sends the prompt again; a follow-up turn a crash cut off is settled, never resumed, so it makes no paid request after the crash. Its paid requests are held to a reserve of their own (`reserveUsd`, counted from its first request), and a request is refused while the session's spend is unknown. `followUpState` reads its state from its records, for a host deciding whether an open turn is the follow-up's.
