---
packages: @parcha/agentrun-kernel, @parcha/agentrun-harness-claude, @parcha/agentrun-harness-codex
kind: feature
---
The local session machine and the adapter session are one implementation each in the kernel, and both harnesses run on them: `openLocalMachine`, `startChild`, `childEnv` and `confined` from `@parcha/agentrun-kernel/host`, and `openAdapterSession` and `CallsInFlight` from `@parcha/agentrun-kernel`. Each harness's `localMachine`, `childEnv` and `confined` keep their names, messages and behavior.
On Codex, a pause now drains as it does on Claude: `interrupt({ drainMs })` lets a call in flight run on until its outcome is recorded, and `send` is refused while the session pauses. Before, Codex stopped the turn at once and cut the call. A turn whose drive ends in a `Restart` is rebuilt from the log, at most 3 times; an app-server that exits mid-turn still fails the turn.
