---
packages: @parcha/agentrun-serve
kind: fix
---
A run's usage row reads the same on every harness, and says what an owner needs to know about its cost.
- A run that ended says "Cost: …" in the Timeline and the run's view; only a run still going says "Cost so far: …".
- Claude Code, Codex and OpenCode runs count their tool calls with no price ("; 1 tool call not metered", and `usage.not_metered`), as pi runs did.
- A model request that failed with no price (a provider's refusal sends none) says on its row that its cost is unknown and the provider may still bill it. Its cost stays unknown, never $0.
