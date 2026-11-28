---
packages: @parcha/agentrun-serve, @parcha/agentrun-computer
kind: fix
---
Local template evals wait for their Docker computers, egress proxies and volumes to be removed before exiting, up to a shared two-minute cleanup deadline. The Markdown and JSON reports identify any run whose cleanup failed or timed out.
