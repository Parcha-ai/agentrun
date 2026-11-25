---
packages: @parcha/agentrun-serve
kind: fix
---
MCP evidence (`evidence/mcp`) on a Mode 2 run now lands on the run's disk too. Before, a claim's MCP gateway wrote to the runner's own folder for the run, which a Mode 2 claim never makes, or (in pi's spec) over the disk's file API, which the run's computer's mount refuses while it holds the disk's write delegation. Either way, the model was told a long answer "could not be saved". Each claim path now hands the gateway the run's active Workspace: the one attached to the run's computer once that computer mounts the folder, otherwise the disk's file API. Mode 1 is unchanged: the run's folder on this machine, which a Docker box bind-mounts.
