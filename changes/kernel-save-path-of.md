---
packages: @parcha/agentrun-kernel
kind: feature
---
`@parcha/agentrun-kernel/kernel` exports `savePathOf(given)`, the function `computer_screenshot` resolves its `save_as` with: a path relative to the run's folder, normalized (posix), inside it, ending `.png`, or a thrown refusal in words. A host's tool gate can then hold a `save_as` at the path the screenshot is saved at, not by a reading of its own. AgentRun's serve does this for a folder an MCP tool's file setting files its answers in. Nothing else changes: the screenshot resolves `save_as` as before.
