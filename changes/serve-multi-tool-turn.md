---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent
kind: fix
---
A claude-agent or codex run whose model asks for two or more tools in one answer completes. A harness reports each call as it runs it, and serve wrote the answer at its first call's end, so each later call of that answer went into the next answer's entry, after its own result: the closing answer then held a tool call, the call read as interrupted though it had succeeded, and the run stayed `working` until it was cancelled. Such a call is now written as a continuation of its answer (`agentrun.request_continued`), before its result. The timeline shows it under the answer it continues, and counts it as a tool call but not as a model request.
