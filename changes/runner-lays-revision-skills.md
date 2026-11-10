---
packages: @parcha/agentrun-serve
kind: fix
---
A run the runner takes now has its agent's own skills: at each claim the runner lays the revision's skill files in the run's `.agents/skills/` from the revision's stored texts, each skill folder not there yet, never over a learned skill or an earlier claim's, before the prompt names them. Before, nothing laid them and a run of an agent with skills failed with `".agents" is not there`.
