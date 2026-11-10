---
packages: @parcha/agentrun-serve
kind: fix
---
A model key saved in Settings → Model keys now runs agents on the runner with no restart. Before, the runner read model keys only from the environment AgentRun started with, so a server whose only key was saved in Settings failed every run with "No Anthropic key here … add one in Settings → Model keys". pi runs, claude-agent and codex runs, a workflow's model nodes and a learning run's grade now take their model's key from the store at each claim, as tool keys already were; a key set where AgentRun starts still wins, and a key saved again is the one the next run uses. Claude Code and Codex runs on a server started through its launcher reach their model with its key again (#2165): the runner no longer drops the keys its launcher handed it when it builds a CLI run's environment.
