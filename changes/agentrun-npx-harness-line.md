---
packages: @parcha/agentrun-serve, repo
kind: fix
---
Started by `npx @parcha/agentrun`, a server with no Claude Agent SDK or Codex says the line that adds it and keeps the person on that command and its data: `npx -p @parcha/agentrun -p @parcha/agentrun-serve@<its version> -p @anthropic-ai/claude-agent-sdk@0.3.286 agentrun` (for Codex, `-p @openai/codex@0.164.0`). It said the line for `npx @parcha/agentrun-serve`, which starts another command on another data directory. The command tells the server it started it with `AGENTRUN_COMMAND=agentrun`; a server installed in a project still says its `npm install` line.
