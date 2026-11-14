---
packages: @parcha/agentrun-serve
kind: feature
---
After an active agent's latest run completes successfully, its console page offers an optional production onboarding call and a link to create an AgentRun Cloud account or sign in. It confirms the full run result first and stays hidden during run-list loading, if a read fails, or if the answer is invalid. Both links open without sending local agent details, prompts, configuration or the referring URL. Local Run and Edit stay available; no Cloud account is required to keep using this server.
