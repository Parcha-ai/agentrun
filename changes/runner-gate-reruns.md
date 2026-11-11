---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel
kind: fix
---
A tool call the runner runs again after a crash meets the run's gate again. Before, a replay-safe call (web_search, web_fetch) that pi reran after a crash skipped the gate: a deny set since its first attempt didn't stop it, and a tool set to ask since ran it with no one's approval. Now a deny or a pin refuses the rerun in words saying the earlier attempt may have taken effect ("whether it took effect is not known"), never "nothing was sent", and a tool set to ask parks the run on it, the owner's answer then acting on it. A stop that lands while the rerun is asked wins over a permission that comes after it: the call never starts. Codex and Claude Code reruns say the same.
