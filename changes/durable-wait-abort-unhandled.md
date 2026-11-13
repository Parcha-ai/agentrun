---
packages: @parcha/agentrun-serve
kind: fix
---
A runner's close, or a lost claim, while a resumed pi run opens its session no longer ends the runner process on an unhandled rejection. pi-durable answers a wait registered after its signal aborted with a promise it rejects at once and hands back only after the commits before it are published, so on Postgres that rejection could go unhandled: the standalone runner exited 1 on it with its claims left to lapse, and a runner beside the server took the server down. Every wait on a pi-durable submission or task (the pi turn, a steer's turn, a subagent, a workflow node and task, a host tool's waitForTask) now runs on a signal of its own that never aborts and is cut by the caller's signal here, so the turn ends interrupted as before. A waiter pi-durable made and never handed back because its Session failed (a commit's storage error) no longer rejects unhandled either.
