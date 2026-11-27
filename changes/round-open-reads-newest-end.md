---
packages: @parcha/agentrun-serve
kind: fix
---
Checking whether a run's learning round is still going now reads only the newest end in the run's journal: its job's end kept for the look-back, or the run's last end. A claim that waits on another run's round checks it about every 2 s, and a run of a learning agent checks each of its agent's steered running runs as it starts. Before, each check read the run's whole journal, so a long run cost more with every check. The answer is unchanged.
