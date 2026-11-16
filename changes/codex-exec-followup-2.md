---
packages: @parcha/agentrun-serve, @parcha/agentrun-harness-codex
kind: fix
---
Two fixes to how a Codex code-mode `exec` reads on the timeline, and one line in the desktop and phone skills. An exec that ends ok after its call parked on a person's approval and then ran shows its calls' outcomes alone, without "The exec was cut short after these calls (the session stopped)" or a resumed wait's "that cell's script was cut off". The model is still told those words, and an exec that failed still shows them. An exec the run's end closes, because nothing else ended it (the run stopped while its call waited for approval, or a crash whose next claim never resumed Codex's thread), now reads "Using tool: exec interrupted" with no status (`tool_status` null), never failed: a park or a stop failed nothing. A call a crash cut off still reads failed. The skills' "On Codex" paragraph now says Codex's exec has no top-level `return`, so a script's output goes through `text(...)`.
