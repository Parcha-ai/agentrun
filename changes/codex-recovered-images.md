---
packages: @parcha/agentrun-harness-codex
kind: fix
---
On Codex, a call that returned images and completed just before the session stopped, before Codex recorded its answer, is now repaired as its text plus a line saying how many images it returned, which are not shown again. Before, the model got the images' base64 as JSON text.
