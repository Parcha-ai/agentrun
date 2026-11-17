---
packages: repo
kind: docs
---
The setup skill (`docs/SKILL.md`) checks that the person can reach the machine before a local install. In a hosted cloud session or sandbox whose loopback their browser cannot open, the assistant stops before changing anything and offers a session on their own computer or AgentRun Cloud; on a remote machine it continues only with a tunnel or port forward they confirm. After the server starts, it waits until the person confirms the console opens in their browser, and never describes a preview or link it has not confirmed exists.
