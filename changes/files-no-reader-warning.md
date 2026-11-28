---
packages: @parcha/agentrun-serve
kind: fix
---
A run given `file_ids` whose agent has no tool that reads files (no `read` or `bash`) is no longer told it can open them. Its first message names the files as "Files attached to this run, but this agent has no tool that reads files", and the create answer (POST /agents/{agent_id}/runs, POST /runs) carries a `warnings` entry at `file_ids`, reason `no_file_tool`, saying so and how to fix it. The run still starts. Before, codex and claude-agent runs said they would read the file, then asked the person to paste it.
