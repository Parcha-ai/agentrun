---
packages: @parcha/agentrun-claude-agent
kind: fix
---
After a crash mid-turn, the claude-agent harness's recovery note no longer reaches the user's answer. The note (which tool calls completed, which may have half-run) was sent as a user message, and the model sometimes answered it back ("No tool calls had run, so nothing needed undoing, and ..."). It now rides in the resuming drive's system prompt. The user's turn holds only the user's own words: the interrupted turn's prompts the transcript lost, and messages sent since. With none, it is a bare "Continue.". A resumed session sends the system prompt recorded at its start, whatever a later launch passes (`systemPrompt.snapshot`, Agent SDK 0.3.286), so the resuming drive alone renders its own (`snapshot: false`). That drive records nothing, so the next drive sends the original prompt again.
