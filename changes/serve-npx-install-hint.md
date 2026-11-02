---
packages: @parcha/agentrun-serve
kind: fix
---
claude-agent's missing Agent SDK names the line that fixes it for how the server was started. Run from npx (`npx @parcha/agentrun-serve`), where there is no project to install into, its reason in `GET /v2/capabilities` and in a refused run gives `npx -p @parcha/agentrun-serve@<this version> -p @anthropic-ai/claude-agent-sdk@0.3.286 agentrun-serve`, which runs the same server with the SDK beside it. Installed in a project, it gives the `npm install --save-exact …` line, as before. The server tells npx by where its own files are: under npm's `_npx` cache.
