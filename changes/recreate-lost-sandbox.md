---
packages: @parcha/agentrun-serve
kind: fix
---
A run whose sandbox is lost mid-run now gets a new one. Before, every later tool call went to the deleted sandbox and failed, and the run could still end `completed`.
- A sandbox is lost when its provider no longer has it: the hosted connection says it was deleted, or a call answers gone and the provider's read of the machine answers not found.
- The tool call that finds it lost fails in the provider's words. The next tool call starts a new sandbox under the same claim (its own create request, the claim's labels and epoch) and runs there, also when the lost sandbox was kept through a park. A start that fails is tried again at the next tool call under the same request, and does not count toward the bound. In Mode 2 the new sandbox mounts the run's folder with a new Archil mount credential, and the lost one's credential is removed.
- The timeline says `Its computer was lost; started a new one (<name>).`
- A claim starts at most 2 new sandboxes. The next loss fails the run at once, even if the model answers without another call, served with error code `computer_unavailable` and the provider's words.
- A 5xx, a timeout, or a failed read of the machine is not a loss and starts nothing. Desktops, phones, paired computers and an agent's own computer are never started again this way. The run's end and the owner's computer channel never start one either.
