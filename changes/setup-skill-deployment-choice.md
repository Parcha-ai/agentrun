---
packages: repo
kind: docs
---
The setup skill (`docs/SKILL.md`) asks where AgentRun should run before it installs or deploys anything. The assistant presents four places with one line each (this computer, a machine the person already runs agents on, a hosting provider, AgentRun Cloud) and waits for the answer. "Set it up", "self-host" or "on my machines" no longer counts as a choice, and it never creates a service on Render or another provider the person did not name. Before that question it asks which scheduled, triggered or always-on agents the person already runs and, with permission, reads this machine's cron, timer and CI schedules for Claude Code and Codex jobs, so AgentRun goes where those agents live and they are the ones connected.
