---
packages: @parcha/agentrun-serve
kind: fix
---
Settings → Model keys names, for each key, the harnesses that key runs on this server, the same before and after another provider's key is saved. With Claude Code on an endpoint set where AgentRun starts (`ANTHROPIC_BASE_URL`), OpenRouter's key no longer lists Claude Code once Anthropic's key is saved: only Anthropic's own key runs it there.
