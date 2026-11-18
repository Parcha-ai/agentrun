---
packages: @parcha/agentrun-harness-claude
kind: feature
---
Claude Agent can run on the claude CLI's own login on the same machine instead of a model key. `claudeLoginStatus` asks the CLI `claude auth status` and returns what it said (signed in, method, email, plan), never a token. `claudeLoginEnv` gives the run's CLI the login's directories and no `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` or key. `claudeLoginCommand` and `startClaudeLogin` give or start the CLI's own `auth login`. A session on the login keeps its directory out of the sandbox's reads, never wipes it, and books its tokens with no dollars.
