---
packages: @parcha/agentrun-serve
kind: fix
---
A capped workflow run writes one budget entry per cap in two more cases. A retry of the raise that resumed the run, reaching it once it parked again at the raised cap, is taken and leaves the new pause standing: its raise entry names the pause the raise answered, as an agentic run's does, not the one the run stands at since. A claim of a run paused at its cap whose row reads running (a woken claim lost before its release) parks the run again on its pause, as a claim of the parked run does. Before, each ran the held step into the same cap and wrote another `agentrun.budget` entry. A run's view shows the pause it stands at after such a retry: a raise entry clears only the pause it names.
