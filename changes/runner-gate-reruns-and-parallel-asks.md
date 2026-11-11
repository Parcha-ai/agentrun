---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel
kind: fix
---
A tool call the runner runs again after a crash meets the run's gate again. Before, a replay-safe call (web_search, web_fetch) that pi reran after a crash skipped the gate: a deny set since its first attempt didn't stop it, and a tool set to ask since ran it with no one's approval. Now a deny or a pin refuses the rerun in words saying the earlier attempt may have taken effect ("whether it took effect is not known"), never "nothing was sent", and a tool set to ask parks the run on it, the owner's answer then acting on it. Codex and Claude Code reruns say the same.

When a turn asks for approval of several calls at once, one waits for the person at a time: the others are refused in words ("This write call was not run: the write call <id> already waits for a person's approval. Call it again once that one is answered."), so a run has one pending approval, and the model calls them again once it's answered.
