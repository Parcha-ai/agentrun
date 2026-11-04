---
packages: repo
kind: docs
---
The README and the setup skill (`docs/SKILL.md`) lead with one model key: `OPENROUTER_API_KEY`, set where AgentRun starts, gives pi, Claude Code and Codex agents each a current model, with no `AGENT_MODEL`, and the console's Settings → Model keys is where to add it, with no restart. The Docker and Render instructions drop `AGENT_MODEL` for the same reason; a provider's own key (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`) still works in its place.
