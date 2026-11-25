---
packages: @parcha/agentrun-harness-acp
kind: fix
---
A turn whose agent dies saying a refusal the recipe names now fails as that refusal, even when the agent's stdout closed before its stderr was read. The failure waits up to five seconds for the agent's process to close before it reads the stderr tail. Before, a turn could fail as `ACP_AGENT_EXITED` with "ACP connection closed" while the refusal was still in the pipe.
