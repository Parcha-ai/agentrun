---
packages: @parcha/agentrun-serve
kind: fix
---
Behaviour change for Mode 2: MCP evidence (`evidence/mcp`) now lands on the run's disk instead of the runner's local folder for the run. Before, a claim's MCP gateway wrote to that local folder, outside the run's files. Where nothing had made the folder, it told the model a long answer "could not be saved". In pi's spec it wrote over the disk's file API instead, which the run's computer's mount refuses while it holds the disk's write delegation. Each claim path now hands the gateway the run's active Workspace: the one attached to the run's computer once that computer mounts the folder, otherwise the disk's file API. A Mode 2 run with no computer mounting its folder files no fal results (`evidence/fal`) until Parcha-ai/agentrun#3777. With one, they are filed through the computer. Mode 1 is unchanged: the run's folder on this machine, which a Docker box bind-mounts.
