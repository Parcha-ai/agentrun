---
packages: @parcha/agentrun-serve
kind: fix
---
An agent in a sandbox box is no longer refused for want of a model key that is set, on a machine where Claude Code is signed in. With Claude Code's login on, an agent in a box (a pi agent on an OpenRouter model in E2B, say) read as having no model key at all, saved in Settings → Model keys or set where AgentRun starts: its run was refused with "No OpenRouter key here …", its save warned the same, and its learning page read no model, while the same agent on the runner ran.
